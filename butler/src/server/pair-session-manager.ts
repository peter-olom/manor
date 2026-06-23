import { promises as fs } from "node:fs";
import path from "node:path";

import { ButlerAgentService } from "./butler-agent.js";
import { buildReferencePromptText } from "./reference-inputs.js";
import type { CodexAppServerClient } from "./codex-client.js";
import type { FileReferenceStore } from "./file-store.js";
import type { HostControllerClient } from "./host-controller-client.js";
import type { ImageReferenceStore } from "./image-store.js";
import type { MemoryUpdateScheduler } from "./memory-update-scheduler.js";
import type { PairStore } from "./pair-store.js";
import type { ButlerRoutingClassifier } from "./butler-routing-classifier.js";
import type { RuntimeBrokerClient } from "./runtime-broker-client.js";
import type { LoadedServiceTemplate, ServiceTemplateRegistry } from "./service-templates.js";
import type { ButlerStateStore } from "./state-store.js";
import type { ButlerMessageView } from "./types.js";
import type { PairChat, PairDetail, PairMessage, PairComposeSettings, PairSummary } from "../shared/pairing.js";

type PairSessionManagerOptions = {
  pairStore: PairStore;
  store: ButlerStateStore;
  codexClient: CodexAppServerClient;
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
};

function pairSystemPrompt(pairId: string): string {
  return [
    "PAIR SUPERVISION CONTEXT",
    `You are Butler supervising exactly one Manor pair: ${pairId}.`,
    "The operator only talks to you. Do not tell the operator to message Codex directly.",
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

export class PairSessionManager {
  private readonly services = new Map<string, { service: ButlerAgentService; started: Promise<void> }>();

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

  async getPairDetail(pairId: string, before: number | null, limit: number): Promise<PairDetail | null> {
    const pair = this.options.pairStore.getPair(pairId);
    if (!pair) return null;
    const service = await this.ensureService(pairId);
    const latest = service.getMessagePage(null, 1);
    this.syncPairSnapshot(pairId, latest.messages.at(-1) ?? null, latest.totalCount);
    const refreshed = this.options.pairStore.getPair(pairId);
    if (!refreshed) return null;
    const page = service.getMessagePage(before, limit);
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
      compose: service ? this.resolveCompose(updated, service) : { butler: { thinkingLevel: "medium", availableThinkingLevels: ["low", "medium", "high", "xhigh"] }, codex: { effort: null, availableEfforts: [] } }
    };
  }

  async setButlerThinkingLevel(pairId: string, level: string): Promise<PairDetail | null> {
    const service = this.services.get(pairId)?.service;
    if (!service) return null;
    service.setThinkingLevel(level as never);
    return this.getPairDetail(pairId, null, 120);
  }

  async setCodexEffort(pairId: string, effort: string | null): Promise<PairDetail | null> {
    const pair = this.options.pairStore.getPair(pairId);
    if (!pair?.worker) {
      this.options.pairStore.updatePairComposeOverrides(pairId, { codexEffort: effort });
      return this.getPairDetail(pairId, null, 120);
    }
    try {
      if (effort) {
        await this.options.codexClient.updateThreadReasoningEffort(pair.worker.threadId, effort as never);
      }
    } catch {
      // best-effort: we still persist the override so the UI reflects operator intent
    }
    this.options.pairStore.updatePairComposeOverrides(pairId, { codexEffort: effort });
    return this.getPairDetail(pairId, null, 120);
  }

  private resolveCompose(pair: PairChat, service: ButlerAgentService): PairComposeSettings {
    const shell = service.getShellSnapshot();
    const availableThinkingLevels = shell.compose?.availableThinkingLevels?.length
      ? shell.compose.availableThinkingLevels
      : (["low", "medium", "high", "xhigh"] as string[]);
    const thinkingLevel = pair.butlerThinkingLevel ?? shell.compose?.thinkingLevel ?? "medium";
    const codexCompose = this.options.codexClient.getConnectionState().compose;
    const workerEffort = pair.worker?.requestedReasoningEffort ?? null;
    const availableEfforts = (codexCompose?.availableModels ?? [])
      .flatMap((model) => (model as { supportedReasoningEfforts?: string[] }).supportedReasoningEfforts ?? []);
    const uniqueEfforts = Array.from(new Set(availableEfforts));
    return {
      butler: { thinkingLevel, availableThinkingLevels },
      codex: { effort: pair.codexEffort ?? workerEffort ?? codexCompose?.effort ?? null, availableEfforts: uniqueEfforts }
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
    service.prompt(promptText, input.imageReferenceIds, { mode: "queue", displayText });
    this.syncPairSnapshot(input.pairId);
    return this.getPairDetail(input.pairId, null, 120);
  }

  async getWorkerThread(pairId: string): Promise<unknown | null> {
    const pair = this.options.pairStore.getPair(pairId);
    if (!pair?.worker) return null;
    try {
      await this.options.codexClient.loadThread(pair.worker.threadId);
    } catch {
      // Saved local state is enough for the read-only worker pane.
    }
    return this.options.store.getThreadDetail(pair.worker.threadId) ?? null;
  }

  private async ensureService(pairId: string): Promise<ButlerAgentService> {
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
    const service = new ButlerAgentService({
      store: this.options.store,
      codexClient: this.options.codexClient,
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
    this.services.set(pair.id, { service, started });
    await started;
    return service;
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
      butlerLastError: shell.lastError,
      messageCount: messageCount ?? latestPage?.totalCount ?? 0,
      lastMessage: latestMessage ? mapButlerMessage(latestMessage) : null,
      updatedAt: latestMessage?.at ?? Date.now()
    });
  }
}
