import { EventEmitter } from "node:events";
import { promises as fs } from "node:fs";
import path from "node:path";

import { resolveWorkspaceProjectInfo } from "./repo-worktree.js";
import { inferThreadExecutionContract, parseThreadExecutionContract } from "./thread-contract.js";
import type {
  AppSnapshot,
  AppShellSnapshot,
  ButlerSupervisorSummaryView,
  ButlerMessageView,
  ButlerWindow,
  CodexCompactionView,
  CodexContextUsageView,
  CodexEventEntry,
  CodexThreadExecutionContractView,
  CodexItemRecord,
  CodexItemView,
  CodexMilestoneEntry,
  CodexProjectSummaryView,
  CodexSupervisionView,
  CodexThreadDetailView,
  CodexThreadRecord,
  CodexThreadStatus,
  CodexThreadSummary,
  CodexThreadSupervisorView,
  CodexTurnRecord,
  CodexTurnView,
  CodexWorkerReportView,
  PreviewProofRecordView,
  PreviewVerificationArtifactView,
  PreviewVerificationConsoleMessageView,
  PreviewVerificationFailedRequestView,
  PreviewVerificationView,
  PreviewLeaseView,
  RuntimeCleanupTaskView,
  RuntimeSnapshot,
  StackLeaseView,
  ServiceLeaseView,
  PersistedUiState
} from "./types.js";

const MAX_EVENT_LOG = 80;
const DEFAULT_BUTLER_THREAD_LIMIT = 20;
const DEFAULT_PREVIEW_LEASE_TTL_MS = 30 * 60 * 1000;
const DEFAULT_STACK_LEASE_TTL_MS = 30 * 60 * 1000;
const DEFAULT_SERVICE_LEASE_TTL_MS = 30 * 60 * 1000;
const DEFAULT_LEASE_REAP_GRACE_MS = 10 * 60 * 1000;
const DEFAULT_ARTIFACT_RETENTION_MS = 14 * 24 * 60 * 60 * 1000;
const LEASE_ACTIVITY_WRITE_THROTTLE_MS = 15_000;

function emptyCodexContextUsage(): CodexContextUsageView {
  return {
    tokens: null,
    contextWindow: null,
    percent: null
  };
}

function emptyCodexCompaction(): CodexCompactionView {
  return {
    active: false,
    count: 0,
    lastStartedAt: null,
    lastCompletedAt: null
  };
}

function emptyCodexSupervision(): CodexSupervisionView {
  return {
    butlerTurnsUsed: 0,
    maxButlerTurns: DEFAULT_BUTLER_THREAD_LIMIT,
    capReached: false
  };
}

function emptyThreadSupervisor(): CodexThreadSupervisorView {
  return {
    projectId: "unknown",
    projectLabel: "Unknown",
    latestUserPrompt: null,
    latestAgentReply: null,
    summary: "No supervisor summary yet.",
    blocked: false
  };
}

function clipText(value: string | null | undefined, max = 160): string | null {
  if (!value) {
    return null;
  }

  const normalized = value.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return null;
  }

  return normalized.length > max ? `${normalized.slice(0, max - 1)}…` : normalized;
}

function formatWindowTitle(threadId: string): string {
  return `Job ${threadId.slice(0, 8)}`;
}

function normalizeWindow(window: ButlerWindow): ButlerWindow {
  return {
    threadId: window.threadId,
    title: formatWindowTitle(window.threadId),
    openedAt: window.openedAt
  };
}

function buildThreadSupervisor(thread: CodexThreadRecord): CodexThreadSupervisorView {
  const project = resolveWorkspaceProjectInfo(thread.cwd);
  const flattenedItems = thread.turns.flatMap((turn) => turn.items.map((item) => ({ turn, item })));
  const latestUserPrompt = clipText(
    [...flattenedItems]
      .reverse()
      .find(({ item }) => item.type === "userMessage" && item.text.trim())?.item.text ?? null
  );
  const latestAgentReply = clipText(
    [...flattenedItems]
      .reverse()
      .find(({ item }) => item.type === "agentMessage" && item.text.trim())?.item.text ?? null
  );
  const latestTurn = thread.turns.at(-1) ?? null;
  const blocked =
    Boolean(latestTurn?.error) ||
    latestTurn?.status === "failed" ||
    latestTurn?.status === "interrupted";

  let summary = "No supervisor summary yet.";
  if (blocked) {
    summary = latestTurn?.error
      ? `Blocked after ${latestUserPrompt ? `"${latestUserPrompt}"` : "the latest prompt"}. Error: ${clipText(latestTurn.error, 120)}`
      : `Blocked after ${latestUserPrompt ? `"${latestUserPrompt}"` : "the latest prompt"}.`;
  } else if (thread.status === "active") {
    summary = latestUserPrompt
      ? `Working on "${latestUserPrompt}".`
      : thread.preview
        ? `Working on ${clipText(thread.preview, 120)}.`
        : "Work is in progress.";
  } else if (latestAgentReply) {
    summary = latestUserPrompt
      ? `Idle after "${latestUserPrompt}". Latest result: ${clipText(latestAgentReply, 120)}`
      : `Idle. Latest result: ${clipText(latestAgentReply, 120)}`;
  } else if (thread.preview) {
    summary = `Idle. Preview: ${clipText(thread.preview, 120)}`;
  } else if (thread.turnCount > 0) {
    summary = "Idle with prior activity.";
  }

  return {
    projectId: project.id,
    projectLabel: project.label,
    latestUserPrompt,
    latestAgentReply,
    summary,
    blocked
  };
}

