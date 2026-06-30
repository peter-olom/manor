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
import type { ButlerRoutingClassifier } from "./butler-routing-classifier.js";
import type { RuntimeBrokerClient } from "./runtime-broker-client.js";
import type { LoadedServiceTemplate, ServiceTemplateRegistry } from "./service-templates.js";
import type { SessionTitleGenerator } from "./session-title-generator.js";
import type { ButlerStateStore } from "./state-store.js";
import type { ButlerMessageView, ButlerLivePatchView } from "./types.js";
import type { PairChat, PairCodexModelOption, PairDetail, PairMessage, PairComposeSettings, PairSummary } from "../shared/pairing.js";
import { DEFAULT_THINKING_LEVELS } from "../shared/pairing.js";
import { pairTitleIsDefault } from "./pair-store.js";
import { getUnifiedWorkerCompose, loadWorkerThread, updateUnifiedWorkerCompose, updateWorkerThreadEffort } from "./worker-client-router.js";

type PairButlerService = Pick<
  ButlerAgentService,
  "dispose" | "getMessagePage" | "getShellSnapshot" | "on" | "prompt" | "setThinkingLevel" | "start" | "stopPrompt" | "updateComposeSettings"
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
  routingClassifier?: ButlerRoutingClassifier | null;
  onButlerPatch?: (payload: ButlerLivePatchView) => void;
  sessionTitleGenerator?: SessionTitleGenerator | null;
  createButlerService?: (options: ConstructorParameters<typeof ButlerAgentService>[0]) => PairButlerService;
};

function toPairModelOptions(models: ReturnType<CodexAppServerClient["getConnectionState"]>["compose"]["availableModels"]): PairCodexModelOption[] {
  return models.map((model) => ({
    id: model.id,
    label: model.label,
    provider: model.provider,
    supportedReasoningEfforts: [...model.supportedReasoningEfforts],
    defaultReasoningEffort: model.defaultReasoningEffort
  }));
}

function chooseEffortForModel(model: PairCodexModelOption | null, requested: string | null): string | null {
  if (!model) {
    return requested;
  }
  if (requested && model.supportedReasoningEfforts.includes(requested)) {
    return requested;
  }
  return model.defaultReasoningEffort ?? model.supportedReasoningEfforts[0] ?? null;
}

function pairSystemPrompt(pairId: string): string {
  return [
    "PAIR SUPERVISION CONTEXT",
    `You are Butler supervising exactly one Manor pair: ${pairId}.`,
    "The operator only talks to you. Do not tell the operator to message the worker directly.",
    "When work should be executed, use delegate_to_codex or message_job. When worker evidence returns, review it adversarially before replying to the operator.",
    "Keep operator-visible replies concise. Do not mention hidden tool prompts or internal routing."
  ].join("\n");
}

function mapRole(role: string): PairMessage["role"] {
  if (role === "assistant" || role === "butler") return "butler";
  if (role === "user" || role === "user-with-attachments") return "user";
  if (role === "worker") return "worker";
  return "system";
}

