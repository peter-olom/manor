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
  dropTrailingFailedButlerTurns,
  extractLatestAssistantFailure as extractButlerAssistantFailure,
  getButlerCompactionSnapshot,
  getButlerContextUsage,
  getButlerLiveSnapshot,
  getButlerMessagePage,
  getButlerShellSnapshot,
  getButlerSnapshot,
  getVisibleButlerMessages,
  promptButler,
  promptButlerInternal,
  restoreButlerCompactionState,
  runButlerPrompt,
  sanitizeButlerSessionMessages,
  sanitizePersistedButlerSessions,
  updateButlerComposeSettings
} from "./butler-agent-session.js";
import { buildButlerServiceTools } from "./butler-agent-service-tools.js";
import { buildButlerProjectTools } from "./butler-agent-project-tools.js";
import { buildButlerDelegationTools, buildButlerStackPreviewTools } from "./butler-agent-stack-preview-tools.js";
import { reviewButlerProofScreenshot } from "./butler-agent-proof-review.js";
import type { ButlerAgentSessionAccess, ButlerAgentToolAccess } from "./butler-agent-tool-access.js";
import { BUTLER_TOOL_CATALOG } from "./butler-agent-tool-catalog.js";
import { readButlerAuthStatus, readCodexAuthStatus } from "./auth-status.js";
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
  describeProofMode,
  detectExecutionLane,
  detectProofMode,
  isSharedShellRepoBootstrapTask,
  taskNeedsRuntimeExecution
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
  ButlerAuthStatus,
  ButlerThreadCallbackView,
  ButlerCompactionView,
  ButlerContextUsageView,
  ButlerMessageView,
  ButlerMessagePageView,
  ButlerOnboardingView,
  ButlerThinkingLevel,
  ButlerToolUiEffect,
  ButlerToolView,
  CodexExecutionLane,
  CodexProofMode,
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
  private readonly piAuthPath: string;
  private readonly codexAuthPath: string;
  private readonly codexConfigDir: string;
  private readonly sessionDir: string;
  private readonly artifactsDir: string;
  private readonly operatorMessageStatePath: string;
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
    this.piAuthPath = options.piAuthPath;
    this.codexAuthPath = options.codexAuthPath;
    this.codexConfigDir = options.codexConfigDir;
    this.sessionDir = options.sessionDir;
    this.artifactsDir = options.artifactsDir;
    this.refreshRuntimeInventory = options.refreshRuntimeInventory ?? null;
    this.operatorMessageStatePath = path.join(this.sessionDir, "operator-messages.json");
    this.legacyNoticeStatePath = path.join(this.sessionDir, "notices.json");
    this.callbackStatePath = path.join(this.sessionDir, "chat-callbacks.json");
    this.toolCatalog = this.buildToolCatalog();
  }

  private async refreshRuntimeInventoryIfAvailable(): Promise<string | null> {
    if (!this.refreshRuntimeInventory) {
      return null;
    }

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

  private async saveOperatorMessageState(): Promise<void> {
    await fs.writeFile(this.operatorMessageStatePath, JSON.stringify(this.operatorMessages, null, 2), "utf8");
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

  private async inferDelegationExecutionLane(task: string, cwd: string): Promise<CodexExecutionLane> {
    void cwd;
    return detectExecutionLane(task);
  }

  private inferDelegationProofMode(task: string): CodexProofMode {
    return detectProofMode(task);
  }

  private async buildDelegationDeveloperInstructions(
    workspace: { cwd: string; branchName: string | null },
    task: string
  ): Promise<string> {
    const repoBootstrapTask = isSharedShellRepoBootstrapTask(task);
    const managedWorktreeTask = taskRequiresManagedWorktree(task);
    const proofMode = this.inferDelegationProofMode(task);
    const runtimeLikelyNeeded = taskNeedsRuntimeExecution(task) || proofMode !== "none";

    return [
      "This thread was started by Butler.",
      "You are the worker inside Manor. Butler is the supervisor and policy owner.",
      "Execute the requested task directly instead of explaining how the operator could do it manually.",
      "The task prompt includes an AUTHORITATIVE JOB CONTRACT with the assigned thread id, workspace, harness binding, execution guidance, and proof mode. Follow that contract over any stale worktree or cwd hints elsewhere in the task.",
      "Treat the contract workspace and proof obligations as binding. Execution guidance tells you how to split repo work from runtime work.",
      "Once you are inside a repository with its own AGENTS guidance, follow that repo-specific install and runtime guidance over generic Manor defaults unless it would violate the contract's execution guidance, callback, or reporting obligations.",
      `Work inside ${workspace.cwd} unless the task explicitly requires a deeper subdirectory.`,
      workspace.branchName
        ? `Stay on branch ${workspace.branchName}. Do not switch back to main or share this branch with another task.`
        : repoBootstrapTask
          ? "For repository bootstrap work in /repos, clone first in Codex-shell. After the repo exists, create the requested butler/ branch inside that repo."
          : managedWorktreeTask
            ? "Create or reuse the explicitly requested isolated branch or worktree before you make changes."
            : "Stay on the existing checkout. Do not create a branch or managed worktree unless the operator explicitly asked for one.",
      "Do repo, git, and code-editing work in Codex-shell.",
      runtimeLikelyNeeded
        ? "When the task needs a running process, browser session, service, logs, or direct target verification, use manor-harness previews, stacks, or services as needed."
        : "Stay in Codex-shell unless the task later needs execution or proof.",
      repoBootstrapTask
        ? "For repository bootstrap work, keep the initial clone, git status, and branch setup in Codex-shell. Bring up runtime only if the task later needs execution or proof."
        : "If the task needs execution, keep the flow simple: do any needed repo prep in Codex-shell first, then use Manor runtime for run, inspect, and verify steps.",
      "Do not treat mentions of Codex-shell in the operator ask as a ban on previews when the task actually needs execution or verification.",
      "Do not wait for Manor to infer project-specific bootstrap details. If the job needs repo prep, do that explicitly in Codex-shell first. If the runtime environment needs install, env setup, or a custom start command, run those explicitly once runtime work begins.",
      "If the work needs multiple cooperating services, create a stack first with `manor-harness stack start`, then attach previews and services to it with `--stack <stackId>` and stable `--alias` names that mirror the app's expected internal hostnames.",
      "When a stack needs recurring databases or object storage, start it with `manor-harness stack start --stateful` so Manor derives a per-job retained storage key, forks from the project base, and sets the default promotion target automatically.",
      "Use `--storage-mode base` only when you are intentionally creating or refreshing the shared base state for that project. Do not share one writable database volume across concurrent jobs.",
      "After validating a job-scoped stateful stack, use `manor-harness stack promote <stackId>` to publish its retained data back to the project base. Only override the target manually when the task explicitly needs a different namespace.",
      "For attached previews and services, use `manor-harness` for inspect, logs, processes, and exec directly against the runtime. Butler still owns start, stop, lifecycle, and policy.",
      "Codex-shell is for workspace, git, and repo-directed edits only. If the task needs a running process, browser session, service, or direct target verification, use Manor runtime.",
      runtimeLikelyNeeded && proofMode === "ui"
        ? "Do not use direct shell curl or fetch as stronger evidence than preview-runtime verification. Use `manor-harness browser verify` for direct URLs and `manor-harness preview verify` for preview-backed pages."
        : "Do not treat Codex-shell checks as stronger evidence than runtime verification when the task needs execution.",
      runtimeLikelyNeeded
        ? "Do not declare the job blocked from Codex-shell setup failures while normal runtime execution or verification remains untried."
        : "Do not report the job blocked until you have exhausted the normal recovery steps for the requested repo work.",
      proofMode === "ui"
        ? "Proof mode: headed UI proof. Before reporting completion, run headed verification with browser verify for direct URLs or preview verify for preview-backed pages, then inspect the persisted proof bundle."
        : proofMode === "operational"
          ? "Proof mode: operational verification. Record the relevant runtime evidence in your report, but do not invent a browser proof requirement."
          : "Proof mode: no persisted proof bundle is required unless the operator later asks for one.",
      "Prefer explicit, boring commands over wrappers or project-specific Manor tricks. The goal is stable runtime control, not clever bootstrap.",
      runtimeLikelyNeeded
        ? "Preview commands start with the job worktree as the working directory. Prefer relative paths there, or use the contract cwd under /repos. Do not assume a /workspace mount exists inside previews."
        : "Use the contract cwd as the working directory and keep commands explicit in Codex-shell.",
      proofMode === "ui"
        ? "When UI proof requires actual interaction, use `manor-harness browser verify --url <https://...> --script-file <path> --mode headful --json` for direct URLs or `manor-harness preview verify <preview> --script-file <path> --mode headful --json` for preview-backed pages."
        : "Do not add a browser verification step unless the contract or operator explicitly asks for UI proof.",
      proofMode === "ui"
        ? "When proof needs an authenticated session, prefer `manor-harness browser verify --url <https://...> --session-cookie <token> ...` or `manor-harness preview verify <preview> --session-cookie <token> ...` instead of wrapper scripts that call `page.goto()` again."
        : "Report the concrete evidence you used without inventing extra proof steps.",
      "If the contract is for local Manor runtime and the app has email flows, prefer Mailpit or another built-in local dependency when the app under test is running inside Manor.",
      proofMode === "ui"
        ? "After verification, inspect the proof bundle from the command you used and include the screenshot, video, and manifest links in your report."
        : "Do not pad the report with artifact links that the contract did not ask for.",
      proofMode === "ui"
        ? "Do not treat artifact existence alone as accepted proof. Butler must review the screenshot, and the video is for human review."
        : "Use the smallest sufficient evidence set for the assigned proof mode.",
      "Use only the harness actions exposed through `manor-harness`. Do not try to command Butler directly outside those actions.",
      "Keep Butler-owned memory current as you work. After a meaningful checkpoint, record it with `manor-harness memory checkpoint --summary \"<what changed>\" --next-action \"<next step>\"` and add blockers, plan steps, assumptions, or proof requirements when they matter.",
      "When you make a durable decision or capture a reusable note for this job, record it with `manor-harness memory decision ...` or `manor-harness memory note ...`.",
      "If a checkpoint, decision, or note should be promoted into shared project memory later, mark it with `--promote` or submit an explicit candidate with `manor-harness memory promote ...`. Do not write shared project memory directly.",
      "When you complete meaningful work, record a supervisor report before your final reply with `manor-harness report --status completed --summary \"<concise outcome>\" --details \"<brief oversight note with the key fact, risk, or next step>\"`.",
      "If you are blocked or need operator attention, record it before your reply with `manor-harness report --status blocked --summary \"<what is blocked>\" --details \"<what you need, what failed, or the next recommended action>\"`.",
      runtimeLikelyNeeded
        ? "Do not report runtime work blocked while runtime execution remains untried unless you explain why execution itself is blocked."
        : "Do not report the job blocked until you have exhausted the normal recovery steps for the requested repo work.",
      "Supervisor reports should help Butler oversee the job. Keep `summary` short and outcome-first, and use `details` for the extra context Butler should surface without dumping the whole conversation.",
      "Keep the thread focused on the delegated task and report concise progress and outcome."
    ].join("\n");
  }

  private buildSupervisionSmokeTask(totalFollowUps: number): string {
    return [
      "This is a Butler supervision smoke test. Do not edit files, inspect repositories, or use git.",
      `The goal is to prove that Butler can steer this thread privately for ${totalFollowUps} follow-up turns without operator nudging.`,
      "Immediately emit one blocked supervisor report using the thread id from the authoritative contract:",
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

  private detectSupervisionSmokeRequest(task: string, goal?: string): { totalFollowUps: number } | null {
    const combined = [task, goal].filter(Boolean).join("\n");
    if (!/\bsmoke\b/i.test(combined)) {
      return null;
    }
    if (!/\b(supervision|oversight)\b/i.test(combined)) {
      return null;
    }

    const turnsMatch = combined.match(/\b([2-5])\s+turns?\b/i) ?? combined.match(/\bturns?\s*[:=]?\s*([2-5])\b/i);
    const totalFollowUps = turnsMatch ? Number.parseInt(turnsMatch[1] ?? "3", 10) : 3;
    return { totalFollowUps: Math.max(2, Math.min(5, totalFollowUps)) };
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
    executionLane?: CodexExecutionLane;
    proofMode?: CodexProofMode;
    extraNotes?: string[];
  }): Promise<{ text: string; contract: CodexThreadExecutionContractView }> {
    const requestedTask = options.goal ? `${options.task}\n\nGoal: ${options.goal}` : options.task;
    const requestedTaskOnly = options.task.trim();
    const operatorGoal = options.goal?.trim() ? options.goal.trim() : null;
    const project = resolveWorkspaceProjectInfo(options.workspace.cwd);
    const repoBootstrapTask = isSharedShellRepoBootstrapTask(requestedTaskOnly);
    const notes = ["Treat this contract as authoritative over any older worktree or cwd hints in the task text."];
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

    const executionLane = options.executionLane ?? (await this.inferDelegationExecutionLane(requestedTaskOnly, options.workspace.cwd));
    const proofMode = options.proofMode ?? this.inferDelegationProofMode(requestedTaskOnly);
    const runtimeLikelyNeeded = taskNeedsRuntimeExecution(requestedTaskOnly) || proofMode !== "none";
    notes.push("Use Codex-shell for repository, git, and code-editing work.");
    notes.push(
      runtimeLikelyNeeded
        ? "If the task needs execution, use manor-harness previews, stacks, or services as needed."
        : "Do not bring up Manor runtime unless the task later needs execution or proof."
    );
    if (repoBootstrapTask) {
      notes.push("For repository bootstrap tasks in /repos, keep the initial clone, git status, and branch setup in Codex-shell.");
    }
    const projectPolicyLines = formatProjectPolicyContextLines({ store: this.store, projectId: project.id });
    if (projectPolicyLines.length > 0)
      notes.push(
        "Load the remembered project policies into your plan before provisioning previews or services.",
        ...projectPolicyLines.slice(1)
      );

    const baseContract = buildThreadExecutionContract({
      threadId: options.threadId,
      workspaceCwd: options.workspace.cwd,
      projectId: project.id,
      projectLabel: project.label,
      branch: options.workspace.branchName,
      taskText: requestedTask,
      executionLane,
      proofMode,
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
      "AUTHORITATIVE JOB CONTRACT",
      `thread_id: ${options.threadId}`,
      `workspace_cwd: ${options.workspace.cwd}`,
      `project_id: ${project.id}`,
      `project_label: ${project.label}`,
      `branch: ${options.workspace.branchName ?? "(existing workspace)"}`,
      `execution_guidance: ${
        runtimeLikelyNeeded
          ? "Do repo work in Codex-shell. Use manor-harness previews, stacks, or services when you need execution."
          : "Keep repo work in Codex-shell. Use manor-harness only if the task later needs execution or proof."
      }`,
      `harness_binding: manor-harness --thread ${options.threadId}`,
      `proof_mode: ${contract.proofModeLabel}`,
    ];

    if (contract.operatorGoal) {
      lines.push(`operator_goal: ${contract.operatorGoal}`);
    }
    lines.push(`requested_task: ${contract.requestedTask}`);

    for (const condition of contract.successConditions) {
      lines.push(`success_condition: ${condition}`);
    }
    for (const condition of contract.stopConditions) {
      lines.push(`stop_condition: ${condition}`);
    }
    for (const condition of contract.escalationConditions) {
      lines.push(`escalation_condition: ${condition}`);
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

    const screenshots = findVerificationArtifacts(decoratedVerification, "screenshot");
    const availableScreenshots = screenshots.filter((artifact) => artifact.filePath && artifact.availability === "available");
    if (availableScreenshots.length === 0) {
      const latestScreenshot = screenshots.at(-1) ?? null;
      if (!latestScreenshot?.filePath) {
        throw new Error(`Preview ${subject.id} has no screenshot artifact to review.`);
      }

      throw new Error(latestScreenshot.availability === "expired"
        ? `Preview ${subject.id} screenshot proof expired after retention.`
        : `Preview ${subject.id} screenshot proof is no longer available.`);
    }

    return {
      preview: subject,
      verification: decoratedVerification,
      primaryScreenshot: availableScreenshots[0]!,
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

  private getContextUsage(): ButlerContextUsageView { return getButlerContextUsage(this.getSessionAccess()); }

  private getCompactionSnapshot(): ButlerCompactionView { return getButlerCompactionSnapshot(this.getSessionAccess()); }

  private async runPrompt(text: string, imageReferenceIds: string[] = []): Promise<void> {
    await runButlerPrompt(this.getSessionAccess(), text, imageReferenceIds);
  }

  private extractLatestAssistantFailure(): string | null { return extractButlerAssistantFailure(this.getSessionAccess()); }

  private dropTrailingFailedTurns(): void { dropTrailingFailedButlerTurns(this.getSessionAccess()); }

  private sanitizeSessionMessages(): void { sanitizeButlerSessionMessages(this.getSessionAccess()); }

  private getVisibleMessages(): ButlerMessageView[] { return getVisibleButlerMessages(this.getSessionAccess()); }

  getMessagePage(before: number | null, limit: number): ButlerMessagePageView {
    return getButlerMessagePage(this.getSessionAccess(), before, limit);
  }

  getLiveSnapshot(): ButlerLiveSnapshot { return getButlerLiveSnapshot(this.getSessionAccess()); }

  getShellSnapshot(): AppShellSnapshot["butler"] { return getButlerShellSnapshot(this.getSessionAccess()); }

  getSnapshot(): AppSnapshot["butler"] { return getButlerSnapshot(this.getSessionAccess()); }

  getCodexAuthStatus(): ButlerAuthStatus { return this.codexAuth; }

  private async promptOperatorTurn(text: string, imageReferenceIds: string[] = []): Promise<void> {
    const guard = buildOperatorThreadGuard(this.store, text, this.getRecentFocusedThreadId());
    this.activeOperatorThreadGuard = guard;

    if (guard.lockedThreadId && this.store.getThread(guard.lockedThreadId)) {
      this.noteThreadFocus(guard.lockedThreadId, guard.explicitThreadIds.length > 0 ? "operator_reference" : "operator_follow_up");
    }

    try {
      if (guard.contextPrompt) {
        await promptButlerInternal(
          this.getSessionAccess(),
          [
            "This is hidden grounding for the next operator turn.",
            "Do not answer it directly.",
            "Use it to keep job references exact during the next operator turn only.",
            guard.contextPrompt
          ].join("\n")
        );
      }
      await promptButler(this.getSessionAccess(), text, imageReferenceIds);
    } finally {
      this.activeOperatorThreadGuard = null;
    }
  }

  prompt(text: string, imageReferenceIds: string[] = []): void {
    void this.promptOperatorTurn(text, imageReferenceIds);
  }

  async updateComposeSettings(provider: string, modelId: string, thinkingLevel: ButlerThinkingLevel): Promise<void> {
    await updateButlerComposeSettings(this.getSessionAccess(), provider, modelId, thinkingLevel);
  }
}
