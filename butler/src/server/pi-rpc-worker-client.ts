import { EventEmitter } from "node:events";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

import { RpcClient, type RpcEventListener } from "@mariozechner/pi-coding-agent";

import { createManorModelRegistry, modelToModelOption } from "./model-provider-config.js";
import { selectProviderWebToolSource } from "./provider-web-tools.js";
import { PiProviderRuntimeMapper } from "./pi-provider-events.js";
import type { ButlerStateStore } from "./state-store.js";
import type { CodexInputItem } from "./image-store.js";
import type { CodexThreadPatchView, ModelOption, ReasoningEffort } from "./types.js";
import type { ProviderRuntimeLivePatch } from "../shared/provider-runtime.js";

type PiRpcWorkerClientEvents = {
  change: [];
  threadPatch: [ProviderRuntimeLivePatch];
};

type PiWorkerSession = {
  threadId: string;
  client: RpcClient;
  mapper: PiProviderRuntimeMapper;
  unsubscribe: (() => void) | null;
  cwd: string;
};

function inputItemsToText(input: string | CodexInputItem[]): string {
  if (typeof input === "string") return input.trim();
  return input
    .map((item) => item.type === "text" ? item.text : `Attached ${item.type}: ${item.path}`)
    .filter(Boolean)
    .join("\n")
    .trim();
}

function storeItemType(patch: Extract<ProviderRuntimeLivePatch, { kind: "item-lifecycle" | "content-delta" }>): string {
  if (patch.itemType === "assistant_message") return "agentMessage";
  if (patch.itemType === "user_message") return "userMessage";
  if (patch.itemType === "command_execution") return "commandExecution";
  if (patch.itemType === "file_change") return "fileChange";
  if (patch.itemType === "reasoning") return "reasoning";
  return patch.itemType;
}

function defaultPiCliPath(): string {
  return path.join(path.dirname(fileURLToPath(import.meta.resolve("@mariozechner/pi-coding-agent"))), "cli.js");
}

export function defaultOllamaWebToolsExtensionPath(): string {
  const currentPath = fileURLToPath(import.meta.url);
  return path.join(path.dirname(currentPath), `pi-ollama-web-tools-extension${path.extname(currentPath)}`);
}

export function defaultOpencodeWebToolsExtensionPath(): string {
  const currentPath = fileURLToPath(import.meta.url);
  return path.join(path.dirname(currentPath), `pi-opencode-web-tools-extension${path.extname(currentPath)}`);
}

export async function webToolsExtensionArgsForProvider(provider: string | null | undefined, env: NodeJS.ProcessEnv = process.env): Promise<string[]> {
  const source = await selectProviderWebToolSource(provider, env);
  if (source === "opencode") return ["--extension", defaultOpencodeWebToolsExtensionPath()];
  if (source === "ollama") return ["--extension", defaultOllamaWebToolsExtensionPath()];
  return [];
}

export class PiRpcWorkerClient extends EventEmitter<PiRpcWorkerClientEvents> {
  private readonly sessions = new Map<string, PiWorkerSession>();
  private availableModels: ModelOption[] = [];
  private selectedProvider: string | null = null;
  private selectedModel: string | null = null;
  private selectedEffort: ReasoningEffort | null = null;
  private lastError: string | null = null;

  constructor(private readonly options: { store: ButlerStateStore; piAuthPath: string; sessionRootDir: string; cliPath?: string | null }) {
    super();
  }

  async start(): Promise<void> {
    await this.loadModels();
  }

  async refreshModels(): Promise<void> {
    await this.loadModels();
  }

  getConnectionState(): { connected: boolean; lastError: string | null; compose: { provider: string | null; model: string | null; effort: ReasoningEffort | null; availableModels: ModelOption[] } } {
    return {
      connected: true,
      lastError: this.lastError,
      compose: {
        provider: this.selectedProvider,
        model: this.selectedModel,
        effort: this.selectedEffort,
        availableModels: this.availableModels
      }
    };
  }

  async updateComposeSettings(modelId: string, effort: ReasoningEffort | null): Promise<void> {
    const model = this.availableModels.find((entry) => entry.id === modelId || `${entry.provider}/${entry.id}` === modelId);
    if (!model) throw new Error("Selected Pi RPC worker model is not available");
    this.selectedProvider = model.provider;
    this.selectedModel = model.id;
    this.selectedEffort = effort;
    this.emit("change");
  }

  async updateThreadReasoningEffort(threadId: string, effort: ReasoningEffort): Promise<void> {
    const session = this.sessions.get(threadId);
    if (!session) throw new Error("Pi RPC worker thread is not loaded");
    await session.client.setThinkingLevel(effort === "minimal" ? "low" : effort as never);
    this.options.store.setThreadRequestedReasoningEffort(threadId, effort);
  }

