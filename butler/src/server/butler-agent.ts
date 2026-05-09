import crypto from "node:crypto";
import { EventEmitter } from "node:events";
import { promises as fs } from "node:fs";
import path from "node:path";

import { getModel } from "@mariozechner/pi-ai";
import { AuthStorage, defineTool, ModelRegistry, type AgentSession } from "@mariozechner/pi-coding-agent";
import type { TSchema } from "@sinclair/typebox";

import {
  buildCallbackReviewPrompt,
  buildCloseoutId,
  buildChatCallbackText,
  buildOperatorThreadGuard,
  buildFallbackChatCallbackText,
  buildLatestProofMap,
  buildMessagePage,
  buildSystemPrompt,
  collapseCallbackDuplicateMessages,
  contentToText,
  describePendingCallbacks,
  extractLatestNoticeTexts,
  extractWorkspaceMentions,
  findVerificationArtifact,
  findVerificationArtifacts,
  getFallbackTurnId,
  isAssistantFailureMessage,
  isCallbackOutstanding,
  MAX_HISTORY_PAGE_SIZE,
  mergeVisibleMessages,
  normalizeNoticeText,
  parseProofScreenshotReview,
  sanitizeHistoryMessage,
  sanitizeHistoryMessages,
  serializeMessages,
  SNAPSHOT_MESSAGE_TAIL_LIMIT,
  summarizeNoticeResult,
  type ButlerOperatorThreadGuard,
  type PendingChatCallback,
  type ProofScreenshotReview,
  type ResolvedPreviewProof,
  type SupervisionSmokePlan
} from "./butler-agent-helpers.js";
import { buildButlerCodexTools } from "./butler-agent-codex-tools.js";
import {
  createOrRefreshButlerSession,
  getButlerLiveSnapshot,
  getButlerMessagePage,
  getButlerShellSnapshot,
  getButlerSnapshot,
  promptButler,
  promptButlerInternal,
  stopButlerPrompt,
  restoreButlerCompactionState,
  sanitizeButlerSessionMessages,
  sanitizePersistedButlerSessions,
  updateButlerComposeSettings
} from "./butler-agent-session.js";
import { clearButlerSessionChat, deleteButlerSessionChatFrom, keepOperatorMessagesBefore } from "./butler-agent-chat-hygiene.js";
import { buildButlerServiceTools } from "./butler-agent-service-tools.js";
import { buildButlerProjectTools } from "./butler-agent-project-tools.js";
import { buildButlerDelegationTools, buildButlerStackPreviewTools } from "./butler-agent-stack-preview-tools.js";
import { reviewButlerProofScreenshot } from "./butler-agent-proof-review.js";
import type { ButlerAgentSessionAccess, ButlerAgentToolAccess } from "./butler-agent-tool-access.js";
import { BUTLER_TOOL_CATALOG } from "./butler-agent-tool-catalog.js";
import { keepButlerActivityBefore, normalizeButlerActivitySummaryTurns } from "./butler-activity.js";
import { readButlerAuthStatus, readCodexAuthStatus } from "./auth-status.js";
import { notifyDirectCodexMessage, type DirectCodexMessageAccess, type DirectCodexMessagePingInput } from "./direct-codex-message.js";
import { type FileReferenceStore } from "./file-store.js";
import { buildOnboardingView } from "./onboarding-status.js";
import { type ImageReferenceStore } from "./image-store.js";
import { formatProjectPolicyContextLines } from "./project-artifacts-policies.js";
import { decoratePreviewVerification } from "./preview-verification.js";
import {
  ensureTaskWorktree,
  resolveExistingWorkspaceCwd,
  resolveWorkspaceBranchName,
  resolveWorkspaceProjectInfo,
  taskRequiresManagedWorktree
} from "./repo-worktree.js";
import { RuntimeBrokerClient } from "./runtime-broker-client.js";
import { type LoadedServiceTemplate, ServiceTemplateRegistry, toServiceLeaseView } from "./service-templates.js";
import { formatStackStorageSummary, normalizeStackStorageMode } from "./stack-storage.js";
import {
  buildThreadExecutionContract,
  describeProofExpectation,
  isSharedShellRepoBootstrapTask,
} from "./thread-contract.js";
import {
  applyWorkspacePreviewDefaults,
  formatWorkspaceBootstrapLines,
  inspectWorkspaceBootstrap
} from "./workspace-bootstrap.js";
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
  ButlerThinkingLevel,
  ButlerToolUiEffect,
  ButlerToolView,
  CodexThreadExecutionContractView,
  ModelOption
} from "./types.js";
import { ButlerStateStore } from "./state-store.js";
import { CodexAppServerClient } from "./codex-client.js";
import type { PreviewLeaseView, PreviewProofRecordView, PreviewVerificationArtifactView, PreviewVerificationView } from "./types.js";

const CALLBACK_RECOVERY_TIMEOUT_MS = 30_000;

