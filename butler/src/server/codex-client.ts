import { EventEmitter } from "node:events";
import { promises as fs } from "node:fs";
import path from "node:path";

import WebSocket, { type RawData } from "ws";

import type { CodexInputItem } from "./image-store.js";
import { cleanupManagedWorktree, resolveExistingWorkspaceCwd } from "./repo-worktree.js";
import { ButlerStateStore } from "./state-store.js";
import type { ModelOption, ReasoningEffort, RuntimeCleanupTaskView } from "./types.js";

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

type ThreadDeleteContext = {
  threadId: string;
  cwd: string | null;
  stacks: RuntimeCleanupTaskView["stacks"];
  previews: RuntimeCleanupTaskView["previews"];
  services: RuntimeCleanupTaskView["services"];
};

function normalizeModelLabel(rawLabel: string, id: string): string {
  const source = rawLabel.trim() || id.trim();
  if (!source) {
    return id;
  }

  const normalized = source.replace(/\s+/g, "-");
  const parts = normalized.split("-").filter(Boolean);
  if (parts.length < 2) {
    return source;
  }

  const head = parts[0]?.toLowerCase() === "gpt" ? "GPT" : parts[0];
  const version = parts[1] ?? "";
  const suffix = parts
    .slice(2)
    .map((part) => {
      const lower = part.toLowerCase();
      if (lower === "codex") {
        return "Codex";
      }
      if (lower === "mini") {
        return "Mini";
      }
      if (lower === "max") {
        return "Max";
      }
      if (lower === "spark") {
        return "Spark";
      }
      return part.length > 1 ? `${part[0]!.toUpperCase()}${part.slice(1).toLowerCase()}` : part.toUpperCase();
    })
    .join(" ");

  return `${head}-${version}${suffix ? ` ${suffix}` : ""}`;
}