  async startThread(options: {
    task: string;
    input?: CodexInputItem[] | ((threadId: string) => CodexInputItem[] | Promise<CodexInputItem[]>);
    cwd?: string | null;
    developerInstructions?: string | null;
    effort?: ReasoningEffort | null;
    openWindow?: boolean;
  }): Promise<{ threadId: string; turnId: string | null }> {
    const task = options.task.trim();
    if (!task) throw new Error("task is required");
    const threadId = `pi-${crypto.randomUUID()}`;
    const cwd = options.cwd?.trim() || "/repos";
    const session = await this.createSession(threadId, cwd);
    this.options.store.upsertThreadSummary({
      id: threadId,
      name: task.slice(0, 120),
      cwd,
      source: "pi-rpc",
      status: { type: "active" },
      createdAt: Date.now(),
      updatedAt: Date.now()
    });
    if (options.openWindow !== false) this.options.store.openWindow(threadId);
    const resolvedInput = typeof options.input === "function" ? await options.input(threadId) : (options.input ?? [{ type: "text", text: task } as CodexInputItem]);
    const prompt = [options.developerInstructions?.trim() ? `Developer instructions:\n${options.developerInstructions.trim()}` : null, inputItemsToText(resolvedInput)].filter(Boolean).join("\n\n");
    if (options.effort ?? this.selectedEffort) {
      await session.client.setThinkingLevel((options.effort ?? this.selectedEffort) as never);
      this.options.store.setThreadRequestedReasoningEffort(threadId, (options.effort ?? this.selectedEffort) as never);
    }
    await session.client.prompt(prompt);
    this.emit("change");
    return { threadId, turnId: null };
  }

  async sendMessage(threadId: string, input: string | CodexInputItem[]): Promise<{ threadId: string; turnId: string | null }> {
    const session = this.sessions.get(threadId);
    if (!session) throw new Error("Pi RPC worker thread is not loaded");
    const text = inputItemsToText(input);
    const state = await session.client.getState().catch(() => null);
    if (state?.isStreaming) await session.client.steer(text);
    else await session.client.prompt(text);
    return { threadId, turnId: null };
  }

  async stopThread(threadId: string): Promise<boolean> {
    const session = this.sessions.get(threadId);
    if (!session) return false;
    await session.client.abort().catch(() => undefined);
    this.options.store.setThreadStatus(threadId, "idle");
    this.emit("change");
    return true;
  }

  async loadThread(threadId: string): Promise<void> {
    if (!this.sessions.has(threadId)) {
      throw new Error("Pi RPC worker session is not loaded in this process");
    }
  }

  async deleteThread(threadId: string): Promise<boolean> {
    const session = this.sessions.get(threadId);
    if (!session) return false;
    session.unsubscribe?.();
    await session.client.stop();
    this.sessions.delete(threadId);
    this.options.store.closeWindow(threadId);
    this.options.store.removeThread(threadId);
    this.emit("change");
    return true;
  }

  private async loadModels(): Promise<void> {
    const registry = await createManorModelRegistry(this.options.piAuthPath);
    this.availableModels = registry.getAvailable().map(modelToModelOption);
    const selected = this.availableModels.find((model) => model.id === this.selectedModel && model.provider === this.selectedProvider) ?? this.availableModels[0] ?? null;
    this.selectedProvider = selected?.provider ?? null;
    this.selectedModel = selected?.id ?? null;
    this.emit("change");
  }

  private async createSession(threadId: string, cwd: string): Promise<PiWorkerSession> {
    const modelRef = this.selectedProvider && this.selectedModel ? `${this.selectedProvider}/${this.selectedModel}` : this.selectedModel ?? undefined;
    const extensionArgs = await this.webToolsExtensionArgs();
    const client = new RpcClient({
      cwd,
      cliPath: this.options.cliPath ?? defaultPiCliPath(),
      env: {
        PI_AGENT_DIR: path.dirname(this.options.piAuthPath),
        PI_CODING_AGENT_DIR: path.dirname(this.options.piAuthPath)
      },
      ...(this.selectedProvider ? { provider: this.selectedProvider } : {}),
      ...(modelRef ? { model: modelRef } : {}),
      args: [...extensionArgs, "--session-dir", path.join(this.options.sessionRootDir, threadId)]
    });
    const mapper = new PiProviderRuntimeMapper(threadId);
    await client.start();
    const listener: RpcEventListener = (event) => {
      const patches = mapper.map(event as never, { messages: [], getSessionStats: () => ({ contextUsage: null }) } as never);
      for (const patch of patches) this.applyPatch(patch);
    };
    const unsubscribe = client.onEvent(listener);
    const session: PiWorkerSession = { threadId, client, mapper, unsubscribe, cwd };
    this.sessions.set(threadId, session);
    return session;
  }

  private async webToolsExtensionArgs(): Promise<string[]> {
    return webToolsExtensionArgsForProvider(this.selectedProvider);
  }

  private applyPatch(patch: ProviderRuntimeLivePatch): void {
    if (patch.kind === "thread-state") {
      this.options.store.setThreadStatus(patch.threadId, patch.state === "idle" ? "idle" : "active");
    } else if (patch.kind === "turn-lifecycle") {
      this.options.store.updateTurn(patch.threadId, {
        id: patch.turnId,
        status: patch.status === "started" ? "in_progress" : patch.status
      });
    } else if (patch.kind === "item-lifecycle") {
      this.options.store.updateItem(patch.threadId, patch.turnId, {
        id: patch.itemId,
        type: storeItemType(patch),
        status: patch.status === "completed" ? "completed" : "started",
        text: patch.text,
        command: patch.text
      }, patch.status === "completed" ? "completed" : "started");
    } else if (patch.kind === "content-delta") {
      this.options.store.appendItemDelta(patch.threadId, patch.turnId, patch.itemId, patch.delta, storeItemType(patch), { emitChange: false });
    }
    this.emit("threadPatch", patch satisfies CodexThreadPatchView);
    this.emit("change");
  }
}
