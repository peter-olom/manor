import { EventEmitter } from "node:events";
import { promises as fs } from "node:fs";
import path from "node:path";
import { getModel } from "@mariozechner/pi-ai";
import { defineTool, type AgentSession, type ModelRegistry } from "@mariozechner/pi-coding-agent";
import type { TSchema } from "@sinclair/typebox";
import {
  buildChatCallbackText,
  buildCloseoutId,
  buildOperatorThreadGuard,
  buildFallbackChatCallbackText,
  buildLatestProofMap,
  buildMessagePage,
  buildSystemPrompt,
  collapseCallbackDuplicateMessages,
  contentToText,
  describePendingCallbacks,
  extractLatestNoticeTexts,
  findVerificationArtifact,
  getFallbackTurnId,
  getVisibleThreadProofs,
  isAssistantFailureMessage,
  isCallbackOutstanding,
  latestCompletedAgentMessageAt,
  MAX_HISTORY_PAGE_SIZE,
  mergeVisibleMessages,
  normalizeNoticeText,
  parseProofScreenshotReview,
  sanitizeHistoryMessage,
  sanitizeHistoryMessages,
  selectReviewableProofArtifacts,
  serializeMessages,
  SNAPSHOT_MESSAGE_TAIL_LIMIT,
  summarizeToolResultDetails,
  summarizeNoticeResult,
  type ButlerOperatorThreadGuard,
  type PendingChatCallback,
  type ProofScreenshotReview,
  type ResolvedPreviewProof,
  type SupervisionSmokePlan
} from "./butler-agent-helpers.js";
import { buildButlerWorkerTools } from "./butler-agent-codex-tools.js";
import type { ButlerAgentDefaults, ButlerAgentServiceOptions, ButlerDelegationAttachmentAcknowledgement, ButlerOperatorSink, ButlerWorkerDefaults } from "./butler-agent-options.js";
import { clearPendingOperatorPrompts, createOrRefreshButlerSession, getButlerLiveSnapshot, getButlerMessagePage, getButlerShellSnapshot, getButlerSnapshot, keepPendingOperatorPromptsBefore, promptButler, promptButlerInternal, registerPendingOperatorPrompt, removePendingOperatorPrompt, stopButlerPrompt, restoreButlerCompactionState, sanitizeButlerSessionMessages, sanitizePersistedButlerSessions, updateButlerComposeSettings } from "./butler-agent-session.js";
import { clearButlerSessionChat, deleteButlerSessionChatFromLocated, keepOperatorMessagesBefore, locateButlerSessionDeletePoint, locateButlerSessionDeletePointBeforeTimestamp } from "./butler-agent-chat-hygiene.js";
import { buildButlerDelegationContract } from "./butler-agent-delegation-contract-builder.js";
import { buildDelegationDeveloperInstructions } from "./butler-agent-delegation-instructions.js";
import { buildButlerFilesystemTools } from "./butler-agent-filesystem-tools.js";
import { buildButlerServiceTools } from "./butler-agent-service-tools.js";
import { buildButlerManorTools } from "./butler-agent-manor-tools.js";
import { buildButlerOperatorTools } from "./butler-agent-operator-tools.js";
import { answerOperatorQuestionMessage, postOperatorQuestionMessage, recordOperatorQuestionTasteMemory, recoverInterruptedOperatorQuestionDeliveries, settleOperatorQuestionDelivery } from "./butler-agent-operator-question.js";
import { buildButlerProjectTools } from "./butler-agent-project-tools.js";
import { buildButlerDelegationTools, buildButlerStackPreviewTools } from "./butler-agent-stack-preview-tools.js";
import { reviewButlerProofScreenshot } from "./butler-agent-proof-review.js";
import type { ButlerAgentSessionAccess, ButlerAgentToolAccess } from "./butler-agent-tool-access.js";
import { BUTLER_TOOL_CATALOG } from "./butler-agent-tool-catalog.js";
import { keepButlerActivityBefore } from "./butler-activity.js";
import { ButlerActivitySummaryState } from "./butler-activity-summary-state.js";
import { loadButlerCallbackState, reconcileReservedCallbackDispatch, saveButlerCallbackState } from "./butler-callback-state.js";
import { applyCallbackReviewFailure, beginCallbackReviewAttempt, CallbackReviewScheduler, isCallbackReviewAutomationPause, isCallbackReviewRetryablePause, isCurrentCallbackReview, pauseCallbackReview, persistCallbackReviewProgress, prepareCallbackReviewRetry, runCallbackAdversarialReview, selectRunnableCallbackReviews, shouldIgnoreCallbackReviewFailure } from "./butler-callback-review-runner.js";
import { blockCloseoutReview, getOperatorCloseoutBlocker as getCloseoutBlocker, idleCloseoutReview, isSameBlockedCloseout, queueCloseoutReview, recordGatedCloseout, relevantTerminalWorkerReport } from "./butler-closeout-gate.js";
import { backfillOperatorMessagesFromSessionFiles, normalizeOperatorMessages, normalizeOperatorQuestion, removeOperatorMessage, upsertOperatorMessage } from "./butler-operator-messages.js";
import { postOperatorJobReply as deliverOperatorJobReply, type OperatorJobReplyAccess } from "./butler-operator-closeout.js";
import { readButlerAuthStatus, readCodexAuthStatus } from "./auth-status.js";
import { backfillDirectCodexMessagesFromSessionFiles, buildDirectCodexMessagePingSummary, notifyDirectCodexMessage, type DirectCodexMessageAccess, type DirectCodexMessagePingInput } from "./direct-codex-message.js";
import { type FileReferenceStore } from "./file-store.js";
import { HostControllerClient } from "./host-controller-client.js";
import { ManorRestartRequestState } from "./manor-restart-state.js";
import { buildOnboardingView, codexHarnessOnboardingRequired } from "./onboarding-status.js";
import { type ImageReferenceStore } from "./image-store.js";
import {
  bindJobPayloadDelivery as bindStoredJobPayloadDelivery,
  buildJobPayload,
  formatJobPayloadMessage,
  jobPayloadsRoot,
  persistJobPayload,
  updateJobPayload,
  type JobPayloadKind
} from "./job-instruction-artifacts.js";
import { writeJsonStateFileAtomic } from "./json-state-file.js";
import { redactSensitiveText } from "./redact-sensitive-text.js";
import { assertCallbackReviewCurrent, getCallbackReviewExecution, runButlerJobMutationGuardedTool, runOutsideJobMutationContext, runSerializedCallbackReplacement, runSerializedJobMutation, runSerializedJobMutations } from "./butler-job-mutation-guard.js";
import type { MemoryUpdateScheduler } from "./memory-update-scheduler.js";
import { createManorModelRegistry, modelToModelOption } from "./model-provider-config.js";
import { loadWorkerThread, sendWorkerMessage, type WorkerClientAccess } from "./worker-client-router.js";
import { handoffWorkerAtomically } from "./worker-handoff.js";
import { decoratePreviewVerification } from "./preview-verification.js";
import { ensureTaskWorktree, resolveExistingWorkspaceCwd, resolveWorkspaceBranchName, resolveWorkspaceProjectInfo, taskRequiresManagedWorktree } from "./repo-worktree.js";
import { RuntimeBrokerClient } from "./runtime-broker-client.js";
import { type LoadedServiceTemplate, ServiceTemplateRegistry, toServiceLeaseView } from "./service-templates.js";
import { formatStackStorageSummary, normalizeStackStorageMode } from "./stack-storage.js";
import { applyWorkspacePreviewDefaults, formatWorkspaceBootstrapLines, inspectWorkspaceBootstrap } from "./workspace-bootstrap.js";
import type {
  AppSnapshot,
  AppShellSnapshot,
  ButlerLiveSnapshot,
  ButlerActivityTurnView,
  ButlerAuthStatus,
  ButlerThreadCallbackView,
  ButlerCompactionView,
  ButlerMessageView,
  ButlerMessagePageView,
  ButlerOnboardingView,
  ButlerOperatorQuestionView,
  ButlerRoutingDecisionView,
  ButlerThinkingLevel,
  ButlerToolUiEffect,
  ButlerToolView,
  ButlerTraceItemView,
  ButlerTraceMetaView,
  CodexThreadExecutionContractView,
  JobMemoryPromotionCandidateView,
  ModelOption,
  ReasoningEffort,
  SupervisionChecklistView
} from "./types.js";
import { ButlerStateStore } from "./state-store.js";
import { CodexAppServerClient } from "./codex-client.js";
import type { PiRpcWorkerClient } from "./pi-rpc-worker-client.js";
import type { PreviewLeaseView, PreviewProofRecordView, PreviewVerificationArtifactView, PreviewVerificationView, ProjectMemoryView } from "./types.js";
const CALLBACK_RECOVERY_TIMEOUT_MS = 30_000;
import { readPersistedTrace, readPersistedTraceMeta } from "./butler-trace-persistence.js";

