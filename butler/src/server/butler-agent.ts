import crypto from "node:crypto";
import { EventEmitter } from "node:events";
import { promises as fs } from "node:fs";
import path from "node:path";

import { getModel } from "@mariozechner/pi-ai";
import {
  AuthStorage,
  defineTool,
  ModelRegistry,
  type AgentSession
} from "@mariozechner/pi-coding-agent";
import type { TSchema } from "@sinclair/typebox";

import {
  buildLatestProofMap,
  buildMessagePage,
  buildSystemPrompt,
  collapseCallbackDuplicateMessages,
  contentToText,
  extractLatestNoticeTexts,
  extractWorkspaceMentions,
  findVerificationArtifact,
  isAssistantFailureMessage,
  isCallbackOutstanding,
  MAX_HISTORY_PAGE_SIZE,
  mergeVisibleMessages,
  normalizeNoticeText,
  parseProofScreenshotReview,
  requiresOperatorAcknowledgement,
  requiresOperatorCallback,
  sanitizeHistoryMessage,
  sanitizeHistoryMessages,
  serializeMessages,
  SNAPSHOT_MESSAGE_TAIL_LIMIT,
  summarizeNoticeResult,
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
  restoreButlerCompactionState,
  runButlerPrompt,
  sanitizeButlerSessionMessages,
  sanitizePersistedButlerSessions,
  updateButlerComposeSettings
} from "./butler-agent-session.js";
import { buildButlerServiceTools } from "./butler-agent-service-tools.js";
import { buildButlerDelegationTools, buildButlerStackPreviewTools } from "./butler-agent-stack-preview-tools.js";
import { reviewButlerProofScreenshot } from "./butler-agent-proof-review.js";
import type { ButlerAgentSessionAccess, ButlerAgentToolAccess } from "./butler-agent-tool-access.js";
import { BUTLER_TOOL_CATALOG } from "./butler-agent-tool-catalog.js";
import { readButlerAuthStatus } from "./auth-status.js";
import { buildOnboardingView } from "./onboarding-status.js";
import { type ImageReferenceStore } from "./image-store.js";
import { decoratePreviewVerification } from "./preview-verification.js";
import {
  ensureTaskWorktree,
  resolveExistingWorkspaceCwd,
  resolveWorkspaceBranchName,
  resolveWorkspaceProjectInfo,
  taskRequiresManagedWorktree,
  workspacePrefersHostRuntime
} from "./repo-worktree.js";
import { RuntimeBrokerClient } from "./runtime-broker-client.js";
import { type LoadedServiceTemplate, ServiceTemplateRegistry, toServiceLeaseView } from "./service-templates.js";
import { formatStackStorageSummary, normalizeStackStorageMode } from "./stack-storage.js";
import {
  buildThreadExecutionContract,
  describeExecutionLane,
  describeProofMode,
  detectExecutionLane,
  detectProofMode,
  isSharedShellRepoBootstrapTask
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
  private readonly operatorMessageStatePath: string;
  private readonly legacyNoticeStatePath: string;
  private readonly callbackStatePath: string;
  private readonly refreshRuntimeInventory: (() => Promise<void>) | null;
  private modelRegistry: ModelRegistry | null = null;
  private session: AgentSession | null = null;
  private auth: ButlerAuthStatus = { mode: "none", loggedIn: false };
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
  private smokeReactionInFlight = false;
  private smokeReactionQueued = false;
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
          callbackState === "received_worker_callback" || callbackState === "recovered_from_thread_state" ? "closed" : callbackState;
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

  private registerPendingChatCallback(threadId: string): void {
    const now = Date.now();
    this.pendingChatCallbacks.set(threadId, {
      threadId,
      callbackState: "waiting",
      resolutionState: null,
      requestedAt: now,
      lastEventAt: now,
      lastWorkerStatusSeen: this.store.getThread(threadId)?.status ?? null,
      lastTerminalReportAt: null,
      operatorCloseoutStatus: "owed",
      owesOperatorReply: true,
      closeoutChannel: "none",
      closedAt: null,
      updatedAt: now
    });
    this.store.addEvent(threadId, "butler.callback.registered", "Butler registered an operator closeout obligation.");
    void this.saveCallbackState();
  }

  private queueDelegationAcknowledgement(threadId: string, text: string): void {
    const at = Date.now();
    const messageId = `delegation-ack-${threadId}`;
    this.upsertOperatorMessage(messageId, text, at);
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

  private buildCloseoutId(threadId: string, turnId: string): string {
    return `${threadId}:${turnId}`;
  }

  private getFallbackTurnId(thread: ReturnType<ButlerStateStore["getThread"]>): string | null {
    const latestTurnId = thread?.turns.at(-1)?.id ?? null;
    return typeof latestTurnId === "string" && latestTurnId.trim() ? latestTurnId : null;
  }

  private buildChatCallbackText(
    thread: ReturnType<ButlerStateStore["getThread"]>,
    workerReport: ReturnType<ButlerStateStore["getWorkerReport"]>
  ): string | null {
    if (!thread || !workerReport) {
      return null;
    }

    const lead =
      workerReport.status === "completed"
        ? `Update on ${thread.supervisor.projectLabel}.`
        : `${thread.supervisor.projectLabel} needs attention.`;
    return [lead, workerReport.summary, workerReport.details].filter(Boolean).join("\n\n");
  }

  private buildFallbackChatCallbackText(thread: ReturnType<ButlerStateStore["getThread"]>): string | null {
    if (!thread || thread.status !== "idle") {
      return null;
    }

    const latestReply = thread.supervisor.latestAgentReply?.trim();
    if (!latestReply) {
      return null;
    }

    return [
      `Update on ${thread.supervisor.projectLabel}.`,
      "I never got feedback from the worker, so I checked the thread directly.",
      latestReply
    ].join("\n\n");
  }

  private describePendingCallbacks(): string {
    const outstandingCallbacks = [...this.pendingChatCallbacks.values()].filter(isCallbackOutstanding);
    if (outstandingCallbacks.length === 0) {
      return "Delegated callback state: none pending.";
    }

    const lines = outstandingCallbacks
      .map((callback) => {
        const thread = this.store.getThread(callback.threadId);
        const projectLabel = thread?.supervisor.projectLabel ?? "unknown";
        const status = callback.lastWorkerStatusSeen ?? thread?.status ?? "unknown";
        if (callback.callbackState === "missing_worker_callback") {
          return `- job ${callback.threadId} on ${projectLabel}: no worker callback received; latest known thread status is ${status}. If asked, say you never got feedback from the worker and that you are checking the thread directly.`;
        }
        return `- job ${callback.threadId} on ${projectLabel}: waiting on worker callback; latest known thread status is ${status}.`;
      })
      .join("\n");

    return ["Delegated callback state:", lines].join("\n");
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
      const nextStatus = thread?.status ?? "unknown";
      const fallbackAnchorAt = Math.max(callback.requestedAt, thread?.updatedAt ?? callback.requestedAt);
      const callbackTimedOut = now - fallbackAnchorAt >= CALLBACK_RECOVERY_TIMEOUT_MS;
      const nextCallbackState =
        workerReport || nextStatus !== "idle" || !(thread?.supervisor.latestAgentReply?.trim()) || !callbackTimedOut
          ? "waiting"
          : "missing_worker_callback";

      if (callback.lastWorkerStatusSeen !== nextStatus || callback.callbackState !== nextCallbackState) {
        callback.lastWorkerStatusSeen = nextStatus;
        callback.lastEventAt = thread?.updatedAt ?? now;
        callback.lastTerminalReportAt = workerReport?.updatedAt ?? callback.lastTerminalReportAt;
        if (callback.callbackState !== "missing_worker_callback" && nextCallbackState === "missing_worker_callback") {
          this.store.addEvent(callback.threadId, "butler.callback.missing", "No worker callback arrived, so Butler is checking thread state directly.");
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
      if (workerReport) {
        const closeoutId = this.buildCloseoutId(callback.threadId, workerReport.turnId);
        callback.lastTerminalReportAt = workerReport.updatedAt;
        callback.lastEventAt = workerReport.updatedAt;
        callback.lastWorkerStatusSeen = thread.status;
        callback.updatedAt = Date.now();

        if (!this.deliveredCloseoutIds.has(closeoutId)) {
          const text = this.buildChatCallbackText(thread, workerReport);
          if (!text) {
            continue;
          }

          this.upsertOperatorMessage(`callback-${closeoutId}`, text, workerReport.updatedAt);
          this.deliveredCloseoutIds.add(closeoutId);
          this.store.addEvent(callback.threadId, "butler.callback.received", "Butler received the worker callback and posted the closeout.");
          this.store.addEvent(callback.threadId, "butler.job.closed", "Butler closed the delegated job in main chat.");
          changed = true;
        }

        callback.callbackState = "closed";
        callback.resolutionState = "received_worker_callback";
        callback.operatorCloseoutStatus = "posted";
        callback.owesOperatorReply = false;
        callback.closeoutChannel = "main_chat";
        callback.closedAt = workerReport.updatedAt;
        callback.updatedAt = Date.now();
        changed = true;
        continue;
      }

      if (callback.callbackState !== "missing_worker_callback") {
        continue;
      }

      const fallbackTurnId = this.getFallbackTurnId(thread);
      if (!fallbackTurnId) {
        continue;
      }
      const closeoutId = this.buildCloseoutId(callback.threadId, fallbackTurnId);
      const text = this.buildFallbackChatCallbackText(thread);
      if (!text) {
        continue;
      }

      if (!this.deliveredCloseoutIds.has(closeoutId)) {
        this.upsertOperatorMessage(`callback-fallback-${closeoutId}`, text, thread.updatedAt);
        this.deliveredCloseoutIds.add(closeoutId);
        this.store.addEvent(callback.threadId, "butler.recovery.invoked", "Butler recovered missing callback state from the worker thread.");
        this.store.addEvent(callback.threadId, "butler.job.closed", "Butler closed the delegated job after thread-state recovery.");
        changed = true;
      }

      callback.callbackState = "closed";
      callback.resolutionState = "recovered_from_thread_state";
      callback.lastWorkerStatusSeen = thread.status;
      callback.lastEventAt = thread.updatedAt;
      callback.operatorCloseoutStatus = "posted";
      callback.owesOperatorReply = false;
      callback.closeoutChannel = "main_chat";
      callback.closedAt = thread.updatedAt;
      callback.updatedAt = Date.now();
      changed = true;
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
    const authChanged = nextAuth.mode !== this.auth.mode || nextAuth.loggedIn !== this.auth.loggedIn;

    if (authChanged) {
      this.auth = nextAuth;
      this.modelRegistry = ModelRegistry.inMemory(AuthStorage.create(this.piAuthPath));
      await this.createOrRefreshSession();
    }

    const nextOnboarding = await buildOnboardingView({
      butlerAuth: this.auth,
      codexAuthPath: this.codexAuthPath,
      codexConfigDir: this.codexConfigDir
    });

    if (JSON.stringify(nextOnboarding) !== JSON.stringify(this.onboarding) || authChanged) {
      this.onboarding = nextOnboarding;
      this.emit("change");
    }

    await this.reconcilePendingChatCallbacks();
  }

  // This is the single discoverable registry for Butler actions and their UI
  // side effects. Keep agent tool definitions aligned with this catalog.
  private buildToolCatalog(): ButlerToolView[] {
    return BUTLER_TOOL_CATALOG;
  }

  private getToolUiEffects(name: string): ButlerToolUiEffect[] {
    return this.toolCatalog.find((tool) => tool.name === name)?.uiEffects ?? [];
  }

  private getToolAccess(): ButlerAgentToolAccess {
    return this as unknown as ButlerAgentToolAccess;
  }

  private getSessionAccess(): ButlerAgentSessionAccess {
    return this as unknown as ButlerAgentSessionAccess;
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
    const repoPrefersHost = await workspacePrefersHostRuntime(cwd);
    return detectExecutionLane(task, { repoPrefersHostRuntime: repoPrefersHost });
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
    const executionLane = await this.inferDelegationExecutionLane(task, workspace.cwd);
    const proofMode = this.inferDelegationProofMode(task);

    return [
      "This thread was started by Butler.",
      "You are the worker inside Manor. Butler is the supervisor and policy owner.",
      "Execute the requested task directly instead of explaining how the operator could do it manually.",
      "The task prompt includes an AUTHORITATIVE JOB CONTRACT with the assigned thread id, workspace, and harness binding. Follow that contract over any stale worktree or cwd hints elsewhere in the task.",
      "Treat the contract execution_lane and proof_mode as binding. Do not switch lanes or add extra proof obligations unless the operator explicitly changes the ask.",
      "Once you are inside a repository with its own AGENTS guidance, follow that repo-specific install and runtime guidance over generic Manor defaults unless it would violate the contract's execution mode, callback, or reporting obligations.",
      `Work inside ${workspace.cwd} unless the task explicitly requires a deeper subdirectory.`,
      workspace.branchName
        ? `Stay on branch ${workspace.branchName}. Do not switch back to main or share this branch with another task.`
        : repoBootstrapTask
          ? "For repository bootstrap work in /repos, clone first in the shared shell workspace. After the repo exists, create the requested butler/ branch inside that repo."
          : managedWorktreeTask
            ? "Create or reuse the explicitly requested isolated branch or worktree before you make changes."
            : "Stay on the existing checkout. Do not create a branch or managed worktree unless the operator explicitly asked for one.",
      `Execution lane: ${describeExecutionLane(executionLane)}.`,
      executionLane === "shared-shell-bootstrap"
        ? "This task stays in the shared Codex shell for repo setup or local workspace work. Do not start a preview unless the contract is updated to a runtime lane."
        : executionLane === "shared-shell-host-runtime"
          ? "This task uses the shared Codex shell as the host runtime. Follow repo-local host-run guidance and do not switch to a preview unless the operator changes the contract."
          : executionLane === "preview-runtime"
            ? "This task uses a preview for runtime execution. Start with `manor-harness --thread <jobId> status`, then use the preview tools to install, run, inspect, and verify."
            : "This task is tied to the live deployed target. Do not substitute a local preview or shared-shell result for the reported outcome.",
      executionLane === "preview-runtime"
        ? "When the preview lane is active, keep the flow simple: start a preview, then use `manor-harness preview exec`, `logs`, `processes`, `inspect`, and `verify` to adapt the project."
        : "If you need supervisory guidance while staying in the assigned lane, use `manor-harness assist --summary \"<what is stuck>\" --details \"<error and context>\"` before your final blocked report.",
      "Do not wait for Manor to infer project-specific bootstrap details once you are in the chosen runtime lane. If the app needs an install command, env setup, or a custom start command, run those explicitly there.",
      "If the work needs multiple cooperating services, create a stack first with `manor-harness stack start`, then attach previews and services to it with `--stack <stackId>` and stable `--alias` names that mirror the app's expected internal hostnames.",
      "When a stack needs recurring databases or object storage, start it with `manor-harness stack start --stateful` so Manor derives a per-job retained storage key, forks from the project base, and sets the default promotion target automatically.",
      "Use `--storage-mode base` only when you are intentionally creating or refreshing the shared base state for that project. Do not share one writable database volume across concurrent jobs.",
      "After validating a job-scoped stateful stack, use `manor-harness stack promote <stackId>` to publish its retained data back to the project base. Only override the target manually when the task explicitly needs a different namespace.",
      "For attached previews and services, use `manor-harness` for inspect, logs, processes, and exec directly against the runtime. Butler still owns start, stop, lifecycle, and policy.",
      "The shared Codex shell is for workspace, git, and repo-directed setup work, plus host-runtime tasks when repo-local guidance explicitly says to run on the host.",
      "Do not declare the job blocked from shared-shell failures when the contract lane still allows normal recovery inside that same lane.",
      proofMode === "ui"
        ? "Proof mode: headed UI proof. Before reporting completion, run headed preview verification and inspect the persisted proof bundle."
        : proofMode === "operational"
          ? "Proof mode: operational verification. Record the relevant runtime evidence in your report, but do not invent a browser proof requirement."
          : "Proof mode: no persisted proof bundle is required unless the operator later asks for one.",
      "Prefer explicit, boring commands over wrappers or project-specific Manor tricks. The goal is stable runtime control, not clever bootstrap.",
      executionLane === "preview-runtime"
        ? "Preview commands start with the job worktree as the working directory. Prefer relative paths there, or use the contract cwd under /repos. Do not assume a /workspace mount exists inside previews."
        : "Use the contract cwd as the working directory and keep commands explicit for the assigned lane.",
      proofMode === "ui"
        ? "When UI proof requires actual interaction, pass a browser script with `manor-harness preview verify <preview> --script-file <path> --mode headful --json` instead of stopping at a static page."
        : "Do not add a browser verification step unless the contract or operator explicitly asks for UI proof.",
      proofMode === "ui"
        ? "When the proof route needs an authenticated session, prefer `manor-harness preview verify <preview> --session-cookie <token> ...` or `--cookie NAME=VALUE ...` instead of building wrapper scripts that call `page.goto()` again."
        : "Keep verification in the assigned lane and report the concrete evidence you used.",
      "If the contract is for local Manor runtime and the app has email flows, prefer Mailpit or another built-in local dependency when the app under test is running inside Manor.",
      proofMode === "ui"
        ? "After verification, inspect the proof bundle with `manor-harness preview proof <preview> --json` and include the screenshot, video, and manifest links in your report."
        : "Do not pad the report with artifact links that the contract did not ask for.",
      proofMode === "ui"
        ? "Do not treat artifact existence alone as accepted proof. Butler must review the screenshot, and the video is for human review."
        : "Use the smallest sufficient evidence set for the assigned proof mode.",
      "Use only the harness actions exposed through `manor-harness`. Do not try to command Butler directly outside those actions.",
      "When you complete meaningful work, record a supervisor report before your final reply with `manor-harness report --status completed --summary \"<concise outcome>\" --details \"<brief oversight note with the key fact, risk, or next step>\"`.",
      "If you are blocked or need operator attention, record it before your reply with `manor-harness report --status blocked --summary \"<what is blocked>\" --details \"<what you need, what failed, or the next recommended action>\"`.",
      executionLane === "preview-runtime"
        ? "Do not report runtime verification blocked while the preview path remains untried unless you explain why preview execution itself is blocked."
        : "Do not report the job blocked until you have exhausted the normal recovery steps inside the assigned lane.",
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
    operatorAcknowledgementRequired?: boolean;
    operatorCallbackRequired?: boolean;
    extraNotes?: string[];
  }): Promise<{ text: string; contract: CodexThreadExecutionContractView }> {
    const requestedTask = options.goal ? `${options.task}\n\nGoal: ${options.goal}` : options.task;
    const requestedTaskOnly = options.task.trim();
    const operatorGoal = options.goal?.trim() ? options.goal.trim() : null;
    const project = resolveWorkspaceProjectInfo(options.workspace.cwd);
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

    if (options.extraNotes?.length) {
      notes.push(...options.extraNotes);
    }

    const executionLane = options.executionLane ?? (await this.inferDelegationExecutionLane(requestedTaskOnly, options.workspace.cwd));
    const proofMode = options.proofMode ?? this.inferDelegationProofMode(requestedTaskOnly);

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
      operatorAcknowledgementRequired: options.operatorAcknowledgementRequired ?? baseContract.operatorAcknowledgementRequired,
      operatorCallbackRequired: options.operatorCallbackRequired ?? baseContract.operatorCallbackRequired,
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
      `execution_lane: ${contract.executionLaneLabel}`,
      `harness_binding: manor-harness --thread ${options.threadId}`,
      `proof_mode: ${contract.proofModeLabel}`,
      `operator_acknowledgement: ${contract.operatorAcknowledgementRequired ? "required" : "optional"}`,
      `operator_callback: ${contract.operatorCallbackRequired ? "required" : "optional"}`
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

    const screenshot = findVerificationArtifact(decoratedVerification, "screenshot");
    if (!screenshot?.filePath) {
      throw new Error(`Preview ${subject.id} has no screenshot artifact to review.`);
    }
    if (screenshot.availability !== "available") {
      throw new Error(
        screenshot.availability === "expired"
          ? `Preview ${subject.id} screenshot proof expired after retention.`
          : `Preview ${subject.id} screenshot proof is no longer available.`
      );
    }

    return {
      preview: subject,
      verification: decoratedVerification,
      screenshot,
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
    if (!value || typeof value !== "object") {
      return {};
    }

    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter((entry): entry is [string, string] => typeof entry[0] === "string" && typeof entry[1] === "string")
        .map(([key, entryValue]) => [key.trim(), entryValue.trim()])
        .filter(([key, entryValue]) => key.length > 0 && entryValue.length > 0)
    );
  }

  private normalizeStringArray(value: unknown): string[] {
    if (!Array.isArray(value)) {
      return [];
    }

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
  }): string {
    return formatStackStorageSummary(stack);
  }

  private async reviewProofScreenshot(
    proof: ResolvedPreviewProof,
    options?: {
      expectedOutcome?: string;
    }
  ): Promise<ProofScreenshotReview> {
    return reviewButlerProofScreenshot(this.getSessionAccess(), proof, options);
  }

  private buildCustomTools() {
    const toolAccess = this.getToolAccess();
    return [
      ...buildButlerStackPreviewTools(toolAccess),
      ...buildButlerServiceTools(toolAccess),
      ...buildButlerCodexTools(toolAccess),
      ...buildButlerDelegationTools(toolAccess)
    ];
  }

  private async createOrRefreshSession(): Promise<void> {
    await createOrRefreshButlerSession(this.getSessionAccess());
  }

  private async sanitizePersistedSessions(): Promise<void> {
    await sanitizePersistedButlerSessions(this.getSessionAccess());
  }

  private restoreCompactionState(): void {
    restoreButlerCompactionState(this.getSessionAccess());
  }

  private getContextUsage(): ButlerContextUsageView {
    return getButlerContextUsage(this.getSessionAccess());
  }

  private getCompactionSnapshot(): ButlerCompactionView {
    return getButlerCompactionSnapshot(this.getSessionAccess());
  }

  private async runPrompt(text: string, imageReferenceIds: string[] = []): Promise<void> {
    await runButlerPrompt(this.getSessionAccess(), text, imageReferenceIds);
  }

  private extractLatestAssistantFailure(): string | null {
    return extractButlerAssistantFailure(this.getSessionAccess());
  }

  private dropTrailingFailedTurns(): void {
    dropTrailingFailedButlerTurns(this.getSessionAccess());
  }

  private sanitizeSessionMessages(): void {
    sanitizeButlerSessionMessages(this.getSessionAccess());
  }

  private getVisibleMessages(): ButlerMessageView[] {
    return getVisibleButlerMessages(this.getSessionAccess());
  }

  getMessagePage(before: number | null, limit: number): ButlerMessagePageView {
    return getButlerMessagePage(this.getSessionAccess(), before, limit);
  }

  getLiveSnapshot(): ButlerLiveSnapshot {
    return getButlerLiveSnapshot(this.getSessionAccess());
  }

  getShellSnapshot(): AppShellSnapshot["butler"] {
    return getButlerShellSnapshot(this.getSessionAccess());
  }

  getSnapshot(): AppSnapshot["butler"] {
    return getButlerSnapshot(this.getSessionAccess());
  }

  prompt(text: string, imageReferenceIds: string[] = []): void {
    promptButler(this.getSessionAccess(), text, imageReferenceIds);
  }

  async updateComposeSettings(provider: string, modelId: string, thinkingLevel: ButlerThinkingLevel): Promise<void> {
    await updateButlerComposeSettings(this.getSessionAccess(), provider, modelId, thinkingLevel);
  }
}