function mapButlerMessage(message: ButlerMessageView): PairMessage {
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

export class PairSessionManager {
  private readonly services = new Map<string, { service: PairButlerService; started: Promise<void> }>();
  private readonly titleInFlight = new Set<string>();
  private readonly titleAttempted = new Set<string>();

  constructor(private readonly options: PairSessionManagerOptions) {}

  async listSummaries(): Promise<PairSummary[]> {
    this.options.pairStore.syncWorkerReports();
    for (const pairId of this.services.keys()) {
      this.syncPairSnapshot(pairId);
    }
    return this.options.pairStore.listSummaries();
  }

  async createPair(input: { title?: string | null; defaultCwd?: string | null } = {}): Promise<PairDetail> {
    const pair = this.options.pairStore.createPair(input);
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
  }): Promise<PairDetail> {
    const pair = this.options.pairStore.createPair({ title: input.title, defaultCwd: input.defaultCwd });
    this.options.pairStore.attachWorker(pair.id, {
      threadId: input.threadId,
      task: input.task,
      cwd: input.cwd,
      handoffPrompt: input.handoffPrompt
    });
    await this.ensureService(pair.id);
    return this.getPairDetail(pair.id, null, 120) as Promise<PairDetail>;
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
            worker: { runtime: "auto", provider: null, model: null, effort: null, availableModels: [], availableEfforts: [] },
            codex: { model: null, effort: null, availableModels: [], availableEfforts: [] }
          }
    };
  }

  async setButlerThinkingLevel(pairId: string, level: string): Promise<PairDetail | null> {
    const service = this.services.get(pairId)?.service;
    if (!service) return null;
    service.setThinkingLevel(level as never);
    return this.getPairDetail(pairId, null, 120);
  }

  async setButlerModel(pairId: string, modelId: string): Promise<PairDetail | null> {
    const service = this.services.get(pairId)?.service;
    if (!service) return null;
    const shell = service.getShellSnapshot();
    const model = (shell.compose?.availableModels ?? []).find((entry) => entry.id === modelId);
    if (!model) {
      throw new Error("Selected Butler model is not available");
    }
    const thinkingLevel = shell.compose?.thinkingLevel ?? "medium";
    await service.updateComposeSettings(model.provider ?? shell.compose?.provider ?? "", model.id, thinkingLevel as never);
    return this.getPairDetail(pairId, null, 120);
  }

  async setCodexEffort(pairId: string, effort: string | null): Promise<PairDetail | null> {
    const pair = this.options.pairStore.getPair(pairId);
    if (!pair?.worker) {
      if (effort) await updateUnifiedWorkerCompose(this.options, { model: pair?.codexModel ?? null, effort: effort as never });
      this.options.pairStore.updatePairComposeOverrides(pairId, { codexEffort: effort });
      return this.getPairDetail(pairId, null, 120);
    }
    if (effort) {
      await updateWorkerThreadEffort(this.options, pair.worker.threadId, effort as never);
      await updateUnifiedWorkerCompose(this.options, { model: pair.codexModel ?? null, effort: effort as never });
    }
    this.options.pairStore.updatePairComposeOverrides(pairId, { codexEffort: effort });
    return this.getPairDetail(pairId, null, 120);
  }

  async setCodexModel(pairId: string, modelId: string): Promise<PairDetail | null> {
    const pair = this.options.pairStore.getPair(pairId);
    if (!pair) return null;
    const compose = getUnifiedWorkerCompose(this.options, pair.codexModel ?? null, pair.codexEffort ?? null);
    const model = compose.availableModels.find((entry) => entry.id === modelId);
    if (!model) {
      throw new Error("Selected worker model is not available");
    }
    const effort = chooseEffortForModel(toPairModelOptions([model])[0] ?? null, pair.codexEffort ?? pair.worker?.requestedReasoningEffort ?? compose.effort ?? null);
    if (pair.worker) {
      await updateWorkerThreadEffort(this.options, pair.worker.threadId, effort as never);
    }
    await updateUnifiedWorkerCompose(this.options, { model: modelId, effort: effort as never });
    this.options.pairStore.updatePairComposeOverrides(pairId, { codexModel: modelId, codexEffort: effort });
    return this.getPairDetail(pairId, null, 120);
  }

  private resolveCompose(pair: PairChat, service: PairButlerService): PairComposeSettings {
    const shell = service.getShellSnapshot();
    const availableThinkingLevels = shell.compose?.availableThinkingLevels?.length
      ? shell.compose.availableThinkingLevels
      : [...DEFAULT_THINKING_LEVELS];
    const butlerModels = toPairModelOptions(shell.compose?.availableModels ?? []);
    const thinkingLevel = pair.butlerThinkingLevel ?? shell.compose?.thinkingLevel ?? "medium";
    const workerCompose = getUnifiedWorkerCompose(this.options, pair.codexModel ?? null, pair.codexEffort ?? null);
    const availableModels = toPairModelOptions(workerCompose.availableModels);
    const selectedModelId = workerCompose.model ?? availableModels[0]?.id ?? null;
    const selectedModel = availableModels.find((model) => model.id === selectedModelId) ?? null;
    const workerEffort = pair.worker?.requestedReasoningEffort ?? null;
    const availableEfforts = selectedModel
      ? selectedModel.supportedReasoningEfforts
      : availableModels.flatMap((model) => model.supportedReasoningEfforts);
    const uniqueEfforts = Array.from(new Set(availableEfforts));
    const effort = chooseEffortForModel(selectedModel, pair.codexEffort ?? workerEffort ?? workerCompose.effort ?? null);
    const worker = { runtime: workerCompose.runtime, provider: workerCompose.provider, model: selectedModelId, effort, availableModels, availableEfforts: uniqueEfforts };
    return {
      butler: { provider: shell.compose?.provider ?? null, model: shell.compose?.model ?? butlerModels[0]?.id ?? null, thinkingLevel, availableModels: butlerModels, availableThinkingLevels },
      worker,
      codex: { model: selectedModelId, effort, availableModels, availableEfforts: uniqueEfforts }
    };
  }

  async deletePair(pairId: string): Promise<boolean> {
    const loaded = this.services.get(pairId);
    if (loaded) {
      loaded.service.dispose();
      this.services.delete(pairId);
    }
    return this.options.pairStore.deletePair(pairId);
  }

  async stopButler(pairId: string): Promise<boolean> {
    const loaded = this.services.get(pairId);
    if (!loaded) return false;
    await loaded.started;
    await loaded.service.stopPrompt();
    this.syncPairSnapshot(pairId);
    return true;
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

  async getWorkerThread(pairId: string): Promise<unknown | null> {
    const pair = this.options.pairStore.getPair(pairId);
    if (!pair?.worker) return null;
    try {
      await loadWorkerThread(this.options, pair.worker.threadId);
    } catch {
      // Saved local state is enough for the read-only worker pane.
    }
    return this.options.store.getThreadDetail(pair.worker.threadId) ?? null;
  }

  private async ensureService(pairId: string): Promise<PairButlerService> {
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
      routingClassifier: this.options.routingClassifier,
      systemPromptSuffix: pairSystemPrompt(pair.id),
      operatorSink: {
        onDelegationAcknowledgement: ({ threadId, text }) => {
          const thread = this.options.store.getThread(threadId);
          this.options.pairStore.attachWorker(pair.id, {
            threadId,
            task: thread?.executionContract?.requestedTask ?? thread?.supervisor.latestUserPrompt ?? null,
            cwd: thread?.cwd ?? null,
            handoffPrompt: text
          });
          this.syncPairSnapshot(pair.id);
        },
        onOperatorReply: () => this.syncPairSnapshot(pair.id)
      }
    });
    const started = service.start().then(() => {
      this.syncPairSnapshot(pair.id);
    }).catch((error) => {
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
    const latestPage = latest === undefined || messageCount === undefined ? service.getMessagePage(null, 1) : null;
    const latestMessage = latest ?? latestPage?.messages.at(-1) ?? null;
    this.options.pairStore.updatePairSnapshot(pairId, {
      butlerSessionId: shell.sessionId,
      butlerReady: shell.ready,
      butlerPending: shell.pending || shell.isStreaming,
      butlerPendingReason: blockedCloseoutReason(shell),
      butlerLastError: shell.lastError,
      messageCount: messageCount ?? latestPage?.totalCount ?? 0,
      lastMessage: latestMessage ? mapButlerMessage(latestMessage) : null,
      updatedAt: latestMessage?.at ?? Date.now()
    });
  }
}
