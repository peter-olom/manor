import { promises as fs } from "node:fs";
import path from "node:path";

import { ButlerAgentService } from "./butler-agent.js";
import { buildReferencePromptText } from "./reference-inputs.js";
import type { CodexAppServerClient } from "./codex-client.js";
import type { PiRpcWorkerClient } from "./pi-rpc-worker-client.js";
import type { FileReferenceStore } from "./file-store.js";
import type { HostControllerClient } from "./host-controller-client.js";
import type { ImageReferenceStore } from "./image-store.js";
import type { MemoryUpdateScheduler } from "./memory-update-scheduler.js";
import type { PairStore } from "./pair-store.js";
import type { RuntimeBrokerClient } from "./runtime-broker-client.js";
import type { LoadedServiceTemplate, ServiceTemplateRegistry } from "./service-templates.js";
import type { SessionTitleGenerator } from "./session-title-generator.js";
import type { ButlerStateStore } from "./state-store.js";
import type { ButlerMessageView, ButlerLivePatchView, ModelOption } from "./types.js";
import type { PairChat, PairModelOption, PairDetail, PairMessage, PairComposeSettings, PairSummary, PairWorker } from "../shared/pairing.js";
import { DEFAULT_THINKING_LEVELS } from "../shared/pairing.js";
import { pairTitleIsDefault } from "./pair-store.js";
import { getUnifiedWorkerCompose, loadWorkerThread, updateUnifiedWorkerCompose, updateWorkerThreadEffort, type WorkerClientAccess } from "./worker-client-router.js";
import { parseProviderModelRef } from "./model-provider-config.js";
import { workerThreadIsRunning } from "./worker-thread-status.js";

type PairButlerService = Pick<
  ButlerAgentService,
  "answerOperatorQuestion" | "dispose" | "ensureExternalWorkerDelegation" | "getMessagePage" | "getShellSnapshot" | "handoffWorker" | "on" | "prompt" | "refreshModelSettings" | "retryBlockedCallbackReviews" | "setThinkingLevel" | "start" | "stopPrompt" | "updateComposeSettings"
>;

type PairSessionManagerOptions = {
  pairStore: PairStore;
  store: ButlerStateStore;
  codexClient: CodexAppServerClient;
  piRpcWorkerClient?: PiRpcWorkerClient | null;
  hostController: HostControllerClient;
  runtimeBroker: RuntimeBrokerClient;
  serviceTemplateRegistry: ServiceTemplateRegistry;
  imageStore: ImageReferenceStore;
  fileStore: FileReferenceStore;
  piAuthPath: string;
  codexAuthPath: string;
  codexConfigDir: string;
  sessionRootDir: string;
  artifactsDir: string;
  refreshRuntimeInventory?: () => Promise<void>;
  memoryScheduler?: MemoryUpdateScheduler | null;
  onButlerPatch?: (payload: ButlerLivePatchView) => void;
  sessionTitleGenerator?: SessionTitleGenerator | null;
  getCodexAuthStatus?: () => { loggedIn: boolean };
  createButlerService?: (options: ConstructorParameters<typeof ButlerAgentService>[0]) => PairButlerService;
};

function toPairModelOptions(models: ReturnType<CodexAppServerClient["getConnectionState"]>["compose"]["availableModels"]): PairModelOption[] {
  return models
    .filter((model) => model.provider !== "opencode")
    .map((model) => ({
      id: model.id,
      label: model.label,
      provider: model.provider,
      harness: model.harness ?? null,
      supportsReasoning: model.supportsReasoning,
      supportedThinkingLevels: [...model.supportedThinkingLevels],
      supportedReasoningEfforts: [...model.supportedReasoningEfforts],
      defaultReasoningEffort: model.defaultReasoningEffort
    }));
}

function chooseEffortForModel(model: PairModelOption | null, requested: string | null): string | null {
  if (!model) {
    return requested;
  }
  if (requested && model.supportedReasoningEfforts.includes(requested)) {
    return requested;
  }
  return model.defaultReasoningEffort ?? model.supportedReasoningEfforts[0] ?? null;
}

function chooseThinkingLevelForModel(model: PairModelOption | null, requested: string | null): string {
  const levels = model?.supportedThinkingLevels ?? [];
  if (requested && levels.includes(requested)) {
    return requested;
  }
  return model?.defaultReasoningEffort ?? levels[0] ?? "medium";
}

