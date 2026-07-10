import { EventEmitter } from "node:events";
import { rm } from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

import { RpcClient, type RpcEventListener } from "@mariozechner/pi-coding-agent";

import { createManorModelRegistry, modelToModelOption, shouldExposeManorModel, syncManorPiModelsJson } from "./model-provider-config.js";
import { readButlerAuthStatus } from "./auth-status.js";
import { isChatGptSubscriptionModelAvailable } from "./chatgpt-entitlement.js";
import { getActiveManorSettings } from "./manor-settings-runtime.js";
import { selectProviderWebToolSource } from "./provider-web-tools.js";
import { PiProviderRuntimeMapper } from "./pi-provider-events.js";
import { piThinkingLevelForEffort } from "./pi-thinking-levels.js";
import { StaleWorkerOperationError } from "./stale-worker-operation-error.js";
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
  provider: string;
  model: string;
  activityVersion: number;
  acceptedEventVersion: number | null;
  eventStreamVersion: number | null;
  pendingPromptGenerations: number[];
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
  const settings = getActiveManorSettings(env);
  if (provider === settings.providers.opencodeGo.providerId || provider === "opencode-go") {
    return ["--extension", defaultOpencodeWebToolsExtensionPath()];
  }
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

  constructor(private readonly options: {
    store: ButlerStateStore;
    piAuthPath: string;
    sessionRootDir: string;
    cliPath?: string | null;
    codexHomeDir?: string | null;
    butlerBaseUrl?: string | null;
    onThreadCapabilityReady?: (threadId: string, cwd: string) => Promise<unknown>;
    onThreadCapabilityRemoved?: (threadId: string) => Promise<unknown>;
    onThreadDeleting?: (context: {
      threadId: string;
      stacks: Array<{ id: string; retainsVolumes: boolean; status: string }>;
      previews: Array<{ id: string; stackId: string | null; status: string }>;
      services: Array<{ id: string; stackId: string | null; runtimeKind: string; status: string }>;
    }) => Promise<unknown>;
  }) {
    super();
  }

  private beginSessionOperation(session: PiWorkerSession): number {
    session.activityVersion += 1;
    session.acceptedEventVersion = session.activityVersion;
    return session.activityVersion;
  }

  private invalidateSessionOperations(session: PiWorkerSession): number {
    session.activityVersion += 1;
    session.acceptedEventVersion = null;
    return session.activityVersion;
  }

  private isSessionGenerationCurrent(session: PiWorkerSession, generation: number): boolean {
    return this.sessions.get(session.threadId) === session && session.activityVersion === generation;
  }

  private isSessionEventGenerationCurrent(session: PiWorkerSession, generation: number | null): boolean {
    return generation !== null
      && this.isSessionGenerationCurrent(session, generation)
      && session.acceptedEventVersion === generation;
  }

  private invalidateSessionGenerationIfCurrent(session: PiWorkerSession, generation: number): void {
    if (this.isSessionGenerationCurrent(session, generation)) this.invalidateSessionOperations(session);
  }

  private staleOperation(threadId: string): StaleWorkerOperationError {
    return new StaleWorkerOperationError(threadId);
  }

  private async rejectStaleStartedSession(session: PiWorkerSession): Promise<never> {
    let cleanupError: unknown;
    if (this.sessions.get(session.threadId) === session && session.acceptedEventVersion === null) {
      try {
        await this.cleanupStartedSession(session);
      } catch (error) {
        cleanupError = error;
      }
    }
    throw new StaleWorkerOperationError(session.threadId, cleanupError);
  }

  private async cleanupStartedSession(session: PiWorkerSession): Promise<void> {
    if (this.sessions.get(session.threadId) !== session) return;
    await this.removeThreadDurably(session.threadId);
    session.pendingPromptGenerations = [];
    session.unsubscribe?.();
    this.sessions.delete(session.threadId);
    let stopError: unknown;
    try {
      await session.client.stop();
    } catch (error) {
      stopError = error;
    }
    await this.removeSessionDirectory(session.threadId);
    this.emit("change");
    if (stopError) throw stopError;
  }

  private async rejectFailedStartedSession(session: PiWorkerSession, startError: unknown): Promise<never> {
    try {
      await this.cleanupStartedSession(session);
    } catch (cleanupError) {
      const startMessage = startError instanceof Error ? startError.message : String(startError);
      const cleanupMessage = cleanupError instanceof Error ? cleanupError.message : String(cleanupError);
      throw new AggregateError([startError, cleanupError], `Pi Worker start failed: ${startMessage}; cleanup failed: ${cleanupMessage}`);
    }
    throw startError;
  }

  private async promptSession(session: PiWorkerSession, generation: number, text: string): Promise<void> {
    session.pendingPromptGenerations.push(generation);
    try {
      await session.client.prompt(text);
    } finally {
      const pendingIndex = session.pendingPromptGenerations.indexOf(generation);
      if (pendingIndex >= 0) session.pendingPromptGenerations.splice(pendingIndex, 1);
    }
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
    await session.client.setThinkingLevel(piThinkingLevelForEffort(effort) as never);
    this.options.store.setThreadRequestedReasoningEffort(threadId, effort);
  }

  async startThread(options: {
    task: string;
    input?: CodexInputItem[] | ((threadId: string) => CodexInputItem[] | Promise<CodexInputItem[]>);
    cwd?: string | null;
    developerInstructions?: string | null;
    provider?: string | null;
    model?: string | null;
    effort?: ReasoningEffort | null;
    openWindow?: boolean;
  }): Promise<{ threadId: string; turnId: string | null }> {
    const task = options.task.trim();
    if (!task) throw new Error("task is required");
    const threadId = `pi-${crypto.randomUUID()}`;
    const cwd = options.cwd?.trim() || "/repos";
    const selected = this.availableModels.find((entry) =>
      entry.id === options.model || `${entry.provider}/${entry.id}` === options.model
    ) ?? this.availableModels.find((entry) => entry.id === this.selectedModel && entry.provider === this.selectedProvider) ?? null;
    if (!selected?.provider) throw new Error("Selected Pi RPC worker model is not available");
    if (options.provider && options.provider !== selected.provider) throw new Error("Selected Pi RPC worker provider does not match its model");
    const session = await this.createSession(threadId, cwd, selected.provider, selected.id);
    this.options.store.upsertThreadSummary({
      id: threadId,
      name: task.slice(0, 120),
      cwd,
      source: "pi-rpc",
      modelProvider: selected.provider,
      status: { type: "active" },
      createdAt: Date.now(),
      updatedAt: Date.now()
    });
    try {
      await this.options.onThreadCapabilityReady?.(threadId, cwd);
    } catch (error) {
      return this.rejectFailedStartedSession(session, error);
    }
    if (options.openWindow !== false) this.options.store.openWindow(threadId);
    const preflightGeneration = session.activityVersion;
    let resolvedInput: CodexInputItem[];
    try {
      resolvedInput = typeof options.input === "function" ? await options.input(threadId) : (options.input ?? [{ type: "text", text: task } as CodexInputItem]);
    } catch (error) {
      if (!this.isSessionGenerationCurrent(session, preflightGeneration)) return this.rejectStaleStartedSession(session);
      return this.rejectFailedStartedSession(session, error);
    }
    if (!this.isSessionGenerationCurrent(session, preflightGeneration)) return this.rejectStaleStartedSession(session);
    const prompt = [options.developerInstructions?.trim() ? `Developer instructions:\n${options.developerInstructions.trim()}` : null, inputItemsToText(resolvedInput)].filter(Boolean).join("\n\n");
    const requestedEffort = options.effort === undefined ? this.selectedEffort : options.effort;
    if (requestedEffort) {
      try {
        await session.client.setThinkingLevel(piThinkingLevelForEffort(requestedEffort) as never);
      } catch (error) {
        if (!this.isSessionGenerationCurrent(session, preflightGeneration)) return this.rejectStaleStartedSession(session);
        return this.rejectFailedStartedSession(session, error);
      }
      if (!this.isSessionGenerationCurrent(session, preflightGeneration)) return this.rejectStaleStartedSession(session);
      this.options.store.setThreadRequestedReasoningEffort(threadId, requestedEffort);
    }
    const operationGeneration = this.beginSessionOperation(session);
    try {
      await this.promptSession(session, operationGeneration, prompt);
    } catch (error) {
      if (!this.isSessionGenerationCurrent(session, operationGeneration)) return this.rejectStaleStartedSession(session);
      this.invalidateSessionGenerationIfCurrent(session, operationGeneration);
      return this.rejectFailedStartedSession(session, error);
    }
    if (!this.isSessionGenerationCurrent(session, operationGeneration)) return this.rejectStaleStartedSession(session);
    this.emit("change");
    return { threadId, turnId: null };
  }

  async sendMessage(threadId: string, input: string | CodexInputItem[]): Promise<{ threadId: string; turnId: string | null }> {
    const session = this.sessions.get(threadId);
    if (!session) throw new Error("Pi RPC worker thread is not loaded");
    const text = inputItemsToText(input);
    const preflightGeneration = session.activityVersion;
    const state = await session.client.getState().catch(() => null);
    if (!this.isSessionGenerationCurrent(session, preflightGeneration)) throw this.staleOperation(threadId);
    const operationGeneration = this.beginSessionOperation(session);
    try {
      if (state?.isStreaming) {
        session.eventStreamVersion = operationGeneration;
        await session.client.steer(text);
      } else {
        await this.promptSession(session, operationGeneration, text);
      }
    } catch (error) {
      if (!this.isSessionGenerationCurrent(session, operationGeneration)) throw this.staleOperation(threadId);
      this.invalidateSessionGenerationIfCurrent(session, operationGeneration);
      throw error;
    }
    if (!this.isSessionGenerationCurrent(session, operationGeneration)) throw this.staleOperation(threadId);
    return { threadId, turnId: null };
  }

  async stopThread(threadId: string): Promise<boolean> {
    const session = this.sessions.get(threadId);
    if (!session) return false;
    const activityVersion = this.invalidateSessionOperations(session);
    await session.client.abort().catch(() => undefined);
    session.pendingPromptGenerations = session.pendingPromptGenerations.filter((generation) => generation > activityVersion);
    if (!this.isSessionGenerationCurrent(session, activityVersion)) return true;
    this.options.store.setThreadStatus(threadId, { type: "idle" });
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
    if (!session) {
      if (!this.options.store.getThread(threadId)) return false;
      await this.removeThreadDurably(threadId);
      await this.removeSessionDirectory(threadId);
      this.emit("change");
      return true;
    }
    this.invalidateSessionOperations(session);
    await this.removeThreadDurably(threadId);
    session.pendingPromptGenerations = [];
    session.unsubscribe?.();
    await session.client.stop().catch(() => undefined);
    this.sessions.delete(threadId);
    await this.removeSessionDirectory(threadId);
    this.emit("change");
    return true;
  }

  private async removeSessionDirectory(threadId: string): Promise<void> {
    await rm(path.join(this.options.sessionRootDir, threadId), { recursive: true, force: true }).catch(() => undefined);
  }

  private async removeThreadDurably(threadId: string): Promise<void> {
    const cwd = this.sessions.get(threadId)?.cwd ?? this.options.store.getThread(threadId)?.cwd ?? "/repos";
    let capabilityRevoked = false;
    try {
      await this.options.onThreadDeleting?.({
        threadId,
        stacks: this.options.store.listStackLeases().filter((lease) => lease.threadId === threadId).map((lease) => ({ id: lease.id, retainsVolumes: Boolean(lease.retainsVolumes), status: lease.status })),
        previews: this.options.store.listPreviewLeases().filter((lease) => lease.threadId === threadId).map((lease) => ({ id: lease.id, stackId: lease.stackId, status: lease.status })),
        services: this.options.store.listServiceLeases().filter((lease) => lease.threadId === threadId).map((lease) => ({ id: lease.id, stackId: lease.stackId, runtimeKind: lease.runtimeKind, status: lease.status }))
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Pi Worker deletion could not be persisted: ${message}`);
    }

    if (this.options.onThreadCapabilityRemoved) {
      try {
        await this.options.onThreadCapabilityRemoved(threadId);
        capabilityRevoked = true;
      } catch (error) {
        const restoreError = await this.restoreThreadCapability(threadId, cwd);
        const message = error instanceof Error ? error.message : String(error);
        const suffix = restoreError ? `; capability restore failed: ${restoreError}` : "";
        throw new Error(`Pi Worker deletion could not be persisted: ${message}${suffix}`);
      }
    }

    try {
      await this.options.store.removeThreadDurably(threadId);
    } catch (error) {
      const restoreError = capabilityRevoked ? await this.restoreThreadCapability(threadId, cwd) : null;
      const message = error instanceof Error ? error.message : String(error);
      const suffix = restoreError ? `; capability restore failed: ${restoreError}` : "";
      throw new Error(`Pi Worker deletion could not be persisted: ${message}${suffix}`);
    }
  }

  private async restoreThreadCapability(threadId: string, cwd: string): Promise<string | null> {
    if (!this.options.onThreadCapabilityReady) return null;
    try {
      await this.options.onThreadCapabilityReady(threadId, cwd);
      return null;
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  }

  private async loadModels(): Promise<void> {
    await syncManorPiModelsJson(this.options.piAuthPath);
    const registry = await createManorModelRegistry(this.options.piAuthPath);
    const auth = await readButlerAuthStatus(this.options.piAuthPath);
    this.availableModels = registry.getAvailable()
      .filter((model) => shouldExposeManorModel(model))
      .filter((model) => auth.mode !== "chatgpt" || isChatGptSubscriptionModelAvailable(model))
      .map(modelToModelOption);
    const selected = this.availableModels.find((model) => model.id === this.selectedModel && model.provider === this.selectedProvider) ?? this.availableModels[0] ?? null;
    this.selectedProvider = selected?.provider ?? null;
    this.selectedModel = selected?.id ?? null;
    this.emit("change");
  }

  private async createSession(threadId: string, cwd: string, provider: string, model: string): Promise<PiWorkerSession> {
    await syncManorPiModelsJson(this.options.piAuthPath);
    const extensionArgs = await this.webToolsExtensionArgs(provider);
    const codexHomeDir = this.options.codexHomeDir ?? process.env.CODEX_HOME ?? null;
    const harnessRegistryPath = process.env.MANOR_HARNESS_REGISTRY_PATH
      ?? (codexHomeDir ? path.join(codexHomeDir, "manor", "harness-capabilities.json") : null);
    const client = new RpcClient({
      cwd,
      cliPath: this.options.cliPath ?? defaultPiCliPath(),
      env: {
        PI_AGENT_DIR: path.dirname(this.options.piAuthPath),
        PI_CODING_AGENT_DIR: path.dirname(this.options.piAuthPath),
        ...(harnessRegistryPath ? { MANOR_HARNESS_REGISTRY_PATH: harnessRegistryPath } : {}),
        MANOR_BUTLER_BASE_URL: this.options.butlerBaseUrl ?? "http://127.0.0.1:8080",
        MANOR_THREAD_ID: threadId
      },
      provider,
      model,
      args: [...extensionArgs, "--session-dir", path.join(this.options.sessionRootDir, threadId)]
    });
    const mapper = new PiProviderRuntimeMapper(threadId);
    try {
      await client.start();
    } catch (error) {
      await client.stop().catch(() => undefined);
      await this.removeSessionDirectory(threadId);
      throw error;
    }
    const session: PiWorkerSession = {
      threadId,
      client,
      mapper,
      unsubscribe: null,
      cwd,
      provider,
      model,
      activityVersion: 0,
      acceptedEventVersion: null,
      eventStreamVersion: null,
      pendingPromptGenerations: []
    };
    const listener: RpcEventListener = (event) => {
      this.handleSessionEvent(session, event);
    };
    session.unsubscribe = client.onEvent(listener);
    this.sessions.set(threadId, session);
    return session;
  }

  private async webToolsExtensionArgs(provider: string | null = this.selectedProvider): Promise<string[]> {
    return webToolsExtensionArgsForProvider(provider);
  }

  private handleSessionEvent(session: PiWorkerSession, event: Parameters<RpcEventListener>[0]): void {
    let eventGeneration = session.eventStreamVersion ?? session.acceptedEventVersion;
    if (event.type === "agent_start") {
      eventGeneration = session.pendingPromptGenerations.shift() ?? session.acceptedEventVersion;
      session.eventStreamVersion = eventGeneration;
    }

    const patches = session.mapper.map(
      event as never,
      { messages: [], getSessionStats: () => ({ contextUsage: null }) } as never
    );
    for (const patch of patches) this.applyPatch(session, eventGeneration, patch);

    if (event.type === "agent_end") {
      if (session.eventStreamVersion === eventGeneration) session.eventStreamVersion = null;
      if (session.acceptedEventVersion === eventGeneration) session.acceptedEventVersion = null;
    }
  }

  private applyPatch(session: PiWorkerSession, operationGeneration: number | null, patch: ProviderRuntimeLivePatch): void {
    if (!this.isSessionEventGenerationCurrent(session, operationGeneration)) {
      return;
    }
    if (patch.kind === "thread-state") {
      this.options.store.setThreadStatus(patch.threadId, { type: patch.state === "idle" ? "idle" : "active" });
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
