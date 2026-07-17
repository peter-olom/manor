import { promises as fs } from "node:fs";
import path from "node:path";

import { ButlerAgentService } from "./butler-agent.js";
import { buildProofsByThreadMap } from "./butler-agent-helpers.js";
import { buildComposerInputItemsPrompt, buildReferencePromptText, normalizeComposerInputItems } from "./reference-inputs.js";
import type { PiRpcWorkerClient } from "./pi-rpc-worker-client.js";
import type { FileReferenceStore } from "./file-store.js";
import type { HostControllerClient } from "./host-controller-client.js";
import type { ImageReferenceStore } from "./image-store.js";
import type { MemoryUpdateScheduler } from "./memory-update-scheduler.js";
import type { PairStore } from "./pair-store.js";
import type { RuntimeBrokerClient } from "./runtime-broker-client.js";
import type { LoadedServiceTemplate, ServiceTemplateRegistry } from "./service-templates.js";
import type { SessionTitleGenerator } from "./session-title-generator.js";
import type { SkillsService } from "./skills-service.js";
import type { ExtensionUiBroker } from "./extension-ui-broker.js";
import type { ButlerStateStore } from "./state-store.js";
import type { ButlerMessageView, ButlerLivePatchView, ModelOption } from "./types.js";
import type { VisionInspectionService } from "./vision-inspection.js";
import type { PairAutomation, PairButlerActivityOutcome, PairChat, PairComposerInputItem, PairComposerSuggestion, PairModelOption, PairDetail, PairMessage, PairComposeSettings, PairReviewActivity, PairSummary, PairTraceItem, PairWorker, PairWorkspaceOption } from "../shared/pairing.js";
import type { WorkerSessionControlAction, WorkerSessionControls } from "../shared/worker-session-controls.js";
import { DEFAULT_THINKING_LEVELS } from "../shared/pairing.js";
import { pairTitleIsDefault } from "./pair-store.js";
import { getUnifiedWorkerCompose, loadWorkerThread, updateUnifiedWorkerCompose, updateWorkerThreadEffort, type WorkerClientAccess } from "./worker-client-router.js";
import { parseProviderModelRef } from "./model-provider-config.js";
import { isCallbackReviewRetryablePause } from "./butler-callback-review-runner.js";
import { resolveOperatorTimezone } from "./operator-timezone.js";
import { redactSensitiveText } from "./redact-sensitive-text.js";
import { workerThreadIsRunning } from "./worker-thread-status.js";
import { pageWorkerProofRecords, pageWorkerThread } from "./worker-thread-page.js";
import { listWorkspaceProjectDirectories, validateWorkspaceCwd, type WorkspaceProjectDirectory } from "./repo-worktree.js";
import { buildManorSkillRoutingContext, listManorSkillCapabilities, normalizeManorSkillName, parseManorSkillInvocation, skillAvailabilityDetail } from "./manor-skill-routing.js";
import type { AutomationDispatchResult } from "./session-automation-scheduler.js";
import { automationDispatchEndsAt } from "./session-automation.js";
import type { ActivityWatchdogDiagnostics } from "../shared/activity-watchdog.js";
import { listComposerFileSuggestions } from "./composer-file-suggestions.js";

type PairButlerService = Pick<
  ButlerAgentService,
  "answerOperatorQuestion" | "cancelCallbackReview" | "dispose" | "ensureExternalWorkerDelegation" | "exportSession" | "getLiveSnapshot" | "getMessagePage" | "getSessionControls" | "getShellSnapshot" | "handoffWorker" | "listComposerCommands" | "on" | "postAutomationNotice" | "prompt" | "quiesceCallbackReviews" | "refreshModelSettings" | "reloadResources" | "removeExternalWorkerDelegation" | "retryBlockedCallbackReviews" | "runAutomationPrompt" | "runSessionControl" | "setThinkingLevel" | "start" | "stopPrompt" | "updateComposeSettings" | "watchdogs"
>;

type PairSessionManagerOptions = {
  pairStore: PairStore;
  store: ButlerStateStore;
  piRpcWorkerClient?: PiRpcWorkerClient | null;
  hostController: HostControllerClient;
  runtimeBroker: RuntimeBrokerClient;
  serviceTemplateRegistry: ServiceTemplateRegistry;
  imageStore: ImageReferenceStore;
  fileStore: FileReferenceStore;
  visionInspection: VisionInspectionService;
  piAuthPath: string;
  workerAuthPath: string;
  workerConfigDir: string;
  sessionRootDir: string;
  artifactsDir: string;
  refreshRuntimeInventory?: () => Promise<void>;
  memoryScheduler?: MemoryUpdateScheduler | null;
  onButlerPatch?: (payload: ButlerLivePatchView) => void;
  onWorkerThreadRefreshed?: (threadId: string) => void;
  sessionTitleGenerator?: SessionTitleGenerator | null;
  skillsService: SkillsService;
  extensionUiBroker: ExtensionUiBroker;
  getWorkerAuthStatus?: () => { loggedIn: boolean };
  createButlerService?: (options: ConstructorParameters<typeof ButlerAgentService>[0]) => PairButlerService;
  listWorkspaceProjects?: () => Promise<WorkspaceProjectDirectory[]>;
  validateWorkspace?: (cwd: string) => Promise<string>;
};