function findWorkerModel(models: ModelOption[], modelId: string, harness?: string | null): ModelOption | null {
  const matches = models.filter((model) => model.id === modelId && (!harness || model.harness === harness));
  return matches.length === 1 ? matches[0]! : null;
}

function pairSystemPrompt(pairId: string): string {
  return [
    "PAIR SUPERVISION CONTEXT",
    `You are Butler supervising exactly one Manor pair: ${pairId}.`,
    "The operator only talks to you. Do not tell the operator to message the worker directly.",
    "Call the execution role Worker. Never describe a generic delegation or job as Codex.",
    "When work should be executed, use delegate_to_worker or message_job. When Worker evidence returns, review it adversarially before replying to the operator.",
    "Keep operator-visible replies concise. Do not mention hidden tool prompts or internal routing."
  ].join("\n");
}

function mapRole(role: string): PairMessage["role"] {
  if (role === "assistant" || role === "butler") return "butler";
  if (role === "user" || role === "user-with-attachments") return "user";
  if (role === "worker") return "worker";
  return "system";
}

export function mapButlerMessage(message: ButlerMessageView): PairMessage {
  return {
    id: message.id,
    role: mapRole(message.role),
    lane: "butler",
    text: message.displayText?.trim() || message.text,
    at: message.at ?? Date.now(),
    sourceThreadId: null,
    memoryObservationId: null,
    metadata: { sourceRole: message.role },
    pending: message.pending,
    ...(message.question ? { question: message.question } : {}),
    ...(message.trace && message.trace.length > 0 ? { trace: message.trace } : {})
  };
}

function blockedCloseoutReason(shell: ReturnType<ButlerAgentService["getShellSnapshot"]>): string | null {
  const callback = shell.supervision.callbacks.find((entry) =>
    entry.owesOperatorReply &&
    entry.callbackState !== "closed" &&
    entry.reviewState === "blocked" &&
    typeof entry.blockedCloseoutReason === "string" &&
    entry.blockedCloseoutReason.trim()
  );
  return callback?.blockedCloseoutReason ? `Closeout blocked: ${callback.blockedCloseoutReason}` : null;
}

function butlerModelMatchesReference(model: ModelOption, reference: string): boolean {
  if (model.id === reference) return true;
  const parsed = parseProviderModelRef(reference);
  const openAiProviders = new Set(["openai", "openai-codex"]);
  const providerMatches = !parsed.provider || !model.provider || parsed.provider === model.provider ||
    (openAiProviders.has(parsed.provider) && openAiProviders.has(model.provider));
  return providerMatches && parsed.model === model.id;
}

function butlerModelAvailabilityError(pair: PairChat, shell: ReturnType<ButlerAgentService["getShellSnapshot"]>): string | null {
  const available = shell.compose?.availableModels ?? [];
  if (available.length === 0) return "No connected Butler model is available. Open Settings → Providers to connect or repair a provider.";
  if (pair.butlerModel && !available.some((model) => butlerModelMatchesReference(model, pair.butlerModel!))) {
    return `The chosen Butler model ${pair.butlerModel} is unavailable. Open Settings → Providers to reconnect it, or choose another Butler model.`;
  }
  return null;
}

function pairNeedsSupervision(pair: PairChat, store: ButlerStateStore): boolean {
  if (!pair.worker) return false;
  const thread = store.getThread(pair.worker.threadId);
  const report = store.getWorkerReport(pair.worker.threadId);
  if (workerThreadIsRunning(thread) || pair.worker.status === "running" || pair.worker.status === "starting") return true;
  if (!report) return true;
  if ((thread?.turns.at(-1)?.startedAt ?? 0) > report.updatedAt) return true;
  return !pair.worker.lastReviewedReportAt || report.updatedAt > pair.worker.lastReviewedReportAt;
}

