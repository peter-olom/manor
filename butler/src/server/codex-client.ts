import { EventEmitter } from "node:events";
import { promises as fs } from "node:fs";
import path from "node:path";

import WebSocket, { type RawData } from "ws";

import { ButlerStateStore } from "./state-store.js";
import type { ModelOption, ReasoningEffort } from "./types.js";

type JsonRpcMessage = {
  id?: number;
  method?: string;
  params?: Record<string, unknown>;
  result?: Record<string, unknown>;
  error?: {
    code: number;
    message: string;
  };
};

export class CodexAppServerClient extends EventEmitter {
  private readonly baseUrl: string;
  private readonly store: ButlerStateStore;
  private socket: WebSocket | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (value: Record<string, unknown>) => void; reject: (error: Error) => void }>();
  private reconnectTimer: NodeJS.Timeout | null = null;
  private readonly resumedThreadIds = new Set<string>();
  private readonly directControlThreadIds = new Set<string>();
  private readonly activeTurnIds = new Map<string, string>();
  private readonly deletedThreadIds = new Set<string>();
  private connected = false;
  private lastError: string | null = null;
  private availableModels: ModelOption[] = [];
  private selectedModel: string | null = null;
  private selectedEffort: ReasoningEffort | null = null;
  private readonly defaultCwd = "/repos";
  private readonly codexHomeDir: string;

  constructor(baseUrl: string, store: ButlerStateStore, codexHomeDir: string) {
    super();
    this.baseUrl = baseUrl;
    this.store = store;
    this.codexHomeDir = codexHomeDir;
  }

  start(): void {
    this.connect();
  }

  getConnectionState(): { connected: boolean; lastError: string | null; compose: { model: string | null; effort: ReasoningEffort | null; availableModels: ModelOption[] } } {
    return {
      connected: this.connected,
      lastError: this.lastError,
      compose: {
        model: this.selectedModel,
        effort: this.selectedEffort,
        availableModels: this.availableModels
      }
    };
  }

  private connect(): void {
    const socket = new WebSocket(this.baseUrl);
    this.socket = socket;

    socket.on("open", async () => {
      try {
        await this.call("initialize", {
          clientInfo: {
            name: "manor-butler",
            title: "Manor Butler",
            version: "0.1.0"
          }
        });

        socket.send(JSON.stringify({ jsonrpc: "2.0", method: "initialized", params: {} }));
        this.connected = true;
        this.lastError = null;
        this.emit("change");
        await this.loadModels();
        await this.seedThreads();
      } catch (error) {
        this.lastError = error instanceof Error ? error.message : String(error);
        this.emit("change");
        socket.close();
      }
    });

    socket.on("message", (buffer: RawData) => {
      try {
        const message = JSON.parse(buffer.toString()) as JsonRpcMessage;
        this.handleMessage(message);
      } catch (error) {
        this.lastError = error instanceof Error ? error.message : String(error);
        this.emit("change");
      }
    });

    socket.on("close", () => {
      this.connected = false;
      this.socket = null;
      this.resumedThreadIds.clear();
      this.directControlThreadIds.clear();
      this.activeTurnIds.clear();

      for (const pending of this.pending.values()) {
        pending.reject(new Error("Codex app-server connection closed"));
      }
      this.pending.clear();

      if (!this.reconnectTimer) {
        this.reconnectTimer = setTimeout(() => {
          this.reconnectTimer = null;
          this.connect();
        }, 1500);
      }

      this.emit("change");
    });

    socket.on("error", (error: Error) => {
      this.lastError = error.message;
      this.emit("change");
    });
  }

  private handleMessage(message: JsonRpcMessage): void {
    if (typeof message.id === "number") {
      const pending = this.pending.get(message.id);
      if (!pending) {
        return;
      }
      this.pending.delete(message.id);
      if (message.error) {
        pending.reject(new Error(message.error.message));
      } else {
        pending.resolve(message.result ?? {});
      }
      return;
    }

    if (!message.method) {
      return;
    }

    const params = message.params ?? {};
    const threadId = typeof params.threadId === "string" ? params.threadId : null;

    if (threadId && this.deletedThreadIds.has(threadId)) {
      return;
    }

    switch (message.method) {
      case "thread/started":
        if (params.thread && typeof params.thread === "object") {
          const thread = params.thread as Record<string, unknown>;
          if (typeof thread.id === "string") {
            if (this.deletedThreadIds.has(thread.id)) {
              return;
            }
            this.store.upsertThreadSummary(thread);
            this.store.addEvent(thread.id, message.method, "Thread started");
          }
        }
        break;
      case "thread/status/changed":
        if (typeof params.threadId === "string") {
          this.store.setThreadStatus(params.threadId, params.status);
          this.store.addEvent(params.threadId, message.method, JSON.stringify(params.status ?? {}));
        }
        break;
      case "turn/started":
        if (typeof params.threadId === "string" && params.turn && typeof params.turn === "object") {
          const turn = params.turn as Record<string, unknown>;
          if (typeof turn.id === "string") {
            this.activeTurnIds.set(params.threadId, turn.id);
          }
          this.store.updateTurn(params.threadId, turn);
          this.store.addEvent(params.threadId, message.method, "Turn started");
        }
        break;
      case "turn/completed":
        if (typeof params.threadId === "string" && params.turn && typeof params.turn === "object") {
          this.activeTurnIds.delete(params.threadId);
          this.store.updateTurn(params.threadId, params.turn as Record<string, unknown>);
          this.store.addEvent(params.threadId, message.method, "Turn completed");
        }
        break;
      case "item/started":
      case "item/completed":
        if (typeof params.threadId === "string" && typeof params.turnId === "string" && params.item && typeof params.item === "object") {
          this.store.updateItem(
            params.threadId,
            params.turnId,
            params.item as Record<string, unknown>,
            message.method.endsWith("completed") ? "completed" : "started"
          );
        }
        break;
      case "item/agentMessage/delta":
        if (
          typeof params.threadId === "string" &&
          typeof params.turnId === "string" &&
          typeof params.itemId === "string" &&
          typeof params.delta === "string"
        ) {
          this.store.appendItemDelta(params.threadId, params.turnId, params.itemId, params.delta);
        }
        break;
      case "thread/tokenUsage/updated":
        if (typeof params.threadId === "string" && params.tokenUsage && typeof params.tokenUsage === "object") {
          const tokenUsage = params.tokenUsage as Record<string, unknown>;
          const total =
            tokenUsage.total && typeof tokenUsage.total === "object" ? (tokenUsage.total as Record<string, unknown>) : null;
          this.store.updateThreadTokenUsage(params.threadId, {
            totalTokens: typeof total?.totalTokens === "number" ? total.totalTokens : null,
            modelContextWindow: typeof tokenUsage.modelContextWindow === "number" ? tokenUsage.modelContextWindow : null
          });
        }
        break;
      default:
        if (typeof params.threadId === "string") {
          this.store.addEvent(params.threadId, message.method, JSON.stringify(params).slice(0, 240));
        }
        break;
    }

    this.emit("change");
  }

  private async seedThreads(): Promise<void> {
    let cursor: string | null = null;

    do {
      const result = await this.call("thread/list", {
        cursor,
        limit: 100,
        sourceKinds: ["appServer", "cli", "vscode"]
      });

      const threads = Array.isArray(result.data) ? (result.data as Record<string, unknown>[]) : [];
      for (const thread of threads) {
        if (typeof thread.id === "string" && this.deletedThreadIds.has(thread.id)) {
          continue;
        }
        this.store.upsertThreadSummary(thread);
      }

      cursor = typeof result.nextCursor === "string" ? result.nextCursor : null;
    } while (cursor);

    const loaded = await this.call("thread/loaded/list", {});
    const loadedIds = Array.isArray(loaded.data) ? loaded.data.filter((value): value is string => typeof value === "string") : [];
    this.store.markLoadedThreads(loadedIds);

    for (const threadId of loadedIds) {
      await this.resumeThread(threadId).catch(() => undefined);
    }
  }

  private async loadModels(): Promise<void> {
    let cursor: string | null = null;
    const models: ModelOption[] = [];

    do {
      const result = await this.call("model/list", {
        cursor,
        limit: 100,
        includeHidden: false
      });

      const entries = Array.isArray(result.data) ? (result.data as Record<string, unknown>[]) : [];
      for (const entry of entries) {
        const id = typeof entry.id === "string" ? entry.id : typeof entry.model === "string" ? entry.model : null;
        if (!id) {
          continue;
        }

        const supportedReasoningEfforts = Array.isArray(entry.supportedReasoningEfforts)
          ? entry.supportedReasoningEfforts
              .map((option) =>
                option && typeof option === "object" && "reasoningEffort" in option && typeof option.reasoningEffort === "string"
                  ? (option.reasoningEffort as ReasoningEffort)
                  : null
              )
              .filter((value): value is ReasoningEffort => Boolean(value))
          : [];

        models.push({
          id,
          label: typeof entry.displayName === "string" ? entry.displayName : id,
          provider: null,
          supportsReasoning: supportedReasoningEfforts.length > 0,
          supportedReasoningEfforts,
          defaultReasoningEffort:
            typeof entry.defaultReasoningEffort === "string" ? (entry.defaultReasoningEffort as ReasoningEffort) : supportedReasoningEfforts[0] ?? null
        });
      }

      cursor = typeof result.nextCursor === "string" ? result.nextCursor : null;
    } while (cursor);

    this.availableModels = models;
    const defaultModel = this.availableModels.find((model) => model.id === this.selectedModel) ?? this.availableModels[0] ?? null;
    this.selectedModel = defaultModel?.id ?? null;
    this.selectedEffort = defaultModel ? this.resolveEffort(defaultModel, this.selectedEffort) : null;
    this.emit("change");
  }

  private resolveEffort(model: ModelOption, effort: ReasoningEffort | null): ReasoningEffort | null {
    if (!model.supportsReasoning) {
      return null;
    }

    if (effort && model.supportedReasoningEfforts.includes(effort)) {
      return effort;
    }

    return model.defaultReasoningEffort ?? model.supportedReasoningEfforts[0] ?? null;
  }

  private buildExecutionConfig(): Record<string, unknown> {
    return {
      cwd: this.defaultCwd,
      approvalPolicy: "never",
      sandboxPolicy: {
        type: "workspaceWrite",
        writableRoots: ["/repos", "/artifacts", "/state"],
        networkAccess: true
      }
    };
  }

  private async ensureInteractiveThread(threadId: string): Promise<string> {
    if (this.directControlThreadIds.has(threadId)) {
      return threadId;
    }

    const thread = this.store.getThread(threadId);
    await this.resumeThread(threadId, true);
    this.directControlThreadIds.add(threadId);

    if (thread && thread.source !== "appServer") {
      this.store.addEvent(threadId, "thread/direct-control", "Butler attached direct control without creating a new thread");
    }

    return threadId;
  }

  private call(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error("Codex app-server is not connected"));
    }

    const id = this.nextId++;
    this.socket.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });
  }

  async loadThread(threadId: string): Promise<void> {
    this.deletedThreadIds.delete(threadId);
    const result = await this.call("thread/read", {
      threadId,
      includeTurns: true
    });

    if (result.thread && typeof result.thread === "object") {
      this.store.setThreadDetail(result.thread as Record<string, unknown>);
    }

    await this.resumeThread(threadId).catch(() => undefined);
  }

  async resumeThread(threadId: string, forceConfig = false): Promise<void> {
    this.deletedThreadIds.delete(threadId);
    if (!forceConfig && this.resumedThreadIds.has(threadId)) {
      return;
    }

    const result = await this.call("thread/resume", {
      threadId,
      ...this.buildExecutionConfig()
    });
    if (result.thread && typeof result.thread === "object") {
      this.store.upsertThreadSummary(result.thread as Record<string, unknown>);
    }
    this.resumedThreadIds.add(threadId);
  }

  async updateComposeSettings(modelId: string, effort: ReasoningEffort | null): Promise<void> {
    const model = this.availableModels.find((entry) => entry.id === modelId);
    if (!model) {
      throw new Error("Selected Codex model is not available");
    }

    this.selectedModel = model.id;
    this.selectedEffort = this.resolveEffort(model, effort);
    this.emit("change");
  }

  async sendMessage(threadId: string, text: string): Promise<void> {
    const message = text.trim();
    if (!message) {
      throw new Error("text is required");
    }

    const targetThreadId = await this.ensureInteractiveThread(threadId);

    const activeTurnId = this.activeTurnIds.get(targetThreadId);
    if (activeTurnId) {
      await this.call("turn/steer", {
        threadId: targetThreadId,
        expectedTurnId: activeTurnId,
        input: [{ type: "text", text: message }]
      });
      return;
    }

    const params: Record<string, unknown> = {
      threadId: targetThreadId,
      input: [{ type: "text", text: message }],
      ...this.buildExecutionConfig()
    };

    if (this.selectedModel) {
      params.model = this.selectedModel;
    }

    if (this.selectedEffort) {
      params.effort = this.selectedEffort;
    }

    const result = await this.call("turn/start", params);
    if (result.turn && typeof result.turn === "object") {
      this.store.updateTurn(targetThreadId, result.turn as Record<string, unknown>);
    }
  }

  private async listFilesRecursive(root: string): Promise<string[]> {
    const entries = await fs.readdir(root, { withFileTypes: true }).catch(() => []);
    const files: string[] = [];

    for (const entry of entries) {
      const entryPath = path.join(root, entry.name);
      if (entry.isDirectory()) {
        files.push(...(await this.listFilesRecursive(entryPath)));
      } else if (entry.isFile()) {
        files.push(entryPath);
      }
    }

    return files;
  }

  private async deleteThreadArtifacts(threadId: string): Promise<number> {
    const removed = new Set<string>();
    const sessionsDir = path.join(this.codexHomeDir, "sessions");
    const snapshotsDir = path.join(this.codexHomeDir, "shell_snapshots");

    const sessionFiles = await this.listFilesRecursive(sessionsDir);
    for (const filePath of sessionFiles) {
      if (!filePath.includes(threadId)) {
        continue;
      }

      await fs.rm(filePath, { force: true });
      removed.add(filePath);
    }

    const snapshotFiles = await this.listFilesRecursive(snapshotsDir);
    for (const filePath of snapshotFiles) {
      const name = path.basename(filePath);
      if (!name.startsWith(`${threadId}.`)) {
        continue;
      }

      await fs.rm(filePath, { force: true });
      removed.add(filePath);
    }

    return removed.size;
  }

  private async unsubscribeThread(threadId: string): Promise<void> {
    await this.call("thread/unsubscribe", { threadId }).catch(() => undefined);
    this.resumedThreadIds.delete(threadId);
    this.directControlThreadIds.delete(threadId);
    this.activeTurnIds.delete(threadId);
  }

  async deleteThread(threadId: string): Promise<{ deletedArtifacts: number }> {
    this.deletedThreadIds.add(threadId);
    await this.unsubscribeThread(threadId);
    const deletedArtifacts = await this.deleteThreadArtifacts(threadId);
    this.store.removeThread(threadId);
    this.emit("change");
    return { deletedArtifacts };
  }

  async deleteAllThreads(): Promise<{ deletedThreadIds: string[]; deletedArtifacts: number }> {
    const threadIds = this.store.listThreads().map((thread) => thread.id);
    for (const threadId of threadIds) {
      this.deletedThreadIds.add(threadId);
    }
    for (const threadId of threadIds) {
      await this.unsubscribeThread(threadId);
    }

    const sessionsDir = path.join(this.codexHomeDir, "sessions");
    const snapshotsDir = path.join(this.codexHomeDir, "shell_snapshots");
    let deletedArtifacts = 0;

    for (const filePath of await this.listFilesRecursive(sessionsDir)) {
      await fs.rm(filePath, { force: true });
      deletedArtifacts += 1;
    }

    for (const filePath of await this.listFilesRecursive(snapshotsDir)) {
      await fs.rm(filePath, { force: true });
      deletedArtifacts += 1;
    }

    this.store.removeThreads(threadIds);
    this.emit("change");
    return { deletedThreadIds: threadIds, deletedArtifacts };
  }
}