export class ButlerAgentService extends EventEmitter {
  private readonly store: ButlerStateStore;
  private readonly codexClient: CodexAppServerClient;
  private readonly runtimeBroker: RuntimeBrokerClient;
  private readonly serviceTemplateRegistry: ServiceTemplateRegistry;
  private readonly imageStore: ImageReferenceStore;
  private readonly fileStore: FileReferenceStore;
  private readonly piAuthPath: string;
  private readonly codexAuthPath: string;
  private readonly codexConfigDir: string;
  private readonly sessionDir: string;
  private readonly artifactsDir: string;
  private readonly operatorMessageStatePath: string;
  private readonly activitySummaryStatePath: string;
  private readonly legacyNoticeStatePath: string;
  private readonly callbackStatePath: string;
  private readonly refreshRuntimeInventory: (() => Promise<void>) | null;
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
  private readonly toolCatalog: ButlerToolView[];
  private unsubscribeSession: (() => void) | null = null;
  private statusRefreshTimer: NodeJS.Timeout | null = null;
  private readonly operatorMessages: ButlerMessageView[] = [];
  private readonly pendingChatCallbacks = new Map<string, PendingChatCallback>();
  private readonly deliveredCloseoutIds = new Set<string>();
  private readonly supervisionSmokePlans = new Map<string, SupervisionSmokePlan>();
  private readonly actedSmokeMilestoneIds = new Set<string>();
  private recentThreadFocus: Array<{ threadId: string; notedAt: number; reason: string | null }> = [];
  private activeOperatorThreadGuard: ButlerOperatorThreadGuard | null = null;
  private smokeReactionInFlight = false;
  private smokeReactionQueued = false;
  private callbackReviewInFlight = false;
  private callbackReviewQueued = false;
  private compaction: Omit<ButlerCompactionView, "autoEnabled" | "active" | "count"> = {
    lastReason: null,
    lastStartedAt: null,
    lastCompletedAt: null,
    lastTokensBefore: null,
    lastWillRetry: false,
    lastAborted: false,
    lastError: null
  };

  constructor(options: {
    store: ButlerStateStore;
    codexClient: CodexAppServerClient;
    runtimeBroker: RuntimeBrokerClient;
    serviceTemplateRegistry: ServiceTemplateRegistry;
    imageStore: ImageReferenceStore;
    fileStore: FileReferenceStore;
    piAuthPath: string;
    codexAuthPath: string;
    codexConfigDir: string;
    sessionDir: string;
    artifactsDir: string;
    refreshRuntimeInventory?: () => Promise<void>;
  }) {
    super();
    this.store = options.store;
    this.codexClient = options.codexClient;
    this.runtimeBroker = options.runtimeBroker;
    this.serviceTemplateRegistry = options.serviceTemplateRegistry;
    this.imageStore = options.imageStore;
    this.fileStore = options.fileStore;
    this.piAuthPath = options.piAuthPath;
    this.codexAuthPath = options.codexAuthPath;
    this.codexConfigDir = options.codexConfigDir;
    this.sessionDir = options.sessionDir;
    this.artifactsDir = options.artifactsDir;
    this.refreshRuntimeInventory = options.refreshRuntimeInventory ?? null;
    this.operatorMessageStatePath = path.join(this.sessionDir, "operator-messages.json");
    this.activitySummaryStatePath = path.join(this.sessionDir, "activity-summaries.json");
    this.legacyNoticeStatePath = path.join(this.sessionDir, "notices.json");
    this.callbackStatePath = path.join(this.sessionDir, "chat-callbacks.json");
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
        const kind = item.kind === "message" || typeof item.kind !== "string" ? "message" : null;

        if (!id || !role || !text || !kind) {
          continue;
        }

        this.operatorMessages.push({ id, role, text, at, kind });
      }

      this.operatorMessages.sort((left, right) => (left.at ?? 0) - (right.at ?? 0));
      if (this.operatorMessages.length > 40) {
        this.operatorMessages.splice(0, this.operatorMessages.length - 40);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }

      await this.loadLegacyOperatorMessageState();
    }
  }

  private async loadLegacyOperatorMessageState(): Promise<void> {
    try {
      const raw = await fs.readFile(this.legacyNoticeStatePath, "utf8");
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) {
        return;
      }

      this.operatorMessages.splice(0, this.operatorMessages.length);
      for (const item of parsed) {
        if (!item || typeof item !== "object" || item.kind === "notice") {
          continue;
        }

        const id = typeof item.id === "string" ? item.id : null;
        const role = typeof item.role === "string" ? item.role : null;
        const text = typeof item.text === "string" ? item.text : null;
        const at = typeof item.at === "number" && Number.isFinite(item.at) ? item.at : null;

        if (!id || !role || !text) {
          continue;
        }

        this.operatorMessages.push({ id, role, text, at, kind: "message" });
      }

      this.operatorMessages.sort((left, right) => (left.at ?? 0) - (right.at ?? 0));
      if (this.operatorMessages.length > 40) {
        this.operatorMessages.splice(0, this.operatorMessages.length - 40);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }
  }

  private async loadCallbackState(): Promise<void> {
    try {
      const raw = await fs.readFile(this.callbackStatePath, "utf8");
      const parsed = JSON.parse(raw) as {
        callbackRecords?: PendingChatCallback[];
        pendingCallbacks?: PendingChatCallback[];
        deliveredCloseoutIds?: string[];
        deliveredMilestoneIds?: string[];
      };

      this.pendingChatCallbacks.clear();
      const callbackEntries = parsed.callbackRecords ?? parsed.pendingCallbacks ?? [];
      for (const entry of callbackEntries) {
        if (!entry || typeof entry !== "object" || typeof entry.threadId !== "string") {
          continue;
        }
        const requestedAt = typeof entry.requestedAt === "number" && Number.isFinite(entry.requestedAt) ? entry.requestedAt : Date.now();
        const updatedAt = typeof entry.updatedAt === "number" && Number.isFinite(entry.updatedAt) ? entry.updatedAt : requestedAt;
        const callbackState =
          entry.callbackState === "received_worker_callback" ||
          entry.callbackState === "missing_worker_callback" ||
          entry.callbackState === "recovered_from_thread_state" ||
          entry.callbackState === "closed" ||
          entry.callbackState === "waiting"
            ? entry.callbackState
            : "waiting";
        const resolutionState =
          entry.resolutionState === "received_worker_callback" || entry.resolutionState === "recovered_from_thread_state"
            ? entry.resolutionState
            : callbackState === "received_worker_callback" || callbackState === "recovered_from_thread_state"
              ? callbackState
              : null;
        const normalizedCallbackState =
          (entry.operatorCloseoutStatus === "posted" || entry.owesOperatorReply === false) &&
          (callbackState === "received_worker_callback" || callbackState === "recovered_from_thread_state")
            ? "closed"
            : callbackState;
        const normalizedReviewReason =
          normalizedCallbackState === "received_worker_callback"
            ? "worker_callback"
            : normalizedCallbackState === "missing_worker_callback"
              ? "thread_recovery"
              : null;
        this.pendingChatCallbacks.set(entry.threadId, {
          threadId: entry.threadId,
          callbackState: normalizedCallbackState,
          resolutionState,
          requestedAt,
          lastEventAt: typeof entry.lastEventAt === "number" && Number.isFinite(entry.lastEventAt) ? entry.lastEventAt : updatedAt,
          lastWorkerStatusSeen:
            entry.lastWorkerStatusSeen === "active" || entry.lastWorkerStatusSeen === "idle" || entry.lastWorkerStatusSeen === "unknown"
              ? entry.lastWorkerStatusSeen
              : null,
          lastTerminalReportAt:
            typeof entry.lastTerminalReportAt === "number" && Number.isFinite(entry.lastTerminalReportAt)
              ? entry.lastTerminalReportAt
              : null,
          lastPrivateSteerText: typeof entry.lastPrivateSteerText === "string" && entry.lastPrivateSteerText.trim() ? entry.lastPrivateSteerText : null,
          lastPrivateSteerAt:
            typeof entry.lastPrivateSteerAt === "number" && Number.isFinite(entry.lastPrivateSteerAt) ? entry.lastPrivateSteerAt : null,
          nextWorkerReportAction: entry.nextWorkerReportAction === "reply_to_operator" ? "reply_to_operator" : "review",
          operatorCloseoutStatus:
            entry.operatorCloseoutStatus === "not_required" ||
            entry.operatorCloseoutStatus === "owed" ||
            entry.operatorCloseoutStatus === "posted"
              ? entry.operatorCloseoutStatus
              : normalizedCallbackState === "closed"
                ? "posted"
                : "owed",
          owesOperatorReply: typeof entry.owesOperatorReply === "boolean" ? entry.owesOperatorReply : normalizedCallbackState !== "closed",
          closeoutChannel:
            entry.closeoutChannel === "main_chat" ||
            entry.closeoutChannel === "none"
              ? entry.closeoutChannel
              : normalizedCallbackState === "closed"
                ? "main_chat"
                : "none",
          reviewState: normalizedReviewReason ? "queued" : "idle",
          reviewReason: normalizedReviewReason,
          closedAt: typeof entry.closedAt === "number" && Number.isFinite(entry.closedAt) ? entry.closedAt : null,
          updatedAt
        });
      }

      this.deliveredCloseoutIds.clear();
      for (const closeoutId of [...(parsed.deliveredCloseoutIds ?? []), ...(parsed.deliveredMilestoneIds ?? [])]) {
        if (typeof closeoutId === "string" && closeoutId.trim()) {
          this.deliveredCloseoutIds.add(closeoutId);
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }
  }

  private async saveOperatorMessageState(): Promise<void> { await fs.writeFile(this.operatorMessageStatePath, JSON.stringify(this.operatorMessages, null, 2), "utf8"); }

  private async loadActivitySummaryState(): Promise<void> {
    try {
      const raw = await fs.readFile(this.activitySummaryStatePath, "utf8");
      this.activitySummaryTurns.splice(0, this.activitySummaryTurns.length, ...normalizeButlerActivitySummaryTurns(JSON.parse(raw)));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }
  }

  private async saveActivitySummaryState(): Promise<void> { await fs.writeFile(this.activitySummaryStatePath, JSON.stringify(this.activitySummaryTurns, null, 2), "utf8"); }

  private persistActivitySummaryTurn(turn: ButlerActivityTurnView): void {
    const nextTurns = normalizeButlerActivitySummaryTurns([
      ...this.activitySummaryTurns.filter((entry) => entry.id !== turn.id),
      turn
    ]);
    this.activitySummaryTurns.splice(0, this.activitySummaryTurns.length, ...nextTurns);
    void this.saveActivitySummaryState();
  }

  private async saveCallbackState(): Promise<void> {
    await fs.writeFile(
      this.callbackStatePath,
      JSON.stringify(
        {
          callbackRecords: [...this.pendingChatCallbacks.values()],
          deliveredCloseoutIds: [...this.deliveredCloseoutIds]
        },
        null,
        2
      ),
      "utf8"
    );
  }

  async clearChat(): Promise<void> { this.operatorMessages.splice(0, this.operatorMessages.length); this.activityTurns.splice(0, this.activityTurns.length); this.activitySummaryTurns.splice(0, this.activitySummaryTurns.length); this.activeActivityTurnId = null; await Promise.all([this.saveOperatorMessageState(), this.saveActivitySummaryState()]); clearButlerSessionChat(this.session); this.lastError = null; this.emit("change"); }

  async deleteChatFromMessage(messageId: string): Promise<void> { const deleteFrom = deleteButlerSessionChatFrom(this.session, messageId); keepOperatorMessagesBefore(this.operatorMessages, deleteFrom); const prunedActivity = keepButlerActivityBefore(this as unknown as ButlerAgentSessionAccess, deleteFrom); await Promise.all([this.saveOperatorMessageState(), ...(prunedActivity ? [this.saveActivitySummaryState()] : [])]); this.lastError = null; this.emit("change"); }

  async notifyDirectCodexMessage(input: DirectCodexMessagePingInput & { threadId: string }): Promise<void> { await notifyDirectCodexMessage(this as unknown as DirectCodexMessageAccess, input); }

  private registerPendingChatCallback(threadId: string, options?: { privateSteerText?: string | null; nextWorkerReportAction?: "review" | "reply_to_operator" }): void {
    const now = Date.now();
    const existing = this.pendingChatCallbacks.get(threadId);
    const privateSteerText = typeof options?.privateSteerText === "string" && options.privateSteerText.trim() ? options.privateSteerText.trim() : null;
    const nextWorkerReportAction = options?.nextWorkerReportAction === "reply_to_operator" ? "reply_to_operator" : "review";
    this.pendingChatCallbacks.set(threadId, {
      threadId,
      callbackState: "waiting",
      resolutionState: null,
      requestedAt: now,
      lastEventAt: now,
      lastWorkerStatusSeen: this.store.getThread(threadId)?.status ?? null,
      lastTerminalReportAt: null,
      lastPrivateSteerText: privateSteerText,
      lastPrivateSteerAt: privateSteerText ? now : null,
      nextWorkerReportAction,
      operatorCloseoutStatus: "owed",
      owesOperatorReply: true,
      closeoutChannel: "none",
      reviewState: "idle",
      reviewReason: null,
      closedAt: null,
      updatedAt: now
    });
    this.store.addEvent(threadId, existing ? "butler.callback.rearmed" : "butler.callback.registered", existing
      ? "Butler renewed the operator closeout obligation after a private steer."
      : "Butler registered an operator closeout obligation.");
    void this.saveCallbackState();
  }

  private queueDelegationAcknowledgement(threadId: string, text: string): void {
    const at = Date.now();
    const messageId = `delegation-ack-${threadId}`;
    this.upsertOperatorMessage(messageId, text, at);
    this.noteThreadFocus(threadId, "delegation");
    this.store.addEvent(threadId, "butler.acknowledgement.posted", "Butler posted the operator-facing delegation acknowledgement.");
    void this.saveOperatorMessageState();
    this.emit("change");
  }

  private upsertOperatorMessage(id: string, text: string, at: number): void {
    const existingMessage = this.operatorMessages.find((entry) => entry.id === id);
    if (existingMessage) {
      existingMessage.text = text;
      existingMessage.at = at;
    } else {
      this.operatorMessages.push({
        id,
        role: "assistant",
        text,
        at,
        kind: "message"
      });
    }
    this.operatorMessages.sort((left, right) => (left.at ?? 0) - (right.at ?? 0));
    if (this.operatorMessages.length > 40) {
      this.operatorMessages.splice(0, this.operatorMessages.length - 40);
    }
  }

  private async postOperatorJobReply(threadId: string, text: string): Promise<void> {
    const callback = this.pendingChatCallbacks.get(threadId);
    if (!callback || !isCallbackOutstanding(callback)) {
      throw new Error(`Job ${threadId} does not have an outstanding operator reply obligation.`);
    }
    const thread = this.store.getThread(threadId);
    if (!thread) {
      throw new Error(`Job ${threadId} is no longer available.`);
    }
    const workerReport = this.store.getWorkerReport(threadId);
    const relevantWorkerReport = workerReport && workerReport.updatedAt >= callback.requestedAt ? workerReport : null;
    const closeoutTurnId = relevantWorkerReport?.turnId ?? getFallbackTurnId(thread);
    if (!closeoutTurnId) {
      throw new Error(`Job ${threadId} does not have a turn Butler can close against yet.`);
    }
    const closeoutId = buildCloseoutId(threadId, closeoutTurnId);
    const messageId = relevantWorkerReport ? `callback-${closeoutId}` : `callback-fallback-${closeoutId}`;
    const at = relevantWorkerReport?.updatedAt ?? thread.updatedAt;
    const resolutionState = relevantWorkerReport ? "received_worker_callback" : "recovered_from_thread_state";
    this.upsertOperatorMessage(messageId, text.trim(), at);
    this.noteThreadFocus(threadId, "closeout");
    this.deliveredCloseoutIds.add(closeoutId);
    callback.callbackState = "closed";
    callback.resolutionState = resolutionState;
    callback.lastWorkerStatusSeen = thread.status;
    callback.lastEventAt = at;
    callback.lastTerminalReportAt = relevantWorkerReport?.updatedAt ?? callback.lastTerminalReportAt;
    callback.lastPrivateSteerText = callback.lastPrivateSteerText ?? null;
    callback.lastPrivateSteerAt = callback.lastPrivateSteerAt ?? null;
    callback.nextWorkerReportAction = "review";
    callback.operatorCloseoutStatus = "posted";
    callback.owesOperatorReply = false;
    callback.closeoutChannel = "main_chat";
    callback.reviewState = "idle";
    callback.reviewReason = null;
    callback.closedAt = at;
    callback.updatedAt = Date.now();

    this.store.addEvent(threadId, resolutionState === "received_worker_callback" ? "butler.job.closed" : "butler.recovery.invoked", resolutionState === "received_worker_callback"
      ? "Butler posted the operator-facing closeout after reviewing the worker callback."
      : "Butler posted the operator-facing closeout after recovering from thread state.");
    if (resolutionState === "recovered_from_thread_state") {
      this.store.addEvent(threadId, "butler.job.closed", "Butler closed the delegated job after thread-state recovery.");
    }

    await this.saveOperatorMessageState();
    await this.saveCallbackState();
    this.emit("change");
  }

  private describePendingCallbacks(): string {
    return describePendingCallbacks(this.store, [...this.pendingChatCallbacks.values()]);
  }

  private async reconcilePendingChatCallbacks(): Promise<void> {
    const outstandingCallbacks = [...this.pendingChatCallbacks.values()].filter(isCallbackOutstanding);
    if (outstandingCallbacks.length === 0) {
      return;
    }

    let changed = false;
    for (const callback of outstandingCallbacks) {
      const now = Date.now();
      callback.updatedAt = now;
      try {
        await this.codexClient.loadThread(callback.threadId);
      } catch {
        callback.lastWorkerStatusSeen = "unknown";
        changed = true;
        continue;
      }

      const thread = this.store.getThread(callback.threadId);
      const workerReport = this.store.getWorkerReport(callback.threadId);
      const relevantWorkerReport = workerReport && workerReport.updatedAt >= callback.requestedAt ? workerReport : null;
      const nextStatus = thread?.status ?? "unknown";
      const fallbackAnchorAt = Math.max(callback.requestedAt, thread?.updatedAt ?? callback.requestedAt);
      const callbackTimedOut = now - fallbackAnchorAt >= CALLBACK_RECOVERY_TIMEOUT_MS;
      const nextCallbackState =
        relevantWorkerReport
          ? "received_worker_callback"
          : nextStatus !== "idle" ||
              !(thread?.supervisor.latestAgentReply?.trim()) ||
              (thread?.updatedAt ?? 0) < callback.requestedAt ||
              !callbackTimedOut
            ? "waiting"
            : "missing_worker_callback";

      if (callback.lastWorkerStatusSeen !== nextStatus || callback.callbackState !== nextCallbackState) {
        callback.lastWorkerStatusSeen = nextStatus;
        callback.lastEventAt = thread?.updatedAt ?? now;
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
    }

    if (changed) {
      await this.saveCallbackState();
    }

    await this.processPendingChatCallbacks();
  }

  private async processPendingChatCallbacks(): Promise<boolean> {
    const outstandingCallbacks = [...this.pendingChatCallbacks.values()].filter(isCallbackOutstanding);
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
      const relevantWorkerReport = workerReport && workerReport.updatedAt >= callback.requestedAt ? workerReport : null;
      if (relevantWorkerReport) {
        callback.lastTerminalReportAt = relevantWorkerReport.updatedAt;
        callback.lastEventAt = relevantWorkerReport.updatedAt;
        callback.lastWorkerStatusSeen = thread.status;
        if (callback.nextWorkerReportAction === "reply_to_operator") {
          const text = buildChatCallbackText(thread, relevantWorkerReport);
          if (text) {
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
      if (callback.reviewState !== "queued" || callback.reviewReason !== "thread_recovery") {
        callback.reviewState = "queued";
        callback.reviewReason = "thread_recovery";
        callback.updatedAt = Date.now();
        changed = true;
      }
    }

    if (changed) {
      this.operatorMessages.sort((left, right) => (left.at ?? 0) - (right.at ?? 0));
      if (this.operatorMessages.length > 40) {
        this.operatorMessages.splice(0, this.operatorMessages.length - 40);
      }
      await this.saveOperatorMessageState();
      await this.saveCallbackState();
      this.emit("change");
    }

    return changed;
  }

  private handleStoreChange(): void {
    void (async () => {
      await this.processPendingChatCallbacks();
      this.scheduleCallbackReviews();
      this.scheduleSmokeTestReactions();
    })().catch((error) => {
      this.lastError = error instanceof Error ? error.message : String(error);
      this.emit("change");
    });
  }

  async start(): Promise<void> {
    await fs.mkdir(this.sessionDir, { recursive: true });
    await this.loadOperatorMessageState();
    await this.loadActivitySummaryState();
    await this.loadCallbackState();
    this.auth = await readButlerAuthStatus(this.piAuthPath);
    this.codexAuth = await readCodexAuthStatus(this.codexAuthPath);
    this.modelRegistry = ModelRegistry.inMemory(AuthStorage.create(this.piAuthPath));
    await this.createOrRefreshSession();
    await this.refreshExternalStatus();
    this.store.on("change", () => this.handleStoreChange());
    this.handleStoreChange();
    this.statusRefreshTimer = setInterval(() => {
      void this.refreshExternalStatus();
    }, 10000);

    this.ready = true;
    this.emit("change");
  }

  private async refreshExternalStatus(): Promise<void> {
    const nextAuth = await readButlerAuthStatus(this.piAuthPath);
    const nextCodexAuth = await readCodexAuthStatus(this.codexAuthPath);
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
      this.modelRegistry = ModelRegistry.inMemory(AuthStorage.create(this.piAuthPath));
      await this.createOrRefreshSession();
    }
    this.codexAuth = nextCodexAuth;

    const nextOnboarding = await buildOnboardingView({
      butlerAuth: this.auth,
      codexAuth: this.codexAuth,
      codexConfigDir: this.codexConfigDir
    });

    if (JSON.stringify(nextOnboarding) !== JSON.stringify(this.onboarding) || authChanged) {
      this.onboarding = nextOnboarding;
      this.emit("change");
    }

    await this.reconcilePendingChatCallbacks();
    this.scheduleCallbackReviews();
  }

  // This is the single discoverable registry for Butler actions and their UI
  // side effects. Keep agent tool definitions aligned with this catalog.
  private buildToolCatalog(): ButlerToolView[] {
    return BUTLER_TOOL_CATALOG;
  }

  private getToolUiEffects(name: string): ButlerToolUiEffect[] {
    return this.toolCatalog.find((tool) => tool.name === name)?.uiEffects ?? [];
  }

  private getToolAccess(): ButlerAgentToolAccess { return this as unknown as ButlerAgentToolAccess; }

  private getSessionAccess(): ButlerAgentSessionAccess { return this as unknown as ButlerAgentSessionAccess; }

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
    execute: (toolCallId: string, params: TParams) => Promise<{ content: Array<{ type: "text"; text: string }>; details?: Record<string, unknown> }>;
  }) {
    return defineTool({
      name: definition.name,
      label: definition.label,
      description: definition.description,
      promptSnippet: definition.promptSnippet,
      parameters: definition.parameters,
      execute: async (toolCallId, params) => {
        const result = await definition.execute(toolCallId, params as TParams);
        return {
          ...result,
          details: {
            ...(result.details ?? {}),
            uiEffects: definition.uiEffects
          }
        };
      }
    });
  }

  private getThreadBudgetLimitMessage(threadId: string): string | null {
    const supervision = this.store.getThreadSupervision(threadId);
    if (supervision.maxButlerTurns === null || supervision.butlerTurnsUsed < supervision.maxButlerTurns) {
      return null;
    }

    return `Butler has reached the supervision limit for job ${threadId}. Used ${supervision.butlerTurnsUsed}/${supervision.maxButlerTurns} Butler turns. Raise the limit on that thread before asking Butler to steer it again.`;
  }

  private async buildDelegationDeveloperInstructions(
    workspace: { cwd: string; branchName: string | null },
    task: string
  ): Promise<string> {
    const repoBootstrapTask = isSharedShellRepoBootstrapTask(task);
    const managedWorktreeTask = taskRequiresManagedWorktree(task);

    return [
      "This thread was started by Butler.",
      "You are the worker inside Manor. Butler is the supervisor.",
      "Execute the requested task directly instead of explaining how the operator could do it manually.",
      "The task prompt includes a MANOR JOB BRIEF with the thread id, workspace, branch, and harness binding. Use that brief if any older path or branch hint conflicts with it.",
      "Once you are inside a repository with its own AGENTS guidance, follow that repo-specific guidance over generic Manor defaults.",
      `Work inside ${workspace.cwd} unless the task explicitly requires a deeper subdirectory.`,
      workspace.branchName
        ? `Stay on branch ${workspace.branchName}. Do not switch back to main or share this branch with another task.`
        : repoBootstrapTask
          ? "For repository bootstrap work in /repos, clone first in Codex-shell. After the repo exists, create the requested butler/ branch inside that repo."
          : managedWorktreeTask
            ? "Create or reuse the explicitly requested isolated branch or worktree before you make changes."
            : "Stay on the existing checkout. Do not create a branch or managed worktree unless the operator explicitly asked for one.",
      "Use Codex-shell for repository, git, and code-editing work.",
      "When the task needs a running app, disposable dependency, browser interaction, or durable proof, use manor-harness and choose the simplest working path.",
      "Browser-use sessions already record video, tracing, a ready screenshot, a final screenshot, and per-action screenshots by default. Use them when the task asks for browser proof. Use file proof when a durable file, PDF, Office file, archive, report, export, or log is the simplest evidence.",
      "Do not wait for Manor to infer project commands. If the project needs install, run, test, or bootstrap commands, choose and run them explicitly.",
      "Keep visible Codex chatter useful: post brief progress notes before major phases, after meaningful findings, and before long-running verification.",
      "Do not bury the thread in tool calls only. If you are about to run several commands or inspect several files, say what you are doing and what you learned afterward.",
      "Prefer simple execution over ceremony. Keep progress notes concise and avoid restating obvious plans.",
      "Use only the harness actions exposed through `manor-harness`.",
      "Treat the job brief acceptance points as the supervisor contract. Complete and verify each point before reporting completed.",
      "When reporting completion, include brief evidence for each acceptance point in the supervisor report details. Reference the relevant screenshot, video, trace, browser proof, desktop proof, log, or file proof when available.",
      "Do not claim an acceptance point is complete unless you have checked it. If evidence is missing or a point is incomplete, report blocked or continue the work.",
      "Keep Butler-owned memory current when it materially helps continuation. Use `manor-harness memory checkpoint`, `memory decision`, and `memory note` sparingly and only when the information is worth preserving.",
      "If the job produced reusable decisions, gotchas, PR verdicts, repo state changes, or project facts, include them plainly in the supervisor report details so Butler's separate memory-review pass can propose durable candidates.",
      "When you complete meaningful work, record a supervisor report before your final reply with `manor-harness report --status completed --summary \"<concise outcome>\" --details \"<brief oversight note with the key fact, risk, or next step>\"`.",
      "If you are blocked or need operator attention, record it before your reply with `manor-harness report --status blocked --summary \"<what is blocked>\" --details \"<what you need, what failed, or the next recommended action>\"`.",
      "Supervisor reports should help Butler oversee the job. Keep `summary` short and outcome-first, and use `details` for the extra context Butler should surface without dumping the whole conversation.",
      "Keep the thread focused on the delegated task and report concise progress and outcome."
    ].join("\n");
  }

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

  private async sendPrivateJobFollowUp(threadId: string, text: string): Promise<void> {
    const limitMessage = this.getThreadBudgetLimitMessage(threadId);
    if (limitMessage) {
      throw new Error(limitMessage);
    }

    await this.codexClient.loadThread(threadId);
    await this.codexClient.sendMessage(threadId, this.imageStore.buildCodexInput(text, []));
    this.store.noteButlerSteer(threadId);
    this.store.addEvent(threadId, "butler.supervision.turn_spent", "Butler spent a private supervision turn on this job.");
  }

  private scheduleCallbackReviews(): void {
    if (this.callbackReviewInFlight) {
      this.callbackReviewQueued = true;
      return;
    }

    this.callbackReviewInFlight = true;
    void this.processCallbackReviews()
      .catch((error) => {
        this.lastError = error instanceof Error ? error.message : String(error);
      })
      .finally(() => {
        this.callbackReviewInFlight = false;
        if (this.callbackReviewQueued) {
          this.callbackReviewQueued = false;
          this.scheduleCallbackReviews();
        }
      });
  }

  private async processCallbackReviews(): Promise<void> {
    const pendingReviews = [...this.pendingChatCallbacks.values()]
      .filter((callback) => isCallbackOutstanding(callback) && callback.reviewState === "queued")
      .sort((left, right) => left.updatedAt - right.updatedAt);

    if (pendingReviews.length === 0) {
      return;
    }

    for (const callback of pendingReviews) {
      const liveCallback = this.pendingChatCallbacks.get(callback.threadId);
      if (!liveCallback || !isCallbackOutstanding(liveCallback) || liveCallback.reviewState !== "queued") {
        continue;
      }

      liveCallback.reviewState = "running";
      liveCallback.updatedAt = Date.now();
      await this.saveCallbackState();
      this.emit("change");

      try {
        await promptButlerInternal(this.getSessionAccess(), buildCallbackReviewPrompt(this.store, liveCallback));
      } catch (error) {
        const nextCallback = this.pendingChatCallbacks.get(callback.threadId);
        if (nextCallback && isCallbackOutstanding(nextCallback)) {
          nextCallback.reviewState = "queued";
          nextCallback.updatedAt = Date.now();
          await this.saveCallbackState();
          this.emit("change");
        }
        throw error;
      }

      const nextCallback = this.pendingChatCallbacks.get(callback.threadId);
      if (!nextCallback || !isCallbackOutstanding(nextCallback)) {
        continue;
      }
      if (nextCallback.reviewState === "running") {
        const thread = this.store.getThread(callback.threadId);
        const workerReport = this.store.getWorkerReport(callback.threadId);
        const relevantWorkerReport = workerReport && workerReport.updatedAt >= nextCallback.requestedAt ? workerReport : null;
        const safeCloseoutText =
          nextCallback.callbackState === "received_worker_callback"
            ? buildChatCallbackText(thread, relevantWorkerReport)
            : nextCallback.callbackState === "missing_worker_callback"
              ? buildFallbackChatCallbackText(thread)
              : null;
        if (safeCloseoutText) {
          await this.postOperatorJobReply(callback.threadId, safeCloseoutText);
          continue;
        }

        nextCallback.reviewState = "idle";
        nextCallback.updatedAt = Date.now();
        await this.saveCallbackState();
        this.emit("change");
      }
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
  }): Promise<{ text: string; contract: CodexThreadExecutionContractView }> {
    const requestedTask = options.goal ? `${options.task}\n\nGoal: ${options.goal}` : options.task;
    const requestedTaskOnly = options.task.trim();
    const operatorGoal = options.goal?.trim() ? options.goal.trim() : null;
    const project = resolveWorkspaceProjectInfo(options.workspace.cwd);
    const repoBootstrapTask = isSharedShellRepoBootstrapTask(requestedTaskOnly);
    const notes = ["Use this job brief if older task text points at a stale workspace or branch."];
    const workspaceMentions = extractWorkspaceMentions(requestedTask).filter((entry) => entry !== options.workspace.cwd);

    for (const mention of workspaceMentions) {
      const resolvedMention = await resolveExistingWorkspaceCwd(mention);
      const mentionExists = await fs.access(resolvedMention).then(() => true).catch(() => false);
      if (!mentionExists) {
        notes.push(`Ignore stale workspace hint ${mention}. Use ${options.workspace.cwd} instead.`);
        continue;
      }
      if (resolvedMention !== mention && resolvedMention === options.workspace.cwd) {
        notes.push(`The task referenced ${mention}, but the live workspace resolves to ${options.workspace.cwd}.`);
      }
    }

    if (options.extraNotes?.length) notes.push(...options.extraNotes);

    if (repoBootstrapTask) {
      notes.push("This job begins in the shared /repos workspace. Create or clone the repo first, then continue inside it.");
    }
    const projectPolicyLines = formatProjectPolicyContextLines({ store: this.store, projectId: project.id });
    if (projectPolicyLines.length > 1) {
      notes.push(...projectPolicyLines.slice(1));
    }

    const baseContract = buildThreadExecutionContract({
      threadId: options.threadId,
      workspaceCwd: options.workspace.cwd,
      projectId: project.id,
      projectLabel: project.label,
      branch: options.workspace.branchName,
      taskText: requestedTask,
      requestedTask: requestedTaskOnly,
      operatorGoal,
      notes
    });
    const contract: CodexThreadExecutionContractView = {
      ...baseContract,
      requestedTask: requestedTaskOnly,
      operatorGoal,
      notes: [...new Set(notes.map((note) => note.trim()).filter(Boolean))]
    };
    const lines = [
      "MANOR JOB BRIEF",
      `thread_id: ${options.threadId}`,
      `workspace_cwd: ${options.workspace.cwd}`,
      `project_id: ${project.id}`,
      `project_label: ${project.label}`,
      `branch: ${options.workspace.branchName ?? "(existing workspace)"}`,
      `harness_binding: manor-harness --thread ${options.threadId}`,
      `proof_expectation: ${describeProofExpectation(contract.proofExpectation)}`,
    ];

    for (const point of contract.acceptancePoints) {
      lines.push(`acceptance_point: ${point}`);
    }

    if (contract.operatorGoal) {
      lines.push(`operator_goal: ${contract.operatorGoal}`);
    }

    for (const note of notes) {
      lines.push(`note: ${note}`);
    }

    return {
      text: `${lines.join("\n")}\n\nREQUESTED TASK\n${requestedTask}`,
      contract
    };
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
      .filter((stack) => stack.status !== "stopped" && (!threadId || stack.threadId === threadId || !stack.threadId));
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

    if (threadId && stack.threadId && stack.threadId !== threadId) {
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
      .filter((preview) => preview.status !== "stopped" && (!threadId || preview.threadId === threadId || !preview.threadId));
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
    runId?: string
  ): ResolvedPreviewProof {
    const decoratedVerification = decoratePreviewVerification(verification);
    if (runId && decoratedVerification.runId !== runId.trim()) {
      throw new Error(`Preview ${subject.id} does not have verification run ${runId.trim()}.`);
    }

    const artifacts = decoratedVerification.artifacts.filter((artifact) => artifact.filePath && artifact.availability === "available");
    if (artifacts.length === 0) throw new Error(`Preview ${subject.id} has no available proof artifact to review.`);
    const availableScreenshots = findVerificationArtifacts(decoratedVerification, "screenshot").filter((artifact) => artifact.filePath && artifact.availability === "available");

    return {
      preview: subject,
      verification: decoratedVerification,
      primaryArtifact: availableScreenshots[0] ?? artifacts[0]!,
      primaryScreenshot: availableScreenshots[0] ?? null,
      artifacts,
      screenshots: availableScreenshots,
      video: findVerificationArtifact(decoratedVerification, "video"),
      manifest: findVerificationArtifact(decoratedVerification, "manifest"),
      trace: findVerificationArtifact(decoratedVerification, "trace")
    };
  }

  private resolvePreviewProof(params: { threadId?: string; leaseId?: string; runId?: string }): ResolvedPreviewProof {
    const preview = params.leaseId ? this.requireValidatedPreview(params.leaseId, params.threadId?.trim() || null) : null;

    if (preview?.lastVerification) {
      return this.toResolvedProof(preview, preview.lastVerification, params.runId);
    }

    const previewProof =
      preview
        ? this.store.getLatestPreviewProofForPreview(preview.id)
        : params.threadId
          ? this.store.getLatestPreviewProofForThread(params.threadId.trim())
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
        params.runId
      );
    }

    if (!preview && params.threadId) {
      const latestPreview = this.getLatestThreadVerificationPreview(params.threadId.trim());
      if (latestPreview.lastVerification) {
        return this.toResolvedProof(latestPreview, latestPreview.lastVerification, params.runId);
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

  private async reviewProofScreenshot(proof: ResolvedPreviewProof, options?: { expectedOutcome?: string }): Promise<ProofScreenshotReview> { return reviewButlerProofScreenshot(this.getSessionAccess(), proof, options); }

  private buildCustomTools() {
    const toolAccess = this.getToolAccess();
    return [...buildButlerStackPreviewTools(toolAccess), ...buildButlerServiceTools(toolAccess), ...buildButlerProjectTools(toolAccess, this.artifactsDir), ...buildButlerCodexTools(toolAccess), ...buildButlerDelegationTools(toolAccess)];
  }

  private async createOrRefreshSession(): Promise<void> { await createOrRefreshButlerSession(this.getSessionAccess()); }

  private async sanitizePersistedSessions(): Promise<void> { await sanitizePersistedButlerSessions(this.getSessionAccess()); }

  private restoreCompactionState(): void { restoreButlerCompactionState(this.getSessionAccess()); }

  private sanitizeSessionMessages(): void { sanitizeButlerSessionMessages(this.getSessionAccess()); }

  getMessagePage(before: number | null, limit: number): ButlerMessagePageView { return getButlerMessagePage(this.getSessionAccess(), before, limit); }

  getLiveSnapshot(): ButlerLiveSnapshot { return getButlerLiveSnapshot(this.getSessionAccess()); }

  getShellSnapshot(): AppShellSnapshot["butler"] { return getButlerShellSnapshot(this.getSessionAccess()); }

  getSnapshot(): AppSnapshot["butler"] { return getButlerSnapshot(this.getSessionAccess()); }

  getCodexAuthStatus(): ButlerAuthStatus { return this.codexAuth; }

  private async promptOperatorTurn(text: string, imageReferenceIds: string[] = [], options: { mode?: "queue" | "steer" } = {}): Promise<void> {
    const guard = buildOperatorThreadGuard(this.store, text, this.getRecentFocusedThreadId());
    this.activeOperatorThreadGuard = guard;
    if (guard.lockedThreadId && this.store.getThread(guard.lockedThreadId)) {
      this.noteThreadFocus(guard.lockedThreadId, guard.explicitThreadIds.length > 0 ? "operator_reference" : "operator_follow_up");
    }

    try {
      if (guard.contextPrompt) {
        await promptButlerInternal(this.getSessionAccess(), ["This is hidden grounding for the next operator turn.", "Do not answer it directly.", "Use it to keep job references exact during the next operator turn only.", guard.contextPrompt].join("\n"));
      }
      await promptButler(this.getSessionAccess(), text, imageReferenceIds, options);
    } finally {
      this.activeOperatorThreadGuard = null;
    }
  }

  prompt(text: string, imageReferenceIds: string[] = [], options: { mode?: "queue" | "steer" } = {}): void { void this.promptOperatorTurn(text, imageReferenceIds, options); }

  async stopPrompt(): Promise<boolean> { return stopButlerPrompt(this.getSessionAccess()); }

  async updateComposeSettings(provider: string, modelId: string, thinkingLevel: ButlerThinkingLevel): Promise<void> { await updateButlerComposeSettings(this.getSessionAccess(), provider, modelId, thinkingLevel); }
}
