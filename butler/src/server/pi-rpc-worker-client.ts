import { EventEmitter } from "node:events";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

import { RpcClient, type ModelRegistry, type RpcEventListener } from "@earendil-works/pi-coding-agent";
import type { ImageContent } from "@earendil-works/pi-ai";
import type { AgentMessage } from "@earendil-works/pi-agent-core";

import { createManorModelRegistry, modelToModelOption, shouldExposeManorModel, syncManorPiModelsJson } from "./model-provider-config.js";
import { readButlerAuthStatus } from "./auth-status.js";
import { isChatGptSubscriptionModelAvailable } from "./chatgpt-entitlement.js";
import { getActiveManorSettings } from "./manor-settings-runtime.js";
import { selectProviderWebToolSource } from "./provider-web-tools.js";
import { PiProviderRuntimeMapper } from "./pi-provider-events.js";
import { piThinkingLevelForEffort } from "./pi-thinking-levels.js";
import { StaleWorkerOperationError } from "./stale-worker-operation-error.js";
import { loadPiImageFiles, type PiImageFile } from "./pi-image-loader.js";
import { redactSensitiveText } from "./redact-sensitive-text.js";
import { summarizeUsage, usageSamplesFromPiEntries } from "./model-usage.js";
import type { ButlerStateStore } from "./state-store.js";
import type { CodexInputItem } from "./image-store.js";
import type { CodexThreadPatchView, ModelOption, ReasoningEffort } from "./types.js";
import type { ProviderRuntimeLivePatch } from "../shared/provider-runtime.js";
import type { WorkerSessionControls } from "../shared/worker-session-controls.js";
import type { ExtensionUiBroker } from "./extension-ui-broker.js";
import { contentToText, extractMessageTimestamp } from "./butler-agent-helpers.js";
import { WorkerTransportDeadError, type WorkerThreadRuntimeProbe } from "./worker-thread-runtime-probe.js";

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
  modelContextWindow: number | null;
  activityVersion: number;
  acceptedEventVersion: number | null;
  eventStreamVersion: number | null;
  pendingPromptGenerations: number[];
  operationTurnIds?: string[];
  transportClosed: boolean;
};

type PiWorkerSessionMetadata = {
  threadId: string;
  cwd: string;
  provider: string;
  model: string;
};

const PI_WORKER_METADATA_FILE = "manor-session.json";
const PI_TRANSPORT_CLOSED_EVENT = "manor_transport_closed";