async function awaitPairShutdown<T>(operation: Promise<T>, label: string, timeoutMs = 10_000): Promise<T> {
  return await new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out.`)), timeoutMs);
    timer.unref?.();
    operation.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); }
    );
  });
}

export class PairSessionManager {
  private readonly services = new Map<string, { service: PairButlerService; started: Promise<void> }>();
  private readonly titleInFlight = new Set<string>();
  private readonly titleAttempted = new Set<string>();
  private readonly handoffTails = new Map<string, Promise<void>>();
  private readonly quiescedPairs = new Set<string>();

  constructor(private readonly options: PairSessionManagerOptions) {}

  private async runSerializedPairHandoff<T>(pairId: string, run: () => Promise<T>): Promise<T> {
    const previous = this.handoffTails.get(pairId) ?? Promise.resolve();
    let release!: () => void;
    const turn = new Promise<void>((resolve) => { release = resolve; });
    const tail = previous.catch(() => undefined).then(() => turn);
    this.handoffTails.set(pairId, tail);
    await previous.catch(() => undefined);
    try {
      return await run();
    } finally {
      release();
      if (this.handoffTails.get(pairId) === tail) this.handoffTails.delete(pairId);
    }
  }

  private getWorkerClientAccess(): WorkerClientAccess {
    return {
      ...this.options,
      getWorkerAffinity: () => this.options.pairStore.getWorkerAffinity(),
      recordSuccessfulWorkerSelection: (selection) => this.options.pairStore.recordSuccessfulWorkerSelection(selection)
    };
  }

  async listSummaries(): Promise<PairSummary[]> {
    this.options.pairStore.syncWorkerReports();
    for (const pairId of this.services.keys()) {
      this.syncPairSnapshot(pairId);
    }
    return this.options.pairStore.listSummaries();
  }

  async startSupervisedSessions(): Promise<void> {
    const supervised = this.options.pairStore.listSummaries().filter((pair) => pairNeedsSupervision(pair, this.options.store));
    await Promise.allSettled(supervised.map((pair) => this.ensureService(pair.id)));
  }

  async createPair(input: { title?: string | null; defaultCwd?: string | null } = {}): Promise<PairDetail> {
    const pair = this.options.pairStore.createPair(input);
    await this.options.pairStore.flushPendingSave();
    await this.ensureService(pair.id);
    return this.getPairDetail(pair.id, null, 120) as Promise<PairDetail>;
  }

  async createWorkerPair(input: {
    title?: string | null;
    defaultCwd?: string | null;
    threadId: string;
    task?: string | null;
    cwd?: string | null;
    handoffPrompt?: string | null;
    runtime?: "openai" | "pi-rpc" | null;
    harness?: string | null;
    provider?: string | null;
    model?: string | null;
    effort?: string | null;
  }): Promise<PairDetail> {
    const pair = this.options.pairStore.createPair({ title: input.title, defaultCwd: input.defaultCwd });
    try {
      this.options.pairStore.attachWorker(pair.id, {
        threadId: input.threadId,
        task: input.task,
        cwd: input.cwd,
        handoffPrompt: input.handoffPrompt,
        runtime: input.runtime,
        harness: input.harness,
        provider: input.provider,
        model: input.model,
        effort: input.effort
      });
      await this.options.pairStore.flushPendingSave();
      const service = await this.ensureService(pair.id);
      await service.ensureExternalWorkerDelegation(input.threadId);
      return this.getPairDetail(pair.id, null, 120) as Promise<PairDetail>;
    } catch (error) {
      try {
        await this.deletePair(pair.id);
      } catch (cleanupError) {
        const failure = new Error(
          `Worker pair setup failed and pair cleanup could not be persisted: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`,
          { cause: error }
        ) as Error & { pairId: string };
        failure.pairId = pair.id;
        throw failure;
      }
      throw error;
    }
  }

  async getPairDetail(pairId: string, before: number | null, limit: number): Promise<PairDetail | null> {
    const pair = this.options.pairStore.getPair(pairId);
    if (!pair) return null;
    const service = await this.ensureService(pairId);
    const latest = service.getMessagePage(null, 1);
    this.syncPairSnapshot(pairId, latest.messages.at(-1) ?? null, latest.totalCount);
    const refreshed = this.options.pairStore.getPair(pairId);
    if (!refreshed) return null;
    const page = service.getMessagePage(before, limit);
    this.maybeGenerateTitleFromPage(refreshed, page.messages);
    return {
      ...refreshed,
      messages: page.messages.map(mapButlerMessage),
      messageCount: page.totalCount,
      loadedStart: page.startIndex,
      hasMore: page.hasMore,
      compose: this.resolveCompose(refreshed, service)
    };
  }

  updatePairTitle(pairId: string, title: string): PairDetail | null {
    const updated = this.options.pairStore.updatePairTitle(pairId, title);
    if (!updated) return null;
    const service = this.services.get(pairId)?.service;
    const page = service?.getMessagePage(null, 120);
    return {
      ...updated,
      messages: page?.messages.map(mapButlerMessage) ?? [],
      messageCount: page?.totalCount ?? updated.messageCount,
      loadedStart: page?.startIndex ?? 0,
      hasMore: page?.hasMore ?? false,
      compose: service
        ? this.resolveCompose(updated, service)
        : {
            butler: { provider: null, model: null, thinkingLevel: "medium", availableModels: [], availableThinkingLevels: [...DEFAULT_THINKING_LEVELS] },
            worker: { runtime: "auto", harness: null, provider: null, model: null, effort: null, availableModels: [], availableEfforts: [] }
          }
    };
  }

  async setButlerThinkingLevel(pairId: string, level: string): Promise<PairDetail | null> {
    const service = this.services.get(pairId)?.service;
    if (!service) return null;
    const shell = service.getShellSnapshot();
    if (shell.pending || shell.isStreaming) throw new Error("Butler is working. Wait for this turn to finish before changing its model or thinking level.");
    const availableLevels = shell.compose?.availableThinkingLevels ?? [];
    if (availableLevels.length > 0 && !availableLevels.includes(level as never)) {
      throw new Error("Selected Butler thinking level is not available for this model");
    }
    service.setThinkingLevel(level as never);
    this.options.pairStore.updatePairComposeOverrides(pairId, { butlerThinkingLevel: level });
    return this.getPairDetail(pairId, null, 120);
  }

  async setButlerModel(pairId: string, modelId: string): Promise<PairDetail | null> {
    const service = this.services.get(pairId)?.service;
    if (!service) return null;
    const shell = service.getShellSnapshot();
    if (shell.pending || shell.isStreaming) throw new Error("Butler is working. Wait for this turn to finish before changing its model or thinking level.");
    const model = (shell.compose?.availableModels ?? []).find((entry) => entry.id === modelId);
    if (!model) {
      throw new Error("Selected Butler model is not available");
    }
    const ref = parseProviderModelRef(model.id);
    const thinkingLevel = shell.compose?.thinkingLevel ?? "medium";
    await service.updateComposeSettings(ref.provider ?? model.provider ?? shell.compose?.provider ?? "", ref.model ?? model.id, thinkingLevel as never);
    const effectiveCompose = service.getShellSnapshot().compose;
    this.options.pairStore.updatePairComposeOverrides(pairId, {
      butlerModel: effectiveCompose?.model ?? modelId,
      butlerThinkingLevel: effectiveCompose?.thinkingLevel ?? thinkingLevel
    });
    return this.getPairDetail(pairId, null, 120);
  }

  async setWorkerEffort(pairId: string, effort: string | null): Promise<PairDetail | null> {
    const pair = this.options.pairStore.getPair(pairId);
    const harness = pair?.worker?.harness ?? pair?.workerHarness ?? null;
    const compose = getUnifiedWorkerCompose(this.getWorkerClientAccess(), pair?.worker?.model ?? pair?.workerModel ?? null, effort, "auto", harness);
    const resolvedEffort = compose.effort;
    if (!pair?.worker) {
      if (resolvedEffort) await updateUnifiedWorkerCompose(this.getWorkerClientAccess(), { harness, model: pair?.workerModel ?? null, effort: resolvedEffort as never, runtime: "auto" });
      this.options.pairStore.updatePairComposeOverrides(pairId, { workerEffort: resolvedEffort });
      return this.getPairDetail(pairId, null, 120);
    }
    if (resolvedEffort) {
      await updateWorkerThreadEffort(this.getWorkerClientAccess(), pair.worker.threadId, resolvedEffort as never);
    }
    this.options.pairStore.updateWorkerEffort(pairId, pair.worker.threadId, resolvedEffort);
    return this.getPairDetail(pairId, null, 120);
  }

  async setWorkerModel(pairId: string, modelId: string, harness?: string | null): Promise<PairDetail | null> {
    const pair = this.options.pairStore.getPair(pairId);
    if (!pair) return null;
    const compose = getUnifiedWorkerCompose(this.getWorkerClientAccess(), modelId, pair.workerEffort ?? null, "auto", harness ?? null);
    const model = findWorkerModel(compose.availableModels, modelId, harness);
    if (!model) {
      throw new Error("Selected worker model is not available");
    }
    const effort = chooseEffortForModel(toPairModelOptions([model])[0] ?? null, pair.workerEffort ?? pair.worker?.requestedReasoningEffort ?? compose.effort ?? null);
    if (!pair.worker) {
      await updateUnifiedWorkerCompose(this.getWorkerClientAccess(), { harness: model.harness ?? null, model: modelId, effort: effort as never, runtime: "auto" });
    }
    this.options.pairStore.updatePairComposeOverrides(pairId, { workerHarness: model.harness ?? null, workerModel: modelId, workerEffort: effort });
    return this.getPairDetail(pairId, null, 120);
  }

  async handoffWorker(pairId: string, modelId: string, harness: string | null, requestedEffort: string | null): Promise<PairDetail | null> {
    return this.runSerializedPairHandoff(pairId, async () => {
      const pair = this.options.pairStore.getPair(pairId);
      if (!pair) return null;
      if (!pair.worker) throw new Error("No active worker is available to hand off");
      if (pair.worker.model === modelId && (!harness || pair.worker.harness === harness)) throw new Error("That worker model is already active. Change Thinking directly.");
      const compose = getUnifiedWorkerCompose(this.getWorkerClientAccess(), modelId, requestedEffort, "auto", harness);
      const model = findWorkerModel(compose.availableModels, modelId, harness);
      if (!model) throw new Error("Selected worker model is not available");
      const effort = chooseEffortForModel(toPairModelOptions([model])[0] ?? null, requestedEffort ?? compose.effort);
      const service = await this.ensureService(pairId);
      await service.handoffWorker({
        sourceThreadId: pair.worker.threadId,
        harness: model.harness ?? compose.harness ?? "codex",
        model: modelId,
        effort: effort as never,
        butlerThreadId: pair.butlerSessionId
      });
      return this.getPairDetail(pairId, null, 120);
    });
  }

  private resolveCompose(pair: PairChat, service: PairButlerService): PairComposeSettings {
    const shell = service.getShellSnapshot();
    const availableThinkingLevels = shell.compose?.availableThinkingLevels?.length
      ? shell.compose.availableThinkingLevels
      : [];
    const butlerModels = toPairModelOptions(shell.compose?.availableModels ?? []);
    const selectedButlerModelId = shell.compose?.model ?? butlerModels[0]?.id ?? null;
    const selectedButlerModel = butlerModels.find((model) => model.id === selectedButlerModelId) ?? butlerModels[0] ?? null;
    const thinkingLevel = chooseThinkingLevelForModel(selectedButlerModel, pair.butlerThinkingLevel ?? shell.compose?.thinkingLevel ?? null);
    const requestedWorkerHarness = pair.worker?.harness ?? pair.workerHarness ?? null;
    const workerCompose = getUnifiedWorkerCompose(this.getWorkerClientAccess(), pair.worker?.model ?? pair.workerModel ?? null, pair.workerEffort ?? null, "auto", requestedWorkerHarness);
    const availableModels = toPairModelOptions(workerCompose.availableModels);
    const selectedModelId = workerCompose.model ?? availableModels[0]?.id ?? null;
    const selectedModel = availableModels.find((model) => model.id === selectedModelId && (!workerCompose.harness || model.harness === workerCompose.harness)) ?? null;
    const workerEffort = pair.worker?.requestedReasoningEffort ?? null;
    const availableEfforts = selectedModel
      ? selectedModel.supportedReasoningEfforts
      : availableModels.flatMap((model) => model.supportedReasoningEfforts);
    const uniqueEfforts = Array.from(new Set(availableEfforts));
    const effort = chooseEffortForModel(selectedModel, pair.workerEffort ?? workerEffort ?? workerCompose.effort ?? null);
    const worker = { runtime: workerCompose.runtime, harness: workerCompose.harness, provider: workerCompose.provider, model: selectedModelId, effort, availableModels, availableEfforts: uniqueEfforts };
    return {
      butler: { provider: shell.compose?.provider ?? null, model: shell.compose?.model ?? butlerModels[0]?.id ?? null, thinkingLevel, availableModels: butlerModels, availableThinkingLevels },
      worker
    };
  }

  async quiescePair(pairId: string): Promise<boolean> {
    const existing = this.options.pairStore.getPair(pairId);
    if (!existing) return false;
    this.quiescedPairs.add(pairId);
    const loaded = this.services.get(pairId);
    try {
      if (loaded) {
        await awaitPairShutdown(loaded.started, "Butler pair startup");
        await awaitPairShutdown(loaded.service.stopPrompt(), "Butler pair shutdown");
        loaded.service.dispose();
        this.services.delete(pairId);
      }
    } catch (error) {
      this.quiescedPairs.delete(pairId);
      throw error;
    }
    return true;
  }

  async resumePair(pairId: string): Promise<boolean> {
    if (!this.options.pairStore.getPair(pairId)) {
      this.quiescedPairs.delete(pairId);
      return false;
    }
    this.quiescedPairs.delete(pairId);
    await this.ensureService(pairId);
    return true;
  }

  async deletePair(pairId: string): Promise<boolean> {
    const existing = this.options.pairStore.getPair(pairId);
    await this.quiescePair(pairId);
    const deleted = this.options.pairStore.deletePair(pairId);
    try {
      await this.options.pairStore.flushPendingSave();
    } catch (error) {
      let restoreError: unknown = null;
      if (existing) {
        this.options.pairStore.restorePairAfterFailedDelete(existing);
        try {
          await this.options.pairStore.flushPendingSave();
        } catch (caught) {
          restoreError = caught;
        }
      }
      this.quiescedPairs.delete(pairId);
      if (existing) {
        try {
          await this.ensureService(pairId);
        } catch (resumeError) {
          throw new Error(
            `Pair deletion could not be persisted and Butler supervision could not be resumed: ${resumeError instanceof Error ? resumeError.message : String(resumeError)}`,
            { cause: error }
          );
        }
      }
      if (restoreError) {
        throw new Error(
          `Pair deletion failed and the durable pair could not be restored: ${restoreError instanceof Error ? restoreError.message : String(restoreError)}`,
          { cause: error }
        );
      }
      throw error;
    }
    this.quiescedPairs.delete(pairId);
    return deleted;
  }

  async stopButler(pairId: string): Promise<boolean> {
    const loaded = this.services.get(pairId);
    if (!loaded) return false;
    await loaded.started;
    await loaded.service.stopPrompt();
    this.syncPairSnapshot(pairId);
    return true;
  }

  async refreshModelSettings(): Promise<void> {
    await Promise.all([...this.services.entries()].map(async ([pairId, loaded]) => {
      await loaded.started;
      await loaded.service.refreshModelSettings();
      this.syncPairSnapshot(pairId);
    }));
  }

  async sendOperatorMessage(input: {
    pairId: string;
    text: string;
    imageReferenceIds: string[];
    fileReferenceIds: string[];
  }): Promise<PairDetail | null> {
    const pair = this.options.pairStore.getPair(input.pairId);
    if (!pair) return null;
    const service = await this.ensureService(input.pairId);
    const selectionError = butlerModelAvailabilityError(pair, service.getShellSnapshot());
    if (selectionError) throw new Error(selectionError);
    const promptText = buildReferencePromptText({
      text: input.text,
      imageStore: this.options.imageStore,
      imageReferenceIds: input.imageReferenceIds,
      fileStore: this.options.fileStore,
      fileReferenceIds: input.fileReferenceIds,
      includeIds: true,
      includeFilePaths: true
    });
    const referenceCount = input.imageReferenceIds.length + input.fileReferenceIds.length;
    const displayText = input.text.trim() || (referenceCount === 1 ? "Attached 1 reference file." : `Attached ${referenceCount} reference files.`);
    const shouldGenerateTitle = this.shouldGenerateTitle(pair, input.text, service);
    service.prompt(promptText, input.imageReferenceIds, { mode: "queue", displayText });
    if (shouldGenerateTitle) {
      this.generateTitleAsync(input.pairId, input.text, pair.defaultCwd);
    }
    this.syncPairSnapshot(input.pairId);
    return this.getPairDetail(input.pairId, null, 120);
  }

  async answerOperatorQuestion(input: {
    pairId: string;
    messageId: string;
    questionId: string;
    optionId?: string;
    freeformText?: string;
  }): Promise<PairDetail | null> {
    if (!this.options.pairStore.getPair(input.pairId)) return null;
    const service = await this.ensureService(input.pairId);
    await service.answerOperatorQuestion({
      messageId: input.messageId,
      questionId: input.questionId,
      optionId: input.optionId,
      freeformText: input.freeformText
    });
    this.syncPairSnapshot(input.pairId);
    return this.getPairDetail(input.pairId, null, 120);
  }

  async getWorkerThread(pairId: string): Promise<unknown | null> {
    const pair = this.options.pairStore.getPair(pairId);
    if (!pair?.worker) return null;
    try {
      await loadWorkerThread(this.getWorkerClientAccess(), pair.worker.threadId);
    } catch {
      // Saved local state is enough for the read-only worker pane.
    }
    return this.options.store.getThreadDetail(pair.worker.threadId) ?? null;
  }

  async retryBlockedReview(pairId: string): Promise<PairDetail | null> {
    const pair = this.options.pairStore.getPair(pairId);
    if (!pair) return null;
    const service = await this.ensureService(pairId);
    if (!service.retryBlockedCallbackReviews(pair.worker?.threadId)) throw new Error("No paused adversarial review is waiting to retry.");
    return this.getPairDetail(pairId, null, 120);
  }

  private async ensureService(pairId: string): Promise<PairButlerService> {
    if (this.quiescedPairs.has(pairId)) throw new Error("Butler session is closing.");
    const existing = this.services.get(pairId);
    if (existing) {
      await existing.started;
      return existing.service;
    }

    const pair = this.options.pairStore.getPair(pairId);
    if (!pair) {
      throw new Error("Butler session not found");
    }
    const sessionDir = path.join(this.options.sessionRootDir, pair.id);
    await fs.mkdir(sessionDir, { recursive: true });
    const createService = this.options.createButlerService ?? ((serviceOptions: ConstructorParameters<typeof ButlerAgentService>[0]) => new ButlerAgentService(serviceOptions));
    const service = createService({
      store: this.options.store,
      codexClient: this.options.codexClient,
      piRpcWorkerClient: this.options.piRpcWorkerClient ?? null,
      hostController: this.options.hostController,
      runtimeBroker: this.options.runtimeBroker,
      serviceTemplateRegistry: this.options.serviceTemplateRegistry,
      imageStore: this.options.imageStore,
      fileStore: this.options.fileStore,
      piAuthPath: this.options.piAuthPath,
      codexAuthPath: this.options.codexAuthPath,
      codexConfigDir: this.options.codexConfigDir,
      sessionDir,
      artifactsDir: this.options.artifactsDir,
      refreshRuntimeInventory: this.options.refreshRuntimeInventory,
      memoryScheduler: this.options.memoryScheduler,
      systemPromptSuffix: pairSystemPrompt(pair.id),
      operatorSink: {
        onDelegationAcknowledgement: ({ threadId, text, runtime, harness, provider, model, effort, replacesThreadId }) => {
          const thread = this.options.store.getThread(threadId);
          const before = this.options.pairStore.getPair(pair.id);
          const previousWorker: PairWorker | null = before?.worker ? {
            ...before.worker,
            handedOffFrom: before.worker.handedOffFrom ? { ...before.worker.handedOffFrom } : null
          } : null;
          const attached = this.options.pairStore.attachWorker(pair.id, {
            threadId,
            task: thread?.executionContract?.requestedTask ?? thread?.supervisor.latestUserPrompt ?? null,
            cwd: thread?.cwd ?? null,
            handoffPrompt: text,
            runtime,
            harness,
            provider,
            model,
            effort,
            replacesThreadId
          });
          if (attached?.worker?.threadId !== threadId) return { attached: false };
          this.syncPairSnapshot(pair.id);
          return {
            attached: true,
            flush: () => this.options.pairStore.flushPendingSave(),
            rollback: () => {
              if (!this.options.pairStore.restoreWorkerIfCurrent(pair.id, threadId, previousWorker)) return false;
              this.syncPairSnapshot(pair.id);
              return true;
            }
          };
        },
        onOperatorReply: () => this.syncPairSnapshot(pair.id)
      },
      getWorkerDefaults: () => {
        const current = this.options.pairStore.getPair(pair.id);
        return {
          runtime: "auto",
          threadId: current?.worker?.threadId ?? null,
          harness: current?.workerHarness ?? current?.worker?.harness ?? null,
          model: current?.workerModel ?? current?.worker?.model ?? null,
          effort: current?.workerEffort ?? null
        };
      },
      getWorkerAffinity: () => this.options.pairStore.getWorkerAffinity(),
      recordSuccessfulWorkerSelection: (selection) => this.options.pairStore.recordSuccessfulWorkerSelection(selection),
      getButlerDefaults: () => {
        const current = this.options.pairStore.getPair(pair.id);
        return {
          model: current?.butlerModel ?? null,
          thinkingLevel: current?.butlerThinkingLevel ?? null
        };
      }
    });
    const started = service.start().then(async () => {
      const currentPair = this.options.pairStore.getPair(pair.id);
      if (currentPair?.worker && pairNeedsSupervision(currentPair, this.options.store)) await service.ensureExternalWorkerDelegation(currentPair.worker.threadId);
      this.syncPairSnapshot(pair.id);
    }).catch((error) => {
      if (this.services.get(pair.id)?.service === service) {
        this.services.delete(pair.id);
        service.dispose();
      }
      this.options.pairStore.updatePairSnapshot(pair.id, {
        butlerReady: false,
        butlerPending: false,
        butlerLastError: error instanceof Error ? error.message : String(error)
      });
      throw error;
    });
    service.on("change", () => this.syncPairSnapshot(pair.id));
    if (this.options.onButlerPatch) {
      service.on("butlerPatch", this.options.onButlerPatch);
    }
    this.services.set(pair.id, { service, started });
    await started;
    return service;
  }

  private shouldGenerateTitle(pair: PairChat, text: string, service: PairButlerService): boolean {
    if (!this.options.sessionTitleGenerator || this.titleInFlight.has(pair.id) || this.titleAttempted.has(pair.id) || !pairTitleIsDefault(pair.title) || !text.trim()) {
      return false;
    }
    const page = service.getMessagePage(null, 120);
    return page.totalCount === 0 && !page.messages.some((message) => message.role === "user" || message.role === "user-with-attachments");
  }

  private maybeGenerateTitleFromPage(pair: PairChat, messages: ButlerMessageView[]): void {
    if (!this.options.sessionTitleGenerator || this.titleInFlight.has(pair.id) || this.titleAttempted.has(pair.id) || !pairTitleIsDefault(pair.title)) {
      return;
    }
    const firstUserMessage = messages.find((message) => (message.role === "user" || message.role === "user-with-attachments") && (message.displayText?.trim() || message.text.trim()));
    const text = firstUserMessage?.displayText?.trim() || firstUserMessage?.text.trim() || "";
    if (text) {
      this.generateTitleAsync(pair.id, text, pair.defaultCwd);
    }
  }

  private generateTitleAsync(pairId: string, firstUserPrompt: string, cwd: string | null): void {
    const generator = this.options.sessionTitleGenerator;
    if (!generator) return;
    this.titleAttempted.add(pairId);
    this.titleInFlight.add(pairId);
    void generator.generateTitle({ firstUserPrompt, cwd })
      .then((title) => {
        if (title) {
          this.options.pairStore.updateDefaultPairTitle(pairId, title);
        }
      })
      .catch((error) => {
        console.warn("Session title generation failed", error instanceof Error ? error.message : String(error));
      })
      .finally(() => {
        this.titleInFlight.delete(pairId);
      });
  }

  private syncPairSnapshot(pairId: string, latest?: ButlerMessageView | null, messageCount?: number): void {
    const service = this.services.get(pairId)?.service;
    if (!service) return;
    const shell = service.getShellSnapshot();
    const pair = this.options.pairStore.getPair(pairId);
    const latestPage = latest === undefined || messageCount === undefined ? service.getMessagePage(null, 1) : null;
    const latestMessage = latest ?? latestPage?.messages.at(-1) ?? null;
    this.options.pairStore.updatePairSnapshot(pairId, {
      butlerSessionId: shell.sessionId,
      butlerReady: shell.ready,
      butlerPending: shell.pending || shell.isStreaming,
      butlerPendingReason: blockedCloseoutReason(shell),
      butlerLastError: (pair ? butlerModelAvailabilityError(pair, shell) : null) ?? shell.lastError,
      messageCount: messageCount ?? latestPage?.totalCount ?? 0,
      lastMessage: latestMessage ? mapButlerMessage(latestMessage) : null,
      updatedAt: latestMessage?.at ?? Date.now()
    });
  }
}