function buildProjectSummary(threads: CodexThreadRecord[]): CodexProjectSummaryView[] {
  const grouped = new Map<string, CodexThreadRecord[]>();

  for (const thread of threads) {
    const group = grouped.get(thread.supervisor.projectId) ?? [];
    group.push(thread);
    grouped.set(thread.supervisor.projectId, group);
  }

  return [...grouped.entries()]
    .map(([id, projectThreads]) => {
      const sorted = [...projectThreads].sort((a, b) => b.updatedAt - a.updatedAt);
      const activeCount = sorted.filter((thread) => thread.status === "active").length;
      const blockedCount = sorted.filter((thread) => thread.supervisor.blocked).length;
      const completedCount = sorted.filter((thread) => thread.status === "idle" && !thread.supervisor.blocked).length;
      const lead = sorted[0];
      const statusBits = [
        activeCount > 0 ? `${activeCount} active` : null,
        blockedCount > 0 ? `${blockedCount} blocked` : null,
        completedCount > 0 ? `${completedCount} idle` : null
      ].filter(Boolean);

      return {
        id,
        label: lead?.supervisor.projectLabel ?? id,
        threadCount: sorted.length,
        activeCount,
        blockedCount,
        completedCount,
        updatedAt: lead?.updatedAt ?? Date.now(),
        summary: `${statusBits.length > 0 ? `${statusBits.join(", ")}.` : "No active work."} Latest: ${lead?.supervisor.summary ?? "No supervisor summary yet."}`,
        threadIds: sorted.map((thread) => thread.id)
      };
    })
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

function buildSupervisorSummary(projects: CodexProjectSummaryView[], threads: CodexThreadRecord[]): ButlerSupervisorSummaryView {
  const activeThreads = threads.filter((thread) => thread.status === "active").length;
  const blockedThreads = threads.filter((thread) => thread.supervisor.blocked).length;
  const completedThreads = threads.filter((thread) => thread.status === "idle" && !thread.supervisor.blocked).length;
  const leadProject = projects[0];

  return {
    totalThreads: threads.length,
    activeThreads,
    blockedThreads,
    completedThreads,
    projectCount: projects.length,
    updatedAt: leadProject?.updatedAt ?? Date.now(),
    summary:
      threads.length === 0
        ? "No Codex workstreams are active yet."
        : `${activeThreads} active, ${blockedThreads} blocked, ${completedThreads} idle across ${projects.length} project${projects.length === 1 ? "" : "s"}. ${leadProject ? `Most recent project: ${leadProject.label}.` : ""}`.trim()
  };
}

function inferPersistedThreadExecutionContract(thread: CodexThreadRecord): CodexThreadExecutionContractView | null {
  return inferThreadExecutionContract({
    threadId: thread.id,
    workspaceCwd: thread.cwd ?? "/repos",
    projectId: thread.supervisor.projectId,
    projectLabel: thread.supervisor.projectLabel,
    branch: null,
    previewText: thread.preview,
    latestUserPrompt: thread.supervisor.latestUserPrompt
  });
}

function normalizeStatus(status: unknown): CodexThreadStatus {
  if (status && typeof status === "object" && "type" in status && typeof status.type === "string") {
    if (status.type === "active" || status.type === "idle") {
      return status.type;
    }
  }

  return "unknown";
}

function normalizePreviewVerificationArtifact(
  artifact: PreviewVerificationArtifactView,
  defaults: {
    checkedAt: number;
    artifactRetentionMs: number;
  }
): PreviewVerificationArtifactView {
  const retainedUntilAt =
    typeof artifact.retainedUntilAt === "number" && Number.isFinite(artifact.retainedUntilAt)
      ? artifact.retainedUntilAt
      : defaults.checkedAt + defaults.artifactRetentionMs;
  const expiredAt =
    typeof artifact.expiredAt === "number" && Number.isFinite(artifact.expiredAt) ? artifact.expiredAt : null;
  const availability =
    artifact.availability === "expired" || artifact.availability === "missing" || artifact.availability === "available"
      ? artifact.availability
      : expiredAt !== null
        ? "expired"
        : typeof artifact.filePath === "string" && artifact.filePath.trim()
          ? "available"
          : "missing";

  return {
    kind:
      artifact.kind === "manifest" ||
      artifact.kind === "screenshot" ||
      artifact.kind === "video" ||
      artifact.kind === "trace" ||
      artifact.kind === "html"
        ? artifact.kind
        : "other",
    label: typeof artifact.label === "string" && artifact.label.trim() ? artifact.label.trim() : "Artifact",
    fileName: typeof artifact.fileName === "string" && artifact.fileName.trim() ? artifact.fileName.trim() : "artifact",
    filePath: typeof artifact.filePath === "string" ? artifact.filePath : "",
    contentType: typeof artifact.contentType === "string" && artifact.contentType.trim() ? artifact.contentType.trim() : "application/octet-stream",
    sizeBytes: typeof artifact.sizeBytes === "number" && Number.isFinite(artifact.sizeBytes) ? artifact.sizeBytes : null,
    url: typeof artifact.url === "string" && artifact.url.trim() ? artifact.url : null,
    downloadUrl: typeof artifact.downloadUrl === "string" && artifact.downloadUrl.trim() ? artifact.downloadUrl : null,
    availability,
    retainedUntilAt,
    expiredAt
  };
}

function normalizePreviewVerificationConsoleMessage(
  message: PreviewVerificationConsoleMessageView
): PreviewVerificationConsoleMessageView {
  return {
    type: typeof message.type === "string" && message.type.trim() ? message.type.trim() : "log",
    text: typeof message.text === "string" ? message.text : "",
    location: typeof message.location === "string" && message.location.trim() ? message.location.trim() : null
  };
}

function normalizePreviewVerificationFailedRequest(
  request: PreviewVerificationFailedRequestView
): PreviewVerificationFailedRequestView {
  return {
    url: typeof request.url === "string" ? request.url : "",
    method: typeof request.method === "string" && request.method.trim() ? request.method.trim() : "GET",
    errorText: typeof request.errorText === "string" && request.errorText.trim() ? request.errorText.trim() : null
  };
}

function normalizePreviewVerification(
  verification: PreviewVerificationView,
  artifactRetentionMs: number
): PreviewVerificationView {
  const checkedAt =
    typeof verification.checkedAt === "number" && Number.isFinite(verification.checkedAt) ? verification.checkedAt : Date.now();

  return {
    runId: typeof verification.runId === "string" && verification.runId.trim() ? verification.runId.trim() : crypto.randomUUID(),
    mode: verification.mode === "headful" ? "headful" : "headless",
    checkedAt,
    durationMs:
      typeof verification.durationMs === "number" && Number.isFinite(verification.durationMs) && verification.durationMs >= 0
        ? verification.durationMs
        : 0,
    ok: Boolean(verification.ok),
    status: typeof verification.status === "number" && Number.isFinite(verification.status) ? verification.status : null,
    title: typeof verification.title === "string" ? verification.title : "",
    url: typeof verification.url === "string" ? verification.url : "",
    error: typeof verification.error === "string" && verification.error.trim() ? verification.error.trim() : null,
    failureKind:
      verification.failureKind === "preview" ||
      verification.failureKind === "http" ||
      verification.failureKind === "auth" ||
      verification.failureKind === "readiness" ||
      verification.failureKind === "script" ||
      verification.failureKind === "artifact" ||
      verification.failureKind === "unknown"
        ? verification.failureKind
        : "none",
    summary: {
      consoleMessageCount:
        typeof verification.summary?.consoleMessageCount === "number" && Number.isFinite(verification.summary.consoleMessageCount)
          ? Math.max(0, Math.trunc(verification.summary.consoleMessageCount))
          : 0,
      pageErrorCount:
        typeof verification.summary?.pageErrorCount === "number" && Number.isFinite(verification.summary.pageErrorCount)
          ? Math.max(0, Math.trunc(verification.summary.pageErrorCount))
          : 0,
      failedRequestCount:
        typeof verification.summary?.failedRequestCount === "number" && Number.isFinite(verification.summary.failedRequestCount)
          ? Math.max(0, Math.trunc(verification.summary.failedRequestCount))
          : 0,
      responseErrorCount:
        typeof verification.summary?.responseErrorCount === "number" && Number.isFinite(verification.summary.responseErrorCount)
          ? Math.max(0, Math.trunc(verification.summary.responseErrorCount))
          : 0,
      assetFailureCount:
        typeof verification.summary?.assetFailureCount === "number" && Number.isFinite(verification.summary.assetFailureCount)
          ? Math.max(0, Math.trunc(verification.summary.assetFailureCount))
          : 0,
      phaseCount:
        typeof verification.summary?.phaseCount === "number" && Number.isFinite(verification.summary.phaseCount)
          ? Math.max(0, Math.trunc(verification.summary.phaseCount))
          : Array.isArray(verification.phases)
            ? verification.phases.length
            : 0
    },
    phases: Array.isArray(verification.phases)
      ? verification.phases
          .filter((phase): phase is PreviewVerificationView["phases"][number] => Boolean(phase && typeof phase === "object"))
          .map((phase) => ({
            name: typeof phase.name === "string" && phase.name.trim() ? phase.name.trim() : "phase",
            label: typeof phase.label === "string" && phase.label.trim() ? phase.label.trim() : "Phase",
            status: phase.status === "failed" || phase.status === "skipped" ? phase.status : "completed",
            startedAt:
              typeof phase.startedAt === "number" && Number.isFinite(phase.startedAt) ? phase.startedAt : checkedAt,
            completedAt:
              typeof phase.completedAt === "number" && Number.isFinite(phase.completedAt) ? phase.completedAt : checkedAt,
            durationMs:
              typeof phase.durationMs === "number" && Number.isFinite(phase.durationMs) && phase.durationMs >= 0
                ? phase.durationMs
                : 0,
            message: typeof phase.message === "string" && phase.message.trim() ? phase.message.trim() : null
          }))
      : [],
    readiness: {
      initialUrl: typeof verification.readiness?.initialUrl === "string" ? verification.readiness.initialUrl : "",
      finalUrl: typeof verification.readiness?.finalUrl === "string" ? verification.readiness.finalUrl : "",
      expectedPath:
        typeof verification.readiness?.expectedPath === "string" && verification.readiness.expectedPath.trim()
          ? verification.readiness.expectedPath.trim()
          : null,
      selector:
        typeof verification.readiness?.selector === "string" && verification.readiness.selector.trim()
          ? verification.readiness.selector.trim()
          : null,
      selectorSatisfied:
        typeof verification.readiness?.selectorSatisfied === "boolean" ? verification.readiness.selectorSatisfied : null,
      routeStatus:
        typeof verification.readiness?.routeStatus === "number" && Number.isFinite(verification.readiness.routeStatus)
          ? verification.readiness.routeStatus
          : typeof verification.status === "number" && Number.isFinite(verification.status)
            ? verification.status
            : null,
      routeOk: verification.readiness?.routeOk === true || Boolean(verification.ok),
      loginRedirectDetected: verification.readiness?.loginRedirectDetected === true,
      htmlErrorSignals: Array.isArray(verification.readiness?.htmlErrorSignals)
        ? verification.readiness.htmlErrorSignals.filter(
            (entry): entry is string => typeof entry === "string" && entry.trim().length > 0
          )
        : [],
      sameOriginAssetFailureCount:
        typeof verification.readiness?.sameOriginAssetFailureCount === "number" &&
        Number.isFinite(verification.readiness.sameOriginAssetFailureCount)
          ? Math.max(0, Math.trunc(verification.readiness.sameOriginAssetFailureCount))
          : 0,
      websocketFailureCount:
        typeof verification.readiness?.websocketFailureCount === "number" &&
        Number.isFinite(verification.readiness.websocketFailureCount)
          ? Math.max(0, Math.trunc(verification.readiness.websocketFailureCount))
          : 0,
      notes: Array.isArray(verification.readiness?.notes)
        ? verification.readiness.notes.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
        : []
    },
    auth: {
      headerCount:
        typeof verification.auth?.headerCount === "number" && Number.isFinite(verification.auth.headerCount)
          ? Math.max(0, Math.trunc(verification.auth.headerCount))
          : 0,
      cookieCount:
        typeof verification.auth?.cookieCount === "number" && Number.isFinite(verification.auth.cookieCount)
          ? Math.max(0, Math.trunc(verification.auth.cookieCount))
          : 0,
      cookieNames: Array.isArray(verification.auth?.cookieNames)
        ? verification.auth.cookieNames.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
        : [],
      usedSessionCookie: verification.auth?.usedSessionCookie === true
    },
    artifacts: Array.isArray(verification.artifacts)
      ? verification.artifacts
          .filter((artifact): artifact is PreviewVerificationArtifactView => Boolean(artifact && typeof artifact === "object"))
          .map((artifact) => normalizePreviewVerificationArtifact(artifact, { checkedAt, artifactRetentionMs }))
      : [],
    consoleMessages: Array.isArray(verification.consoleMessages)
      ? verification.consoleMessages
          .filter((message): message is PreviewVerificationConsoleMessageView => Boolean(message && typeof message === "object"))
          .map((message) => normalizePreviewVerificationConsoleMessage(message))
      : [],
    pageErrors: Array.isArray(verification.pageErrors)
      ? verification.pageErrors.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
      : [],
    failedRequests: Array.isArray(verification.failedRequests)
      ? verification.failedRequests
          .filter((request): request is PreviewVerificationFailedRequestView => Boolean(request && typeof request === "object"))
          .map((request) => normalizePreviewVerificationFailedRequest(request))
      : []
  };
}

function buildPreviewProofRecordId(previewId: string, verificationRunId: string): string {
  return `${previewId}:${verificationRunId}`;
}

function summarizeItem(item: Record<string, unknown>): string {
  if (item.type === "agentMessage" && typeof item.text === "string") {
    return item.text;
  }

  if (item.type === "userMessage" && Array.isArray(item.content)) {
    const text = item.content
      .map((entry) => (entry && typeof entry === "object" && "text" in entry && typeof entry.text === "string" ? entry.text : ""))
      .filter(Boolean)
      .join("\n");
    return text;
  }

  if (item.type === "commandExecution" && typeof item.command === "string") {
    return item.command;
  }

  return "";
}

function normalizeItem(item: Record<string, unknown>, status: "started" | "completed"): CodexItemRecord {
  const id = typeof item.id === "string" ? item.id : crypto.randomUUID();
  return {
    id,
    type: typeof item.type === "string" ? item.type : "unknown",
    status,
    text: summarizeItem(item),
    at: Date.now(),
    raw: item
  };
}

function shouldExposeCodexItem(item: CodexItemRecord): boolean {
  if (item.type !== "agentMessage" && item.type !== "userMessage") {
    return false;
  }

  return item.text.trim().length > 0;
}

function normalizeTurn(turn: Record<string, unknown>): CodexTurnRecord {
  const rawItems = Array.isArray(turn.items) ? (turn.items as Record<string, unknown>[]) : [];
  return {
    id: typeof turn.id === "string" ? turn.id : crypto.randomUUID(),
    status: typeof turn.status === "string" ? turn.status : "unknown",
    error: typeof turn.error === "string" ? turn.error : null,
    startedAt: Date.now(),
    completedAt: typeof turn.status === "string" && turn.status === "completed" ? Date.now() : null,
    items: rawItems.map((item) => normalizeItem(item, "completed"))
  };
}

export class ButlerStateStore extends EventEmitter {
  private readonly uiStatePath: string;
  private readonly threads = new Map<string, CodexThreadRecord>();
  private readonly stackLeases = new Map<string, StackLeaseView>();
  private readonly previewLeases = new Map<string, PreviewLeaseView>();
  private readonly serviceLeases = new Map<string, ServiceLeaseView>();
  private readonly runtimeCleanupTasks = new Map<string, RuntimeCleanupTaskView>();
  private readonly previewProofs = new Map<string, PreviewProofRecordView>();
  private readonly persistedSupervisionByThreadId = new Map<string, { butlerTurnsUsed: number; maxButlerTurns: number | null }>();
  private readonly persistedWorkerReportsByThreadId = new Map<string, CodexWorkerReportView[]>();
  private windows: ButlerWindow[] = [];
  private focusedWindowId: string | null = null;
  private saveTimer: NodeJS.Timeout | null = null;
  private readonly latestStartedTurnIds = new Map<string, string>();
  private readonly latestCompletedTurnIds = new Map<string, string>();
  private readonly latestBlockedTurnIds = new Map<string, string>();
  private milestonesEnabled = false;
  private threadInventoryReady = false;
  private readonly previewLeaseTtlMs: number;
  private readonly stackLeaseTtlMs: number;
  private readonly serviceLeaseTtlMs: number;
  private readonly leaseReapGraceMs: number;
  private readonly artifactRetentionMs: number;
  private readonly persistedExecutionContractsByThreadId = new Map<string, CodexThreadExecutionContractView>();

  private reconcileThreadWindows(): boolean {
    if (!this.threadInventoryReady) {
      return false;
    }

    const knownThreadIds = new Set(this.threads.keys());
    const seenThreadIds = new Set<string>();
    const nextWindows: ButlerWindow[] = [];

    for (const window of this.windows) {
      const threadId = typeof window.threadId === "string" ? window.threadId.trim() : "";
      if (!threadId || !knownThreadIds.has(threadId) || seenThreadIds.has(threadId)) {
        continue;
      }

      seenThreadIds.add(threadId);
      nextWindows.push(
        normalizeWindow({
          threadId,
          title: window.title,
          openedAt: window.openedAt
        })
      );
    }

    const nextFocusedWindowId =
      this.focusedWindowId && seenThreadIds.has(this.focusedWindowId)
        ? this.focusedWindowId
        : nextWindows[0]?.threadId ?? null;

    const windowsChanged =
      nextWindows.length !== this.windows.length ||
      nextWindows.some((window, index) => {
        const current = this.windows[index];
        return (
          current?.threadId !== window.threadId ||
          current?.openedAt !== window.openedAt ||
          current?.title !== window.title
        );
      });
    const focusChanged = this.focusedWindowId !== nextFocusedWindowId;

    if (!windowsChanged && !focusChanged) {
      return false;
    }

    this.windows = nextWindows;
    this.focusedWindowId = nextFocusedWindowId;
    return true;
  }

  private refreshStackMembership(stackId: string, now = Date.now()): void {
    const lease = this.stackLeases.get(stackId);
    if (!lease) {
      return;
    }

    const previewIds = [...this.previewLeases.values()]
      .filter((entry) => entry.stackId === stackId && entry.status !== "stopped")
      .map((entry) => entry.id)
      .sort();
    const serviceIds = [...this.serviceLeases.values()]
      .filter((entry) => entry.stackId === stackId && entry.status !== "stopped")
      .map((entry) => entry.id)
      .sort();
    const previousPreviewIds = [...lease.previewIds].sort();
    const previousServiceIds = [...lease.serviceIds].sort();
    const membershipChanged =
      previousPreviewIds.length !== previewIds.length ||
      previousServiceIds.length !== serviceIds.length ||
      previousPreviewIds.some((entry, index) => entry !== previewIds[index]) ||
      previousServiceIds.some((entry, index) => entry !== serviceIds[index]);

    if (!membershipChanged) {
      return;
    }

    this.stackLeases.set(
      stackId,
      this.normalizeStackLease(
        {
          ...lease,
          previewIds,
          serviceIds,
          updatedAt: Math.max(lease.updatedAt, now)
        },
        now
      )
    );
    this.queueSave();
    this.emitChange();
  }

  constructor(
    uiStatePath: string,
    options?: {
      previewLeaseTtlMs?: number;
      stackLeaseTtlMs?: number;
      serviceLeaseTtlMs?: number;
      leaseReapGraceMs?: number;
      artifactRetentionMs?: number;
    }
  ) {
    super();
    this.uiStatePath = uiStatePath;
    this.previewLeaseTtlMs = options?.previewLeaseTtlMs ?? DEFAULT_PREVIEW_LEASE_TTL_MS;
    this.stackLeaseTtlMs = options?.stackLeaseTtlMs ?? DEFAULT_STACK_LEASE_TTL_MS;
    this.serviceLeaseTtlMs = options?.serviceLeaseTtlMs ?? DEFAULT_SERVICE_LEASE_TTL_MS;
    this.leaseReapGraceMs = options?.leaseReapGraceMs ?? DEFAULT_LEASE_REAP_GRACE_MS;
    this.artifactRetentionMs = options?.artifactRetentionMs ?? DEFAULT_ARTIFACT_RETENTION_MS;
  }

  private applyLeaseLifecycle<T extends PreviewLeaseView | StackLeaseView | ServiceLeaseView>(
    lease: T,
    defaults: { leaseTtlMs: number; now?: number }
  ): T {
    const now = defaults.now ?? Date.now();
    const pinned = Boolean(lease.pinned);
    const leaseTtlMs =
      typeof lease.leaseTtlMs === "number" && Number.isFinite(lease.leaseTtlMs) && lease.leaseTtlMs > 0
        ? lease.leaseTtlMs
        : defaults.leaseTtlMs;
    const lastActivityAt =
      typeof lease.lastActivityAt === "number" && Number.isFinite(lease.lastActivityAt)
        ? lease.lastActivityAt
        : lease.updatedAt ?? lease.createdAt ?? now;
    const ttlAnchorAt =
      typeof lease.ttlAnchorAt === "number" && Number.isFinite(lease.ttlAnchorAt)
        ? lease.ttlAnchorAt
        : lastActivityAt;
    const expiresAt = pinned ? null : ttlAnchorAt + leaseTtlMs;
    const expired = !pinned && expiresAt !== null && now >= expiresAt;
    const expiredAt =
      expired
        ? typeof lease.expiredAt === "number" && Number.isFinite(lease.expiredAt)
          ? lease.expiredAt
          : now
        : null;
    const reapAfterAt = expired && expiredAt !== null ? expiredAt + this.leaseReapGraceMs : null;
    const idleThreshold = Math.max(60_000, Math.floor(leaseTtlMs / 2));
    const lifecycleState =
      lease.status === "starting"
        ? "starting"
        : lease.status === "stopping"
          ? "stopping"
          : expired
            ? "expired"
            : now - lastActivityAt >= idleThreshold
              ? "idle"
              : "active";

    return {
      ...lease,
      pinned,
      leaseTtlMs,
      lastActivityAt,
      ttlAnchorAt,
      expiresAt,
      expiredAt,
      reapAfterAt,
      lifecycleState
    };
  }

  private normalizePreviewLease(lease: PreviewLeaseView, now = Date.now()): PreviewLeaseView {
    const normalizedLease = {
      ...lease,
      stackId: typeof lease.stackId === "string" && lease.stackId.trim() ? lease.stackId.trim() : null,
      aliases: Array.isArray(lease.aliases)
        ? [...new Set(lease.aliases.map((alias) => (typeof alias === "string" ? alias.trim() : "")).filter(Boolean))]
        : [],
      lastVerification:
        lease.lastVerification && typeof lease.lastVerification === "object"
          ? normalizePreviewVerification(lease.lastVerification, this.artifactRetentionMs)
          : null,
      bootstrap: {
        waitSeconds:
          typeof lease.bootstrap?.waitSeconds === "number" && Number.isFinite(lease.bootstrap.waitSeconds) && lease.bootstrap.waitSeconds > 0
            ? Math.trunc(lease.bootstrap.waitSeconds)
            : 120,
        hint: typeof lease.bootstrap?.hint === "string" && lease.bootstrap.hint.trim() ? lease.bootstrap.hint.trim() : null,
        heartbeatKind:
          lease.bootstrap?.heartbeatKind === "http" ||
          lease.bootstrap?.heartbeatKind === "tcp" ||
          lease.bootstrap?.heartbeatKind === "command"
            ? lease.bootstrap.heartbeatKind
            : "none",
        heartbeatTarget:
          typeof lease.bootstrap?.heartbeatTarget === "string" && lease.bootstrap.heartbeatTarget.trim()
            ? lease.bootstrap.heartbeatTarget.trim()
            : null,
        heartbeatIntervalSeconds:
          typeof lease.bootstrap?.heartbeatIntervalSeconds === "number" &&
          Number.isFinite(lease.bootstrap.heartbeatIntervalSeconds) &&
          lease.bootstrap.heartbeatIntervalSeconds > 0
            ? Math.trunc(lease.bootstrap.heartbeatIntervalSeconds)
            : 5,
        phase:
          lease.bootstrap?.phase === "pulling_image" ||
          lease.bootstrap?.phase === "starting_container" ||
          lease.bootstrap?.phase === "bootstrapping" ||
          lease.bootstrap?.phase === "waiting_for_heartbeat" ||
          lease.bootstrap?.phase === "ready" ||
          lease.bootstrap?.phase === "failed"
            ? lease.bootstrap.phase
            : lease.status === "running"
              ? "ready"
              : "starting_container",
        startedAt: typeof lease.bootstrap?.startedAt === "number" && Number.isFinite(lease.bootstrap.startedAt) ? lease.bootstrap.startedAt : null,
        readyAt: typeof lease.bootstrap?.readyAt === "number" && Number.isFinite(lease.bootstrap.readyAt) ? lease.bootstrap.readyAt : null,
        lastHeartbeatAt:
          typeof lease.bootstrap?.lastHeartbeatAt === "number" && Number.isFinite(lease.bootstrap.lastHeartbeatAt)
            ? lease.bootstrap.lastHeartbeatAt
            : null,
        lastHeartbeatError:
          typeof lease.bootstrap?.lastHeartbeatError === "string" && lease.bootstrap.lastHeartbeatError.trim()
            ? lease.bootstrap.lastHeartbeatError.trim()
            : null
      }
    } as PreviewLeaseView;

    return this.applyLeaseLifecycle(normalizedLease, { leaseTtlMs: this.previewLeaseTtlMs, now });
  }

  private normalizeStackLease(lease: StackLeaseView, now = Date.now()): StackLeaseView {
    const normalizedLease = {
      ...lease,
      worktreePath: typeof lease.worktreePath === "string" && lease.worktreePath.trim() ? lease.worktreePath.trim() : null,
      networkName: typeof lease.networkName === "string" ? lease.networkName.trim() : "",
      storageMode:
        lease.storageMode === "job" || lease.storageMode === "base" || lease.storageMode === "custom" || lease.storageMode === "ephemeral"
          ? lease.storageMode
          : "ephemeral",
      retainsVolumes: Boolean(lease.retainsVolumes),
      baseStorageKey: typeof lease.baseStorageKey === "string" && lease.baseStorageKey.trim() ? lease.baseStorageKey.trim() : null,
      storageKey: typeof lease.storageKey === "string" && lease.storageKey.trim() ? lease.storageKey.trim() : null,
      cloneFromStorageKey:
        typeof lease.cloneFromStorageKey === "string" && lease.cloneFromStorageKey.trim()
          ? lease.cloneFromStorageKey.trim()
          : null,
      defaultPromoteTargetStorageKey:
        typeof lease.defaultPromoteTargetStorageKey === "string" && lease.defaultPromoteTargetStorageKey.trim()
          ? lease.defaultPromoteTargetStorageKey.trim()
          : null,
      volumeNames: Array.isArray(lease.volumeNames)
        ? [...new Set(lease.volumeNames.map((name) => (typeof name === "string" ? name.trim() : "")).filter(Boolean))]
        : [],
      previewIds: Array.isArray(lease.previewIds)
        ? [...new Set(lease.previewIds.map((id) => (typeof id === "string" ? id.trim() : "")).filter(Boolean))]
        : [],
      serviceIds: Array.isArray(lease.serviceIds)
        ? [...new Set(lease.serviceIds.map((id) => (typeof id === "string" ? id.trim() : "")).filter(Boolean))]
        : []
    } as StackLeaseView;

    return this.applyLeaseLifecycle(normalizedLease, { leaseTtlMs: this.stackLeaseTtlMs, now });
  }

  private normalizeServiceLease(lease: ServiceLeaseView, now = Date.now()): ServiceLeaseView {
    const normalizedLease = {
      ...lease,
      stackId: typeof lease.stackId === "string" && lease.stackId.trim() ? lease.stackId.trim() : null,
      storageKind:
        lease.storageKind === "volume" || lease.storageKind === "worktree" || lease.storageKind === "ephemeral"
          ? lease.storageKind
          : "ephemeral",
      sticky: Boolean(lease.sticky),
      volumeName: typeof lease.volumeName === "string" && lease.volumeName.trim() ? lease.volumeName.trim() : null,
      volumeMountPath:
        typeof lease.volumeMountPath === "string" && lease.volumeMountPath.trim() ? lease.volumeMountPath.trim() : null,
      aliases: Array.isArray(lease.aliases)
        ? [...new Set(lease.aliases.map((alias) => (typeof alias === "string" ? alias.trim() : "")).filter(Boolean))]
        : []
    } as ServiceLeaseView;

    return this.applyLeaseLifecycle(normalizedLease, { leaseTtlMs: this.serviceLeaseTtlMs, now });
  }

  private normalizePreviewProofRecord(record: PreviewProofRecordView): PreviewProofRecordView {
    const verification = normalizePreviewVerification(record.verification, this.artifactRetentionMs);
    const createdAt =
      typeof record.createdAt === "number" && Number.isFinite(record.createdAt) ? record.createdAt : verification.checkedAt;
    const updatedAt =
      typeof record.updatedAt === "number" && Number.isFinite(record.updatedAt) ? record.updatedAt : verification.checkedAt;

    return {
      id:
        typeof record.id === "string" && record.id.trim()
          ? record.id.trim()
          : buildPreviewProofRecordId(record.previewId, verification.runId),
      previewId: typeof record.previewId === "string" && record.previewId.trim() ? record.previewId.trim() : "unknown",
      threadId: typeof record.threadId === "string" && record.threadId.trim() ? record.threadId.trim() : null,
      projectId: typeof record.projectId === "string" && record.projectId.trim() ? record.projectId.trim() : "unknown",
      projectLabel: typeof record.projectLabel === "string" && record.projectLabel.trim() ? record.projectLabel.trim() : "Unknown",
      previewTitle: typeof record.previewTitle === "string" && record.previewTitle.trim() ? record.previewTitle.trim() : "Preview",
      stackId: typeof record.stackId === "string" && record.stackId.trim() ? record.stackId.trim() : null,
      verification,
      createdAt,
      updatedAt: Math.max(updatedAt, createdAt)
    };
  }

  private upsertPreviewProofRecord(record: PreviewProofRecordView, options?: { emitChange?: boolean }): PreviewProofRecordView {
    const normalized = this.normalizePreviewProofRecord(record);
    this.previewProofs.set(normalized.id, normalized);
    this.queueSave();
    if (options?.emitChange !== false) {
      this.emitChange();
    }
    return normalized;
  }

  private recordPreviewProofFromLease(
    lease: Pick<PreviewLeaseView, "id" | "threadId" | "projectId" | "projectLabel" | "title" | "stackId" | "lastVerification">,
    options?: { emitChange?: boolean }
  ): PreviewProofRecordView | null {
    if (!lease.lastVerification) {
      return null;
    }

    const verification = normalizePreviewVerification(lease.lastVerification, this.artifactRetentionMs);
    return this.upsertPreviewProofRecord(
      {
        id: buildPreviewProofRecordId(lease.id, verification.runId),
        previewId: lease.id,
        threadId: lease.threadId,
        projectId: lease.projectId,
        projectLabel: lease.projectLabel,
        previewTitle: lease.title,
        stackId: lease.stackId,
        verification,
        createdAt: verification.checkedAt,
        updatedAt: verification.checkedAt
      },
      options
    );
  }

  private updateArtifactAvailability(
    filePath: string,
    mutate: (artifact: PreviewVerificationArtifactView) => PreviewVerificationArtifactView
  ): boolean {
    const targetPath = path.resolve(filePath);
    const now = Date.now();
    let changed = false;

    for (const [proofId, proof] of this.previewProofs.entries()) {
      let proofChanged = false;
      const nextArtifacts = proof.verification.artifacts.map((artifact) => {
        if (!artifact.filePath || path.resolve(artifact.filePath) !== targetPath) {
          return artifact;
        }
        proofChanged = true;
        return mutate(artifact);
      });
      if (proofChanged) {
        changed = true;
        this.previewProofs.set(
          proofId,
          this.normalizePreviewProofRecord({
            ...proof,
            verification: {
              ...proof.verification,
              artifacts: nextArtifacts
            },
            updatedAt: now
          })
        );
      }
    }

    for (const [leaseId, lease] of this.previewLeases.entries()) {
      if (!lease.lastVerification) {
        continue;
      }
      let previewChanged = false;
      const nextArtifacts = lease.lastVerification.artifacts.map((artifact) => {
        if (!artifact.filePath || path.resolve(artifact.filePath) !== targetPath) {
          return artifact;
        }
        previewChanged = true;
        return mutate(artifact);
      });
      if (!previewChanged) {
        continue;
      }
      this.previewLeases.set(
        leaseId,
        this.normalizePreviewLease(
          {
            ...lease,
            lastVerification: {
              ...lease.lastVerification,
              artifacts: nextArtifacts
            },
            updatedAt: Math.max(lease.updatedAt, now)
          },
          now
        )
      );
      changed = true;
    }

    if (changed) {
      this.queueSave();
      this.emitChange();
    }

    return changed;
  }

  async load(): Promise<void> {
    try {
      const raw = await fs.readFile(this.uiStatePath, "utf8");
      const data = JSON.parse(raw) as PersistedUiState;
      this.threadInventoryReady = false;
      this.windows = Array.isArray(data.windows)
        ? data.windows
            .filter((window): window is ButlerWindow => Boolean(window && typeof window.threadId === "string"))
            .map((window) =>
              normalizeWindow({
                threadId: window.threadId,
                title: typeof window.title === "string" ? window.title : "",
                openedAt: typeof window.openedAt === "number" ? window.openedAt : Date.now()
              })
            )
        : [];
      this.focusedWindowId = typeof data.focusedWindowId === "string" ? data.focusedWindowId : null;
      this.stackLeases.clear();
      for (const lease of Array.isArray(data.stackLeases) ? data.stackLeases : []) {
        if (lease && typeof lease === "object" && typeof lease.id === "string") {
          this.stackLeases.set(lease.id, this.normalizeStackLease(lease as StackLeaseView));
        }
      }
      this.previewLeases.clear();
      for (const lease of Array.isArray(data.previewLeases) ? data.previewLeases : []) {
        if (lease && typeof lease === "object" && typeof lease.id === "string") {
          this.previewLeases.set(lease.id, this.normalizePreviewLease(lease as PreviewLeaseView));
        }
      }
      this.previewProofs.clear();
      for (const proof of Array.isArray(data.previewProofs) ? data.previewProofs : []) {
        if (proof && typeof proof === "object" && typeof proof.previewId === "string") {
          const normalized = this.normalizePreviewProofRecord(proof as PreviewProofRecordView);
          this.previewProofs.set(normalized.id, normalized);
        }
      }
      this.serviceLeases.clear();
      for (const lease of Array.isArray(data.serviceLeases) ? data.serviceLeases : []) {
        if (lease && typeof lease === "object" && typeof lease.id === "string") {
          this.serviceLeases.set(lease.id, this.normalizeServiceLease(lease as ServiceLeaseView));
        }
      }
      this.runtimeCleanupTasks.clear();
      for (const task of Array.isArray(data.runtimeCleanupTasks) ? data.runtimeCleanupTasks : []) {
        if (task && typeof task === "object" && typeof task.id === "string" && typeof task.threadId === "string") {
          this.runtimeCleanupTasks.set(task.id, task as RuntimeCleanupTaskView);
        }
      }
      this.persistedSupervisionByThreadId.clear();
      this.persistedWorkerReportsByThreadId.clear();
      this.persistedExecutionContractsByThreadId.clear();
      for (const [threadId, policy] of Object.entries(data.supervisionByThreadId ?? {})) {
        this.persistedSupervisionByThreadId.set(threadId, {
          butlerTurnsUsed: typeof policy?.butlerTurnsUsed === "number" ? policy.butlerTurnsUsed : 0,
          maxButlerTurns: typeof policy?.maxButlerTurns === "number" ? policy.maxButlerTurns : null
        });
      }
      for (const [threadId, rawReports] of Object.entries(data.workerReportsByThreadId ?? {})) {
        const entries = Array.isArray(rawReports) ? rawReports : rawReports ? [rawReports] : [];
        const reports = entries
          .filter(
            (report): report is CodexWorkerReportView =>
              Boolean(report) &&
              typeof report === "object" &&
              typeof report.threadId === "string" &&
              typeof report.turnId === "string" &&
              (report.status === "completed" || report.status === "blocked") &&
              typeof report.summary === "string"
          )
          .map((report) => ({
            threadId: report.threadId,
            turnId: report.turnId,
            status: report.status,
            summary: report.summary.trim(),
            details: typeof report.details === "string" && report.details.trim() ? report.details.trim() : null,
            createdAt: typeof report.createdAt === "number" ? report.createdAt : Date.now(),
            updatedAt: typeof report.updatedAt === "number" ? report.updatedAt : Date.now()
          }))
          .sort((left, right) => left.createdAt - right.createdAt)
          .slice(-20);

        if (reports.length > 0) {
          this.persistedWorkerReportsByThreadId.set(threadId, reports);
        }
      }
      for (const [threadId, contract] of Object.entries(data.executionContractsByThreadId ?? {})) {
        if (
          contract &&
          typeof contract === "object" &&
          typeof contract.threadId === "string" &&
          typeof contract.executionMode === "string"
        ) {
          this.persistedExecutionContractsByThreadId.set(threadId, {
            ...contract,
            notes: Array.isArray(contract.notes)
              ? contract.notes.filter((note): note is string => typeof note === "string")
              : []
          });
        }
      }
      for (const lease of this.previewLeases.values()) {
        if (lease.lastVerification) {
          this.recordPreviewProofFromLease(lease, { emitChange: false });
        }
      }
    } catch {
      this.windows = [];
      this.focusedWindowId = null;
      this.stackLeases.clear();
      this.previewLeases.clear();
      this.previewProofs.clear();
      this.serviceLeases.clear();
      this.runtimeCleanupTasks.clear();
      this.persistedSupervisionByThreadId.clear();
      this.persistedWorkerReportsByThreadId.clear();
      this.persistedExecutionContractsByThreadId.clear();
      this.threadInventoryReady = false;
    }
  }

  private queueSave(): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
    }

    this.saveTimer = setTimeout(async () => {
      this.saveTimer = null;
      this.windows = this.windows.map(normalizeWindow);
      const payload: PersistedUiState = {
        windows: this.windows,
        focusedWindowId: this.focusedWindowId,
        stackLeases: [...this.stackLeases.values()].sort((left, right) => right.updatedAt - left.updatedAt),
        previewLeases: [...this.previewLeases.values()].sort((left, right) => right.updatedAt - left.updatedAt),
        previewProofs: [...this.previewProofs.values()].sort(
          (left, right) => right.verification.checkedAt - left.verification.checkedAt
        ),
        serviceLeases: [...this.serviceLeases.values()].sort((left, right) => right.updatedAt - left.updatedAt),
        runtimeCleanupTasks: [...this.runtimeCleanupTasks.values()].sort((left, right) => left.nextAttemptAt - right.nextAttemptAt),
        workerReportsByThreadId: Object.fromEntries(
          [...this.persistedWorkerReportsByThreadId.entries()].map(([threadId, reports]) => [threadId, reports])
        ),
        supervisionByThreadId: Object.fromEntries(
          [...this.persistedSupervisionByThreadId.entries()].map(([threadId, policy]) => [
            threadId,
            {
              butlerTurnsUsed: policy.butlerTurnsUsed,
              maxButlerTurns: policy.maxButlerTurns
            }
          ])
        ),
        executionContractsByThreadId: Object.fromEntries(
          [...this.persistedExecutionContractsByThreadId.entries()].map(([threadId, contract]) => [threadId, contract])
        )
      };
      await fs.mkdir(path.dirname(this.uiStatePath), { recursive: true });
      await fs.writeFile(this.uiStatePath, JSON.stringify(payload, null, 2));
    }, 150);
  }

  private emitChange(): void {
    this.emit("change");
  }

  markThreadInventoryReady(): void {
    this.threadInventoryReady = true;
    if (this.reconcileThreadWindows()) {
      this.queueSave();
      this.emitChange();
    }
  }

  private getOrCreateThread(id: string): CodexThreadRecord {
    const existing = this.threads.get(id);
    if (existing) {
      return existing;
    }

    const created: CodexThreadRecord = {
      id,
      preview: "",
      source: "unknown",
      cwd: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      status: "unknown",
      modelProvider: null,
      turnCount: 0,
      loaded: false,
      contextUsage: emptyCodexContextUsage(),
      compaction: emptyCodexCompaction(),
      supervision: emptyCodexSupervision(),
      supervisor: emptyThreadSupervisor(),
      executionContract: null,
      turns: [],
      eventLog: [],
      milestones: [],
      workerReport: null
    };
    const persisted = this.persistedSupervisionByThreadId.get(id);
    if (persisted) {
      created.supervision.butlerTurnsUsed = persisted.butlerTurnsUsed;
      created.supervision.maxButlerTurns = persisted.maxButlerTurns;
      created.supervision.capReached =
        persisted.maxButlerTurns !== null && persisted.butlerTurnsUsed >= persisted.maxButlerTurns;
    }
    const persistedReports = this.persistedWorkerReportsByThreadId.get(id);
    const persistedReport = persistedReports?.at(-1) ?? null;
    if (persistedReport) {
      created.workerReport = { ...persistedReport };
    }
    const persistedContract = this.persistedExecutionContractsByThreadId.get(id);
    if (persistedContract) {
      created.executionContract = { ...persistedContract };
    }
    this.threads.set(id, created);
    return created;
  }

  private persistThreadSupervision(thread: CodexThreadRecord): void {
    this.persistedSupervisionByThreadId.set(thread.id, {
      butlerTurnsUsed: thread.supervision.butlerTurnsUsed,
      maxButlerTurns: thread.supervision.maxButlerTurns
    });
  }

  private removePreviewProofsForThread(threadId: string): void {
    for (const [proofId, proof] of this.previewProofs.entries()) {
      if (proof.threadId === threadId) {
        this.previewProofs.delete(proofId);
      }
    }
  }

  upsertThreadSummary(thread: Record<string, unknown>): void {
    const id = typeof thread.id === "string" ? thread.id : undefined;
    if (!id) {
      return;
    }

    const record = this.getOrCreateThread(id);
    record.preview = typeof thread.preview === "string" ? thread.preview : record.preview;
    record.source = typeof thread.source === "string" ? thread.source : record.source;
    record.cwd = typeof thread.cwd === "string" ? thread.cwd : record.cwd;
    record.createdAt = typeof thread.createdAt === "number" ? thread.createdAt * 1000 : record.createdAt;
    record.updatedAt = typeof thread.updatedAt === "number" ? thread.updatedAt * 1000 : record.updatedAt;
    record.status = normalizeStatus(thread.status);
    record.modelProvider = typeof thread.modelProvider === "string" ? thread.modelProvider : record.modelProvider;
    const parsedExecutionContract = parseThreadExecutionContract(record.preview);
    if (parsedExecutionContract) {
      record.executionContract = parsedExecutionContract;
      this.persistedExecutionContractsByThreadId.set(id, parsedExecutionContract);
    }

    if (Array.isArray(thread.turns)) {
      record.turnCount = thread.turns.length;
      record.turns = (thread.turns as Record<string, unknown>[]).map((turn) => normalizeTurn(turn));
    } else {
      record.turnCount = Math.max(record.turnCount, record.turns.length);
    }

    this.refreshDerivedThreadState(record);
    if (!record.executionContract) {
      const inferredContract = inferPersistedThreadExecutionContract(record);
      if (inferredContract) {
        record.executionContract = inferredContract;
        this.persistedExecutionContractsByThreadId.set(id, inferredContract);
      }
    }
    this.emitChange();
  }

  setThreadExecutionContract(threadId: string, contract: CodexThreadExecutionContractView): void {
    const record = this.getOrCreateThread(threadId);
    record.executionContract = { ...contract };
    record.updatedAt = Date.now();
    this.persistedExecutionContractsByThreadId.set(threadId, { ...contract });
    this.refreshDerivedThreadState(record);
    this.queueSave();
    this.emitChange();
  }

  markLoadedThreads(threadIds: string[]): void {
    const loaded = new Set(threadIds);
    for (const record of this.threads.values()) {
      record.loaded = loaded.has(record.id);
    }
    this.emitChange();
  }

  enableMilestones(): void {
    this.latestStartedTurnIds.clear();
    this.latestCompletedTurnIds.clear();
    this.latestBlockedTurnIds.clear();

    for (const thread of this.threads.values()) {
      const latestTurn = thread.turns.at(-1);
      if (!latestTurn) {
        continue;
      }

      this.latestStartedTurnIds.set(thread.id, latestTurn.id);
      if (latestTurn.status === "completed") {
        this.latestCompletedTurnIds.set(thread.id, latestTurn.id);
      }
      if (latestTurn.status === "failed" || latestTurn.status === "interrupted" || latestTurn.error) {
        this.latestBlockedTurnIds.set(thread.id, latestTurn.id);
      }
    }

    this.milestonesEnabled = true;
  }

  private primeThreadMilestones(threadId: string): void {
    const thread = this.threads.get(threadId);
    const latestTurn = thread?.turns.at(-1);
    if (!latestTurn) {
      return;
    }

    this.latestStartedTurnIds.set(threadId, latestTurn.id);
    if (latestTurn.status === "completed") {
      this.latestCompletedTurnIds.set(threadId, latestTurn.id);
    }
    if (latestTurn.status === "failed" || latestTurn.status === "interrupted" || latestTurn.error) {
      this.latestBlockedTurnIds.set(threadId, latestTurn.id);
    }
  }

  setThreadDetail(thread: Record<string, unknown>): void {
    const threadId = typeof thread.id === "string" ? thread.id : null;
    const wasEnabled = this.milestonesEnabled;
    this.milestonesEnabled = false;
    this.upsertThreadSummary(thread);
    if (threadId) {
      this.getOrCreateThread(threadId).loaded = true;
    }
    this.milestonesEnabled = wasEnabled;
    if (threadId) {
      this.primeThreadMilestones(threadId);
    }
  }

  setThreadStatus(threadId: string, status: unknown): void {
    const record = this.getOrCreateThread(threadId);
    record.status = normalizeStatus(status);
    record.updatedAt = Date.now();
    this.refreshDerivedThreadState(record);
    this.emitChange();
  }

  private getOrCreateTurn(threadId: string, turnId: string): CodexTurnRecord {
    const record = this.getOrCreateThread(threadId);
    let turn = record.turns.find((entry) => entry.id === turnId);
    if (!turn) {
      turn = {
        id: turnId,
        status: "unknown",
        error: null,
        startedAt: Date.now(),
        completedAt: null,
        items: []
      };
      record.turns.push(turn);
      record.turnCount = record.turns.length;
    }
    return turn;
  }

  updateTurn(threadId: string, turn: Record<string, unknown>): void {
    const turnId = typeof turn.id === "string" ? turn.id : undefined;
    if (!turnId) {
      return;
    }

    const record = this.getOrCreateThread(threadId);
    const target = this.getOrCreateTurn(threadId, turnId);
    target.status = typeof turn.status === "string" ? turn.status : target.status;
    target.error = typeof turn.error === "string" ? turn.error : null;
    if (target.status === "completed" || target.status === "failed" || target.status === "interrupted") {
      target.completedAt = Date.now();
    } else if (!target.startedAt) {
      target.startedAt = Date.now();
    }
    record.updatedAt = Date.now();
    record.turnCount = record.turns.length;
    this.refreshDerivedThreadState(record);
    if (target.status === "completed" || target.status === "failed" || target.status === "interrupted") {
      this.noteThreadLeaseActivity(threadId, target.completedAt ?? Date.now());
    }
    this.emitChange();
  }

  updateItem(threadId: string, turnId: string, item: Record<string, unknown>, status: "started" | "completed"): void {
    const turn = this.getOrCreateTurn(threadId, turnId);
    const normalized = normalizeItem(item, status);
    const activityAt = Date.now();
    const existing = turn.items.find((entry) => entry.id === normalized.id);

    if (existing) {
      existing.status = normalized.status;
      existing.text = normalized.text || existing.text;
      existing.at = activityAt;
      existing.raw = normalized.raw;
    } else {
      turn.items.push(normalized);
    }

    const thread = this.getOrCreateThread(threadId);
    if (normalized.type !== "agentMessage" || status === "completed") {
      thread.updatedAt = activityAt;
    }
    thread.turnCount = thread.turns.length;
    this.refreshDerivedThreadState(thread, activityAt);
    if (normalized.type === "agentMessage") {
      this.noteThreadLeaseActivity(threadId, activityAt);
    }
    this.emitChange();
  }

  appendItemDelta(threadId: string, turnId: string, itemId: string, delta: string): void {
    const turn = this.getOrCreateTurn(threadId, turnId);
    const activityAt = Date.now();
    const target = turn.items.find((item) => item.id === itemId);
    if (!target) {
      turn.items.push({
        id: itemId,
        type: "agentMessage",
        status: "started",
        text: delta,
        at: activityAt,
        raw: {}
      });
    } else {
      target.text += delta;
      target.at = activityAt;
    }

    const thread = this.getOrCreateThread(threadId);
    this.refreshDerivedThreadState(thread, activityAt);
    this.noteThreadLeaseActivity(threadId, activityAt);
    this.emitChange();
  }

  updateThreadTokenUsage(
    threadId: string,
    tokenUsage: {
      totalTokens?: number | null;
      modelContextWindow?: number | null;
    }
  ): void {
    const thread = this.getOrCreateThread(threadId);
    const tokens = typeof tokenUsage.totalTokens === "number" ? tokenUsage.totalTokens : null;
    const contextWindow = typeof tokenUsage.modelContextWindow === "number" ? tokenUsage.modelContextWindow : null;
    thread.contextUsage = {
      tokens,
      contextWindow,
      percent: tokens !== null && contextWindow ? (tokens / contextWindow) * 100 : null
    };
    thread.updatedAt = Date.now();
    this.refreshDerivedThreadState(thread);
    this.emitChange();
  }

  private refreshDerivedThreadState(thread: CodexThreadRecord, activityAt = Date.now()): void {
    let count = 0;
    let active = false;
    let lastStartedAt: number | null = null;
    let lastCompletedAt: number | null = null;

    for (const turn of thread.turns) {
      const hasCompaction = turn.items.some((item) => item.type === "contextCompaction");
      if (!hasCompaction) {
        continue;
      }

      count += 1;
      lastStartedAt = Math.max(lastStartedAt ?? 0, turn.startedAt || 0) || lastStartedAt;

      if (turn.completedAt) {
        lastCompletedAt = Math.max(lastCompletedAt ?? 0, turn.completedAt) || lastCompletedAt;
      } else {
        active = true;
      }

      if (turn.status !== "completed" && turn.status !== "failed" && turn.status !== "interrupted") {
        active = true;
      }
    }

    thread.compaction = {
      active,
      count,
      lastStartedAt,
      lastCompletedAt
    };
    thread.supervision.capReached =
      thread.supervision.maxButlerTurns !== null && thread.supervision.butlerTurnsUsed >= thread.supervision.maxButlerTurns;
    thread.supervisor = buildThreadSupervisor(thread);
    this.persistThreadSupervision(thread);
    this.captureMilestones(thread);
  }

  noteThreadLeaseActivity(threadId: string, at = Date.now()): void {
    let changed = false;

    for (const lease of this.stackLeases.values()) {
      if (lease.threadId !== threadId || lease.status === "stopped") {
        continue;
      }
      if (typeof lease.lastActivityAt === "number" && at - lease.lastActivityAt < LEASE_ACTIVITY_WRITE_THROTTLE_MS) {
        continue;
      }
      this.stackLeases.set(
        lease.id,
        this.normalizeStackLease({ ...lease, lastActivityAt: at, ttlAnchorAt: at, updatedAt: Math.max(lease.updatedAt, at) }, at)
      );
      changed = true;
    }

    for (const lease of this.previewLeases.values()) {
      if (lease.threadId !== threadId || lease.status === "stopped") {
        continue;
      }
      if (typeof lease.lastActivityAt === "number" && at - lease.lastActivityAt < LEASE_ACTIVITY_WRITE_THROTTLE_MS) {
        continue;
      }
      this.previewLeases.set(
        lease.id,
        this.normalizePreviewLease({ ...lease, lastActivityAt: at, ttlAnchorAt: at, updatedAt: Math.max(lease.updatedAt, at) }, at)
      );
      changed = true;
    }

    for (const lease of this.serviceLeases.values()) {
      if (lease.threadId !== threadId || lease.status === "stopped") {
        continue;
      }
      if (typeof lease.lastActivityAt === "number" && at - lease.lastActivityAt < LEASE_ACTIVITY_WRITE_THROTTLE_MS) {
        continue;
      }
      this.serviceLeases.set(
        lease.id,
        this.normalizeServiceLease({ ...lease, lastActivityAt: at, ttlAnchorAt: at, updatedAt: Math.max(lease.updatedAt, at) }, at)
      );
      changed = true;
    }

    if (changed) {
      this.queueSave();
    }
  }

  noteStackLeaseActivity(leaseId: string, at = Date.now()): StackLeaseView | null {
    const lease = this.stackLeases.get(leaseId);
    if (!lease) {
      return null;
    }
    if (typeof lease.lastActivityAt === "number" && at - lease.lastActivityAt < LEASE_ACTIVITY_WRITE_THROTTLE_MS) {
      return this.normalizeStackLease(lease, at);
    }

    const nextLease = this.normalizeStackLease(
      {
        ...lease,
        lastActivityAt: at,
        updatedAt: Math.max(lease.updatedAt, at)
      },
      at
    );
    this.stackLeases.set(leaseId, nextLease);
    this.queueSave();
    this.emitChange();
    return nextLease;
  }

  notePreviewLeaseActivity(leaseId: string, at = Date.now()): PreviewLeaseView | null {
    const lease = this.previewLeases.get(leaseId);
    if (!lease) {
      return null;
    }
    if (typeof lease.lastActivityAt === "number" && at - lease.lastActivityAt < LEASE_ACTIVITY_WRITE_THROTTLE_MS) {
      return this.normalizePreviewLease(lease, at);
    }

    const nextLease = this.normalizePreviewLease(
      {
        ...lease,
        lastActivityAt: at,
        updatedAt: Math.max(lease.updatedAt, at)
      },
      at
    );
    this.previewLeases.set(leaseId, nextLease);
    if (nextLease.stackId) {
      this.noteStackLeaseActivity(nextLease.stackId, at);
    } else {
      this.queueSave();
    }
    this.emitChange();
    return nextLease;
  }

  noteServiceLeaseActivity(leaseId: string, at = Date.now()): ServiceLeaseView | null {
    const lease = this.serviceLeases.get(leaseId);
    if (!lease) {
      return null;
    }
    if (typeof lease.lastActivityAt === "number" && at - lease.lastActivityAt < LEASE_ACTIVITY_WRITE_THROTTLE_MS) {
      return this.normalizeServiceLease(lease, at);
    }

    const nextLease = this.normalizeServiceLease(
      {
        ...lease,
        lastActivityAt: at,
        updatedAt: Math.max(lease.updatedAt, at)
      },
      at
    );
    this.serviceLeases.set(leaseId, nextLease);
    if (nextLease.stackId) {
      this.noteStackLeaseActivity(nextLease.stackId, at);
    } else {
      this.queueSave();
    }
    this.emitChange();
    return nextLease;
  }

  setStackLeasePinned(leaseId: string, pinned: boolean): StackLeaseView | null {
    const lease = this.stackLeases.get(leaseId);
    if (!lease) {
      return null;
    }

    const nextLease = this.normalizeStackLease({ ...lease, pinned }, Date.now());
    this.stackLeases.set(leaseId, nextLease);
    this.queueSave();
    this.emitChange();
    return nextLease;
  }

  setPreviewLeasePinned(leaseId: string, pinned: boolean): PreviewLeaseView | null {
    const lease = this.previewLeases.get(leaseId);
    if (!lease) {
      return null;
    }

    const nextLease = this.normalizePreviewLease({ ...lease, pinned }, Date.now());
    this.previewLeases.set(leaseId, nextLease);
    this.queueSave();
    this.emitChange();
    return nextLease;
  }

  setServiceLeasePinned(leaseId: string, pinned: boolean): ServiceLeaseView | null {
    const lease = this.serviceLeases.get(leaseId);
    if (!lease) {
      return null;
    }

    const nextLease = this.normalizeServiceLease({ ...lease, pinned }, Date.now());
    this.serviceLeases.set(leaseId, nextLease);
    this.queueSave();
    this.emitChange();
    return nextLease;
  }

  listExpiredLeaseIds(now = Date.now()): {
    stacks: string[];
    previews: string[];
    services: string[];
  } {
    const stacks = this.listStackLeases()
      .filter((lease) => typeof lease.reapAfterAt === "number" && lease.reapAfterAt <= now)
      .map((lease) => lease.id);
    const previews = this.listPreviewLeases()
      .filter((lease) => typeof lease.reapAfterAt === "number" && lease.reapAfterAt <= now)
      .map((lease) => lease.id);
    const services = this.listServiceLeases()
      .filter((lease) => typeof lease.reapAfterAt === "number" && lease.reapAfterAt <= now)
      .map((lease) => lease.id);

    return { stacks, previews, services };
  }

  enqueueRuntimeCleanupTask(input: {
    threadId: string;
    cwd: string | null;
    notifyOnError?: boolean;
    stacks: RuntimeCleanupTaskView["stacks"];
    previews: RuntimeCleanupTaskView["previews"];
    services: RuntimeCleanupTaskView["services"];
  }): RuntimeCleanupTaskView {
    const now = Date.now();
    const task: RuntimeCleanupTaskView = {
      id: input.threadId,
      threadId: input.threadId,
      cwd: input.cwd,
      createdAt: now,
      updatedAt: now,
      nextAttemptAt: now,
      attempts: 0,
      lastError: null,
      notifyOnError: input.notifyOnError !== false,
      stacks: [...input.stacks],
      previews: [...input.previews],
      services: [...input.services]
    };
    this.runtimeCleanupTasks.set(task.id, task);
    this.queueSave();
    this.emitChange();
    return task;
  }

  listDueRuntimeCleanupTasks(now = Date.now()): RuntimeCleanupTaskView[] {
    return [...this.runtimeCleanupTasks.values()]
      .filter((task) => task.nextAttemptAt <= now)
      .sort((left, right) => left.nextAttemptAt - right.nextAttemptAt);
  }

  completeRuntimeCleanupTask(taskId: string): void {
    if (!this.runtimeCleanupTasks.delete(taskId)) {
      return;
    }
    this.queueSave();
    this.emitChange();
  }

  failRuntimeCleanupTask(taskId: string, errorMessage: string, nextAttemptAt: number): { task: RuntimeCleanupTaskView | null; notify: boolean } {
    const existing = this.runtimeCleanupTasks.get(taskId);
    if (!existing) {
      return { task: null, notify: false };
    }

    const notify = existing.notifyOnError;
    const nextTask: RuntimeCleanupTaskView = {
      ...existing,
      attempts: existing.attempts + 1,
      updatedAt: Date.now(),
      nextAttemptAt,
      lastError: errorMessage,
      notifyOnError: false
    };
    this.runtimeCleanupTasks.set(taskId, nextTask);
    this.queueSave();
    this.emitChange();
    return { task: nextTask, notify };
  }

  private pushMilestone(thread: CodexThreadRecord, type: CodexMilestoneEntry["type"], summary: string): void {
    const latestTurn = thread.turns.at(-1);
    if (!latestTurn) {
      return;
    }

    const entry: CodexMilestoneEntry = {
      id: `${thread.id}:${type}:${latestTurn.id}:${Date.now()}`,
      at: Date.now(),
      type,
      threadId: thread.id,
      turnId: latestTurn.id,
      projectId: thread.supervisor.projectId,
      summary
    };
    thread.milestones.unshift(entry);
    thread.milestones = thread.milestones.slice(0, 20);
  }

  private captureMilestones(thread: CodexThreadRecord): void {
    if (!this.milestonesEnabled) {
      return;
    }

    const latestTurn = thread.turns.at(-1);
    if (!latestTurn) {
      return;
    }

    if (thread.supervisor.blocked) {
      const knownBlockedTurnId = this.latestBlockedTurnIds.get(thread.id);
      if (latestTurn.id !== knownBlockedTurnId) {
        this.latestBlockedTurnIds.set(thread.id, latestTurn.id);
        this.pushMilestone(thread, "blocked", `${thread.supervisor.projectLabel}: ${thread.supervisor.summary}`);
      }
      return;
    }

    if (latestTurn.status === "completed") {
      const knownCompletedTurnId = this.latestCompletedTurnIds.get(thread.id);
      if (latestTurn.id !== knownCompletedTurnId) {
        this.latestCompletedTurnIds.set(thread.id, latestTurn.id);
        this.pushMilestone(thread, "completed", `${thread.supervisor.projectLabel}: ${thread.supervisor.summary}`);
      }
      return;
    }

    const knownStartedTurnId = this.latestStartedTurnIds.get(thread.id);
    if (latestTurn.id !== knownStartedTurnId && thread.status === "active") {
      this.latestStartedTurnIds.set(thread.id, latestTurn.id);
      this.pushMilestone(thread, "started", `${thread.supervisor.projectLabel}: ${thread.supervisor.summary}`);
    }
  }

  addEvent(threadId: string, method: string, summary: string): void {
    const thread = this.getOrCreateThread(threadId);
    const entry: CodexEventEntry = {
      at: Date.now(),
      method,
      summary
    };
    thread.eventLog.unshift(entry);
    thread.eventLog = thread.eventLog.slice(0, MAX_EVENT_LOG);
    thread.updatedAt = Date.now();
    this.emitChange();
  }

  openWindow(threadId: string): void {
    this.getOrCreateThread(threadId);
    if (!this.windows.find((window) => window.threadId === threadId)) {
      this.windows.unshift({
        threadId,
        title: formatWindowTitle(threadId),
        openedAt: Date.now()
      });
    }
    this.focusedWindowId = threadId;
    this.queueSave();
    this.emitChange();
  }

  focusWindow(threadId: string): void {
    if (!this.windows.find((window) => window.threadId === threadId)) {
      return;
    }
    this.focusedWindowId = threadId;
    this.queueSave();
    this.emitChange();
  }

  focusButler(): void {
    this.focusedWindowId = null;
    this.queueSave();
    this.emitChange();
  }

  closeWindow(threadId: string): void {
    this.windows = this.windows.filter((window) => window.threadId !== threadId);
    if (this.focusedWindowId === threadId) {
      this.focusedWindowId = this.windows[0]?.threadId ?? null;
    }
    this.queueSave();
    this.emitChange();
  }

  removeThread(threadId: string): void {
    this.threads.delete(threadId);
    for (const lease of this.stackLeases.values()) {
      if (lease.threadId === threadId) {
        this.stackLeases.delete(lease.id);
      }
    }
    for (const lease of this.previewLeases.values()) {
      if (lease.threadId === threadId) {
        this.previewLeases.delete(lease.id);
      }
    }
    for (const lease of this.serviceLeases.values()) {
      if (lease.threadId === threadId) {
        this.serviceLeases.delete(lease.id);
      }
    }
    this.removePreviewProofsForThread(threadId);
    this.persistedSupervisionByThreadId.delete(threadId);
    this.persistedWorkerReportsByThreadId.delete(threadId);
    this.persistedExecutionContractsByThreadId.delete(threadId);
    this.latestStartedTurnIds.delete(threadId);
    this.latestCompletedTurnIds.delete(threadId);
    this.latestBlockedTurnIds.delete(threadId);
    this.windows = this.windows.filter((window) => window.threadId !== threadId);
    if (this.focusedWindowId === threadId) {
      this.focusedWindowId = this.windows[0]?.threadId ?? null;
    }
    this.queueSave();
    this.emitChange();
  }

  removeThreads(threadIds: string[]): void {
    const targets = new Set(threadIds);
    if (targets.size === 0) {
      return;
    }

    for (const threadId of targets) {
      this.threads.delete(threadId);
      for (const lease of this.stackLeases.values()) {
        if (lease.threadId === threadId) {
          this.stackLeases.delete(lease.id);
        }
      }
      for (const lease of this.previewLeases.values()) {
        if (lease.threadId === threadId) {
          this.previewLeases.delete(lease.id);
        }
      }
      for (const lease of this.serviceLeases.values()) {
        if (lease.threadId === threadId) {
          this.serviceLeases.delete(lease.id);
        }
      }
      this.removePreviewProofsForThread(threadId);
      this.persistedSupervisionByThreadId.delete(threadId);
      this.persistedWorkerReportsByThreadId.delete(threadId);
      this.persistedExecutionContractsByThreadId.delete(threadId);
      this.latestStartedTurnIds.delete(threadId);
      this.latestCompletedTurnIds.delete(threadId);
      this.latestBlockedTurnIds.delete(threadId);
    }

    this.windows = this.windows.filter((window) => !targets.has(window.threadId));
    if (this.focusedWindowId && targets.has(this.focusedWindowId)) {
      this.focusedWindowId = this.windows[0]?.threadId ?? null;
    }
    this.queueSave();
    this.emitChange();
  }

  listThreads(): CodexThreadSummary[] {
    return [...this.threads.values()]
      .map((thread) => ({
        id: thread.id,
        preview: thread.preview,
        source: thread.source,
        cwd: thread.cwd,
        createdAt: thread.createdAt,
        updatedAt: thread.updatedAt,
        status: thread.status,
        modelProvider: thread.modelProvider,
        turnCount: thread.turnCount,
        loaded: thread.loaded,
        contextUsage: thread.contextUsage,
        compaction: thread.compaction,
        supervision: thread.supervision,
        supervisor: thread.supervisor,
        executionContract: thread.executionContract
      }))
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }

  getThread(threadId: string): CodexThreadRecord | undefined {
    return this.threads.get(threadId);
  }

  private toItemView(item: CodexItemRecord): CodexItemView {
    return {
      id: item.id,
      type: item.type,
      status: item.status,
      text: item.text,
      at: item.at
    };
  }

  private toTurnView(turn: CodexTurnRecord): CodexTurnView {
    return {
      id: turn.id,
      status: turn.status,
      error: turn.error,
      startedAt: turn.startedAt,
      completedAt: turn.completedAt,
      items: turn.items.filter(shouldExposeCodexItem).map((item) => this.toItemView(item))
    };
  }

  private toThreadDetailView(thread: CodexThreadRecord): CodexThreadDetailView {
    return {
      id: thread.id,
      preview: thread.preview,
      source: thread.source,
      cwd: thread.cwd,
      createdAt: thread.createdAt,
      updatedAt: thread.updatedAt,
      status: thread.status,
      modelProvider: thread.modelProvider,
      turnCount: thread.turnCount,
      loaded: thread.loaded,
      contextUsage: thread.contextUsage,
      compaction: thread.compaction,
      supervision: thread.supervision,
      supervisor: thread.supervisor,
      executionContract: thread.executionContract,
      turns: thread.turns.map((turn) => this.toTurnView(turn)),
      eventLog: thread.eventLog,
      workerReport: thread.workerReport
    };
  }

  getThreadDetail(threadId: string): CodexThreadDetailView | undefined {
    const thread = this.threads.get(threadId);
    return thread ? this.toThreadDetailView(thread) : undefined;
  }

  listOpenThreadDetails(): Record<string, CodexThreadDetailView> {
    if (this.reconcileThreadWindows()) {
      this.queueSave();
    }
    return Object.fromEntries(
      this.windows
        .map((window) => {
          const thread = this.threads.get(window.threadId);
          return thread ? [window.threadId, this.toThreadDetailView(thread)] : null;
        })
        .filter((entry): entry is [string, CodexThreadDetailView] => Boolean(entry))
    );
  }

  getRuntimeSnapshot(serviceTemplates: AppSnapshot["butler"]["serviceTemplates"]): RuntimeSnapshot {
    const latestPreviewProofsByThreadId = Object.fromEntries(
      this.listPreviewProofs()
        .filter((proof) => Boolean(proof.threadId))
        .reduce((accumulator, proof) => {
          if (!proof.threadId || accumulator.has(proof.threadId)) {
            return accumulator;
          }
          accumulator.set(proof.threadId, proof);
          return accumulator;
        }, new Map<string, PreviewProofRecordView>())
        .entries()
    );

    return {
      latestPreviewProofsByThreadId,
      stacks: this.listStackLeases(),
      previews: this.listPreviewLeases(),
      serviceTemplates,
      services: this.listServiceLeases()
    };
  }

  getShellSnapshot(
    butler: AppShellSnapshot["butler"],
    codexConnection: {
      connected: boolean;
      lastError: string | null;
      compose: AppSnapshot["codex"]["compose"];
    }
  ): AppShellSnapshot {
    if (this.reconcileThreadWindows()) {
      this.queueSave();
    }
    this.windows = this.windows.map(normalizeWindow);

    return {
      codex: {
        connected: codexConnection.connected,
        lastError: codexConnection.lastError,
        threads: this.listThreads(),
        windows: this.windows,
        focusedWindowId: this.focusedWindowId,
        compose: codexConnection.compose
      },
      butler
    };
  }

  recordWorkerReport(
    threadId: string,
    report: {
      status: "completed" | "blocked";
      summary: string;
      details?: string | null;
      turnId?: string | null;
    }
  ): CodexWorkerReportView {
    const thread = this.getOrCreateThread(threadId);
    const latestTurn = thread.turns.at(-1);
    const explicitTurnId = typeof report.turnId === "string" && report.turnId.trim() ? report.turnId.trim() : null;
    const turnId = explicitTurnId ?? latestTurn?.id ?? null;
    if (!turnId) {
      throw new Error("Cannot record a worker report before the thread has an active or completed turn");
    }

    const now = Date.now();
    const existing = thread.workerReport;
    const nextReport: CodexWorkerReportView = {
      threadId,
      turnId,
      status: report.status,
      summary: report.summary.trim(),
      details: typeof report.details === "string" && report.details.trim() ? report.details.trim() : null,
      createdAt: existing?.turnId === turnId && existing?.status === report.status ? existing.createdAt : now,
      updatedAt: now
    };

    thread.workerReport = nextReport;
    thread.updatedAt = now;
    const history = this.persistedWorkerReportsByThreadId.get(threadId) ?? [];
    const nextHistory = [...history.filter((entry) => entry.turnId !== turnId), nextReport]
      .sort((left, right) => left.createdAt - right.createdAt)
      .slice(-20);
    this.persistedWorkerReportsByThreadId.set(threadId, nextHistory);
    this.queueSave();
    this.emitChange();
    return nextReport;
  }

  getWorkerReport(threadId: string, turnId?: string | null): CodexWorkerReportView | null {
    const liveReport = this.threads.get(threadId)?.workerReport ?? null;
    if (liveReport && (!turnId || liveReport.turnId === turnId)) {
      return liveReport;
    }

    const reports = this.persistedWorkerReportsByThreadId.get(threadId) ?? [];
    if (reports.length === 0) {
      return null;
    }
    if (turnId) {
      return reports.find((entry) => entry.turnId === turnId) ?? null;
    }
    return reports.at(-1) ?? null;
  }

  getOpenWindowIds(): string[] {
    if (this.reconcileThreadWindows()) {
      this.queueSave();
    }
    return this.windows.map((window) => window.threadId);
  }

  getThreadSupervision(threadId: string): { butlerTurnsUsed: number; maxButlerTurns: number | null; capReached: boolean } {
    return this.getOrCreateThread(threadId).supervision;
  }

  noteButlerSteer(threadId: string): { butlerTurnsUsed: number; maxButlerTurns: number | null; capReached: boolean } {
    const thread = this.getOrCreateThread(threadId);
    thread.supervision.butlerTurnsUsed += 1;
    this.refreshDerivedThreadState(thread);
    this.queueSave();
    this.emitChange();
    return thread.supervision;
  }

  setThreadSupervisionLimit(threadId: string, maxButlerTurns: number | null): { butlerTurnsUsed: number; maxButlerTurns: number | null; capReached: boolean } {
    const thread = this.getOrCreateThread(threadId);
    thread.supervision.maxButlerTurns = maxButlerTurns;
    this.refreshDerivedThreadState(thread);
    this.queueSave();
    this.emitChange();
    return thread.supervision;
  }

  listProjectSummaries(): CodexProjectSummaryView[] {
    return buildProjectSummary([...this.threads.values()]);
  }

  getProjectSummary(projectId: string): CodexProjectSummaryView | undefined {
    return this.listProjectSummaries().find((project) => project.id === projectId);
  }

  getSupervisorSummary(): ButlerSupervisorSummaryView {
    const threads = [...this.threads.values()];
    return buildSupervisorSummary(buildProjectSummary(threads), threads);
  }

  listMilestones(): CodexMilestoneEntry[] {
    return [...this.threads.values()]
      .flatMap((thread) => thread.milestones)
      .sort((a, b) => b.at - a.at);
  }

  upsertStackLease(lease: StackLeaseView): void {
    const existing = this.stackLeases.get(lease.id);
    const nextLease = this.normalizeStackLease(
      {
        ...existing,
        ...lease,
        pinned: lease.pinned ?? existing?.pinned ?? false,
        lastActivityAt: lease.lastActivityAt ?? existing?.lastActivityAt ?? lease.updatedAt ?? lease.createdAt,
        ttlAnchorAt: lease.ttlAnchorAt ?? existing?.ttlAnchorAt ?? lease.lastActivityAt ?? lease.updatedAt ?? lease.createdAt,
        leaseTtlMs: lease.leaseTtlMs ?? existing?.leaseTtlMs ?? this.stackLeaseTtlMs
      },
      Date.now()
    );
    this.stackLeases.set(lease.id, nextLease);
    this.queueSave();
    this.emitChange();
  }

  removeStackLease(leaseId: string): void {
    if (!this.stackLeases.delete(leaseId)) {
      return;
    }
    this.queueSave();
    this.emitChange();
  }

  getStackLease(leaseId: string): StackLeaseView | undefined {
    const lease = this.stackLeases.get(leaseId);
    return lease ? this.normalizeStackLease(lease) : undefined;
  }

  listStackLeases(): StackLeaseView[] {
    const now = Date.now();
    return [...this.stackLeases.values()]
      .map((lease) => this.normalizeStackLease(lease, now))
      .sort((left, right) => right.updatedAt - left.updatedAt);
  }

  upsertPreviewLease(lease: PreviewLeaseView): void {
    const existing = this.previewLeases.get(lease.id);
    const nextLease = this.normalizePreviewLease(
      {
        ...existing,
        ...lease,
        pinned: lease.pinned ?? existing?.pinned ?? false,
        lastVerification: lease.lastVerification ?? existing?.lastVerification ?? null,
        lastActivityAt: lease.lastActivityAt ?? existing?.lastActivityAt ?? lease.updatedAt ?? lease.createdAt,
        ttlAnchorAt: lease.ttlAnchorAt ?? existing?.ttlAnchorAt ?? lease.lastActivityAt ?? lease.updatedAt ?? lease.createdAt,
        leaseTtlMs: lease.leaseTtlMs ?? existing?.leaseTtlMs ?? this.previewLeaseTtlMs
      },
      Date.now()
    );
    this.previewLeases.set(lease.id, nextLease);
    this.recordPreviewProofFromLease(nextLease, { emitChange: false });
    if (existing?.stackId && existing.stackId !== nextLease.stackId) {
      this.refreshStackMembership(existing.stackId);
    }
    if (nextLease.stackId) {
      this.refreshStackMembership(nextLease.stackId);
    }
    this.queueSave();
    this.emitChange();
  }

  recordPreviewLeaseVerification(leaseId: string, verification: PreviewVerificationView): PreviewLeaseView | null {
    const lease = this.previewLeases.get(leaseId);
    if (!lease) {
      return null;
    }

    const checkedAt =
      typeof verification.checkedAt === "number" && Number.isFinite(verification.checkedAt) ? verification.checkedAt : Date.now();
    const nextLease = this.normalizePreviewLease(
      {
        ...lease,
        lastVerification: normalizePreviewVerification(verification, this.artifactRetentionMs),
        lastActivityAt: Math.max(lease.lastActivityAt ?? lease.updatedAt ?? lease.createdAt, checkedAt),
        updatedAt: Math.max(lease.updatedAt, checkedAt)
      },
      checkedAt
    );
    this.previewLeases.set(leaseId, nextLease);
    this.recordPreviewProofFromLease(nextLease, { emitChange: false });
    this.queueSave();
    this.emitChange();
    return nextLease;
  }

  markPreviewLeaseStopping(leaseId: string): PreviewLeaseView | null {
    const lease = this.previewLeases.get(leaseId);
    if (!lease) {
      return null;
    }

    const now = Date.now();
    const nextLease = this.normalizePreviewLease(
      {
        ...lease,
        status: "stopping",
        updatedAt: Math.max(lease.updatedAt, now)
      },
      now
    );
    this.previewLeases.set(leaseId, nextLease);
    this.queueSave();
    this.emitChange();
    return nextLease;
  }

  removePreviewLease(leaseId: string): void {
    const existing = this.previewLeases.get(leaseId);
    if (!existing || !this.previewLeases.delete(leaseId)) {
      return;
    }
    this.recordPreviewProofFromLease(existing, { emitChange: false });
    if (existing.stackId) {
      this.refreshStackMembership(existing.stackId);
    }
    this.queueSave();
    this.emitChange();
  }

  getPreviewLease(leaseId: string): PreviewLeaseView | undefined {
    const lease = this.previewLeases.get(leaseId);
    return lease ? this.normalizePreviewLease(lease) : undefined;
  }

  listPreviewLeases(): PreviewLeaseView[] {
    const now = Date.now();
    return [...this.previewLeases.values()]
      .map((lease) => this.normalizePreviewLease(lease, now))
      .sort((left, right) => right.updatedAt - left.updatedAt);
  }

  listPreviewProofs(): PreviewProofRecordView[] {
    return [...this.previewProofs.values()]
      .map((proof) => this.normalizePreviewProofRecord(proof))
      .sort((left, right) => right.verification.checkedAt - left.verification.checkedAt);
  }

  getPreviewProofById(proofId: string): PreviewProofRecordView | null {
    const proof = this.previewProofs.get(proofId);
    return proof ? this.normalizePreviewProofRecord(proof) : null;
  }

  getLatestPreviewProofForThread(threadId: string): PreviewProofRecordView | null {
    return (
      this.listPreviewProofs().find((proof) => proof.threadId === threadId) ?? null
    );
  }

  getLatestPreviewProofForPreview(previewId: string): PreviewProofRecordView | null {
    return (
      this.listPreviewProofs().find((proof) => proof.previewId === previewId) ?? null
    );
  }

  findPreviewProofArtifactByFilePath(filePath: string): { proof: PreviewProofRecordView; artifact: PreviewVerificationArtifactView } | null {
    const targetPath = path.resolve(filePath);
    for (const proof of this.listPreviewProofs()) {
      const artifact = proof.verification.artifacts.find(
        (entry) => entry.filePath && path.resolve(entry.filePath) === targetPath
      );
      if (artifact) {
        return { proof, artifact };
      }
    }
    return null;
  }

  markPreviewProofArtifactExpired(filePath: string, expiredAt = Date.now()): boolean {
    return this.updateArtifactAvailability(filePath, (artifact) => ({
      ...artifact,
      availability: "expired",
      expiredAt
    }));
  }

  markPreviewProofArtifactMissing(filePath: string, missingAt = Date.now()): boolean {
    const existing = this.findPreviewProofArtifactByFilePath(filePath);
    if (!existing) {
      return false;
    }

    const shouldExpire =
      typeof existing.artifact.retainedUntilAt === "number" &&
      Number.isFinite(existing.artifact.retainedUntilAt) &&
      missingAt >= existing.artifact.retainedUntilAt;

    return this.updateArtifactAvailability(filePath, (artifact) => ({
      ...artifact,
      availability: shouldExpire ? "expired" : "missing",
      expiredAt: shouldExpire ? missingAt : artifact.expiredAt
    }));
  }

  getThreadPreviewLease(threadId: string): PreviewLeaseView | undefined {
    return this.listPreviewLeases().find((lease) => lease.threadId === threadId && lease.status !== "stopped");
  }

  upsertServiceLease(lease: ServiceLeaseView): void {
    const existing = this.serviceLeases.get(lease.id);
    const nextLease = this.normalizeServiceLease(
      {
        ...existing,
        ...lease,
        pinned: lease.pinned ?? existing?.pinned ?? false,
        lastActivityAt: lease.lastActivityAt ?? existing?.lastActivityAt ?? lease.updatedAt ?? lease.createdAt,
        ttlAnchorAt: lease.ttlAnchorAt ?? existing?.ttlAnchorAt ?? lease.lastActivityAt ?? lease.updatedAt ?? lease.createdAt,
        leaseTtlMs: lease.leaseTtlMs ?? existing?.leaseTtlMs ?? this.serviceLeaseTtlMs
      },
      Date.now()
    );
    this.serviceLeases.set(lease.id, nextLease);
    if (existing?.stackId && existing.stackId !== nextLease.stackId) {
      this.refreshStackMembership(existing.stackId);
    }
    if (nextLease.stackId) {
      this.refreshStackMembership(nextLease.stackId);
    }
    this.queueSave();
    this.emitChange();
  }

  removeServiceLease(leaseId: string): void {
    const existing = this.serviceLeases.get(leaseId);
    if (!existing || !this.serviceLeases.delete(leaseId)) {
      return;
    }
    if (existing.stackId) {
      this.refreshStackMembership(existing.stackId);
    }
    this.queueSave();
    this.emitChange();
  }

  getServiceLease(leaseId: string): ServiceLeaseView | undefined {
    const lease = this.serviceLeases.get(leaseId);
    return lease ? this.normalizeServiceLease(lease) : undefined;
  }

  listServiceLeases(): ServiceLeaseView[] {
    const now = Date.now();
    return [...this.serviceLeases.values()]
      .map((lease) => this.normalizeServiceLease(lease, now))
      .sort((left, right) => right.updatedAt - left.updatedAt);
  }

  getSnapshot(butler: {
    ready: boolean;
    pending: boolean;
    isStreaming: boolean;
    sessionId: string | null;
    model: string | null;
    auth: AppSnapshot["butler"]["auth"];
    messages: ButlerMessageView[];
    messageCount: number;
    tools: AppSnapshot["butler"]["tools"];
    onboarding: AppSnapshot["butler"]["onboarding"];
    contextUsage: AppSnapshot["butler"]["contextUsage"];
    compaction: AppSnapshot["butler"]["compaction"];
    supervision: AppSnapshot["butler"]["supervision"];
    stacks: AppSnapshot["butler"]["stacks"];
    previews: AppSnapshot["butler"]["previews"];
    serviceTemplates: AppSnapshot["butler"]["serviceTemplates"];
    services: AppSnapshot["butler"]["services"];
    lastError: string | null;
    compose: AppSnapshot["butler"]["compose"];
  }, codexConnection: {
    connected: boolean;
    lastError: string | null;
    compose: AppSnapshot["codex"]["compose"];
  }): AppSnapshot {
    if (this.reconcileThreadWindows()) {
      this.queueSave();
    }
    this.windows = this.windows.map(normalizeWindow);
    const openThreads = Object.fromEntries(
      this.windows
        .map((window) => {
          const thread = this.threads.get(window.threadId);
          return thread ? [window.threadId, thread] : null;
        })
        .filter((entry): entry is [string, CodexThreadRecord] => Boolean(entry))
    );
    const latestPreviewProofsByThreadId = Object.fromEntries(
      this.listPreviewProofs()
        .filter((proof) => Boolean(proof.threadId))
        .reduce((accumulator, proof) => {
          if (!proof.threadId || accumulator.has(proof.threadId)) {
            return accumulator;
          }
          accumulator.set(proof.threadId, proof);
          return accumulator;
        }, new Map<string, PreviewProofRecordView>())
        .entries()
    );

    return {
      codex: {
        connected: codexConnection.connected,
        lastError: codexConnection.lastError,
        threads: this.listThreads(),
        windows: this.windows,
        focusedWindowId: this.focusedWindowId,
        openThreads,
        compose: codexConnection.compose
      },
      butler: {
        ...butler,
        supervision: {
          ...butler.supervision,
          projects: this.listProjectSummaries(),
          supervisor: this.getSupervisorSummary()
        },
        latestPreviewProofsByThreadId,
        stacks: this.listStackLeases(),
        previews: this.listPreviewLeases(),
        serviceTemplates: butler.serviceTemplates,
        services: this.listServiceLeases()
      }
    };
  }
}