function toPairModelOptions(models: ModelOption[]): PairModelOption[] {
  return models
    .filter((model) => model.provider !== "opencode")
    .map((model) => ({
      id: model.id,
      label: model.label,
      provider: model.provider,
      harness: model.harness ?? null,
      inputCapabilities: model.inputCapabilities,
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
    "This session can have one automation. Use configure_automation for recurring work at fixed daily wall-clock times, or configure_interval_automation for a bounded request such as every 5 minutes for the next 30 minutes.",
    "Automation times run in the operator's configured timezone. Use local 24-hour HH:mm times and YYYY-MM-DD dates directly without converting to UTC. Distinguish one-off weekdays from recurring weekdays, inclusive end dates from unbounded schedules, and fixed daily windows from relative intervals. If the operator has not set a timezone it defaults to UTC.",
    "If the task or times are materially missing, use ask_operator before configuring. Never claim an automation was created, changed, paused, resumed, or deleted before the matching tool succeeds.",
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
    ...(message.attachments?.length ? { attachments: message.attachments.map((attachment) => ({ ...attachment })) } : {}),
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

function mapButlerActivity(
  service: PairButlerService,
  messages: ButlerMessageView[] = []
): { items: PairTraceItem[]; outcome: PairButlerActivityOutcome | null } {
  const getLiveSnapshot = (service as Partial<PairButlerService>).getLiveSnapshot;
  if (typeof getLiveSnapshot !== "function") return { items: [], outcome: null };
  const turns = [...getLiveSnapshot.call(service).activityTurns].reverse();
  const latestUserAt = messages.reduce((latest, message) =>
    message.role === "user" || message.role === "user-with-attachments" ? Math.max(latest, message.at ?? 0) : latest, 0);
  const selectedTurn =
    turns.find((turn) => turn.status === "active") ??
    turns.find((turn) => (turn.status !== "completed" || turn.items.length > 0) && turn.startedAt >= latestUserAt - 1_000);
  if (!selectedTurn) return { items: [], outcome: null };
  const representedIds = new Set(messages.flatMap((message) => message.trace?.map((item) => item.id) ?? []));
  const items = selectedTurn.items.filter((item) => !representedIds.has(item.id)).map((item): PairTraceItem => ({
    id: item.id,
    type: item.kind === "thinking" ? "reasoning" : "dynamic_tool_call",
    status: item.status === "active" ? "in_progress" : item.status === "error" ? "failed" : item.status === "stopped" ? "declined" : "completed",
    text: item.text,
    title: item.title,
    at: item.at,
    updatedAt: item.updatedAt,
    completedAt: item.status === "active" ? null : item.updatedAt
  }));
  return {
    items,
    outcome: {
      status: selectedTurn.status,
      startedAt: selectedTurn.startedAt,
      completedAt: selectedTurn.completedAt,
      detail: selectedTurn.detail ? redactSensitiveText(selectedTurn.detail) : null
    }
  };
}

function mapReviewActivity(
  pair: PairChat,
  shell: ReturnType<ButlerAgentService["getShellSnapshot"]>
): PairReviewActivity | null {
  const callback = shell.supervision.callbacks.find((entry) =>
    entry.owesOperatorReply &&
    entry.callbackState !== "closed" &&
    (!pair.worker?.threadId || entry.threadId === pair.worker.threadId) &&
    (entry.reviewState === "queued" || entry.reviewState === "running" || entry.reviewState === "blocked")
  );
  if (!callback || callback.reviewState === "idle") return null;
  const stage = callback.reviewStage ?? (
    callback.reviewState === "running" ? "preparing" :
      callback.reviewState === "blocked" ? "blocked" : "queued"
  );
  const lastActivity = callback.reviewLastActivity?.replace(/^(Finished [^:]+):[\s\S]*$/, "$1.") ?? null;
  return {
    state: callback.reviewState,
    stage,
    attempt: Math.max(0, callback.reviewAttempt ?? 0),
    maxAttempts: 3,
    startedAt: callback.reviewStartedAt ?? null,
    deadlineAt: callback.reviewDeadlineAt ?? null,
    nextAttemptAt: callback.reviewNextAttemptAt ?? null,
    lastActivityAt: callback.reviewLastActivityAt ?? null,
    lastActivity: lastActivity ? redactSensitiveText(lastActivity) : null,
    lastTool: callback.reviewLastTool ?? null,
    lastError: callback.reviewLastError ? redactSensitiveText(callback.reviewLastError) : null,
    errors: (callback.reviewErrors ?? []).map((error) => ({ ...error, message: redactSensitiveText(error.message) })),
    modelProvider: callback.reviewModelProvider ?? null,
    modelId: callback.reviewModelId ?? null,
    thinkingLevel: callback.reviewReasoningLevel ?? null,
    retryable: isCallbackReviewRetryablePause(callback)
  };
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
    return `The chosen Butler model ${pair.butlerModel} is not in the current model inventory. Retry the provider check in Settings → Providers or choose another Butler model.`;
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

async function pairHasPersistedCallbackObligation(pair: PairChat, sessionRootDir: string): Promise<boolean> {
  if (!pair.worker) return false;
  try {
    const raw = await fs.readFile(path.join(sessionRootDir, pair.id, "chat-callbacks.json"), "utf8");
    const parsed = JSON.parse(raw) as { callbackRecords?: Array<Record<string, unknown>>; pendingCallbacks?: Array<Record<string, unknown>> };
    return (parsed.callbackRecords ?? parsed.pendingCallbacks ?? []).some((callback) =>
      callback.threadId === pair.worker?.threadId &&
      callback.callbackState !== "closed" &&
      callback.operatorCloseoutStatus !== "posted" &&
      callback.owesOperatorReply !== false
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" || error instanceof SyntaxError) return false;
    throw error;
  }
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
  private readonly workerThreadRefreshes = new Map<string, Promise<void>>();
  private readonly workerThreadRefreshedAt = new Map<string, number>();

  constructor(private readonly options: PairSessionManagerOptions) {}

  private async persistAutomationMutation<T>(pairId: string, mutate: () => T): Promise<T> {
    const before = this.options.pairStore.getPair(pairId);
    const result = mutate();
    try {
      await this.options.pairStore.flushPendingSave();
      return result;
    } catch (error) {
      if (before) {
        this.options.pairStore.restoreAutomation(pairId, before.automation, before.updatedAt);
        try {
          await this.options.pairStore.flushPendingSave();
        } catch (restoreError) {
          throw new Error(`Automation save failed and rollback could not be persisted: ${restoreError instanceof Error ? restoreError.message : String(restoreError)}`, { cause: error });
        }
      }
      throw error;
    }
  }

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
    const candidates = this.options.pairStore.listSummaries();
    const supervisionFlags = await Promise.all(candidates.map(async (pair) =>
      pairNeedsSupervision(pair, this.options.store) || pairHasPersistedCallbackObligation(pair, this.options.sessionRootDir)
    ));
    const supervised = candidates.filter((_pair, index) => supervisionFlags[index]);
    await Promise.allSettled(supervised.map((pair) => this.ensureService(pair.id)));
  }

  async createPair(input: { title?: string | null; defaultCwd?: string | null } = {}): Promise<PairDetail> {
    const defaultCwd = input.defaultCwd
      ? await (this.options.validateWorkspace ?? validateWorkspaceCwd)(input.defaultCwd)
      : null;
    const pair = this.options.pairStore.createPair({ ...input, defaultCwd });
    await this.options.pairStore.flushPendingSave();
    await this.ensureService(pair.id);
    return this.getPairDetail(pair.id, null, 120) as Promise<PairDetail>;
  }

  async listWorkspaces(): Promise<PairWorkspaceOption[]> {
    const projects = await (this.options.listWorkspaceProjects ?? (() => listWorkspaceProjectDirectories()))();
    return [
      { id: "workspace:shared", label: "Shared workspace", cwd: "/repos", kind: "workspace", gitBacked: false },
      ...projects.filter((project) => project.cwd !== "/repos")
    ];
  }

  async configureAutomation(pairId: string, input: { instruction: string; dailyTimes: string[]; endDate?: string }): Promise<PairAutomation | null> {
    const pair = await this.persistAutomationMutation(pairId, () => this.options.pairStore.configureAutomation(pairId, input));
    if (!pair?.automation) return null;
    return pair.automation;
  }

  async configureOnceAutomation(pairId: string, input: { instruction: string; on: string; time: string }): Promise<PairAutomation | null> {
    const pair = await this.persistAutomationMutation(pairId, () => this.options.pairStore.configureOnceAutomation(pairId, input));
    return pair?.automation ?? null;
  }

  async configureWeeklyAutomation(pairId: string, input: { instruction: string; weekdays: string[]; times: string[]; endDate?: string }): Promise<PairAutomation | null> {
    const pair = await this.persistAutomationMutation(pairId, () => this.options.pairStore.configureWeeklyAutomation(pairId, input));
    return pair?.automation ?? null;
  }

  async configureWindowAutomation(pairId: string, input: { instruction: string; everyMinutes: number; startTime: string; endTime: string; endDate?: string }): Promise<PairAutomation | null> {
    const pair = await this.persistAutomationMutation(pairId, () => this.options.pairStore.configureWindowAutomation(pairId, input));
    return pair?.automation ?? null;
  }

  async configureIntervalAutomation(pairId: string, input: { instruction: string; everyMinutes: number; durationMinutes: number }): Promise<PairAutomation | null> {
    const pair = await this.persistAutomationMutation(pairId, () => this.options.pairStore.configureIntervalAutomation(pairId, input));
    if (!pair?.automation) return null;
    return pair.automation;
  }

  async setAutomationEnabled(pairId: string, enabled: boolean): Promise<PairAutomation | null> {
    const pair = await this.persistAutomationMutation(pairId, () => this.options.pairStore.setAutomationEnabled(pairId, enabled));
    if (!pair?.automation) return null;
    return pair.automation;
  }

  async deleteAutomation(pairId: string): Promise<boolean> {
    const existing = this.options.pairStore.getPair(pairId);
    if (!existing?.automation) return false;
    await this.persistAutomationMutation(pairId, () => this.options.pairStore.deleteAutomation(pairId));
    return true;
  }

  async postAutomationNotice(pairId: string, text: string): Promise<void> {
    const service = await this.ensureService(pairId);
    await service.postAutomationNotice(text);
    this.syncPairSnapshot(pairId);
  }

  async isAutomationBusy(pairId: string): Promise<boolean> {
    const pair = this.options.pairStore.getPair(pairId);
    if (!pair) return true;
    const shell = (await this.ensureService(pairId)).getShellSnapshot();
    const unansweredQuestion = Boolean(pair.lastMessage?.question && !pair.lastMessage.question.answeredAt);
    return pair.butlerPending || Boolean(pair.butlerPendingReason) || unansweredQuestion ||
      pair.status === "worker_running" || pair.status === "needs_butler_review" ||
      shell.pending || shell.isStreaming ||
      shell.supervision.callbacks.some((callback) => callback.owesOperatorReply && callback.callbackState !== "closed");
  }

  async runAutomation(input: { pairId: string; automation: PairAutomation; run: NonNullable<PairAutomation["running"]> }): Promise<AutomationDispatchResult> {
    const pair = this.options.pairStore.getPair(input.pairId);
    if (!pair) throw new Error("Butler session not found");
    const service = await this.ensureService(input.pairId);
    const startedAt = Date.now();
    const deadline = startedAt + 6 * 60 * 60 * 1_000;
    const scheduleEndsAt = automationDispatchEndsAt(input.automation.schedule, resolveOperatorTimezone());
    const scheduleHasEnded = (): boolean => scheduleEndsAt !== null && Date.now() > scheduleEndsAt;
    // The scheduler checks before claiming, then this closes the narrow race
    // where the operator or a Worker callback becomes active immediately after.
    while (await this.isAutomationBusy(input.pairId)) {
      if (scheduleHasEnded()) {
        return { outcome: "skipped", summary: "Automation ended before this delayed run could start.", resultPath: null };
      }
      if (Date.now() >= deadline) throw new Error("Automation could not start within the six-hour run limit because the session remained active");
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 2_000);
        timer.unref?.();
      });
    }
    if (scheduleHasEnded()) {
      return { outcome: "skipped", summary: "Automation ended before this delayed run could start.", resultPath: null };
    }
    const shell = service.getShellSnapshot();
    const selectionError = butlerModelAvailabilityError(pair, shell);
    if (selectionError) {
      await service.postAutomationNotice(`Automation failed: ${selectionError}`);
      const resultPath = await this.saveAutomationResult(input, "failed", selectionError).catch(() => null);
      return { outcome: "failed", summary: selectionError, resultPath };
    }
    const cwd = pair.worker?.cwd ?? pair.defaultCwd ?? "/repos";
    const prompt = [
      "SYSTEM-TRIGGERED AUTOMATION RUN",
      `Automation id: ${input.automation.id}`,
      `Run id: ${input.run.id}`,
      `Scheduled for: ${input.run.scheduledFor}`,
      `Session workspace: ${cwd}`,
      `Task: ${input.automation.instruction}`,
      "Complete the task now. Delegate to Worker when execution is needed and review the result before closing out.",
      "Save generated work with save_project_artifact using tags automation and the automation id when appropriate.",
      "Finish with one concise operator-visible result or failure summary. Do not change this automation unless the stored task explicitly asks you to."
    ].join("\n");
    try {
      const delivered = await service.runAutomationPrompt(prompt, `Automation run: ${input.automation.instruction}`);
      if (!delivered) throw new Error("Butler did not accept the scheduled run");
      this.syncPairSnapshot(input.pairId);
      while (Date.now() < deadline) {
        const current = this.options.pairStore.getPair(input.pairId);
        const shell = service.getShellSnapshot();
        const outstandingCallback = shell.supervision.callbacks.some((callback) => callback.owesOperatorReply && callback.callbackState !== "closed");
        const workerRunning = current?.worker?.status === "running" || current?.worker?.status === "starting" || current?.status === "worker_running" || current?.status === "needs_butler_review";
        if (!shell.pending && !shell.isStreaming && !outstandingCallback && !workerRunning) break;
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, 2_000);
          timer.unref?.();
        });
        this.syncPairSnapshot(input.pairId);
      }
      if (Date.now() >= deadline) throw new Error("Automation exceeded the six-hour run limit");
      const page = service.getMessagePage(null, 30);
      const question = [...page.messages].reverse().find((message) => (message.at ?? 0) >= startedAt && message.question && !message.question.answeredAt);
      const latestReply = [...page.messages].reverse().find((message) => (message.at ?? 0) >= startedAt && (message.role === "assistant" || message.role === "butler"));
      const summary = latestReply?.displayText?.trim() || latestReply?.text.trim() || "Automation completed.";
      const outcome = question ? "needs_input" as const : "succeeded" as const;
      const resultPath = await this.saveAutomationResult(input, outcome, summary);
      return { outcome, summary, resultPath };
    } catch (error) {
      const summary = error instanceof Error ? error.message : String(error);
      await service.postAutomationNotice(`Automation failed: ${summary}`).catch(() => undefined);
      const resultPath = await this.saveAutomationResult(input, "failed", summary).catch(() => null);
      return { outcome: "failed", summary, resultPath };
    } finally {
      this.syncPairSnapshot(input.pairId);
    }
  }

  private async saveAutomationResult(input: { pairId: string; automation: PairAutomation; run: NonNullable<PairAutomation["running"]> }, outcome: string, summary: string): Promise<string> {
    const directory = path.join(this.options.artifactsDir, "automations", input.pairId);
    await fs.mkdir(directory, { recursive: true });
    const resultPath = path.join(directory, `${input.run.id}.md`);
    await fs.writeFile(resultPath, [
      `# Automation run`, "", `- Automation: ${input.automation.id}`, `- Run: ${input.run.id}`,
      `- Scheduled: ${new Date(input.run.scheduledFor).toISOString()}`, `- Outcome: ${outcome}`, "",
      `## Instructions`, "", input.automation.instruction, "", `## Result`, "", summary, ""
    ].join("\n"), "utf8");
    return resultPath;
  }

  async setWorkspaceCwd(pairId: string, requestedCwd: string): Promise<PairDetail | null> {
    return this.runSerializedPairHandoff(pairId, async () => {
      const pair = this.options.pairStore.getPair(pairId);
      if (!pair) return null;
      const cwd = await (this.options.validateWorkspace ?? validateWorkspaceCwd)(requestedCwd);
      const effectiveCwd = pair.worker?.cwd ?? pair.defaultCwd ?? "/repos";
      if (cwd === effectiveCwd) return this.getPairDetail(pairId, null, 120);
      if (pair.butlerPending) throw new Error("Wait for Butler to finish before changing workspace.");
      if (pair.worker && workerThreadIsRunning(this.options.store.getThread(pair.worker.threadId))) {
        throw new Error("Wait for the current Worker turn to finish before changing workspace.");
      }

      const previousDefaultCwd = pair.defaultCwd;
      this.options.pairStore.updatePairDefaultCwd(pairId, cwd);
      try {
        await this.options.pairStore.flushPendingSave();
      } catch (error) {
        this.options.pairStore.updatePairDefaultCwd(pairId, previousDefaultCwd);
        throw error;
      }
      if (!pair.worker) return this.getPairDetail(pairId, null, 120);

      try {
        const service = await this.ensureService(pairId);
        const model = pair.worker.model ?? pair.workerModel;
        const harness = pair.worker.harness ?? pair.workerHarness;
        if (!model || !harness) throw new Error("The active Worker route is unavailable. Switch Worker before changing workspace.");
        await service.handoffWorker({
          sourceThreadId: pair.worker.threadId,
          harness,
          model,
          effort: (pair.worker.requestedReasoningEffort ?? pair.workerEffort ?? null) as never,
          butlerThreadId: pair.butlerSessionId,
          cwd
        });
      } catch (error) {
        this.options.pairStore.updatePairDefaultCwd(pairId, previousDefaultCwd);
        await this.options.pairStore.flushPendingSave();
        throw error;
      }
      return this.getPairDetail(pairId, null, 120);
    });
  }

  async createWorkerPair(input: {
    title?: string | null;
    defaultCwd?: string | null;
    threadId: string;
    task?: string | null;
    cwd?: string | null;
    handoffPrompt?: string | null;
    runtime?: "pi-rpc" | null;
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
        harness: input.harness === "pi" ? "pi" : null,
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
    const shell = service.getShellSnapshot();
    const activity = mapButlerActivity(service, page.messages);
    this.maybeGenerateTitleFromPage(refreshed, page.messages);
    return {
      ...refreshed,
      messages: page.messages.map(mapButlerMessage),
      butlerActivity: activity.items,
      butlerActivityOutcome: activity.outcome,
      review: mapReviewActivity(refreshed, shell),
      messageCount: page.totalCount,
      loadedStart: page.startIndex,
      hasMore: page.hasMore,
      compose: this.resolveCompose(refreshed, service)
    };
  }

  async getActivityWatchdogs(pairId: string): Promise<ActivityWatchdogDiagnostics | null> {
    if (!this.options.pairStore.getPair(pairId)) return null;
    const watchdogs = (await this.ensureService(pairId)).watchdogs.snapshot();
    return { activeCount: watchdogs.length, watchdogs };
  }

  updatePairTitle(pairId: string, title: string): PairDetail | null {
    const updated = this.options.pairStore.updatePairTitle(pairId, title);
    if (!updated) return null;
    const service = this.services.get(pairId)?.service;
    const page = service?.getMessagePage(null, 120);
    const shell = service?.getShellSnapshot();
    const activity = service ? mapButlerActivity(service, page?.messages ?? []) : { items: [], outcome: null };
    return {
      ...updated,
      messages: page?.messages.map(mapButlerMessage) ?? [],
      butlerActivity: activity.items,
      butlerActivityOutcome: activity.outcome,
      review: service && shell ? mapReviewActivity(updated, shell) : null,
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
    const harness = pair?.worker?.harness === "pi" || pair?.workerHarness === "pi" ? "pi" : null;
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
    if (harness && harness !== "pi") throw new Error("Only the Pi Worker harness is available");
    const compose = getUnifiedWorkerCompose(this.getWorkerClientAccess(), modelId, pair.workerEffort ?? null, "auto", harness === "pi" ? "pi" : null);
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
      if (harness && harness !== "pi") throw new Error("Only the Pi Worker harness is available");
      const compose = getUnifiedWorkerCompose(this.getWorkerClientAccess(), modelId, requestedEffort, "auto", harness === "pi" ? "pi" : null);
      const model = findWorkerModel(compose.availableModels, modelId, harness);
      if (!model) throw new Error("Selected worker model is not available");
      const effort = chooseEffortForModel(toPairModelOptions([model])[0] ?? null, requestedEffort ?? compose.effort);
      const service = await this.ensureService(pairId);
      await service.handoffWorker({
        sourceThreadId: pair.worker.threadId,
        harness: model.harness ?? compose.harness ?? "pi",
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
    const requestedWorkerHarness = pair.worker?.harness === "pi" || pair.workerHarness === "pi" ? "pi" : null;
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
        await awaitPairShutdown(loaded.service.quiesceCallbackReviews(), "Adversarial review shutdown");
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

  getPairWorkerThreadId(pairId: string): string | null {
    return this.options.pairStore.getPair(pairId)?.worker?.threadId ?? null;
  }

  async deletePair(pairId: string): Promise<boolean> {
    const existing = this.options.pairStore.getPair(pairId);
    if (existing?.worker) {
      const service = await this.ensureService(pairId);
      await service.removeExternalWorkerDelegation(existing.worker.threadId);
    }
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

  async refreshModelSettings(): Promise<boolean> {
    const refreshed = await Promise.all([...this.services.entries()].map(async ([pairId, loaded]) => {
      await loaded.started;
      const applied = await loaded.service.refreshModelSettings();
      if (applied) this.syncPairSnapshot(pairId);
      return applied;
    }));
    return refreshed.every(Boolean);
  }

  canRefreshModelSettings(): boolean {
    return [...this.services.values()].every(({ service }) => {
      const shell = service.getShellSnapshot();
      return !shell.pending && !shell.isStreaming;
    });
  }

  scheduleButlerSkillsReload(): void {
    for (const [pairId, loaded] of this.services) {
      void loaded.started.then(() => loaded.service.reloadResources()).then(() => this.syncPairSnapshot(pairId)).catch((error) => {
        console.error(`Butler skill reload failed for pair ${pairId}: ${error instanceof Error ? error.message : String(error)}`);
      });
    }
  }

  async listComposerSuggestions(pairId: string, trigger: "@" | "$" | "/", query: string): Promise<PairComposerSuggestion[] | null> {
    const pair = this.options.pairStore.getPair(pairId);
    if (!pair) return null;
    const displayQuery = query.trim().slice(0, 200);
    const normalizedQuery = displayQuery.toLowerCase();
    const matches = (...values: Array<string | null | undefined>) => !normalizedQuery || values.some((value) => value?.toLowerCase().includes(normalizedQuery));
    const skillQuery = trigger === "/" && normalizedQuery.startsWith("skill:") ? normalizedQuery.slice("skill:".length) : normalizedQuery;
    const matchesSkill = (...values: Array<string | null | undefined>) => !skillQuery || values.some((value) => value?.toLowerCase().includes(skillQuery));
    const service = trigger === "/" ? await this.ensureService(pairId) : null;
    const commands = service?.listComposerCommands() ?? [];
    const cwd = await (this.options.validateWorkspace ?? validateWorkspaceCwd)(pair.worker?.cwd ?? pair.defaultCwd ?? "/repos");
    const skills = trigger === "@" ? [] : await listManorSkillCapabilities(this.options.skillsService, cwd);

    if (trigger === "/") {
      const commandSuggestions: PairComposerSuggestion[] = commands.filter((command) => matches(command.name, command.description)).map((command) => ({
        id: `command:${command.name}`,
        kind: "command",
        label: `/${command.name}`,
        detail: command.description,
        insertText: `/${command.name}`
      }));
      const skillCommands: PairComposerSuggestion[] = skills.filter((skill) => matchesSkill(skill.name, skill.description)).map((skill) => ({
        id: `command:/skill:${skill.name}`,
        kind: "command",
        label: `/skill:${skill.name}`,
        detail: skillAvailabilityDetail(skill),
        insertText: `/skill:${skill.name}`
      }));
      return [...commandSuggestions, ...skillCommands].slice(0, 32);
    }

    const skillSuggestions: PairComposerSuggestion[] = skills.filter((skill) => matchesSkill(skill.name, skill.description)).map((skill) => ({
      id: `manor-skill:${skill.name.toLowerCase()}`,
      kind: "skill",
      label: skill.name,
      detail: skillAvailabilityDetail(skill),
      insertText: `$${skill.name}`,
      inputItem: { type: "skill", name: skill.name }
    }));
    if (trigger === "$") {
      if (skillSuggestions.length > 0 || !displayQuery) return skillSuggestions.slice(0, 32);
      const request = `Find or create a skill for ${displayQuery}.`;
      return [{
        id: `action:find-or-create-skill:${normalizedQuery}`,
        kind: "action",
        label: `Find or create a skill for ${displayQuery}`,
        detail: "Ask Butler to find an existing skill or create one with you.",
        insertText: request
      }];
    }

    if (trigger === "@") {
      return listComposerFileSuggestions(cwd, normalizedQuery).catch(() => []);
    }

    return [];
  }

  async sendOperatorMessage(input: {
    pairId: string;
    text: string;
    imageReferenceIds: string[];
    fileReferenceIds: string[];
    inputItems?: unknown[];
  }): Promise<PairDetail | null> {
    const pair = this.options.pairStore.getPair(input.pairId);
    if (!pair) return null;
    const service = await this.ensureService(input.pairId);
    const selectionError = butlerModelAvailabilityError(pair, service.getShellSnapshot());
    if (selectionError) throw new Error(selectionError);
    const invokedSkill = parseManorSkillInvocation(input.text);
    const referencePromptText = buildReferencePromptText({
      text: invokedSkill?.task ?? input.text,
      imageStore: this.options.imageStore,
      imageReferenceIds: input.imageReferenceIds,
      fileStore: this.options.fileStore,
      fileReferenceIds: input.fileReferenceIds,
      includeIds: true,
      includeFilePaths: true
    });
    const normalizedInputItems = normalizeComposerInputItems(input.inputItems);
    const selectedSkillInput = normalizedInputItems.find((item) => item.type === "skill") ?? null;
    const inputItems = [
      ...normalizedInputItems.filter((item) => item.type === "file"),
      ...(selectedSkillInput ? [selectedSkillInput] : [])
    ];
    const composerRoot = await (this.options.validateWorkspace ?? validateWorkspaceCwd)(pair.worker?.cwd ?? pair.defaultCwd ?? "/repos");
    const resolvedInputItems = await Promise.all(inputItems.map(async (item): Promise<PairComposerInputItem> => {
      if (item.type === "file") {
        const filePath = await fs.realpath(path.resolve(item.path)).catch(() => {
          throw new Error("Selected file is no longer available.");
        });
        const relative = path.relative(composerRoot, filePath);
        if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("Selected file is outside this session workspace.");
        return { ...item, path: filePath };
      }
      return item;
    }));
    const contextPromptText = buildComposerInputItemsPrompt(resolvedInputItems.filter((item) => item.type === "file"));
    const promptBody = [referencePromptText, contextPromptText].filter(Boolean).join("\n\n");
    const selectedInputSkillName = resolvedInputItems.find((item) => item.type === "skill")?.name ?? null;
    const selectedSkillName = invokedSkill?.name ?? (selectedInputSkillName ? normalizeManorSkillName(selectedInputSkillName) : null);
    if (selectedInputSkillName && !selectedSkillName) throw new Error("Selected skill has an invalid name.");
    const skillCatalog = selectedSkillName ? await listManorSkillCapabilities(this.options.skillsService, pair.worker?.cwd ?? pair.defaultCwd) : [];
    const selectedSkill = selectedSkillName ? skillCatalog.find((skill) => skill.name.toLowerCase() === selectedSkillName.toLowerCase()) : null;
    const skillRoutingContext = selectedSkillName ? buildManorSkillRoutingContext(selectedSkillName, selectedSkill?.environments ?? [], "worker-pi") : "";
    const nativeButlerInvocation = selectedSkill?.environments.includes("butler-pi") ? `/skill:${selectedSkill.name}` : "";
    const promptText = [nativeButlerInvocation, skillRoutingContext, promptBody].filter(Boolean).join("\n\n");
    const referenceCount = input.imageReferenceIds.length + input.fileReferenceIds.length;
    const displayText = input.text.trim() || (referenceCount > 0
      ? referenceCount === 1 ? "Attached 1 reference file." : `Attached ${referenceCount} reference files.`
      : resolvedInputItems.length === 1 ? "Added 1 context item." : `Added ${resolvedInputItems.length} context items.`);
    const shouldGenerateTitle = this.shouldGenerateTitle(pair, input.text, service);
    service.prompt(promptText, input.imageReferenceIds, { mode: "queue", displayText, fileReferenceIds: input.fileReferenceIds });
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

  async getWorkerThreadPage(pairId: string, before: number | null = null, limit = 10): Promise<{ thread: unknown | null; proofRecords: unknown[] }> {
    const pair = this.options.pairStore.getPair(pairId);
    if (!pair?.worker) return { thread: null, proofRecords: [] };
    this.refreshWorkerThreadInBackground(pair.worker.threadId);
    const thread = this.options.store.getThreadDetail(pair.worker.threadId);
    if (!thread) return { thread: null, proofRecords: [] };
    const page = pageWorkerThread(thread, before, limit);
    const proofs = buildProofsByThreadMap(this.options.store.listPreviewProofs())[pair.worker.threadId] ?? [];
    return { thread: page, proofRecords: pageWorkerProofRecords(proofs, page) };
  }

  private refreshWorkerThreadInBackground(threadId: string): void {
    if (this.workerThreadRefreshes.has(threadId)) return;
    const now = Date.now();
    if (now - (this.workerThreadRefreshedAt.get(threadId) ?? 0) < 15_000) return;
    this.workerThreadRefreshedAt.set(threadId, now);
    const refresh = loadWorkerThread(this.getWorkerClientAccess(), threadId)
      .then(() => { this.options.onWorkerThreadRefreshed?.(threadId); })
      .catch(() => undefined)
      .finally(() => {
        if (this.workerThreadRefreshes.get(threadId) === refresh) this.workerThreadRefreshes.delete(threadId);
      });
    this.workerThreadRefreshes.set(threadId, refresh);
  }

  async retryBlockedReview(pairId: string): Promise<PairDetail | null> {
    const pair = this.options.pairStore.getPair(pairId);
    if (!pair) return null;
    const service = await this.ensureService(pairId);
    if (!await service.retryBlockedCallbackReviews(pair.worker?.threadId)) throw new Error("No paused adversarial review is waiting to retry.");
    return this.getPairDetail(pairId, null, 120);
  }

  async stopReview(pairId: string): Promise<PairDetail | null> {
    const pair = this.options.pairStore.getPair(pairId);
    if (!pair) return null;
    const service = await this.ensureService(pairId);
    if (!await service.cancelCallbackReview(pair.worker?.threadId)) throw new Error("No active adversarial review is running.");
    return this.getPairDetail(pairId, null, 120);
  }

  async getButlerSessionControls(pairId: string): Promise<WorkerSessionControls | null> {
    if (!this.options.pairStore.getPair(pairId)) return null;
    return (await this.ensureService(pairId)).getSessionControls();
  }

  async runButlerSessionControl(
    pairId: string,
    action: WorkerSessionControlAction,
    input: { instructions?: string; entryId?: string; name?: string }
  ): Promise<boolean> {
    if (!this.options.pairStore.getPair(pairId)) return false;
    await (await this.ensureService(pairId)).runSessionControl(action, input);
    this.syncPairSnapshot(pairId);
    return true;
  }

  async exportButlerSession(pairId: string): Promise<string | null> {
    if (!this.options.pairStore.getPair(pairId)) return null;
    return (await this.ensureService(pairId)).exportSession();
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
      piRpcWorkerClient: this.options.piRpcWorkerClient ?? null,
      hostController: this.options.hostController,
      runtimeBroker: this.options.runtimeBroker,
      serviceTemplateRegistry: this.options.serviceTemplateRegistry,
      imageStore: this.options.imageStore,
      fileStore: this.options.fileStore,
      visionInspection: this.options.visionInspection,
      piAuthPath: this.options.piAuthPath,
      workerAuthPath: this.options.workerAuthPath,
      workerConfigDir: this.options.workerConfigDir,
      sessionDir,
      artifactsDir: this.options.artifactsDir,
      runtimeThreadId: `butler:${pair.id}`,
      extensionUiBroker: this.options.extensionUiBroker,
      skillsService: this.options.skillsService,
      refreshRuntimeInventory: this.options.refreshRuntimeInventory,
      memoryScheduler: this.options.memoryScheduler,
      systemPromptSuffix: pairSystemPrompt(pair.id),
      automationAccess: {
        get: () => this.options.pairStore.getPair(pair.id)?.automation ?? null,
        configure: async (input) => {
          const automation = await this.configureAutomation(pair.id, input);
          if (!automation) throw new Error("Butler session not found");
          return automation;
        },
        configureOnce: async (input) => {
          const automation = await this.configureOnceAutomation(pair.id, input);
          if (!automation) throw new Error("Butler session not found");
          return automation;
        },
        configureWeekly: async (input) => {
          const automation = await this.configureWeeklyAutomation(pair.id, input);
          if (!automation) throw new Error("Butler session not found");
          return automation;
        },
        configureWindow: async (input) => {
          const automation = await this.configureWindowAutomation(pair.id, input);
          if (!automation) throw new Error("Butler session not found");
          return automation;
        },
        configureInterval: async (input) => {
          const automation = await this.configureIntervalAutomation(pair.id, input);
          if (!automation) throw new Error("Butler session not found");
          return automation;
        },
        setEnabled: async (enabled) => {
          const automation = await this.setAutomationEnabled(pair.id, enabled);
          if (!automation) throw new Error("This session does not have an automation");
          return automation;
        },
        delete: () => this.deleteAutomation(pair.id)
      },
      operatorSink: {
        onDelegationAcknowledgement: ({ threadId, text, runtime, harness, provider, model, effort, replacesThreadId }) => {
          const thread = this.options.store.getThread(threadId);
          const before = this.options.pairStore.getPair(pair.id);
          const previousDefaultCwd = before?.defaultCwd ?? null;
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
            harness: harness === "pi" ? "pi" : null,
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
              if (!this.options.pairStore.restoreWorkerIfCurrent(pair.id, threadId, previousWorker, previousDefaultCwd)) return false;
              this.syncPairSnapshot(pair.id);
              return true;
            }
          };
        },
        onOperatorReply: () => this.syncPairSnapshot(pair.id)
      },
      getWorkerDefaults: () => {
        const current = this.options.pairStore.getPair(pair.id);
        const runtimeOwnerThreadIds: string[] = [];
        if (current?.worker?.threadId) runtimeOwnerThreadIds.push(current.worker.threadId);
        let predecessor = current?.worker?.handedOffFrom ?? null;
        while (predecessor) {
          runtimeOwnerThreadIds.push(predecessor.threadId);
          predecessor = predecessor.handedOffFrom ?? null;
        }
        return {
          runtime: "auto",
          cwd: current?.worker?.cwd ?? current?.defaultCwd ?? "/repos",
          threadId: current?.worker?.threadId ?? null,
          ...(runtimeOwnerThreadIds.length > 0 ? { runtimeOwnerThreadIds } : {}),
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
        butlerLastError: redactSensitiveText(error instanceof Error ? error.message : String(error))
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
      butlerLastError: redactSensitiveText((pair ? butlerModelAvailabilityError(pair, shell) : null) ?? shell.lastError ?? "") || null,
      messageCount: messageCount ?? latestPage?.totalCount ?? 0,
      lastMessage: latestMessage ? mapButlerMessage(latestMessage) : null,
      updatedAt: latestMessage?.at ?? Date.now()
    });
  }
}