function normalizeInputItems(input: string | CodexInputItem[]): CodexInputItem[] {
  if (typeof input === "string") {
    const message = input.trim();
    if (!message) {
      throw new Error("text is required");
    }

    return [{ type: "text", text: message }];
  }

  const normalized = input.filter((item) => {
    if (item.type === "text") {
      return item.text.trim().length > 0;
    }

    return item.path.trim().length > 0;
  });

  if (normalized.length === 0) {
    throw new Error("input is required");
  }

  return normalized;
}

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
  private readonly onThreadCapabilityReady: ((threadId: string, cwd: string | null | undefined) => Promise<void>) | null;
  private readonly onThreadCapabilityRemoved: ((threadId: string) => Promise<void>) | null;
  private readonly onThreadDeleting: ((context: ThreadDeleteContext) => Promise<void>) | null;
  private readonly onRuntimeCleanupError: ((threadId: string, message: string) => void) | null;
  private cleanupQueueRunning = false;

  constructor(
    baseUrl: string,
    store: ButlerStateStore,
    codexHomeDir: string,
    options?: {
      onThreadCapabilityReady?: (threadId: string, cwd: string | null | undefined) => Promise<void>;
      onThreadCapabilityRemoved?: (threadId: string) => Promise<void>;
      onThreadDeleting?: (context: ThreadDeleteContext) => Promise<void>;
      onRuntimeCleanupError?: (threadId: string, message: string) => void;
    }
  ) {
    super();
    this.baseUrl = baseUrl;
    this.store = store;
    this.codexHomeDir = codexHomeDir;
    this.onThreadCapabilityReady = options?.onThreadCapabilityReady ?? null;
    this.onThreadCapabilityRemoved = options?.onThreadCapabilityRemoved ?? null;
    this.onThreadDeleting = options?.onThreadDeleting ?? null;
    this.onRuntimeCleanupError = options?.onRuntimeCleanupError ?? null;
  }

  start(): void {
    this.connect();
  }

  private async requireExistingWorkspace(cwd: string | null | undefined): Promise<string | null> {
    const normalized = typeof cwd === "string" ? cwd.trim() : "";
    if (!normalized) {
      return null;
    }

    const resolved = await resolveExistingWorkspaceCwd(normalized);
    try {
      await fs.access(resolved);
      return resolved;
    } catch {
      throw new Error(`Requested workspace does not exist: ${normalized}`);
    }
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
        this.store.enableMilestones();
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
      case "thread/name/updated":
        if (params.thread && typeof params.thread === "object") {
          const thread = params.thread as Record<string, unknown>;
          if (typeof thread.id === "string") {
            this.store.upsertThreadSummary(thread);
            this.store.addEvent(thread.id, message.method, "Thread name updated");
          }
        } else if (typeof params.threadId === "string" && typeof params.name === "string") {
          this.store.upsertThreadSummary({ id: params.threadId, name: params.name });
          this.store.addEvent(params.threadId, message.method, "Thread name updated");
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
          const last =
            tokenUsage.last && typeof tokenUsage.last === "object" ? (tokenUsage.last as Record<string, unknown>) : null;
          this.store.updateThreadTokenUsage(params.threadId, {
            totalTokens:
              typeof last?.totalTokens === "number"
                ? last.totalTokens
                : typeof total?.totalTokens === "number"
                  ? total.totalTokens
                  : null,
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
    this.store.markThreadInventoryReady();

    for (const threadId of loadedIds) {
      await this.resumeThread(threadId).catch(() => undefined);
    }

    for (const threadId of this.store.getOpenWindowIds()) {
      await this.loadThread(threadId).catch(() => undefined);
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
          label: normalizeModelLabel(typeof entry.displayName === "string" ? entry.displayName : id, id),
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

  private buildTurnExecutionConfig(): Record<string, unknown> {
    return {
      cwd: this.defaultCwd,
      approvalPolicy: "never",
      sandboxPolicy: {
        type: "dangerFullAccess"
      }
    };
  }

  private buildResumeConfig(): Record<string, unknown> {
    return {
      cwd: this.defaultCwd,
      approvalPolicy: "never",
      sandbox: "danger-full-access"
    };
  }

  private buildThreadStartConfig(overrides?: {
    cwd?: string | null;
    developerInstructions?: string | null;
    serviceName?: string | null;
  }): Record<string, unknown> {
    const params: Record<string, unknown> = {
      cwd: overrides?.cwd ?? this.defaultCwd,
      approvalPolicy: "never",
      sandbox: "danger-full-access",
      personality: "pragmatic",
      serviceName: overrides?.serviceName ?? "Butler"
    };

    if (this.selectedModel) {
      params.model = this.selectedModel;
    }

    if (overrides?.developerInstructions) {
      params.developerInstructions = overrides.developerInstructions;
    }

    return params;
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
      const detail = result.thread as Record<string, unknown>;
      await this.onThreadCapabilityReady?.(
        threadId,
        typeof detail.cwd === "string" ? detail.cwd : this.store.getThread(threadId)?.cwd
      );
    }

    await this.restoreThreadUsage(threadId).catch(() => undefined);
    await this.resumeThread(threadId).catch(() => undefined);
  }

  async resumeThread(threadId: string, forceConfig = false): Promise<void> {
    this.deletedThreadIds.delete(threadId);
    if (!forceConfig && this.resumedThreadIds.has(threadId)) {
      return;
    }

    const result = await this.call("thread/resume", {
      threadId,
      ...this.buildResumeConfig()
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

  async startThread(options: {
    task: string;
    input?: CodexInputItem[] | ((threadId: string) => CodexInputItem[] | Promise<CodexInputItem[]>);
    cwd?: string | null;
    developerInstructions?: string | null;
    openWindow?: boolean;
  }): Promise<{ threadId: string }> {
    const task = options.task.trim();
    if (!task) {
      throw new Error("task is required");
    }

    const threadCwd = await this.requireExistingWorkspace(options.cwd);

    const started = await this.call("thread/start", this.buildThreadStartConfig({
      cwd: threadCwd ?? this.defaultCwd,
      developerInstructions: options.developerInstructions ?? null
    }));

    const thread = started.thread && typeof started.thread === "object" ? (started.thread as Record<string, unknown>) : null;
    const threadId = typeof thread?.id === "string" ? thread.id : null;
    if (!threadId) {
      throw new Error("Codex did not return a thread id");
    }

    this.deletedThreadIds.delete(threadId);
    if (thread) {
      this.store.upsertThreadSummary(thread);
    }
    await this.onThreadCapabilityReady?.(threadId, threadCwd ?? (thread && typeof thread.cwd === "string" ? thread.cwd : null));
    this.resumedThreadIds.add(threadId);
    this.directControlThreadIds.add(threadId);

    const resolvedInput =
      typeof options.input === "function" ? await options.input(threadId) : (options.input ?? task);
    const params: Record<string, unknown> = {
      threadId,
      input: normalizeInputItems(resolvedInput)
    };

    if (threadCwd) {
      params.cwd = threadCwd;
    }

    if (this.selectedModel) {
      params.model = this.selectedModel;
    }

    if (this.selectedEffort) {
      params.effort = this.selectedEffort;
    }

    const turnResult = await this.call("turn/start", params);
    if (turnResult.turn && typeof turnResult.turn === "object") {
      const turn = turnResult.turn as Record<string, unknown>;
      if (typeof turn.id === "string") {
        this.activeTurnIds.set(threadId, turn.id);
      }
      this.store.updateTurn(threadId, turn);
    }

    if (options.openWindow !== false) {
      this.store.openWindow(threadId);
    }

    this.emit("change");
    return { threadId };
  }

  async sendMessage(threadId: string, input: string | CodexInputItem[]): Promise<void> {
    const inputItems = normalizeInputItems(input);
    const threadWorkspace = await this.requireExistingWorkspace(this.store.getThread(threadId)?.cwd);
    if (threadWorkspace) {
      this.store.upsertThreadSummary({ id: threadId, cwd: threadWorkspace });
    }
    await this.onThreadCapabilityReady?.(threadId, threadWorkspace);
    const targetThreadId = await this.ensureInteractiveThread(threadId);

    const activeTurnId = this.activeTurnIds.get(targetThreadId);
    if (activeTurnId) {
      if (threadWorkspace) {
        this.store.upsertThreadSummary({ id: targetThreadId, cwd: threadWorkspace });
      }
      await this.call("turn/steer", {
        threadId: targetThreadId,
        expectedTurnId: activeTurnId,
        input: inputItems
      });
      return;
    }

    const params: Record<string, unknown> = {
      threadId: targetThreadId,
      input: inputItems,
      ...this.buildTurnExecutionConfig()
    };

    if (threadWorkspace) {
      params.cwd = threadWorkspace;
    }

    if (this.selectedModel) {
      params.model = this.selectedModel;
    }

    if (this.selectedEffort) {
      params.effort = this.selectedEffort;
    }

    const result = await this.call("turn/start", params);
    if (threadWorkspace) {
      this.store.upsertThreadSummary({ id: targetThreadId, cwd: threadWorkspace });
    }
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

  private async restoreThreadUsage(threadId: string): Promise<void> {
    const sessionsDir = path.join(this.codexHomeDir, "sessions");
    const sessionFiles = (await this.listFilesRecursive(sessionsDir)).filter((filePath) => filePath.includes(threadId));

    if (sessionFiles.length === 0) {
      return;
    }

    const datedFiles = await Promise.all(
      sessionFiles.map(async (filePath) => ({
        filePath,
        modifiedAt: (await fs.stat(filePath).catch(() => null))?.mtimeMs ?? 0
      }))
    );

    datedFiles.sort((left, right) => right.modifiedAt - left.modifiedAt);

    for (const candidate of datedFiles) {
      const usage = await this.readUsageFromSession(candidate.filePath);
      if (!usage) {
        continue;
      }

      this.store.updateThreadTokenUsage(threadId, usage);
      return;
    }
  }

  private async readUsageFromSession(
    filePath: string
  ): Promise<{ totalTokens: number | null; modelContextWindow: number | null } | null> {
    const content = await fs.readFile(filePath, "utf8").catch(() => null);
    if (!content) {
      return null;
    }

    const lines = content.trim().split("\n").reverse();

    for (const line of lines) {
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue;
      }

      if (parsed.type !== "event_msg") {
        continue;
      }

      const payload = parsed.payload && typeof parsed.payload === "object" ? (parsed.payload as Record<string, unknown>) : null;
      if (!payload || payload.type !== "token_count") {
        continue;
      }

      const info = payload.info && typeof payload.info === "object" ? (payload.info as Record<string, unknown>) : null;
      if (!info) {
        continue;
      }

      const lastUsage =
        info.last_token_usage && typeof info.last_token_usage === "object"
          ? (info.last_token_usage as Record<string, unknown>)
          : null;
      const totalUsage =
        info.total_token_usage && typeof info.total_token_usage === "object"
          ? (info.total_token_usage as Record<string, unknown>)
          : null;

      return {
        totalTokens:
          typeof lastUsage?.total_tokens === "number"
            ? lastUsage.total_tokens
            : typeof totalUsage?.total_tokens === "number"
              ? totalUsage.total_tokens
              : null,
        modelContextWindow: typeof info.model_context_window === "number" ? info.model_context_window : null
      };
    }

    return null;
  }

  private async deleteThreadArtifacts(threadId: string, cwd: string | null): Promise<number> {
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

    if (cwd) {
      const cleanupCount = await cleanupManagedWorktree(cwd).catch(() => 0);
      for (let index = 0; index < cleanupCount; index += 1) {
        removed.add(`worktree-cleanup:${threadId}:${index}`);
      }
    }

    return removed.size;
  }

  private buildThreadDeleteContext(threadId: string): ThreadDeleteContext {
    const thread = this.store.getThread(threadId);

    return {
      threadId,
      cwd: thread?.cwd ?? null,
      stacks: this.store.listStackLeases().filter((lease) => lease.threadId === threadId).map((lease) => ({
        id: lease.id,
        retainsVolumes: Boolean(lease.retainsVolumes),
        status: lease.status
      })),
      previews: this.store.listPreviewLeases().filter((lease) => lease.threadId === threadId).map((lease) => ({
        id: lease.id,
        stackId: lease.stackId,
        status: lease.status
      })),
      services: this.store.listServiceLeases().filter((lease) => lease.threadId === threadId).map((lease) => ({
        id: lease.id,
        stackId: lease.stackId,
        runtimeKind: lease.runtimeKind,
        status: lease.status
      }))
    };
  }

  private async unsubscribeThread(threadId: string): Promise<void> {
    await this.call("thread/unsubscribe", { threadId }).catch(() => undefined);
    this.resumedThreadIds.delete(threadId);
    this.directControlThreadIds.delete(threadId);
    this.activeTurnIds.delete(threadId);
  }

  private scheduleCleanupQueue(): void {
    void this.processPendingCleanupTasks().catch(() => undefined);
  }

  private nextCleanupRetryDelayMs(attempts: number): number {
    const cappedAttempts = Math.max(1, Math.min(attempts, 6));
    return Math.min(15 * 60 * 1000, 30_000 * 2 ** (cappedAttempts - 1));
  }

  async processPendingCleanupTasks(): Promise<void> {
    if (this.cleanupQueueRunning) {
      return;
    }

    this.cleanupQueueRunning = true;
    try {
      for (const task of this.store.listDueRuntimeCleanupTasks()) {
        try {
          await this.onThreadDeleting?.({
            threadId: task.threadId,
            cwd: task.cwd,
            stacks: task.stacks,
            previews: task.previews,
            services: task.services
          });
          await this.deleteThreadArtifacts(task.threadId, task.cwd);
          this.store.completeRuntimeCleanupTask(task.id);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          const nextAttemptAt = Date.now() + this.nextCleanupRetryDelayMs(task.attempts + 1);
          const failed = this.store.failRuntimeCleanupTask(task.id, message, nextAttemptAt);
          if (failed.notify) {
            this.onRuntimeCleanupError?.(task.threadId, message);
          }
        }
      }
    } finally {
      this.cleanupQueueRunning = false;
    }
  }

  async deleteThread(threadId: string): Promise<{ deletedArtifacts: number }> {
    const context = this.buildThreadDeleteContext(threadId);
    this.store.enqueueRuntimeCleanupTask({
      threadId: context.threadId,
      cwd: context.cwd,
      stacks: context.stacks,
      previews: context.previews,
      services: context.services
    });
    this.deletedThreadIds.add(threadId);
    this.store.removeThread(threadId);
    await this.onThreadCapabilityRemoved?.(threadId);
    this.emit("change");
    await this.unsubscribeThread(threadId);
    this.scheduleCleanupQueue();
    return { deletedArtifacts: 0 };
  }

  async deleteAllThreads(): Promise<{ deletedThreadIds: string[]; deletedArtifacts: number }> {
    const threadIds = this.store.listThreads().map((thread) => thread.id);
    const deleteContexts = threadIds.map((threadId) => this.buildThreadDeleteContext(threadId));
    for (const context of deleteContexts) {
      this.store.enqueueRuntimeCleanupTask({
        threadId: context.threadId,
        cwd: context.cwd,
        stacks: context.stacks,
        previews: context.previews,
        services: context.services
      });
    }
    for (const threadId of threadIds) {
      this.deletedThreadIds.add(threadId);
    }
    this.store.removeThreads(threadIds);
    for (const threadId of threadIds) {
      await this.onThreadCapabilityRemoved?.(threadId);
    }
    this.emit("change");
    for (const threadId of threadIds) {
      await this.unsubscribeThread(threadId);
    }
    this.scheduleCleanupQueue();
    return { deletedThreadIds: threadIds, deletedArtifacts: 0 };
  }
}