export async function resolvePiWorkerInput(input: string | CodexInputItem[]): Promise<{ text: string; images: ImageContent[] }> {
  if (typeof input === "string") return { text: input.trim(), images: [] };
  const text: string[] = [];
  const imageFiles: PiImageFile[] = [];
  for (const item of input) {
    if (item.type === "text") {
      if (item.text.trim()) text.push(item.text.trim());
    } else if (item.type === "localImage") {
      imageFiles.push({ path: item.path, mimeType: item.mimeType });
    } else if (item.type === "skill") {
      text.push(`Selected skill: ${item.name} (${item.path})`);
    } else if (item.type === "mention") {
      text.push(`Selected app: ${item.name?.trim() || item.path} (${item.path})`);
    }
  }
  const images = await loadPiImageFiles(imageFiles);
  return {
    text: text.join("\n").trim() || (images.length > 0 ? "Use the attached image for this request." : ""),
    images
  };
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
  return path.join(path.dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"))), "cli.js");
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
  private readonly loadingSessions = new Map<string, Promise<void>>();
  private readonly deletingSessions = new Set<string>();
  private readonly startingSessions = new Set<string>();
  private readonly lastRuntimeActivityAt = new Map<string, number>();
  private readonly transportDeadThreadIds = new Set<string>();
  private readonly retryWaits = new Map<string, string>();
  private pendingTransportStateSave: Promise<void> = Promise.resolve();
  private availableModels: ModelOption[] = [];
  private pricingModels: ReturnType<ModelRegistry["getAvailable"]> = [];
  private oauthPricingModels = new Set<string>();
  private selectedProvider: string | null = null;
  private selectedModel: string | null = null;
  private selectedEffort: ReasoningEffort | null = null;
  private lastError: string | null = null;

  constructor(private readonly options: {
    store: ButlerStateStore;
    piAuthPath: string;
    sessionRootDir: string;
    cliPath?: string | null;
    extensionDir?: string | null;
    manageSessionDirectories?: boolean;
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
    extensionUiBroker?: ExtensionUiBroker | null;
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
    return this.sessions.get(session.threadId) === session
      && session.activityVersion === generation
      && !session.transportClosed;
  }

  private isSessionEventGenerationCurrent(session: PiWorkerSession, generation: number | null): boolean {
    return generation !== null
      && this.isSessionGenerationCurrent(session, generation)
      && session.acceptedEventVersion === generation;
  }

  private invalidateSessionGenerationIfCurrent(session: PiWorkerSession, generation: number): void {
    if (this.isSessionGenerationCurrent(session, generation)) this.invalidateSessionOperations(session);
  }

  private staleOperation(threadId: string, dispatchMayHaveBeenAccepted = false, cause?: unknown): StaleWorkerOperationError {
    return new StaleWorkerOperationError(threadId, { cause, dispatchMayHaveBeenAccepted });
  }

  private async rejectStaleStartedSession(session: PiWorkerSession): Promise<never> {
    this.startingSessions.delete(session.threadId);
    let cleanupError: unknown;
    if (this.sessions.get(session.threadId) === session && session.acceptedEventVersion === null) {
      try {
        await this.cleanupStartedSession(session);
      } catch (error) {
        cleanupError = error;
      }
    }
    throw new StaleWorkerOperationError(session.threadId, { cause: cleanupError });
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
    this.startingSessions.delete(session.threadId);
    try {
      await this.cleanupStartedSession(session);
    } catch (cleanupError) {
      const startMessage = startError instanceof Error ? startError.message : String(startError);
      const cleanupMessage = cleanupError instanceof Error ? cleanupError.message : String(cleanupError);
      throw new AggregateError([startError, cleanupError], `Pi Worker start failed: ${startMessage}; cleanup failed: ${cleanupMessage}`);
    }
    throw startError;
  }

  private async promptSession(session: PiWorkerSession, generation: number, text: string, images: ImageContent[] = [], streamingBehavior?: "steer"): Promise<void> {
    session.pendingPromptGenerations.push(generation);
    try {
      const rpcImages = images.length > 0 ? images : undefined;
      const atomicSend = (session.client as unknown as { send?: (command: Record<string, unknown>) => Promise<unknown> }).send;
      if (streamingBehavior && typeof atomicSend === "function") {
        await atomicSend.call(session.client, { type: "prompt", message: text, images: rpcImages, streamingBehavior });
      } else if (streamingBehavior && session.client instanceof RpcClient) {
        throw new Error("Installed Pi RPC client does not support atomic prompt dispatch.");
      } else {
        await session.client.prompt(text, rpcImages);
      }
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

  getLastRuntimeActivityAt(threadId: string): number | null {
    return this.lastRuntimeActivityAt.get(threadId) ?? null;
  }

  isThreadTransportDead(threadId: string): boolean {
    const session = this.sessions.get(threadId);
    return session ? this.sessionTransportIsDead(session) : this.transportDeadThreadIds.has(threadId);
  }

  invalidateThreadOperations(threadId: string): void {
    const session = this.sessions.get(threadId);
    if (session) this.invalidateSessionOperations(session);
  }

  private sessionTransportIsDead(session: PiWorkerSession): boolean {
    if (session.transportClosed) return true;
    const processHandle = (session.client as unknown as {
      process?: { exitCode?: number | null; signalCode?: string | null; stdin?: { destroyed?: boolean; writable?: boolean } };
    }).process;
    return Boolean(processHandle && (
      processHandle.exitCode !== null && processHandle.exitCode !== undefined
      || processHandle.signalCode !== null && processHandle.signalCode !== undefined
      || processHandle.stdin?.destroyed === true
      || processHandle.stdin?.writable === false
    ));
  }

  async probeThread(threadId: string): Promise<WorkerThreadRuntimeProbe> {
    let session: PiWorkerSession;
    try {
      session = await this.requireSession(threadId);
    } catch (error) {
      if (this.transportDeadThreadIds.has(threadId)) {
        throw new WorkerTransportDeadError(error instanceof Error ? error.message : "Worker Pi transport is closed");
      }
      throw error;
    }
    if (session.transportClosed) throw new WorkerTransportDeadError("Worker Pi transport is closed");
    let state: Awaited<ReturnType<RpcClient["getState"]>>;
    try {
      state = await session.client.getState();
    } catch (error) {
      if (this.sessionTransportIsDead(session)) {
        this.transportDeadThreadIds.add(threadId);
        this.handleSessionTransportClosed(session, error instanceof Error ? error.message : "Worker Pi process exited");
        throw new WorkerTransportDeadError(error instanceof Error ? error.message : "Worker Pi process exited");
      }
      throw error;
    }
    const pendingMessageCount = Number.isFinite(state.pendingMessageCount)
      ? Math.max(0, Math.trunc(state.pendingMessageCount))
      : 0;
    const compacting = state.isCompacting === true;
    const pendingDialog = this.options.extensionUiBroker?.view([{ scope: threadId, lane: "worker" }]).dialog;
    const retryWait = this.retryWaits.get(threadId) ?? null;
    const busy = state.isStreaming === true || compacting || pendingMessageCount > 0 || Boolean(pendingDialog) || Boolean(retryWait);
    const acknowledgedWait = pendingDialog
      ? "Worker is waiting for extension UI input."
      : retryWait
        ?? (compacting
          ? "Worker is compacting context."
          : pendingMessageCount > 0
            ? `Worker has ${pendingMessageCount} queued message${pendingMessageCount === 1 ? "" : "s"}.`
            : null);
    return {
      state: busy ? "busy" : "idle",
      busy,
      compacting,
      pendingMessageCount,
      activityAt: this.getLastRuntimeActivityAt(threadId),
      acknowledgedWait,
      confirmedDead: false
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
    if (!this.sessions.has(threadId)) await this.loadThread(threadId);
    const session = this.sessions.get(threadId);
    if (!session) throw new Error("Pi RPC worker thread is not loaded");
    await session.client.setThinkingLevel(piThinkingLevelForEffort(effort) as never);
    this.options.store.setThreadRequestedReasoningEffort(threadId, effort);
  }

  private async requireSession(threadId: string): Promise<PiWorkerSession> {
    if (!this.sessions.has(threadId)) await this.loadThread(threadId);
    const session = this.sessions.get(threadId);
    if (!session) throw new Error("Pi RPC worker thread is not loaded");
    return session;
  }

  private async replaceStoredTranscriptFromPi(session: PiWorkerSession): Promise<void> {
    const messages = await session.client.getMessages();
    const turns = messages.flatMap((message: AgentMessage, index) => {
      const record = message as unknown as Record<string, unknown>;
      if (record.role !== "assistant") return [];
      const text = contentToText(record.content).trim();
      if (!text) return [];
      const at = extractMessageTimestamp(record) ?? Date.now() + index;
      const failed = record.stopReason === "error";
      const interrupted = record.stopReason === "aborted";
      return [{
        id: `pi-history-${index}-${at}`,
        status: failed ? "failed" : interrupted ? "interrupted" : "completed",
        error: failed && typeof record.errorMessage === "string" ? redactSensitiveText(record.errorMessage) : null,
        startedAt: at,
        completedAt: at,
        items: [{ id: `pi-history-message-${index}-${at}`, type: "agentMessage", status: failed ? "failed" : "completed", text, at, raw: {} }]
      }];
    });
    this.options.store.replaceThreadTurns(session.threadId, turns);
    session.mapper = new PiProviderRuntimeMapper(session.threadId);
    await this.options.store.flushSave();
  }

  async getSessionControls(threadId: string): Promise<WorkerSessionControls> {
    const session = await this.requireSession(threadId);
    const [state, stats, forkPoints, tree, entries] = await Promise.all([
      session.client.getState(),
      session.client.getSessionStats(),
      session.client.getForkMessages(),
      session.client.getTree(),
      session.client.getEntries()
    ]);
    const contextUsage = stats.contextUsage;
    const usage = summarizeUsage(usageSamplesFromPiEntries(
      entries.entries,
      session.threadId,
      this.pricingModels,
      (model) => this.oauthPricingModels.has(`${model.provider}/${model.id}`)
    ));
    return {
      supported: true,
      runtime: "pi",
      busy: state.isStreaming,
      compacting: state.isCompacting,
      autoCompactionEnabled: state.autoCompactionEnabled,
      pendingMessageCount: state.pendingMessageCount,
      sessionName: state.sessionName?.trim() || null,
      stats: {
        userMessages: stats.userMessages,
        assistantMessages: stats.assistantMessages,
        toolCalls: stats.toolCalls,
        totalMessages: stats.totalMessages,
        tokens: { ...stats.tokens },
        cost: usage.cost.total,
        usage,
        contextUsage: contextUsage ? { ...contextUsage } : null
      },
      forkPoints: forkPoints.map((point) => ({ entryId: point.entryId, text: point.text })),
      leafId: tree.leafId
    };
  }

  async compactThread(threadId: string, customInstructions?: string): Promise<void> {
    const session = await this.requireSession(threadId);
    const state = await session.client.getState();
    if (state.isStreaming || state.isCompacting) throw new Error("Wait for the current Worker operation to finish before compacting.");
    await session.client.compact(customInstructions?.trim() || undefined);
  }

  async abortThreadRetry(threadId: string): Promise<void> {
    const session = await this.requireSession(threadId);
    await session.client.abortRetry();
  }

  async exportThreadHtml(threadId: string): Promise<string> {
    const session = await this.requireSession(threadId);
    const exportPath = path.join(this.options.sessionRootDir, threadId, `export-${Date.now()}-${crypto.randomUUID()}.html`);
    const result = await session.client.exportHtml(exportPath);
    const resolved = path.resolve(result.path);
    const allowedRoot = path.resolve(this.options.sessionRootDir, threadId);
    if (resolved !== allowedRoot && !resolved.startsWith(`${allowedRoot}${path.sep}`)) {
      throw new Error("Pi returned an export outside the Worker session directory.");
    }
    return resolved;
  }

  async forkThread(threadId: string, entryId: string): Promise<{ cancelled: boolean }> {
    const session = await this.requireSession(threadId);
    const state = await session.client.getState();
    if (state.isStreaming || state.isCompacting) throw new Error("Wait for the current Worker operation to finish before branching.");
    const result = await session.client.fork(entryId);
    if (!result.cancelled) {
      await this.replaceStoredTranscriptFromPi(session);
      this.options.store.addEvent(threadId, "runtime.session_forked", `Forked the Pi session from ${entryId}.`);
    }
    return { cancelled: result.cancelled };
  }

  async cloneThread(threadId: string): Promise<{ cancelled: boolean }> {
    const session = await this.requireSession(threadId);
    const state = await session.client.getState();
    if (state.isStreaming || state.isCompacting) throw new Error("Wait for the current Worker operation to finish before cloning.");
    const result = await session.client.clone();
    if (!result.cancelled) {
      await this.replaceStoredTranscriptFromPi(session);
      this.options.store.addEvent(threadId, "runtime.session_cloned", "Cloned the active Pi session branch.");
    }
    return result;
  }

  async renameThreadSession(threadId: string, name: string): Promise<void> {
    const session = await this.requireSession(threadId);
    const trimmed = name.trim();
    if (!trimmed) throw new Error("Session name is required.");
    await session.client.setSessionName(trimmed.slice(0, 120));
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
    this.startingSessions.add(threadId);
    let session: PiWorkerSession;
    try {
      session = await this.createSession(threadId, cwd, selected.provider, selected.id);
    } catch (error) {
      this.startingSessions.delete(threadId);
      throw error;
    }
    this.options.store.upsertThreadSummary({
      id: threadId,
      name: task.slice(0, 120),
      cwd,
      source: "pi-rpc",
      modelProvider: selected.provider,
      modelId: selected.id,
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
    let resolvedInput: { text: string; images: ImageContent[] };
    try {
      const inputItems = typeof options.input === "function" ? await options.input(threadId) : (options.input ?? [{ type: "text", text: task } as CodexInputItem]);
      resolvedInput = await resolvePiWorkerInput(inputItems);
    } catch (error) {
      if (!this.isSessionGenerationCurrent(session, preflightGeneration)) return this.rejectStaleStartedSession(session);
      return this.rejectFailedStartedSession(session, error);
    }
    if (!this.isSessionGenerationCurrent(session, preflightGeneration)) return this.rejectStaleStartedSession(session);
    const prompt = [options.developerInstructions?.trim() ? `Developer instructions:\n${options.developerInstructions.trim()}` : null, resolvedInput.text].filter(Boolean).join("\n\n");
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
      await this.promptSession(session, operationGeneration, prompt, resolvedInput.images);
    } catch (error) {
      if (!this.isSessionGenerationCurrent(session, operationGeneration)) return this.rejectStaleStartedSession(session);
      this.invalidateSessionGenerationIfCurrent(session, operationGeneration);
      return this.rejectFailedStartedSession(session, error);
    }
    if (!this.isSessionGenerationCurrent(session, operationGeneration)) return this.rejectStaleStartedSession(session);
    this.startingSessions.delete(threadId);
    this.emit("change");
    return { threadId, turnId: null };
  }

  async sendMessage(threadId: string, input: string | CodexInputItem[]): Promise<{ threadId: string; turnId: string | null }> {
    if (!this.sessions.has(threadId)) await this.loadThread(threadId);
    let session = this.sessions.get(threadId);
    if (!session) throw new Error("Pi RPC worker thread is not loaded");
    let preflightGeneration = session.activityVersion;
    const resolvedInput = await resolvePiWorkerInput(input);
    if (!this.isSessionGenerationCurrent(session, preflightGeneration)) throw this.staleOperation(threadId);
    if (this.sessionModelContextChanged(session)) {
      const state = await session.client.getState().catch(() => null);
      if (!this.isSessionGenerationCurrent(session, preflightGeneration)) throw this.staleOperation(threadId);
      if (state && !state.isStreaming && !state.isCompacting) {
        session = await this.restartSessionForModelContext(session);
        preflightGeneration = session.activityVersion;
      }
    }
    const operationGeneration = this.beginSessionOperation(session);
    try {
      await this.promptSession(session, operationGeneration, resolvedInput.text, resolvedInput.images, "steer");
    } catch (error) {
      if (!this.isSessionGenerationCurrent(session, operationGeneration)) throw this.staleOperation(threadId, true, error);
      this.invalidateSessionGenerationIfCurrent(session, operationGeneration);
      throw error;
    }
    if (!this.isSessionGenerationCurrent(session, operationGeneration)) throw this.staleOperation(threadId, true);
    session.acceptedEventVersion = operationGeneration;
    session.eventStreamVersion = operationGeneration;
    return { threadId, turnId: null };
  }

  getThreadModelOption(threadId: string): ModelOption | null {
    const session = this.sessions.get(threadId);
    if (!session) {
      const thread = this.options.store.getThread(threadId);
      return this.availableModels.find((entry) => entry.id === (thread?.modelId ?? this.selectedModel) && entry.provider === (thread?.modelProvider ?? this.selectedProvider)) ?? null;
    }
    return this.availableModels.find((entry) => entry.id === session.model && entry.provider === session.provider) ?? null;
  }

  async stopThread(threadId: string): Promise<boolean> {
    const session = this.sessions.get(threadId);
    if (!session) return false;
    const previousActivityVersion = session.activityVersion;
    const previousAcceptedEventVersion = session.acceptedEventVersion;
    const activityVersion = this.invalidateSessionOperations(session);
    try {
      await session.client.abort();
    } catch (error) {
      if (this.isSessionGenerationCurrent(session, activityVersion)) {
        session.activityVersion = previousActivityVersion;
        session.acceptedEventVersion = previousAcceptedEventVersion;
      }
      throw error;
    }
    this.retryWaits.delete(threadId);
    session.pendingPromptGenerations = session.pendingPromptGenerations.filter((generation) => generation > activityVersion);
    if (!this.isSessionGenerationCurrent(session, activityVersion)) return true;
    session.eventStreamVersion = null;
    const latestTurn = this.options.store.getThread(threadId)?.turns.at(-1);
    if (latestTurn && ["inProgress", "in_progress", "started"].includes(latestTurn.status)) {
      this.options.store.updateTurn(threadId, {
        id: latestTurn.id,
        status: "interrupted",
        error: "Worker turn stopped by operator."
      });
    }
    this.options.store.setThreadStatus(threadId, { type: "idle" });
    await this.options.store.flushSave();
    this.emit("change");
    return true;
  }

  async loadThread(threadId: string): Promise<void> {
    await this.pendingTransportStateSave;
    if (this.sessions.has(threadId)) return;
    if (this.deletingSessions.has(threadId)) throw new Error(`Pi RPC worker job ${threadId} is being deleted`);
    const existingLoad = this.loadingSessions.get(threadId);
    if (existingLoad) return existingLoad;
    const loading = this.resumeThread(threadId).finally(() => this.loadingSessions.delete(threadId));
    this.loadingSessions.set(threadId, loading);
    return loading;
  }

  private async resumeThread(threadId: string): Promise<void> {
    const thread = this.options.store.getThread(threadId);
    if (!thread || thread.source !== "pi-rpc") throw new Error(`Pi RPC worker job ${threadId} was not found`);
    const metadata = await this.readSessionMetadata(threadId, thread.cwd ?? "/repos", thread.modelProvider);
    const session = await this.createSession(threadId, metadata.cwd, metadata.provider, metadata.model, metadata.sessionPath);
    if (this.deletingSessions.has(threadId)) {
      session.unsubscribe?.();
      this.sessions.delete(threadId);
      await session.client.stop().catch(() => undefined);
      throw new Error(`Pi RPC worker job ${threadId} was deleted while it was resuming`);
    }
    const state = await session.client.getState().catch(() => null);
    const lastTurn = thread.turns.at(-1);
    let changed = false;
    if (lastTurn?.status === "in_progress") {
      this.options.store.updateTurn(threadId, {
        id: lastTurn.id,
        status: "interrupted",
        error: "Worker process restarted before this turn completed."
      });
      changed = true;
    }
    const nextStatus = state?.isStreaming ? "active" : "idle";
    if (thread.status !== nextStatus) {
      this.options.store.setThreadStatus(threadId, { type: nextStatus });
      changed = true;
    }
    if (changed) {
      this.pendingTransportStateSave = this.pendingTransportStateSave
        .then(() => this.options.store.flushSave())
        .catch((error) => console.error("Pi Worker resumed state save failed", error));
    }
    this.emit("change");
  }

  private async readSessionMetadata(threadId: string, fallbackCwd: string, fallbackProvider: string | null): Promise<PiWorkerSessionMetadata & { sessionPath: string }> {
    const sessionDir = path.join(this.options.sessionRootDir, threadId);
    const metadataPath = path.join(sessionDir, PI_WORKER_METADATA_FILE);
    try {
      const metadata = JSON.parse(await readFile(metadataPath, "utf8")) as Partial<PiWorkerSessionMetadata>;
      if (metadata.threadId === threadId && metadata.cwd && metadata.provider && metadata.model) {
        const sessionPath = await this.latestSessionPath(sessionDir);
        return { threadId, cwd: metadata.cwd, provider: metadata.provider, model: metadata.model, sessionPath };
      }
    } catch {
      // Older sessions predate Manor's sidecar metadata. Recover their identity from Pi's JSONL.
    }

    const sessionPath = await this.latestSessionPath(sessionDir);
    const entries = (await readFile(sessionPath, "utf8")).trim().split(/\r?\n/).reverse();
    let provider = fallbackProvider;
    let model: string | null = null;
    let cwd = fallbackCwd;
    for (const line of entries) {
      try {
        const entry = JSON.parse(line) as Record<string, unknown>;
        if (entry.type === "session" && typeof entry.cwd === "string" && entry.cwd.trim()) cwd = entry.cwd;
        if (entry.type === "model_change") {
          provider = typeof entry.provider === "string" ? entry.provider : provider;
          model = typeof entry.modelId === "string" ? entry.modelId : model;
        }
        const message = entry.message && typeof entry.message === "object" ? entry.message as Record<string, unknown> : null;
        provider = typeof message?.provider === "string" ? message.provider : provider;
        model = typeof message?.model === "string" ? message.model : model;
      } catch {
        // Ignore a partial final line left by an interrupted process.
      }
      if (provider && model) break;
    }
    if (!provider || !model) throw new Error(`Persisted Pi RPC worker job ${threadId} is missing its provider or model identity`);
    return { threadId, cwd, provider, model, sessionPath };
  }

  private async latestSessionPath(sessionDir: string): Promise<string> {
    const files = (await readdir(sessionDir)).filter((name) => name.endsWith(".jsonl")).sort();
    const latest = files.at(-1);
    if (!latest) throw new Error("Persisted Pi RPC worker session was not found");
    return path.join(sessionDir, latest);
  }

  async deleteThread(threadId: string): Promise<boolean> {
    if (this.deletingSessions.has(threadId)) return false;
    this.deletingSessions.add(threadId);
    try {
      await this.loadingSessions.get(threadId)?.catch(() => undefined);
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
    } finally {
      this.deletingSessions.delete(threadId);
    }
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
      this.lastRuntimeActivityAt.delete(threadId);
      this.transportDeadThreadIds.delete(threadId);
      this.retryWaits.delete(threadId);
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
    this.pricingModels = registry.getAvailable();
    this.oauthPricingModels = new Set(this.pricingModels
      .filter((model) => registry.isUsingOAuth(model))
      .map((model) => `${model.provider}/${model.id}`));
    this.availableModels = this.pricingModels
      .filter((model) => shouldExposeManorModel(model))
      .filter((model) => auth.mode !== "chatgpt" || isChatGptSubscriptionModelAvailable(model))
      .map(modelToModelOption);
    const selected = this.availableModels.find((model) => model.id === this.selectedModel && model.provider === this.selectedProvider) ?? this.availableModels[0] ?? null;
    this.selectedProvider = selected?.provider ?? null;
    this.selectedModel = selected?.id ?? null;
    this.emit("change");
  }

  private modelContextWindow(provider: string, modelId: string): number | null {
    const model = this.pricingModels.find((entry) => entry.provider === provider && entry.id === modelId);
    return typeof model?.contextWindow === "number" && Number.isFinite(model.contextWindow) ? model.contextWindow : null;
  }

  private sessionModelContextChanged(session: PiWorkerSession): boolean {
    const current = this.modelContextWindow(session.provider, session.model);
    return current !== null && session.modelContextWindow !== current;
  }

  private async restartSessionForModelContext(session: PiWorkerSession): Promise<PiWorkerSession> {
    const threadId = session.threadId;
    this.invalidateSessionOperations(session);
    session.unsubscribe?.();
    this.sessions.delete(threadId);
    await session.client.stop();
    await this.resumeThread(threadId);
    const resumed = this.sessions.get(threadId);
    if (!resumed) throw new Error("Pi RPC worker thread could not be refreshed after its model context changed");
    return resumed;
  }

  private async createSession(threadId: string, cwd: string, provider: string, model: string, sessionPath?: string): Promise<PiWorkerSession> {
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
      args: [
        ...extensionArgs,
        "--session-dir", path.join(this.options.sessionRootDir, threadId),
        ...(sessionPath ? ["--session", sessionPath] : [])
      ]
    });
    const mapper = new PiProviderRuntimeMapper(threadId);
    try {
      if (this.options.manageSessionDirectories !== false) {
        await mkdir(path.join(this.options.sessionRootDir, threadId), { recursive: true });
      }
      await client.start();
      this.lastError = null;
      await writeFile(path.join(this.options.sessionRootDir, threadId, PI_WORKER_METADATA_FILE), JSON.stringify({
        threadId,
        cwd,
        provider,
        model
      } satisfies PiWorkerSessionMetadata, null, 2), "utf8");
    } catch (error) {
      await client.stop().catch(() => undefined);
      if (!sessionPath) await this.removeSessionDirectory(threadId);
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
      modelContextWindow: this.modelContextWindow(provider, model),
      activityVersion: 0,
      acceptedEventVersion: null,
      eventStreamVersion: null,
      pendingPromptGenerations: [],
      operationTurnIds: [],
      transportClosed: false
    };
    const listener: RpcEventListener = (event) => {
      this.handleSessionEvent(session, event);
    };
    session.unsubscribe = client.onEvent(listener);
    this.sessions.set(threadId, session);
    this.transportDeadThreadIds.delete(threadId);
    this.retryWaits.delete(threadId);
    return session;
  }

  private async webToolsExtensionArgs(provider: string | null = this.selectedProvider): Promise<string[]> {
    const args = await webToolsExtensionArgsForProvider(provider);
    if (!this.options.extensionDir) return args;
    return args.map((arg, index) => args[index - 1] === "--extension"
      ? path.join(this.options.extensionDir!, `${path.basename(arg, path.extname(arg))}.js`)
      : arg);
  }

  private handleSessionEvent(session: PiWorkerSession, event: Parameters<RpcEventListener>[0]): void {
    const sessionIsCurrent = this.sessions.get(session.threadId) === session;
    const rpcEvent = event as unknown as Record<string, unknown>;
    if (rpcEvent.type === "extension_ui_request" && typeof rpcEvent.id === "string" && typeof rpcEvent.method === "string") {
      if (sessionIsCurrent && !session.transportClosed) this.lastRuntimeActivityAt.set(session.threadId, Date.now());
      this.options.extensionUiBroker?.acceptRpcRequest(
        session.threadId,
        "worker",
        rpcEvent as never,
        (response) => this.writeExtensionUiResponse(session, response)
      );
      return;
    }
    if ((event as { type?: string }).type === PI_TRANSPORT_CLOSED_EVENT) {
      const reason = (event as unknown as { reason?: unknown }).reason;
      this.handleSessionTransportClosed(session, typeof reason === "string" ? reason : "Worker Pi transport closed.");
      return;
    }
    const previousEventGeneration = session.eventStreamVersion;
    let eventGeneration = previousEventGeneration ?? session.acceptedEventVersion;
    if (event.type === "agent_start") {
      eventGeneration = session.pendingPromptGenerations.shift() ?? session.acceptedEventVersion;
      session.eventStreamVersion = eventGeneration;
      if (eventGeneration !== previousEventGeneration) session.operationTurnIds = [];
    }
    const currentEvent = this.isSessionEventGenerationCurrent(session, eventGeneration);
    if (currentEvent) this.lastRuntimeActivityAt.set(session.threadId, Date.now());
    if (currentEvent && rpcEvent.type === "auto_retry_start") {
      const attempt = typeof rpcEvent.attempt === "number" ? rpcEvent.attempt : null;
      this.retryWaits.set(session.threadId, attempt ? `Worker is waiting for retry attempt ${attempt}.` : "Worker is waiting to retry.");
    } else if (currentEvent && ["auto_retry_end", "agent_start", "agent_settled"].includes(String(rpcEvent.type))) {
      this.retryWaits.delete(session.threadId);
    }

    const patches = session.mapper.map(
      event as never,
      { messages: [], getSessionStats: () => ({ contextUsage: null }) } as never
    );
    for (const patch of patches) {
      if (event.type === "agent_end" && patch.kind === "thread-state" && patch.state === "idle") continue;
      if (patch.kind === "turn-lifecycle" && this.isSessionEventGenerationCurrent(session, eventGeneration)) {
        session.operationTurnIds ??= [];
        if (!session.operationTurnIds.includes(patch.turnId)) session.operationTurnIds.push(patch.turnId);
      }
      this.applyPatch(session, eventGeneration, patch);
    }

    if (event.type === "agent_settled") {
      if (!this.isSessionEventGenerationCurrent(session, eventGeneration)) return;
      const settledAt = Date.now();
      const thread = this.options.store.getThread(session.threadId);
      const operationTurns = new Set(session.operationTurnIds ?? []);
      const activeTurns = thread?.turns.filter((turn) => ["started", "inProgress", "in_progress"].includes(turn.status)) ?? [];
      const lastOperationTurn = [...(thread?.turns ?? [])].reverse().find((turn) => operationTurns.has(turn.id));
      const turnsToSettle = new Map(activeTurns.map((turn) => [turn.id, turn]));
      if (lastOperationTurn?.status === "completed") turnsToSettle.set(lastOperationTurn.id, lastOperationTurn);
      for (const turn of turnsToSettle.values()) {
        const completedReply = turn.items.some((item) =>
          item.type === "agentMessage" && item.status === "completed" && item.text.trim()
        );
        const status = completedReply ? "completed" : "interrupted";
        this.applyPatch(session, eventGeneration, {
          kind: "turn-lifecycle", threadId: session.threadId, turnId: turn.id, status, at: settledAt
        });
        if (!completedReply) {
          const message = "Worker stopped without a completed assistant response.";
          this.options.store.updateTurn(session.threadId, { id: turn.id, status, error: message });
          this.options.store.addEvent(session.threadId, "runtime.error", message);
          this.emit("threadPatch", {
            kind: "runtime-message",
            threadId: session.threadId,
            turnId: turn.id,
            tone: "error",
            message,
            at: settledAt
          } satisfies CodexThreadPatchView);
        }
      }
      this.applyPatch(session, eventGeneration, {
        kind: "thread-state",
        threadId: session.threadId,
        state: "idle",
        at: settledAt
      });
      if (session.eventStreamVersion === eventGeneration) session.eventStreamVersion = null;
      if (session.acceptedEventVersion === eventGeneration) session.acceptedEventVersion = null;
      session.operationTurnIds = [];
      this.pendingTransportStateSave = this.pendingTransportStateSave
        .then(() => this.options.store.flushSave())
        .catch((error) => console.error("Pi Worker settled state save failed", error));
    }
  }

  private writeExtensionUiResponse(session: PiWorkerSession, response: Record<string, unknown>): void {
    const processHandle = (session.client as unknown as { process?: { stdin?: { destroyed?: boolean; writable?: boolean; write(value: string): boolean } } }).process;
    const stdin = processHandle?.stdin;
    if (!stdin || stdin.destroyed || stdin.writable === false) {
      this.handleSessionTransportClosed(session, "Worker Pi extension response transport is unavailable.");
      return;
    }
    try {
      stdin.write(`${JSON.stringify(response)}\n`);
    } catch (error) {
      this.handleSessionTransportClosed(session, error instanceof Error ? error.message : String(error));
    }
  }

  private handleSessionTransportClosed(session: PiWorkerSession, reason: string): void {
    if (this.sessions.get(session.threadId) !== session) return;
    const isStarting = this.startingSessions.has(session.threadId);
    session.transportClosed = true;
    this.transportDeadThreadIds.add(session.threadId);
    this.retryWaits.delete(session.threadId);
    this.invalidateSessionOperations(session);
    session.pendingPromptGenerations = [];
    session.eventStreamVersion = null;
    const detail = redactSensitiveText(reason || "Worker Pi transport closed.").slice(0, 3000);
    this.lastError = detail;
    if (isStarting) {
      this.emit("change");
      return;
    }
    session.unsubscribe?.();
    this.sessions.delete(session.threadId);
    const latestTurn = this.options.store.getThread(session.threadId)?.turns.at(-1);
    if (latestTurn && ["inProgress", "in_progress", "started"].includes(latestTurn.status)) {
      this.options.store.updateTurn(session.threadId, {
        id: latestTurn.id,
        status: "interrupted",
        error: detail
      });
      this.options.store.addEvent(session.threadId, "runtime.error", detail);
      this.emit("threadPatch", {
        kind: "runtime-message",
        threadId: session.threadId,
        turnId: latestTurn.id,
        tone: "error",
        message: detail,
        at: Date.now()
      } satisfies CodexThreadPatchView);
      this.emit("threadPatch", {
        kind: "turn-lifecycle",
        threadId: session.threadId,
        turnId: latestTurn.id,
        status: "interrupted",
        at: Date.now()
      } satisfies CodexThreadPatchView);
    }
    this.options.store.setThreadStatus(session.threadId, { type: "idle" });
    this.pendingTransportStateSave = this.pendingTransportStateSave
      .then(() => this.options.store.flushSave())
      .catch((error) => console.error("Pi Worker transport state save failed", error));
    this.emit("change");
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
      const persistedStatus = patch.status === "in_progress" ? "started" : patch.status;
      this.options.store.updateItem(patch.threadId, patch.turnId, {
        id: patch.itemId,
        type: storeItemType(patch),
        status: persistedStatus,
        text: patch.text,
        command: patch.text
      }, persistedStatus);
    } else if (patch.kind === "content-delta") {
      this.options.store.appendItemDelta(patch.threadId, patch.turnId, patch.itemId, patch.delta, storeItemType(patch), { emitChange: false });
    } else if (patch.kind === "runtime-message") {
      const message = redactSensitiveText(patch.message);
      this.options.store.addEvent(patch.threadId, patch.tone === "error" ? "runtime.error" : "runtime.warning", message);
      this.emit("threadPatch", { ...patch, message } satisfies CodexThreadPatchView);
      this.emit("change");
      return;
    }
    this.emit("threadPatch", patch satisfies CodexThreadPatchView);
    this.emit("change");
  }
}