function isButlerAuthRecoveryError(message: string | null): boolean {
  return typeof message === "string" && /\b(auth|authentication|token|signing in)\b/i.test(message);
}
import { ButlerTraceBuffer } from "./butler-trace-buffer.js";
import { getActiveManorSettings } from "./manor-settings-runtime.js";
import { buildButlerProviderWebTools, PROVIDER_WEB_FETCH_TOOL_NAME, PROVIDER_WEB_SEARCH_TOOL_NAME } from "./provider-web-tools.js";
import { piThinkingLevelForModelOption } from "./pi-thinking-levels.js";
export class ButlerAgentService extends EventEmitter {
  private readonly store: ButlerStateStore;
  private readonly codexClient: CodexAppServerClient;
  private readonly piRpcWorkerClient: PiRpcWorkerClient | null;
  private readonly hostController: HostControllerClient;
  private readonly runtimeBroker: RuntimeBrokerClient;
  private readonly serviceTemplateRegistry: ServiceTemplateRegistry;
  private readonly imageStore: ImageReferenceStore;
  private readonly fileStore: FileReferenceStore;
  private readonly piAuthPath: string;
  private readonly codexAuthPath: string;
  private readonly codexConfigDir: string;
  private readonly sessionDir: string;
  private readonly artifactsDir: string;
  private readonly runtimeThreadId: string;
  private readonly operatorMessageStatePath: string;
  private readonly activitySummaryState: ButlerActivitySummaryState;
  private readonly callbackStatePath: string;
  private readonly refreshRuntimeInventory: (() => Promise<void>) | null;
  private readonly manorRestartRequests: ManorRestartRequestState;
  private readonly memoryScheduler: MemoryUpdateScheduler | null;
  private readonly systemPromptSuffix: string | null;
  private readonly operatorSink: ButlerOperatorSink | null;
  private modelRegistry: ModelRegistry | null = null;
  private session: AgentSession | null = null;
  private auth: ButlerAuthStatus = { mode: "none", loggedIn: false, validationError: null, lastValidatedAt: null };
  private codexAuth: ButlerAuthStatus = { mode: "none", loggedIn: false, validationError: null, lastValidatedAt: null };
  private onboarding: ButlerOnboardingView = {
    complete: false,
    steps: []
  };
  private ready = false;
  private pending = false;
  private stopRequestedAt: number | null = null;
  private readonly activityTurns: ButlerActivityTurnView[] = [];
  private readonly activitySummaryTurns: ButlerActivityTurnView[] = [];
  private activeActivityTurnId: string | null = null;
  private activitySequence = 0;
  private lastError: string | null = null;
  private promptQueue: Promise<void> = Promise.resolve();
  private stopRequestSequence = 0;
  private toolCatalog: ButlerToolView[];
  private unsubscribeSession: (() => void) | null = null;
  private statusRefreshTimer: NodeJS.Timeout | null = null;
  private readonly operatorMessages: ButlerMessageView[] = [];
  private readonly pendingOperatorMessages: ButlerMessageView[] = []; private pendingOperatorMessageSequence = 0; private pendingOperatorMessageRevision = 0;
  private readonly traceBuffer: ButlerTraceBuffer = new ButlerTraceBuffer();
  private readonly pendingChatCallbacks = new Map<string, PendingChatCallback>();
  private readonly deliveredCloseoutIds = new Set<string>();
  private readonly supervisionSmokePlans = new Map<string, SupervisionSmokePlan>();
  private readonly delegationInstructionCache = new Map<string, { signature: string; text: string; contract: CodexThreadExecutionContractView }>();
  private readonly actedSmokeMilestoneIds = new Set<string>();
  private readonly storeChangeHandler = () => this.handleStoreChange();
  private recentThreadFocus: Array<{ threadId: string; notedAt: number; reason: string | null }> = [];
  private activeOperatorThreadGuard: ButlerOperatorThreadGuard | null = null;
  private smokeReactionInFlight = false; private quiescing = false;
  private smokeReactionQueued = false;
  private readonly callbackReviewScheduler: CallbackReviewScheduler;
  private readonly callbackReviewNotBefore = new Map<string, number>();
  private readonly callbackReviewFailureCount = new Map<string, number>(); private callbackStateSaveTail: Promise<void> = Promise.resolve();
  private compaction: Omit<ButlerCompactionView, "autoEnabled" | "active" | "count"> = {
    lastReason: null,
    lastStartedAt: null,
    lastCompletedAt: null,
    lastTokensBefore: null,
    lastWillRetry: false,
    lastAborted: false,
    lastError: null
  };
  constructor(private readonly options: ButlerAgentServiceOptions) {
    super();
    this.store = options.store;
    this.codexClient = options.codexClient;
    this.piRpcWorkerClient = options.piRpcWorkerClient ?? null;
    this.hostController = options.hostController;
    this.runtimeBroker = options.runtimeBroker;
    this.serviceTemplateRegistry = options.serviceTemplateRegistry;
    this.imageStore = options.imageStore;
    this.fileStore = options.fileStore;
    this.piAuthPath = options.piAuthPath;
    this.codexAuthPath = options.codexAuthPath;
    this.codexConfigDir = options.codexConfigDir;
    this.sessionDir = options.sessionDir;
    this.artifactsDir = options.artifactsDir;
    this.runtimeThreadId = options.runtimeThreadId?.trim() || "butler";
    this.refreshRuntimeInventory = options.refreshRuntimeInventory ?? null;
    this.memoryScheduler = options.memoryScheduler ?? null;
    this.systemPromptSuffix = options.systemPromptSuffix?.trim() || null;
    this.operatorSink = options.operatorSink ?? null;
    this.operatorMessageStatePath = path.join(this.sessionDir, "operator-messages.json");
    this.activitySummaryState = new ButlerActivitySummaryState(path.join(this.sessionDir, "activity-summaries.json"), this.activitySummaryTurns, (error) => {
      this.lastError = `Butler activity history could not be saved: ${redactSensitiveText(error instanceof Error ? error.message : String(error))}`;
      console.warn(this.lastError);
      this.emit("change");
    });
    this.callbackStatePath = path.join(this.sessionDir, "chat-callbacks.json");
    this.callbackReviewScheduler = new CallbackReviewScheduler(
      () => this.processCallbackReviews(),
      (error) => { console.warn("Background callback review failed", error instanceof Error ? error.message : String(error)); }
    );
    this.manorRestartRequests = new ManorRestartRequestState(path.join(this.sessionDir, "manor-restart-requests.json"), this.hostController, (error) => {
      this.lastError = error instanceof Error ? error.message : String(error);
      this.emit("change");
    }, () => this.emit("change"));
    this.toolCatalog = this.buildToolCatalog();
  }
  private async refreshRuntimeInventoryIfAvailable(): Promise<string | null> {
    if (!this.refreshRuntimeInventory) return null;
    try {
      await this.refreshRuntimeInventory();
      return null;
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  }
  private async loadOperatorMessageState(): Promise<void> {
    try {
      const raw = await fs.readFile(this.operatorMessageStatePath, "utf8");
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) {
        return;
      }
      this.operatorMessages.splice(0, this.operatorMessages.length);
      for (const item of parsed) {
        if (!item || typeof item !== "object") {
          continue;
        }
        const id = typeof item.id === "string" ? item.id : null;
        const role = typeof item.role === "string" ? item.role : null;
        const text = typeof item.text === "string" ? item.text : null;
        const at = typeof item.at === "number" && Number.isFinite(item.at) ? item.at : null;
        const taskDurationMs = typeof item.taskDurationMs === "number" && Number.isFinite(item.taskDurationMs) ? item.taskDurationMs : null;
        const kind = item.kind === "message" || typeof item.kind !== "string" ? "message" : null;

        if (!id || !role || !text || !kind) {
          continue;
        }

        const question = normalizeOperatorQuestion((item as Record<string, unknown>).question);
        const trace = readPersistedTrace((item as Record<string, unknown>).trace);
        const traceMeta = readPersistedTraceMeta((item as Record<string, unknown>).traceMeta);
        const next: ButlerMessageView = { id, role, text, at, taskDurationMs, kind, ...((item as Record<string, unknown>).providerBacked === true ? { providerBacked: true } : {}), ...(typeof (item as Record<string, unknown>).providerSucceeded === "boolean" ? { providerSucceeded: (item as Record<string, unknown>).providerSucceeded as boolean } : {}), ...(question ? { question } : {}) };
        if (trace && trace.length > 0) next.trace = trace;
        if (traceMeta) next.traceMeta = traceMeta;
        this.operatorMessages.push(next);
      }

      if (normalizeOperatorMessages(this.operatorMessages)) await this.saveOperatorMessageState();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }

    }
  }

  private async loadCallbackState(): Promise<void> {
    await loadButlerCallbackState({
      callbackStatePath: this.callbackStatePath,
      pendingChatCallbacks: this.pendingChatCallbacks,
      deliveredCloseoutIds: this.deliveredCloseoutIds
    });
  }

  async saveOperatorMessageState(): Promise<void> { normalizeOperatorMessages(this.operatorMessages); await writeJsonStateFileAtomic(this.operatorMessageStatePath, this.operatorMessages); }

  private loadActivitySummaryState(): Promise<void> { return this.activitySummaryState.load(); }

  private saveActivitySummaryState(): Promise<void> { return this.activitySummaryState.save(); }

  private persistActivitySummaryTurn(turn: ButlerActivityTurnView): void { void this.activitySummaryState.persistTurn(turn); }

  private saveCallbackState(): Promise<void> {
    const save = this.callbackStateSaveTail.catch(() => {}).then(() => saveButlerCallbackState({
      callbackStatePath: this.callbackStatePath,
      pendingChatCallbacks: this.pendingChatCallbacks,
      deliveredCloseoutIds: this.deliveredCloseoutIds
    }));
    this.callbackStateSaveTail = save; return save;
  }
  async clearChat(): Promise<void> { await this.memoryScheduler?.beforeButlerChatClear([...this.operatorMessages]); this.operatorMessages.splice(0, this.operatorMessages.length); clearPendingOperatorPrompts(this.getSessionAccess(), { includeCommitted: true }); this.activityTurns.splice(0, this.activityTurns.length); this.activitySummaryTurns.splice(0, this.activitySummaryTurns.length); this.activeActivityTurnId = null; this.traceBuffer.reset(); await Promise.all([this.saveOperatorMessageState(), this.saveActivitySummaryState()]); clearButlerSessionChat(this.session); this.lastError = null; this.emit("change"); }

  async deleteChatFromMessage(messageId: string): Promise<void> { const syntheticMessage = this.pendingOperatorMessages.find((message) => message.id === messageId); const deletePoint = syntheticMessage ? locateButlerSessionDeletePointBeforeTimestamp(this.session, messageId, syntheticMessage.at) : locateButlerSessionDeletePoint(this.session, messageId); await this.memoryScheduler?.beforeButlerChatDeleteFrom({ messageId, deleteFromTimestamp: deletePoint.targetAt, messages: [...this.operatorMessages] }); const deleteFrom = deleteButlerSessionChatFromLocated(this.session, deletePoint); keepOperatorMessagesBefore(this.operatorMessages, deleteFrom); keepPendingOperatorPromptsBefore(this.getSessionAccess(), deleteFrom); const prunedActivity = keepButlerActivityBefore(this as unknown as ButlerAgentSessionAccess, deleteFrom); await Promise.all([this.saveOperatorMessageState(), ...(prunedActivity ? [this.saveActivitySummaryState()] : [])]); this.lastError = null; this.emit("change"); }

  async notifyDirectCodexMessage(input: DirectCodexMessagePingInput & { threadId: string }): Promise<void> { await notifyDirectCodexMessage(this as unknown as DirectCodexMessageAccess, input); }
  async reserveDirectCodexMessage(input: DirectCodexMessagePingInput & { threadId: string; requestedAt: number }): Promise<{ callback: PendingChatCallback | null; failureCount: number | null; notBefore: number | null }> { const callback = this.pendingChatCallbacks.get(input.threadId); const reservation = { callback: callback ? { ...callback } : null, failureCount: this.callbackReviewFailureCount.get(input.threadId) ?? null, notBefore: this.callbackReviewNotBefore.get(input.threadId) ?? null }; await this.registerPendingChatCallback(input.threadId, { privateSteerText: buildDirectCodexMessagePingSummary(input), nextWorkerReportAction: "review", requestedAt: input.requestedAt, dispatchState: "reserving" }); return reservation; }
  async markPendingChatCallbackDispatched(threadId: string, requestedAt: number): Promise<void> { if (this.quiescing) return; await runSerializedCallbackReplacement(threadId, async () => { if (this.quiescing) return; const callback = this.pendingChatCallbacks.get(threadId); if (!callback || callback.requestedAt !== requestedAt) return; callback.dispatchState = "ready"; callback.updatedAt = Date.now(); await this.saveCallbackState(); this.emit("change"); }); }
  async rollbackDirectCodexMessage(threadId: string, requestedAt: number, reservation: { callback: PendingChatCallback | null; failureCount: number | null; notBefore: number | null }): Promise<void> { if (this.quiescing) return; const resume = await runSerializedCallbackReplacement(threadId, async () => { if (this.quiescing || this.pendingChatCallbacks.get(threadId)?.requestedAt !== requestedAt) return false; const callback = reservation.callback?.reviewState === "running" ? { ...reservation.callback, reviewState: "queued" as const, updatedAt: Date.now() } : reservation.callback; if (callback) this.pendingChatCallbacks.set(threadId, callback); else this.pendingChatCallbacks.delete(threadId); if (reservation.failureCount === null) this.callbackReviewFailureCount.delete(threadId); else this.callbackReviewFailureCount.set(threadId, reservation.failureCount); if (reservation.notBefore === null) this.callbackReviewNotBefore.delete(threadId); else this.callbackReviewNotBefore.set(threadId, reservation.notBefore); await this.saveCallbackState(); this.emit("change"); return callback?.reviewState === "queued"; }); if (resume) runOutsideJobMutationContext(() => this.callbackReviewScheduler.schedule()); }
  private async registerPendingChatCallback(threadId: string, options?: { privateSteerText?: string | null; preservePrivateSteer?: boolean; nextWorkerReportAction?: "review" | "reply_to_operator"; requestedAt?: number | null; dispatchState?: "ready" | "reserving" }): Promise<void> { if (this.quiescing) throw new Error("Butler session is closing."); await runSerializedCallbackReplacement(threadId, async () => { assertCallbackReviewCurrent(threadId); if (this.quiescing) throw new Error("Butler session is closing.");
    const now = Date.now();
    const requestedAt = typeof options?.requestedAt === "number" && Number.isFinite(options.requestedAt) ? options.requestedAt : now;
    const existing = this.pendingChatCallbacks.get(threadId);
    const suppliedPrivateSteer = typeof options?.privateSteerText === "string" && options.privateSteerText.trim() ? options.privateSteerText.trim() : null;
    const preservePrivateSteer = options?.preservePrivateSteer === true && existing && isCallbackOutstanding(existing);
    const privateSteerText = suppliedPrivateSteer ?? (preservePrivateSteer ? existing.lastPrivateSteerText : null);
    const lastPrivateSteerAt = suppliedPrivateSteer ? requestedAt : preservePrivateSteer ? existing.lastPrivateSteerAt : null;
    const nextWorkerReportAction = options?.nextWorkerReportAction === "reply_to_operator" ? "reply_to_operator" : "review";
    this.resetCallbackReviewFailures(threadId);
    const reviewModel = this.session?.model ?? null;
    const reviewReasoningLevel = getButlerShellSnapshot(this.getSessionAccess()).compose?.thinkingLevel ?? "off";
    this.pendingChatCallbacks.set(threadId, {
      threadId,
      callbackState: "waiting", dispatchState: options?.dispatchState ?? "ready",
      resolutionState: null,
      requestedAt,
      lastEventAt: requestedAt,
      lastWorkerStatusSeen: this.store.getThread(threadId)?.status ?? null,
      lastTerminalReportAt: null,
      lastPrivateSteerText: privateSteerText,
      lastPrivateSteerAt,
      nextWorkerReportAction,
      operatorCloseoutStatus: "owed",
      owesOperatorReply: true,
      closeoutChannel: "none",
      reviewState: "idle",
      reviewReason: null,
      reviewModelProvider: reviewModel?.provider ?? null,
      reviewModelId: reviewModel?.id ?? null,
      reviewReasoningLevel,
      blockedCloseoutReason: null,
      blockedCloseoutReportAt: null,
      closedAt: null,
      updatedAt: now
    });
    this.store.addEvent(threadId, existing ? "butler.callback.rearmed" : "butler.callback.registered", existing
      ? "Butler renewed the operator closeout obligation after a private steer."
      : "Butler registered an operator closeout obligation.");
    await this.saveCallbackState();
  }); }
  private attachDelegationAcknowledgement(threadId: string, text: string, at: number, selection: {
    runtime?: "openai" | "pi-rpc" | null;
    harness?: string | null;
    provider?: string | null;
    model?: string | null;
    effort?: string | null;
    replacesThreadId?: string | null;
  }): ButlerDelegationAttachmentAcknowledgement | void {
    const acknowledgement = this.operatorSink?.onDelegationAcknowledgement?.({ threadId, text, at, ...selection });
    if (selection.replacesThreadId && acknowledgement?.attached !== true) {
      throw new Error("The active worker changed before the handoff could be attached.");
    }
    return acknowledgement;
  }
  private postDelegationAcknowledgement(threadId: string, text: string, at: number): void {
    const messageId = `delegation-ack-${threadId}`;
    upsertOperatorMessage(this.operatorMessages, messageId, text, at);
    this.noteThreadFocus(threadId, "delegation");
    this.store.addEvent(threadId, "butler.acknowledgement.posted", "Butler posted the operator-facing delegation acknowledgement.");
    void this.saveOperatorMessageState();
    this.emit("change");
  }
  private queueDelegationAcknowledgement(threadId: string, text: string, selection: {
    runtime?: "openai" | "pi-rpc" | null;
    harness?: string | null;
    provider?: string | null;
    model?: string | null;
    effort?: string | null;
    replacesThreadId?: string | null;
  } = {}): ButlerDelegationAttachmentAcknowledgement | void {
    const at = Date.now();
    const acknowledgement = this.attachDelegationAcknowledgement(threadId, text, at, selection); if (acknowledgement?.attached === false) return acknowledgement;
    this.postDelegationAcknowledgement(threadId, text, at);
    return acknowledgement;
  }

  private async postOperatorQuestion(input: {
    prompt?: string;
    context?: string | null;
    options?: Array<{ id?: string | null; label: string; description?: string | null }>;
    allowFreeform?: boolean;
    questions?: Array<{
      prompt: string;
      context?: string | null;
      options: Array<{ id?: string | null; label: string; description?: string | null }>;
      allowFreeform?: boolean;
    }>;
  }): Promise<ButlerMessageView & { question: ButlerOperatorQuestionView }> {
    return postOperatorQuestionMessage({
      messages: this.operatorMessages,
      save: () => this.saveOperatorMessageState(),
      emitChange: () => this.emit("change")
    }, input);
  }
  async answerOperatorQuestion(input: { messageId: string; questionId: string; optionId?: string; freeformText?: string }): Promise<{ complete: boolean; queued: boolean; message: ButlerMessageView & { question: ButlerOperatorQuestionView } }> {
    const messageAccess = { messages: this.operatorMessages, save: () => this.saveOperatorMessageState(), emitChange: () => this.emit("change") };
    const answer = await answerOperatorQuestionMessage(messageAccess, input);
    if (answer.complete) recordOperatorQuestionTasteMemory(this.store, answer.message);
    if (answer.replyText) {
      const settle = (delivered: boolean, error: string | null = null) => settleOperatorQuestionDelivery(messageAccess, { messageId: answer.message.id, delivered, error });
      try {
        const delivery = await this.prepareOperatorTurn(answer.replyText, [], { mode: "queue", displayText: answer.replyText, removeOnFailure: true });
        void delivery.completion
          .then((delivered) => settle(delivered, delivered ? null : this.lastError), (error) => settle(false, error instanceof Error ? error.message : String(error)))
          .catch((error) => { this.lastError = error instanceof Error ? error.message : String(error); this.emit("change"); });
      } catch (error) { await settle(false, error instanceof Error ? error.message : String(error)); throw error; }
    }
    return { complete: answer.complete, queued: answer.queued, message: answer.message };
  }
  private async postOperatorJobReply(threadId: string, text: string): Promise<void> { await deliverOperatorJobReply(this as unknown as OperatorJobReplyAccess, threadId, text); }
  private describePendingCallbacks(): string {
    return describePendingCallbacks(this.store, [...this.pendingChatCallbacks.values()]);
  }
  private async reconcilePendingChatCallbacks(): Promise<void> { if (this.quiescing) return;
    const outstandingCallbacks = [...this.pendingChatCallbacks.values()].filter(isCallbackOutstanding);
    if (outstandingCallbacks.length === 0) {
      return;
    }
    let changed = false;
    await Promise.allSettled(outstandingCallbacks.map((callback) => runSerializedJobMutation(callback.threadId, async () => {
      if (this.quiescing || this.pendingChatCallbacks.get(callback.threadId) !== callback || !isCallbackOutstanding(callback)) return;
      const now = Date.now();
      callback.updatedAt = now;
      try {
        await loadWorkerThread(this.getWorkerClientAccess(), callback.threadId); if (this.quiescing) return;
      } catch { if (this.quiescing) return;
        if (!this.store.getThread(callback.threadId)) { await this.removeExternalWorkerDelegation(callback.threadId); return; }
        callback.lastWorkerStatusSeen = "unknown";
        changed = true;
        if (callback.dispatchState !== "reserving") return;
      }
      const thread = this.store.getThread(callback.threadId);
      const dispatchState = reconcileReservedCallbackDispatch(callback, thread);
      if (dispatchState === "drop") { await this.removeExternalWorkerDelegation(callback.threadId); return; }
      if (dispatchState === "ready") { callback.dispatchState = "ready"; changed = true; }
      if (callback.dispatchState === "reserving") return;
      const workerReport = this.store.getWorkerReport(callback.threadId);
      const relevantWorkerReport = relevantTerminalWorkerReport(thread, workerReport, callback.requestedAt);
      const closeoutTurnId = relevantWorkerReport?.turnId ?? getFallbackTurnId(thread);
      if (closeoutTurnId) {
        const closeoutId = buildCloseoutId(callback.threadId, closeoutTurnId);
        const postedMessage = this.operatorMessages.find((message) =>
          (message.id === `callback-${closeoutId}` || message.id === `callback-fallback-${closeoutId}`) &&
          typeof message.at === "number" && message.at >= callback.requestedAt
        );
        if (postedMessage) {
          await this.postOperatorJobReply(callback.threadId, postedMessage?.text ?? "Already delivered.");
          changed = true;
          return;
        }
      }
      const nextStatus = thread?.status ?? "unknown";
      const latestAgentReplyAt = latestCompletedAgentMessageAt(thread);
      const hasRecoverableThreadReply = nextStatus === "idle" && Boolean(thread?.supervisor.latestAgentReply?.trim()) && latestAgentReplyAt !== null && latestAgentReplyAt >= callback.requestedAt;
      const callbackTimedOut = hasRecoverableThreadReply && now - latestAgentReplyAt >= CALLBACK_RECOVERY_TIMEOUT_MS;
      const nextCallbackState =
        relevantWorkerReport
          ? "received_worker_callback"
          : hasRecoverableThreadReply && callbackTimedOut ? "missing_worker_callback" : "waiting";

      if (callback.lastWorkerStatusSeen !== nextStatus || callback.callbackState !== nextCallbackState) {
        callback.lastWorkerStatusSeen = nextStatus;
        callback.lastEventAt = relevantWorkerReport?.updatedAt ?? latestAgentReplyAt ?? thread?.updatedAt ?? now;
        callback.lastTerminalReportAt = relevantWorkerReport?.updatedAt ?? callback.lastTerminalReportAt;
        if (callback.callbackState !== "received_worker_callback" && nextCallbackState === "received_worker_callback") {
          callback.reviewState = "queued";
          callback.reviewReason = "worker_callback";
        }
        if (callback.callbackState !== "missing_worker_callback" && nextCallbackState === "missing_worker_callback") {
          this.store.addEvent(callback.threadId, "butler.callback.missing", "No worker callback arrived, so Butler is checking thread state directly.");
          callback.reviewState = "queued";
          callback.reviewReason = "thread_recovery";
        }
        callback.callbackState = nextCallbackState;
        callback.updatedAt = now;
        changed = true;
      }
    }))); if (this.quiescing) return;

    if (changed) {
      await this.saveCallbackState();
    }

    await this.processPendingChatCallbacks();
  }

  private async processPendingChatCallbacks(): Promise<boolean> { if (this.quiescing) return false; return runSerializedJobMutations([...this.pendingChatCallbacks.values()].filter((callback) => isCallbackOutstanding(callback) && callback.dispatchState !== "reserving").map((callback) => callback.threadId), async () => { if (this.quiescing) return false;
    const outstandingCallbacks = [...this.pendingChatCallbacks.values()].filter((callback) => isCallbackOutstanding(callback) && callback.dispatchState !== "reserving");
    if (outstandingCallbacks.length === 0) {
      return false;
    }

    let changed = false;
    for (const callback of outstandingCallbacks) {
      if (!isCallbackOutstanding(callback)) {
        continue;
      }
      const thread = this.store.getThread(callback.threadId);
      if (!thread) {
        continue;
      }

      const workerReport = this.store.getWorkerReport(callback.threadId);
      const relevantWorkerReport = relevantTerminalWorkerReport(thread, workerReport, callback.requestedAt);
      if (relevantWorkerReport) {
        callback.lastTerminalReportAt = relevantWorkerReport.updatedAt;
        callback.lastEventAt = relevantWorkerReport.updatedAt;
        callback.lastWorkerStatusSeen = thread.status;
        if (callback.reviewState === "blocked") {
          if (isCallbackReviewRetryablePause(callback, relevantWorkerReport.updatedAt)) continue;
          const closeoutBlocker = getCloseoutBlocker(this.store, callback.threadId, { thread, workerReport: relevantWorkerReport });
          if (closeoutBlocker && !closeoutBlocker.startsWith("Adversarial review must finish") && isSameBlockedCloseout(callback, { reason: closeoutBlocker, workerReportUpdatedAt: relevantWorkerReport.updatedAt })) continue;
          queueCloseoutReview(callback, "worker_callback");
          changed = true;
          continue;
        }
        if (callback.nextWorkerReportAction === "reply_to_operator" && relevantWorkerReport.status !== "completed") {
          const text = buildChatCallbackText(thread, relevantWorkerReport);
          if (text) {
            const closeoutBlocker = getCloseoutBlocker(this.store, callback.threadId, { thread, workerReport: relevantWorkerReport });
            if (closeoutBlocker) {
              blockCloseoutReview(callback, {
                reason: closeoutBlocker,
                reviewReason: "worker_callback",
                workerReportUpdatedAt: relevantWorkerReport.updatedAt
              });
              recordGatedCloseout(this.store, callback.threadId, closeoutBlocker);
              changed = true;
              continue;
            }
            await this.postOperatorJobReply(callback.threadId, text);
            changed = true;
            continue;
          }
        }
        if (
          callback.callbackState !== "received_worker_callback" ||
          callback.reviewReason !== "worker_callback" ||
          callback.reviewState === "idle"
        ) {
          callback.callbackState = "received_worker_callback";
          callback.reviewState = "queued";
          callback.reviewReason = "worker_callback";
          callback.updatedAt = Date.now();
          this.store.addEvent(callback.threadId, "butler.callback.received", "Butler received the worker callback and queued an internal supervision review.");
          changed = true;
        }
        continue;
      }

      if (callback.callbackState !== "missing_worker_callback") {
        continue;
      }
      const recoveryReviewActive = callback.reviewState === "queued" || callback.reviewState === "running";
      if (!recoveryReviewActive || callback.reviewReason !== "thread_recovery") {
        if (!recoveryReviewActive) callback.reviewState = "queued";
        callback.reviewReason = "thread_recovery";
        callback.updatedAt = Date.now();
        changed = true;
      }
    }

    if (changed) {
      normalizeOperatorMessages(this.operatorMessages);
      await this.saveOperatorMessageState();
      await this.saveCallbackState();
      this.emit("change");
    }

    return changed;
  }); }

  private handleStoreChange(): void {
    if (this.quiescing) return;
    runOutsideJobMutationContext(() => { void (async () => {
      await this.processPendingChatCallbacks();
      this.callbackReviewScheduler.schedule();
      this.scheduleSmokeTestReactions();
    })().catch((error) => {
      this.lastError = error instanceof Error ? error.message : String(error);
      this.emit("change");
    }); });
  }

  async start(): Promise<void> {
    await fs.mkdir(this.sessionDir, { recursive: true });
    await this.loadOperatorMessageState();
    let operatorStateChanged = await backfillOperatorMessagesFromSessionFiles(this.operatorMessages, this.sessionDir);
    operatorStateChanged = await backfillDirectCodexMessagesFromSessionFiles(this.operatorMessages, process.env.CODEX_SHARED_HOME_DIR || "/codex-home") || operatorStateChanged;
    operatorStateChanged = recoverInterruptedOperatorQuestionDeliveries(this.operatorMessages) || operatorStateChanged;
    if (operatorStateChanged) await this.saveOperatorMessageState();
    await this.loadActivitySummaryState();
    await this.loadCallbackState();
    await this.manorRestartRequests.load();
    this.auth = await readButlerAuthStatus(this.piAuthPath);
    this.codexAuth = await readCodexAuthStatus(this.codexAuthPath);
    this.modelRegistry = await createManorModelRegistry(this.piAuthPath, process.env, { preferredModelRef: this.getButlerDefaults()?.model });
    await this.createOrRefreshSession();
    await this.refreshExternalStatus();
    this.store.on("change", this.storeChangeHandler);
    this.handleStoreChange();
    this.statusRefreshTimer = setInterval(() => {
      void this.refreshExternalStatus();
    }, 10000);

    this.ready = true;
    this.emit("change");
  }

  dispose(): void {
    this.quiescing = true;
    if (this.statusRefreshTimer) clearInterval(this.statusRefreshTimer);
    this.callbackReviewScheduler.dispose();
    this.statusRefreshTimer = null;
    this.store.off("change", this.storeChangeHandler);
    this.unsubscribeSession?.();
    this.unsubscribeSession = null;
  }

  async refreshModelSettings(): Promise<void> { if (this.quiescing) return;
    this.modelRegistry = await createManorModelRegistry(this.piAuthPath, process.env, { preferredModelRef: this.getButlerDefaults()?.model }); if (this.quiescing) return;
    this.toolCatalog = this.buildToolCatalog();
    await this.createOrRefreshSession(); if (this.quiescing) return;
    this.emit("change");
  }

  private async refreshExternalStatus(): Promise<void> { if (this.quiescing) return;
    const nextAuth = await readButlerAuthStatus(this.piAuthPath);
    const nextCodexAuth = await readCodexAuthStatus(this.codexAuthPath); if (this.quiescing) return;
    const clearedStaleAuthError = nextAuth.loggedIn && isButlerAuthRecoveryError(this.lastError);
    const authChanged =
      nextAuth.mode !== this.auth.mode ||
      nextAuth.loggedIn !== this.auth.loggedIn ||
      nextAuth.validationError !== this.auth.validationError ||
      nextCodexAuth.mode !== this.codexAuth.mode ||
      nextCodexAuth.loggedIn !== this.codexAuth.loggedIn ||
      nextCodexAuth.validationError !== this.codexAuth.validationError;

    const butlerAuthChanged =
      nextAuth.mode !== this.auth.mode ||
      nextAuth.loggedIn !== this.auth.loggedIn ||
      nextAuth.validationError !== this.auth.validationError;

    if (butlerAuthChanged) {
      this.auth = nextAuth;
      this.modelRegistry = await createManorModelRegistry(this.piAuthPath, process.env, { preferredModelRef: this.getButlerDefaults()?.model });
      await this.createOrRefreshSession(); if (this.quiescing) return;
    }
    if (authChanged) this.resetCallbackReviewFailures();
    if (clearedStaleAuthError) {
      this.lastError = null;
    }
    this.codexAuth = nextCodexAuth;

    const nextOnboarding = await buildOnboardingView({
      butlerAuth: this.auth,
      codexAuth: this.codexAuth,
      codexConfigDir: this.codexConfigDir,
      codexHarnessRequired: codexHarnessOnboardingRequired(this.getWorkerDefaults(), getActiveManorSettings())
    }); if (this.quiescing) return;

    if (JSON.stringify(nextOnboarding) !== JSON.stringify(this.onboarding) || authChanged || clearedStaleAuthError) {
      this.onboarding = nextOnboarding;
      this.emit("change");
    }

    await this.reconcilePendingChatCallbacks(); if (this.quiescing) return;
    this.callbackReviewScheduler.schedule();
  }
  // This is the single discoverable registry for Butler actions and their UI
  // side effects. Keep agent tool definitions aligned with this catalog.
  private buildToolCatalog(): ButlerToolView[] {
    const base = [...BUTLER_TOOL_CATALOG];
    const activeTools = new Set(this.session?.getActiveToolNames() ?? []);
    if (activeTools.has(PROVIDER_WEB_SEARCH_TOOL_NAME) && activeTools.has(PROVIDER_WEB_FETCH_TOOL_NAME)) {
      base.push(
        { name: PROVIDER_WEB_SEARCH_TOOL_NAME, label: "Web Search", description: "Search the web using the provider configured for the current Butler model.", uiEffects: [] },
        { name: PROVIDER_WEB_FETCH_TOOL_NAME, label: "Web Fetch", description: "Fetch a web page using the provider configured for the current Butler model.", uiEffects: [] }
      );
    }
    return base;
  }

  private getToolUiEffects(name: string): ButlerToolUiEffect[] {
    return this.toolCatalog.find((tool) => tool.name === name)?.uiEffects ?? [];
  }

  private resetCallbackReviewFailures(threadId?: string): void {
    const ids = threadId ? [threadId] : [...this.pendingChatCallbacks.keys()];
    for (const id of ids) {
      this.callbackReviewNotBefore.delete(id);
      this.callbackReviewFailureCount.delete(id);
      const callback = this.pendingChatCallbacks.get(id);
      if (callback && isCallbackReviewAutomationPause(callback)) {
        queueCloseoutReview(callback, callback.reviewReason ?? "worker_callback");
      }
    }
  }

  private getToolAccess(): ButlerAgentToolAccess { return this as unknown as ButlerAgentToolAccess; }

  private getWorkerClientAccess(): WorkerClientAccess {
    return {
      store: this.store,
      codexClient: this.codexClient,
      piRpcWorkerClient: this.piRpcWorkerClient,
      getCodexAuthStatus: () => this.codexAuth,
      getWorkerAffinity: this.options.getWorkerAffinity,
      recordSuccessfulWorkerSelection: this.options.recordSuccessfulWorkerSelection
    };
  }

  private getSessionAccess(): ButlerAgentSessionAccess { return this as unknown as ButlerAgentSessionAccess; }

  getButlerDefaults(): ButlerAgentDefaults | null { return this.options?.getButlerDefaults?.() ?? null; }
  getWorkerDefaults(): ButlerWorkerDefaults | null { return this.options.getWorkerDefaults?.() ?? null; }
  getWorkerAffinity() { return this.options.getWorkerAffinity?.() ?? null; }
  recordSuccessfulWorkerSelection(input: { harness: string; provider: string; model: string; effort?: string | null }) { return this.options.recordSuccessfulWorkerSelection?.(input); }

  resolveMemoryPromotion(candidateId: string, accepted: boolean): { candidate: JobMemoryPromotionCandidateView; projectMemory: ProjectMemoryView | null } | null {
    const candidate = this.store.resolvePromotionCandidate(candidateId, accepted);
    if (!candidate) return null;
    this.memoryScheduler?.observePromotionResolved({
      candidateId: candidate.id,
      accepted,
      projectId: candidate.projectId,
      projectLabel: candidate.projectLabel,
      threadId: candidate.threadId,
      summary: candidate.summary,
      details: candidate.details
    });
    return { candidate, projectMemory: this.store.getProjectMemory(candidate.projectId) };
  }

  private noteThreadFocus(threadId: string, reason?: string): void {
    const thread = this.store.getThread(threadId);
    if (!thread) {
      return;
    }

    const notedAt = Date.now();
    this.recentThreadFocus = [
      { threadId, notedAt, reason: typeof reason === "string" && reason.trim() ? reason.trim() : null },
      ...this.recentThreadFocus.filter((entry) => entry.threadId !== threadId)
    ].slice(0, 8);
  }

  private getRecentFocusedThreadId(): string | null {
    const freshThreshold = Date.now() - 60 * 60 * 1000;
    this.recentThreadFocus = this.recentThreadFocus.filter(
      (entry) => entry.notedAt >= freshThreshold && Boolean(this.store.getThread(entry.threadId))
    );
    return this.recentThreadFocus[0]?.threadId ?? null;
  }

  private getActiveOperatorThreadGuard(): ButlerOperatorThreadGuard | null {
    return this.activeOperatorThreadGuard;
  }
  private defineButlerTool<TParams extends Record<string, unknown>>(definition: {
    name: string;
    label: string;
    description: string;
    promptSnippet: string;
    parameters: TSchema;
    uiEffects: ButlerToolUiEffect[];
    execute: (toolCallId: string, params: TParams, signal?: AbortSignal) => Promise<{ content: Array<{ type: "text"; text: string }>; details?: Record<string, unknown> }>;
  }) {
    return defineTool({
      name: definition.name,
      label: definition.label,
      description: definition.description,
      promptSnippet: definition.promptSnippet,
      parameters: definition.parameters,
      execute: async (toolCallId, params, signal) => runButlerJobMutationGuardedTool(definition.name, params, async () => {
        const result = await definition.execute(toolCallId, params as TParams, signal);
        const details = summarizeToolResultDetails({ ...(result.details ?? {}), uiEffects: definition.uiEffects });
        return { ...result, details };
      })
    });
  }

  private getThreadBudgetLimitMessage(threadId: string): string | null {
    const supervision = this.store.getThreadSupervision(threadId);
    if (supervision.maxButlerTurns === null || supervision.butlerTurnsUsed < supervision.maxButlerTurns) {
      return null;
    }

    return `Butler has reached the supervision limit for job ${threadId}. Used ${supervision.butlerTurnsUsed}/${supervision.maxButlerTurns} Butler turns. Raise the limit on that thread before asking Butler to steer it again.`;
  }

  private getOperatorCloseoutBlocker(threadId: string): string | null { return getCloseoutBlocker(this.store, threadId); }

  get pendingManorRestartRequest(): AppSnapshot["butler"]["pendingManorRestartRequest"] { return this.manorRestartRequests.pendingRequest; }
  get authorizedManorRestartRequest(): AppSnapshot["butler"]["authorizedManorRestartRequest"] { return this.manorRestartRequests.authorizedRequest; }
  requestManorRestartAuthorization(input: Parameters<ManorRestartRequestState["request"]>[0]): NonNullable<AppSnapshot["butler"]["pendingManorRestartRequest"]> { return this.manorRestartRequests.request(input); }
  authorizeManorRestartRequest(requestId: string): NonNullable<AppSnapshot["butler"]["authorizedManorRestartRequest"]> { return this.manorRestartRequests.authorize(requestId); }
  dismissManorRestartRequest(requestId: string): void { this.manorRestartRequests.dismiss(requestId); }
  async startAuthorizedManorRestart(requestId: string) { return this.manorRestartRequests.start(requestId); }
  async getManorRestartStatus() { return this.hostController.getStatus(); }

  private async buildDelegationDeveloperInstructions(workspace: { cwd: string; branchName: string | null }, task: string): Promise<string> { return buildDelegationDeveloperInstructions(workspace, task); }

  private buildSupervisionSmokeTask(totalFollowUps: number): string {
    return [
      "This is a Butler supervision smoke test. Do not edit files, inspect repositories, or use git.",
      `The goal is to prove that Butler can steer this thread privately for ${totalFollowUps} follow-up turns without operator nudging.`,
      "Immediately emit one blocked supervisor report using the thread id from the job brief:",
      "- summary: `Smoke step 1 waiting for Butler`",
      "- details: `Initial smoke report emitted. Waiting for Butler follow-up step 2.`",
      "After that report, reply briefly that step 1 was reported and that you are waiting for Butler.",
      "On each later Butler private follow-up:",
      "- obey the numbered step exactly",
      "- emit the requested supervisor report",
      "- reply briefly that the step was reported and that you are waiting again",
      "- do not continue to any later step until Butler sends the next follow-up",
      "Only finish when Butler explicitly tells you to finalize the smoke test."
    ].join("\n");
  }

  private buildSmokeFollowUpText(plan: SupervisionSmokePlan): string {
    const nextStepNumber = plan.followUpsSent + 2;
    const isFinalFollowUp = plan.followUpsSent + 1 >= plan.totalFollowUps;
    if (isFinalFollowUp) {
      return [
        `Smoke final step ${nextStepNumber}: finalize the supervision smoke test.`,
        `Record a completed supervisor report with summary "Smoke test complete" and details "Butler autonomously steered ${plan.totalFollowUps} private follow-up turns after the initial worker report."`,
        "Then reply briefly that the smoke test is complete."
      ].join("\n");
    }

    const status = nextStepNumber % 2 === 0 ? "completed" : "blocked";
    const summary =
      status === "completed" ? `Smoke step ${nextStepNumber} acknowledged` : `Smoke step ${nextStepNumber} waiting for Butler`;
    const details =
      status === "completed"
        ? `Butler private follow-up ${plan.followUpsSent + 1} landed; worker resumed without operator input.`
        : `Butler private follow-up ${plan.followUpsSent + 1} landed; worker is waiting for the next Butler decision.`;

    return [
      `Smoke step ${nextStepNumber}: continue the supervision smoke test.`,
      `Record a ${status} supervisor report with summary "${summary}" and details "${details}"`,
      "Then reply briefly that the step was reported and that you are waiting for Butler."
    ].join("\n");
  }

  private async sendPrivateJobFollowUp(threadId: string, text: string): Promise<void> { return runSerializedJobMutation(threadId, async () => {
    const limitMessage = this.getThreadBudgetLimitMessage(threadId);
    if (limitMessage) {
      throw new Error(limitMessage);
    }

    await loadWorkerThread(this.getWorkerClientAccess(), threadId);
    const thread = this.store.getThread(threadId);
    const payload = await this.createOrUpdateJobPayload({
      threadId,
      kind: "steering",
      instruction: text,
      contract: thread?.executionContract ?? null,
      checklist: thread?.supervisionChecklist ?? null
    });
    const sent = await sendWorkerMessage(
      this.getWorkerClientAccess(),
      threadId,
      this.imageStore.buildCodexInput(formatJobPayloadMessage(payload.kind as JobPayloadKind, payload.threadId, payload.workerDirective, payload.display.summary), [])
    );
    await this.bindJobPayloadDelivery(threadId, { turnId: sent.turnId });
    this.store.noteButlerSteer(threadId);
    this.store.addEvent(threadId, "butler.supervision.turn_spent", "Butler spent a private supervision turn on this job.");
  }); }

  private async processCallbackReviews(): Promise<void> {
    if (this.quiescing) return;
    const now = Date.now();
    const { pendingReviews, retryAt } = selectRunnableCallbackReviews(
      this.pendingChatCallbacks.values(),
      this.callbackReviewNotBefore,
      now
    );

    if (pendingReviews.length === 0) {
      if (retryAt !== null) this.callbackReviewScheduler.scheduleAt(retryAt);
      return;
    }

    for (const callback of pendingReviews) {
      const liveCallback = await runSerializedJobMutation(callback.threadId, async () => {
        const current = this.pendingChatCallbacks.get(callback.threadId);
        if (!current || !isCallbackOutstanding(current) || current.reviewState !== "queued") return null;
        beginCallbackReviewAttempt(current, this.callbackReviewFailureCount.get(current.threadId) ?? 0);
        await this.saveCallbackState();
        this.emit("change");
        return current;
      });
      if (!liveCallback) continue;

      try {
        await runCallbackAdversarialReview({
          callback: liveCallback,
          sessionAccess: this.getSessionAccess(),
          store: this.store,
          codexHomeDir: path.dirname(this.codexAuthPath),
          piAuthPath: this.piAuthPath,
          scratchDir: path.join(this.sessionDir, "adversarial-review"),
          codexAuthenticated: this.codexAuth.loggedIn || Boolean(process.env.OPENAI_API_KEY?.trim()),
          isCurrent: () => !this.quiescing && this.pendingChatCallbacks.get(liveCallback.threadId) === liveCallback && liveCallback.reviewState === "running" && isCallbackOutstanding(liveCallback),
          onProgress: (progress) => { void persistCallbackReviewProgress({ attempted: liveCallback, progress, getCurrent: () => this.pendingChatCallbacks.get(liveCallback.threadId), save: () => this.saveCallbackState(), emit: () => this.emit("change") }).catch((error) => { this.lastError = `Adversarial review progress could not be saved: ${redactSensitiveText(error instanceof Error ? error.message : String(error))}`; this.emit("change"); }); }
        });
      } catch (error) {
        let failureApplied = false;
        await runSerializedJobMutation(callback.threadId, async () => {
          const nextCallback = this.pendingChatCallbacks.get(callback.threadId);
          if (shouldIgnoreCallbackReviewFailure(liveCallback, nextCallback) || !nextCallback) return;
          applyCallbackReviewFailure({ callback: nextCallback, error, store: this.store, failureCount: this.callbackReviewFailureCount, notBefore: this.callbackReviewNotBefore });
          await this.saveCallbackState(); this.emit("change"); failureApplied = true;
        });
        if (failureApplied) throw error;
        continue;
      }

      await runSerializedJobMutation(callback.threadId, async () => {
        const nextCallback = this.pendingChatCallbacks.get(callback.threadId);
        if (nextCallback !== liveCallback || !isCallbackOutstanding(nextCallback) || nextCallback.reviewState !== "running") return;
        this.callbackReviewNotBefore.delete(liveCallback.threadId);
        this.callbackReviewFailureCount.delete(liveCallback.threadId);
        const thread = this.store.getThread(callback.threadId);
        const workerReport = this.store.getWorkerReport(callback.threadId);
        const relevantWorkerReport = relevantTerminalWorkerReport(thread, workerReport, nextCallback.requestedAt);
        const safeCloseoutText =
          nextCallback.callbackState === "received_worker_callback"
            ? buildChatCallbackText(thread, relevantWorkerReport)
            : nextCallback.callbackState === "missing_worker_callback"
              ? buildFallbackChatCallbackText(thread)
              : null;
        if (safeCloseoutText) {
          const closeoutBlocker = getCloseoutBlocker(this.store, callback.threadId, { thread, workerReport: relevantWorkerReport });
          if (closeoutBlocker) {
            recordGatedCloseout(this.store, callback.threadId, closeoutBlocker);
            blockCloseoutReview(nextCallback, {
              reason: closeoutBlocker,
              reviewReason:
                nextCallback.callbackState === "missing_worker_callback"
                  ? "thread_recovery"
                  : "worker_callback",
              workerReportUpdatedAt: relevantWorkerReport?.updatedAt ?? null
            });
            await this.saveCallbackState();
            this.emit("change");
            return;
          }
          await this.postOperatorJobReply(callback.threadId, safeCloseoutText);
          return;
        }

        idleCloseoutReview(nextCallback);
        await this.saveCallbackState();
        this.emit("change");
      });
    }
  }

  private scheduleSmokeTestReactions(): void {
    if (this.smokeReactionInFlight) {
      this.smokeReactionQueued = true;
      return;
    }

    this.smokeReactionInFlight = true;
    void this.processSmokeTestReactions()
      .catch((error) => {
        this.lastError = error instanceof Error ? error.message : String(error);
      })
      .finally(() => {
        this.smokeReactionInFlight = false;
        if (this.smokeReactionQueued) {
          this.smokeReactionQueued = false;
          this.scheduleSmokeTestReactions();
        }
      });
  }

  private async processSmokeTestReactions(): Promise<void> {
    if (this.supervisionSmokePlans.size === 0) {
      return;
    }

    const milestones = [...this.store.listMilestones()]
      .filter((milestone) => (milestone.type === "completed" || milestone.type === "blocked") && this.supervisionSmokePlans.has(milestone.threadId))
      .sort((left, right) => left.at - right.at);

    for (const milestone of milestones) {
      if (this.actedSmokeMilestoneIds.has(milestone.id)) {
        continue;
      }

      const plan = this.supervisionSmokePlans.get(milestone.threadId);
      if (!plan) {
        this.actedSmokeMilestoneIds.add(milestone.id);
        continue;
      }

      this.actedSmokeMilestoneIds.add(milestone.id);
      if (plan.followUpsSent >= plan.totalFollowUps) {
        this.supervisionSmokePlans.delete(plan.threadId);
        continue;
      }

      await this.sendPrivateJobFollowUp(plan.threadId, this.buildSmokeFollowUpText(plan));
      plan.followUpsSent += 1;

      if (plan.followUpsSent >= plan.totalFollowUps) {
        this.supervisionSmokePlans.set(plan.threadId, plan);
      }
    }
  }

  private async prepareDelegationWorkspace(task: string, cwd?: string): Promise<{ cwd: string; branchName: string | null }> {
    const requestedCwd = cwd ?? "/repos";
    if (cwd) {
      const resolvedCwd = await resolveExistingWorkspaceCwd(cwd);
      if (resolvedCwd && resolvedCwd !== cwd) {
        return {
          cwd: resolvedCwd,
          branchName: await resolveWorkspaceBranchName(resolvedCwd)
        };
      }
    }

    const resolvedCwd = await resolveExistingWorkspaceCwd(requestedCwd);
    if (!taskRequiresManagedWorktree(task)) {
      return {
        cwd: resolvedCwd,
        branchName: await resolveWorkspaceBranchName(resolvedCwd)
      };
    }

    const worktree = await ensureTaskWorktree({
      cwd: resolvedCwd,
      task
    });

    return {
      cwd: worktree.cwd,
      branchName: worktree.branchName
    };
  }

  private async buildDelegationContract(options: {
    threadId: string;
    task: string;
    goal?: string;
    workspace: { cwd: string; branchName: string | null };
    extraNotes?: string[];
    orchestration?: ButlerRoutingDecisionView | null;
  }): Promise<{ text: string; contract: CodexThreadExecutionContractView }> {
    const signature = JSON.stringify(options);
    const cached = this.delegationInstructionCache.get(options.threadId);
    if (cached?.signature === signature) {
      return { text: cached.text, contract: cached.contract };
    }
    const result = await buildButlerDelegationContract({ store: this.store, butlerThreadId: this.session?.sessionId ?? null, reviewBaselineRoot: path.join(this.artifactsDir, "review-baselines"), ...options });
    await persistJobPayload(jobPayloadsRoot(this.artifactsDir), result.payload);
    this.store.setThreadJobPayload(result.payload);
    this.store.setThreadExecutionContract(options.threadId, result.contract);
    const cachedResult = { signature, text: result.text, contract: result.contract };
    this.delegationInstructionCache.set(options.threadId, cachedResult);
    return { text: cachedResult.text, contract: cachedResult.contract };
  }

  private async createOrUpdateJobPayload(input: {
    threadId: string;
    kind: JobPayloadKind;
    instruction: string;
    imageReferenceIds?: string[];
    fileReferenceIds?: string[];
    contract?: CodexThreadExecutionContractView | null;
    checklist?: SupervisionChecklistView | null;
    butlerThreadId?: string | null;
  }) {
    const thread = this.store.getThread(input.threadId);
    const existing = this.store.getThreadJobPayload(input.threadId);
    const update = {
      ...input,
      butlerThreadId: input.butlerThreadId ?? this.session?.sessionId ?? null,
      contract: input.contract ?? thread?.executionContract ?? null,
      checklist: input.checklist ?? thread?.supervisionChecklist ?? null
    };
    const payload = existing
      ? updateJobPayload(existing, update)
      : buildJobPayload(update);
    await persistJobPayload(jobPayloadsRoot(this.artifactsDir), payload, { beforeCommit: () => assertCallbackReviewCurrent(input.threadId) });
    assertCallbackReviewCurrent(input.threadId);
    this.store.setThreadJobPayload(payload);
    return payload;
  }

  private async bindJobPayloadDelivery(threadId: string, delivery: { turnId?: string | null; messageId?: string | null }) {
    const existing = this.store.getThreadJobPayload(threadId);
    if (!existing) return null;
    const payload = bindStoredJobPayloadDelivery(existing, delivery);
    await persistJobPayload(jobPayloadsRoot(this.artifactsDir), payload, { beforeCommit: () => assertCallbackReviewCurrent(threadId) }); assertCallbackReviewCurrent(threadId); this.store.setThreadJobPayload(payload); return payload;
  }

  private getServiceTemplate(templateId: string): LoadedServiceTemplate {
    const template = this.serviceTemplateRegistry.get(templateId);
    if (!template) {
      throw new Error(`Unknown service template: ${templateId}`);
    }
    return template;
  }

  private listServiceTemplates(): LoadedServiceTemplate[] {
    return this.serviceTemplateRegistry.list();
  }

  private getValidatedStack(stackId: string | null, threadId: string | null) {
    if (!stackId) {
      return null;
    }

    const threadStacks = this.store
      .listStackLeases()
      .filter((stack) => stack.status !== "stopped" && (!threadId || stack.threadId === threadId || !stack.threadId || stack.pinned));
    const stack =
      threadStacks.find((entry) => entry.id === stackId) ??
      (threadStacks.filter((entry) => entry.title === stackId).length === 1
        ? threadStacks.filter((entry) => entry.title === stackId)[0]
        : null) ??
      (() => {
        const folded = stackId.trim().toLowerCase();
        const matches = threadStacks.filter((entry) => entry.title.trim().toLowerCase() === folded);
        return matches.length === 1 ? matches[0] : null;
      })();
    if (!stack) {
      throw new Error(`Unknown stack: ${stackId}`);
    }

    if (threadId && stack.threadId && stack.threadId !== threadId && !stack.pinned) {
      throw new Error(`Stack ${stackId} belongs to a different job`);
    }

    return stack;
  }

  private getValidatedPreview(previewSelector: string | null, threadId: string | null) {
    if (!previewSelector) {
      return null;
    }

    const threadPreviews = this.store
      .listPreviewLeases()
      .filter((preview) => preview.status !== "stopped" && (!threadId || preview.threadId === threadId || !preview.threadId || preview.pinned));
    const directIdMatch = threadPreviews.find((entry) => entry.id === previewSelector);
    if (directIdMatch) {
      return directIdMatch;
    }

    const exactTitleMatches = threadPreviews.filter((entry) => entry.title === previewSelector);
    if (exactTitleMatches.length === 1) {
      return exactTitleMatches[0];
    }

    const exactAliasMatches = threadPreviews.filter((entry) => entry.aliases.includes(previewSelector));
    if (exactAliasMatches.length === 1) {
      return exactAliasMatches[0];
    }

    const folded = previewSelector.trim().toLowerCase();
    const foldedTitleMatches = threadPreviews.filter((entry) => entry.title.trim().toLowerCase() === folded);
    if (foldedTitleMatches.length === 1) {
      return foldedTitleMatches[0];
    }

    const foldedAliasMatches = threadPreviews.filter((entry) =>
      entry.aliases.some((alias) => alias.trim().toLowerCase() === folded)
    );
    if (foldedAliasMatches.length === 1) {
      return foldedAliasMatches[0];
    }

    throw new Error(`Unknown preview: ${previewSelector}`);
  }

  private requireValidatedPreview(previewSelector: string, threadId: string | null) {
    const preview = this.getValidatedPreview(previewSelector, threadId);
    if (!preview) {
      throw new Error("Preview selector is required");
    }
    return preview;
  }

  private getValidatedService(serviceSelector: string | null, threadId: string | null) {
    if (!serviceSelector) {
      return null;
    }

    const threadServices = this.store
      .listServiceLeases()
      .filter((service) => service.status !== "stopped" && (!threadId || service.threadId === threadId || !service.threadId));
    const directIdMatch = threadServices.find((entry) => entry.id === serviceSelector);
    if (directIdMatch) {
      return directIdMatch;
    }

    const exactTitleMatches = threadServices.filter((entry) => entry.title === serviceSelector);
    if (exactTitleMatches.length === 1) {
      return exactTitleMatches[0];
    }

    const exactAliasMatches = threadServices.filter((entry) => entry.aliases.includes(serviceSelector));
    if (exactAliasMatches.length === 1) {
      return exactAliasMatches[0];
    }

    const folded = serviceSelector.trim().toLowerCase();
    const foldedTitleMatches = threadServices.filter((entry) => entry.title.trim().toLowerCase() === folded);
    if (foldedTitleMatches.length === 1) {
      return foldedTitleMatches[0];
    }

    const foldedAliasMatches = threadServices.filter((entry) =>
      entry.aliases.some((alias) => alias.trim().toLowerCase() === folded)
    );
    if (foldedAliasMatches.length === 1) {
      return foldedAliasMatches[0];
    }

    throw new Error(`Unknown service: ${serviceSelector}`);
  }

  private requireValidatedService(serviceSelector: string, threadId: string | null) {
    const service = this.getValidatedService(serviceSelector, threadId);
    if (!service) {
      throw new Error("Service selector is required");
    }
    return service;
  }

  private getLatestThreadVerificationPreview(threadId: string): PreviewLeaseView {
    const previews = this.store
      .listPreviewLeases()
      .filter((lease) => lease.threadId === threadId && lease.status !== "stopped");
    if (previews.length === 0) {
      throw new Error(`Job ${threadId} has no active preview.`);
    }

    return [...previews].sort((left, right) => {
      const leftCheckedAt = left.lastVerification?.checkedAt ?? 0;
      const rightCheckedAt = right.lastVerification?.checkedAt ?? 0;
      if (leftCheckedAt !== rightCheckedAt) {
        return rightCheckedAt - leftCheckedAt;
      }
      return right.updatedAt - left.updatedAt;
    })[0]!;
  }

  private toResolvedProof(
    subject: Pick<PreviewLeaseView, "id" | "threadId" | "projectId" | "projectLabel" | "title" | "stackId">,
    verification: PreviewVerificationView,
    runId?: string,
    proofRecordId?: string | null
  ): ResolvedPreviewProof {
    const decoratedVerification = decoratePreviewVerification(verification);
    if (runId && decoratedVerification.runId !== runId.trim()) {
      throw new Error(`Preview ${subject.id} does not have verification run ${runId.trim()}.`);
    }

    const artifacts = selectReviewableProofArtifacts(decoratedVerification);
    if (artifacts.length === 0) throw new Error(`Preview ${subject.id} has no available proof artifact to review.`);
    const availableScreenshots = artifacts.filter((artifact) => artifact.kind === "screenshot");

    return {
      proofRecordId: proofRecordId ?? null,
      preview: subject,
      verification: decoratedVerification,
      primaryArtifact: availableScreenshots[0] ?? artifacts[0]!,
      primaryScreenshot: availableScreenshots[0] ?? null,
      artifacts,
      screenshots: availableScreenshots,
      video: artifacts.find((artifact) => artifact.kind === "video") ?? null,
      manifest: findVerificationArtifact(decoratedVerification, "manifest"),
      trace: findVerificationArtifact(decoratedVerification, "trace")
    };
  }

  private resolvePreviewProof(params: { threadId?: string; leaseId?: string; runId?: string }): ResolvedPreviewProof {
    const preview = params.leaseId ? this.requireValidatedPreview(params.leaseId, params.threadId?.trim() || null) : null;

    if (preview?.lastVerification) {
      const latestProof = this.store.getLatestPreviewProofForPreview(preview.id);
      const proofRecordId = latestProof?.verification.runId === preview.lastVerification.runId ? latestProof.id : null;
      return this.toResolvedProof(preview, preview.lastVerification, params.runId, proofRecordId);
    }

    const previewProof =
      preview
        ? this.store.getLatestPreviewProofForPreview(preview.id)
        : params.threadId
          ? getVisibleThreadProofs(this.store.listPreviewProofs()).find((proof) => proof.threadId === params.threadId?.trim()) ?? null
          : null;

    if (previewProof) {
      return this.toResolvedProof(
        {
          id: previewProof.previewId,
          threadId: previewProof.threadId,
          projectId: previewProof.projectId,
          projectLabel: previewProof.projectLabel,
          title: previewProof.previewTitle,
          stackId: previewProof.stackId
        },
        previewProof.verification,
        params.runId,
        previewProof.id
      );
    }

    if (!preview && params.threadId) {
      const latestPreview = this.getLatestThreadVerificationPreview(params.threadId.trim());
      if (latestPreview.lastVerification) {
        const latestProof = this.store.getLatestPreviewProofForPreview(latestPreview.id);
        const proofRecordId = latestProof?.verification.runId === latestPreview.lastVerification.runId ? latestProof.id : null;
        return this.toResolvedProof(latestPreview, latestPreview.lastVerification, params.runId, proofRecordId);
      }
    }

    if (!preview) {
      throw new Error("review_preview_proof requires a preview or job selector.");
    }

    throw new Error(`Preview ${preview.id} does not have a recorded verification yet.`);
  }

  private resolveWorkspaceProject(cwd: string | null | undefined, fallbackId: string, fallbackLabel: string) {
    const project = resolveWorkspaceProjectInfo(cwd);
    if (project.id === "unknown") {
      return {
        id: fallbackId,
        label: fallbackLabel
      };
    }

    return project;
  }

  private removeStackArtifacts(stackId: string): void {
    for (const lease of this.store.listPreviewLeases()) {
      if (lease.stackId === stackId) {
        this.store.removePreviewLease(lease.id);
      }
    }

    for (const lease of this.store.listServiceLeases()) {
      if (lease.stackId === stackId) {
        this.store.removeServiceLease(lease.id);
      }
    }

    this.store.removeStackLease(stackId);
  }

  private normalizeServiceEnv(value: unknown): Record<string, string> {
    if (!value || typeof value !== "object") return {};
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter((entry): entry is [string, string] => typeof entry[0] === "string" && typeof entry[1] === "string")
        .map(([key, entryValue]) => [key.trim(), entryValue.trim()])
        .filter(([key, entryValue]) => key.length > 0 && entryValue.length > 0)
    );
  }

  private normalizeStringArray(value: unknown): string[] {
    if (!Array.isArray(value)) return [];
    return [...new Set(value.map((entry) => (typeof entry === "string" ? entry.trim() : "")).filter(Boolean))];
  }

  private describeStackStorage(stack: {
    storageMode: "ephemeral" | "job" | "base" | "custom";
    baseStorageKey: string | null;
    storageKey: string | null;
    cloneFromStorageKey: string | null;
    defaultPromoteTargetStorageKey: string | null;
    retainsVolumes: boolean;
    volumeNames: string[];
  }): string { return formatStackStorageSummary(stack); }

  private async reviewProofScreenshot(proof: ResolvedPreviewProof, options?: { expectedOutcome?: string; signal?: AbortSignal }): Promise<ProofScreenshotReview> { return reviewButlerProofScreenshot(this.getSessionAccess(), proof, { ...options, ...getCallbackReviewExecution() }); }

  private buildCustomTools() {
    const toolAccess = this.getToolAccess();
    const tools = [...buildButlerStackPreviewTools(toolAccess), ...buildButlerFilesystemTools(toolAccess), ...buildButlerServiceTools(toolAccess), ...buildButlerManorTools(toolAccess), ...buildButlerProjectTools(toolAccess, this.artifactsDir), ...buildButlerOperatorTools(toolAccess), ...buildButlerWorkerTools(toolAccess), ...buildButlerDelegationTools(toolAccess)];
    tools.push(...buildButlerProviderWebTools(() => this.session?.model?.provider));
    return tools;
  }

  private async createOrRefreshSession(): Promise<void> { await createOrRefreshButlerSession(this.getSessionAccess()); this.toolCatalog = this.buildToolCatalog(); }

  private async sanitizePersistedSessions(): Promise<void> { await sanitizePersistedButlerSessions(this.getSessionAccess()); }

  private restoreCompactionState(): void { restoreButlerCompactionState(this.getSessionAccess()); }

  private sanitizeSessionMessages(): void { sanitizeButlerSessionMessages(this.getSessionAccess()); }

  getMessagePage(before: number | null, limit: number): ButlerMessagePageView { return getButlerMessagePage(this.getSessionAccess(), before, limit); }

  getLiveSnapshot(): ButlerLiveSnapshot { return getButlerLiveSnapshot(this.getSessionAccess()); }

  getShellSnapshot(): AppShellSnapshot["butler"] { return getButlerShellSnapshot(this.getSessionAccess()); }

  getSnapshot(): AppSnapshot["butler"] { return getButlerSnapshot(this.getSessionAccess()); }

  setThinkingLevel(level: ButlerThinkingLevel): void {
    const access = this.getSessionAccess();
    if (!access.session) return;
    const option = access.session.model ? modelToModelOption(access.session.model) : null;
    access.session.setThinkingLevel(piThinkingLevelForModelOption(level, option) as never);
    access.lastError = null;
    access.emit("change");
  }
  getButlerAuthStatus(): ButlerAuthStatus { return this.auth; }
  getCodexAuthStatus(): ButlerAuthStatus { return this.codexAuth; }
  async retryBlockedCallbackReviews(threadId?: string): Promise<boolean> { const callback = threadId ? this.pendingChatCallbacks.get(threadId) : [...this.pendingChatCallbacks.values()].find(isCallbackReviewRetryablePause); if (!callback || !isCallbackReviewRetryablePause(callback)) return false; const model = this.session?.model ?? null; prepareCallbackReviewRetry(callback, { provider: model?.provider ?? null, model: model?.id ?? null, thinkingLevel: getButlerShellSnapshot(this.getSessionAccess()).compose?.thinkingLevel ?? "off" }); this.resetCallbackReviewFailures(callback.threadId); if (callback.reviewState === "blocked") queueCloseoutReview(callback, callback.reviewReason ?? "worker_callback"); await this.saveCallbackState(); this.callbackReviewScheduler.schedule(); this.emit("change"); return true; }
  async quiesceCallbackReviews(): Promise<void> { if (this.quiescing) return; this.quiescing = true; try { await this.cancelCallbackReview(); } catch (error) { this.quiescing = false; throw error; } this.callbackReviewScheduler.dispose(); this.store.off("change", this.storeChangeHandler); }
  async cancelCallbackReview(threadId?: string): Promise<boolean> { const threadIds = threadId ? [threadId] : [...this.pendingChatCallbacks.keys()]; return runSerializedJobMutations(threadIds, async () => { const callbacks = threadId ? [this.pendingChatCallbacks.get(threadId)] : [...this.pendingChatCallbacks.values()]; const active = callbacks.filter((callback): callback is PendingChatCallback => Boolean(callback && (callback.reviewState === "running" || callback.reviewState === "queued"))); if (active.length === 0) return false; for (const callback of active) { this.callbackReviewNotBefore.delete(callback.threadId); this.callbackReviewFailureCount.delete(callback.threadId); pauseCallbackReview(callback, this.store.getWorkerReport(callback.threadId)?.updatedAt ?? null); } await this.saveCallbackState(); this.emit("change"); return true; }); }
  async trackScratchPadDelegation(threadId: string): Promise<void> {
    this.queueDelegationAcknowledgement(threadId, `Added to the scratch pad. I started a deeper async pass in job ${threadId} and will return here with the result.`);
    await this.trackExternalWorkerDelegation(threadId);
  }
  async trackExternalWorkerDelegation(threadId: string): Promise<void> { if (this.quiescing) throw new Error("Butler session is closing."); await runSerializedCallbackReplacement(threadId, async () => {
    if (this.quiescing) throw new Error("Butler session is closing."); await this.registerPendingChatCallback(threadId, { requestedAt: this.store.getThread(threadId)?.createdAt ?? Date.now() }); this.store.noteButlerSteer(threadId);
  }); }
  async ensureExternalWorkerDelegation(threadId: string): Promise<void> { const callback = this.pendingChatCallbacks.get(threadId); if (callback && isCallbackOutstanding(callback)) return; const thread = this.store.getThread(threadId); const latestTurnId = getFallbackTurnId(thread); if (latestTurnId) { const closeoutId = buildCloseoutId(threadId, latestTurnId); if (this.deliveredCloseoutIds.has(closeoutId) || this.operatorMessages.some((message) => message.id === `callback-${closeoutId}` || message.id === `callback-fallback-${closeoutId}`)) return; } const latestWorkAt = Math.max(this.store.getWorkerReport(threadId)?.updatedAt ?? 0, thread?.turns.at(-1)?.startedAt ?? 0); if (callback && latestWorkAt <= (callback.closedAt ?? callback.updatedAt)) return; await this.trackExternalWorkerDelegation(threadId); }
  async handoffWorker(input: { sourceThreadId: string; harness: string; model: string; effort: ReasoningEffort | null; butlerThreadId?: string | null }) {
    return handoffWorkerAtomically({
      access: this.getWorkerClientAccess(),
      sourceThreadId: input.sourceThreadId, targetHarness: input.harness,
      targetModel: input.model,
      targetEffort: input.effort,
      artifactsDir: this.artifactsDir,
      butlerThreadId: input.butlerThreadId ?? this.session?.sessionId ?? null,
      trackCallback: (threadId) => this.trackExternalWorkerDelegation(threadId),
      removeCallback: (threadId) => this.removeExternalWorkerDelegation(threadId),
      attach: (result, text, at) => this.attachDelegationAcknowledgement(result.threadId, text, at, {
        runtime: result.runtime, harness: result.harness, provider: result.provider, model: result.model,
        effort: result.effort, replacesThreadId: input.sourceThreadId
      }),
      post: (threadId, text, at) => this.postDelegationAcknowledgement(threadId, text, at)
    });
  }
  async removeExternalWorkerDelegation(threadId: string): Promise<void> { await runSerializedCallbackReplacement(threadId, async () => { const callback = this.pendingChatCallbacks.get(threadId); if (!callback) return; const failureCount = this.callbackReviewFailureCount.get(threadId); const notBefore = this.callbackReviewNotBefore.get(threadId); const smokePlan = this.supervisionSmokePlans.get(threadId); this.pendingChatCallbacks.delete(threadId); this.callbackReviewFailureCount.delete(threadId); this.callbackReviewNotBefore.delete(threadId); this.supervisionSmokePlans.delete(threadId); try { await this.saveCallbackState(); } catch (error) { this.pendingChatCallbacks.set(threadId, callback); if (failureCount !== undefined) this.callbackReviewFailureCount.set(threadId, failureCount); if (notBefore !== undefined) this.callbackReviewNotBefore.set(threadId, notBefore); if (smokePlan) this.supervisionSmokePlans.set(threadId, smokePlan); throw error; } this.emit("change"); }); }
  private async prepareOperatorTurn(text: string, imageReferenceIds: string[] = [], options: { mode?: "queue" | "steer"; displayText?: string | null; removeOnFailure?: boolean } = {}): Promise<{ completion: Promise<boolean> }> {
    const guard = buildOperatorThreadGuard(this.store, text, this.getRecentFocusedThreadId());
    this.activeOperatorThreadGuard = guard;
    if (guard.lockedThreadId && this.store.getThread(guard.lockedThreadId)) this.noteThreadFocus(guard.lockedThreadId, guard.explicitThreadIds.length > 0 ? "operator_reference" : "operator_follow_up");
    const thread = guard.lockedThreadId ? this.store.getThread(guard.lockedThreadId) : undefined;
    this.memoryScheduler?.observeOperatorMessage({ text, threadId: guard.lockedThreadId, projectId: thread?.supervisor.projectId ?? thread?.executionContract?.projectId ?? null, projectLabel: thread?.supervisor.projectLabel ?? thread?.executionContract?.projectLabel ?? null, at: Date.now() });
    let ignoreStopRequestSequence: number | null = null;
    if (options.mode === "steer") clearPendingOperatorPrompts(this.getSessionAccess());
    const displayText = options.displayText?.trim() || text;
    const pendingOperatorMessageId = registerPendingOperatorPrompt(this.getSessionAccess(), text, displayText);
    const pendingOperatorMessageAt = this.pendingOperatorMessages.find((message) => message.id === pendingOperatorMessageId)?.at ?? Date.now();
    upsertOperatorMessage(this.operatorMessages, pendingOperatorMessageId, text, pendingOperatorMessageAt, null, { role: "user", displayText: displayText !== text ? displayText : null });
    try { await this.saveOperatorMessageState(); } catch (error) { removePendingOperatorPrompt(this.getSessionAccess(), pendingOperatorMessageId); removeOperatorMessage(this.operatorMessages, pendingOperatorMessageId); this.activeOperatorThreadGuard = null; throw error; }
    const completion = (async () => {
      try {
        if (options.mode === "steer") { await stopButlerPrompt(this.getSessionAccess(), { clearPendingOperatorMessages: false }); ignoreStopRequestSequence = this.stopRequestSequence; }
        if (guard.contextPrompt) await promptButlerInternal(this.getSessionAccess(), ["This is hidden grounding for the next operator turn.", "Do not answer it directly.", "Use it to keep job references exact during the next operator turn only.", guard.contextPrompt].join("\n"));
        const delivered = await promptButler(this.getSessionAccess(), text, imageReferenceIds, { mode: options.mode === "steer" ? "queue" : options.mode, pendingOperatorMessageId, ignoreStopRequestSequence });
        if (!delivered && options.removeOnFailure && removeOperatorMessage(this.operatorMessages, pendingOperatorMessageId)) await this.saveOperatorMessageState();
        return delivered;
      } catch (error) { removePendingOperatorPrompt(this.getSessionAccess(), pendingOperatorMessageId); if (removeOperatorMessage(this.operatorMessages, pendingOperatorMessageId)) await this.saveOperatorMessageState(); throw error; } finally { this.activeOperatorThreadGuard = null; }
    })();
    return { completion };
  }
  private async promptOperatorTurn(text: string, imageReferenceIds: string[] = [], options: { mode?: "queue" | "steer"; displayText?: string | null } = {}): Promise<boolean> { return (await this.prepareOperatorTurn(text, imageReferenceIds, options)).completion; }
  prompt(text: string, imageReferenceIds: string[] = [], options: { mode?: "queue" | "steer"; displayText?: string | null } = {}): void { void this.promptOperatorTurn(text, imageReferenceIds, options); }
  async stopPrompt(): Promise<boolean> { return stopButlerPrompt(this.getSessionAccess()); }
  async updateComposeSettings(provider: string, modelId: string, thinkingLevel: ButlerThinkingLevel): Promise<void> { await updateButlerComposeSettings(this.getSessionAccess(), provider, modelId, thinkingLevel); this.toolCatalog = this.buildToolCatalog(); this.emit("change"); }
}
