import { resolveWorkspaceProjectInfo } from "./repo-worktree.js";
import { inferThreadExecutionContract, parseThreadExecutionContract } from "./thread-contract.js";
import type {
  ButlerSupervisorSummaryView,
  ButlerWindow,
  CodexCompactionView,
  CodexContextUsageView,
  CodexItemRecord,
  CodexMilestoneEntry,
  CodexProjectSummaryView,
  CodexSupervisionView,
  CodexThreadDetailView,
  CodexThreadExecutionContractView,
  CodexThreadRecord,
  CodexThreadStatus,
  CodexThreadSupervisorView,
  CodexTurnRecord,
  CodexWorkerReportView,
  JobMemoryEntryKind,
  JobMemoryEntryView,
  JobMemoryPromotionCandidateView,
  JobMemoryView,
  ProjectMemoryView,
  PreviewProofRecordView,
  PreviewVerificationArtifactView,
  PreviewVerificationConsoleMessageView,
  PreviewVerificationFailedRequestView,
  PreviewVerificationView,
  StackLeaseView
} from "./types.js";

export const MAX_EVENT_LOG = 80;
export const DEFAULT_BUTLER_THREAD_LIMIT = 20;
export const DEFAULT_PREVIEW_LEASE_TTL_MS = 30 * 60 * 1000;
export const DEFAULT_STACK_LEASE_TTL_MS = 30 * 60 * 1000;
export const DEFAULT_SERVICE_LEASE_TTL_MS = 30 * 60 * 1000;
export const DEFAULT_LEASE_REAP_GRACE_MS = 10 * 60 * 1000;
export const DEFAULT_ARTIFACT_RETENTION_MS = 14 * 24 * 60 * 60 * 1000;
export const LEASE_ACTIVITY_WRITE_THROTTLE_MS = 15_000;

export function emptyCodexContextUsage(): CodexContextUsageView {
  return {
    tokens: null,
    contextWindow: null,
    percent: null
  };
}

export function emptyCodexCompaction(): CodexCompactionView {
  return {
    active: false,
    count: 0,
    lastStartedAt: null,
    lastCompletedAt: null
  };
}

export function emptyCodexSupervision(): CodexSupervisionView {
  return {
    butlerTurnsUsed: 0,
    maxButlerTurns: DEFAULT_BUTLER_THREAD_LIMIT,
    capReached: false
  };
}

export function emptyThreadSupervisor(): CodexThreadSupervisorView {
  return {
    projectId: "unknown",
    projectLabel: "Unknown",
    latestUserPrompt: null,
    latestAgentReply: null,
    summary: "No supervisor summary yet.",
    blocked: false
  };
}

export function deriveProofRequirements(contract: CodexThreadExecutionContractView | null): string[] {
  if (!contract) {
    return [];
  }

  const requirements = new Set<string>();
  if (contract.proofMode === "ui") {
    requirements.add("Headed UI proof is required before completion.");
  } else if (contract.proofMode === "operational") {
    requirements.add("Operational verification is required before completion.");
  }

  for (const condition of contract.successConditions) {
    if (/\b(proof|verify|verification|artifact|screenshot|video|trace)\b/i.test(condition)) {
      requirements.add(condition.trim());
    }
  }

  return [...requirements];
}

export function buildEmptyJobMemory(input: {
  threadId: string;
  projectId: string;
  projectLabel: string;
  contract?: CodexThreadExecutionContractView | null;
}): JobMemoryView {
  return {
    threadId: input.threadId,
    projectId: input.projectId,
    projectLabel: input.projectLabel,
    operatorGoal: input.contract?.operatorGoal ?? null,
    requestedTask: input.contract?.requestedTask ?? null,
    currentPlan: [],
    latestCheckpoint: null,
    nextAction: null,
    blockers: [],
    assumptions: [],
    proofRequirements: deriveProofRequirements(input.contract ?? null),
    notes: [],
    decisions: [],
    entries: [],
    promotionCandidates: [],
    updatedAt: Date.now()
  };
}

export function buildEmptyProjectMemory(projectId: string, projectLabel: string): ProjectMemoryView {
  return {
    projectId,
    projectLabel,
    summary: null,
    entries: [],
    updatedAt: Date.now()
  };
}

export function normalizeStringList(values: unknown, limit = 20): string[] {
  if (!Array.isArray(values)) {
    return [];
  }

  return [...new Set(values.map((value) => (typeof value === "string" ? value.trim() : "")).filter(Boolean))].slice(0, limit);
}

export function normalizeJobMemoryEntryKind(value: unknown): JobMemoryEntryKind {
  return value === "checkpoint" || value === "decision" || value === "note" ? value : "note";
}

export function summarizeJobMemory(jobMemory: JobMemoryView | null | undefined, status: CodexThreadStatus): string | null {
  if (!jobMemory) {
    return null;
  }

  const lead =
    jobMemory.latestCheckpoint ??
    jobMemory.decisions.at(-1)?.summary ??
    jobMemory.notes.at(-1) ??
    null;
  if (!lead) {
    return null;
  }

  const parts = [lead];
  if (jobMemory.nextAction && status === "active") {
    parts.push(`Next: ${jobMemory.nextAction}`);
  } else if (jobMemory.blockers.length > 0) {
    parts.push(`Blocked by ${jobMemory.blockers[0]}`);
  }

  return clipText(parts.join(" "), 160);
}

export function clipText(value: string | null | undefined, max = 160): string | null {
  if (!value) {
    return null;
  }

  const normalized = value.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return null;
  }

  return normalized.length > max ? `${normalized.slice(0, max - 1)}…` : normalized;
}

export function summarizeTaskText(value: string | null | undefined, max = 120): string | null {
  if (!value) {
    return null;
  }

  const normalized = value.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return null;
  }

  return clipText(normalized, max);
}

export function summarizePreviewText(value: string | null | undefined, max = 120): string | null {
  if (!value) {
    return null;
  }

  const contract = parseThreadExecutionContract(value);
  return summarizeTaskText(contract?.requestedTask ?? value, max);
}

export function deriveThreadTaskTitle(thread: CodexThreadRecord | null | undefined): string | null {
  if (!thread) {
    return null;
  }

  const fromContract = summarizeTaskText(thread.executionContract?.requestedTask);
  if (fromContract) {
    return fromContract;
  }

  const flattenedItems = thread.turns.flatMap((turn) => turn.items.map((item) => ({ turn, item })));
  const latestUserPrompt = summarizeTaskText(
    [...flattenedItems]
      .reverse()
      .find(({ item }) => item.type === "userMessage" && item.text.trim())?.item.text ?? null
  );
  if (latestUserPrompt) {
    return latestUserPrompt;
  }

  return summarizePreviewText(thread.preview);
}

export function formatFallbackJobLabel(threadId: string): string {
  const normalizedThreadId = threadId.trim();
  if (!normalizedThreadId) {
    return "Job";
  }

  if (normalizedThreadId.length <= 13) {
    return `Job ${normalizedThreadId}`;
  }

  return `Job ${normalizedThreadId.slice(0, 8)}-${normalizedThreadId.slice(-4)}`;
}

export function formatWindowTitle(threadId: string, thread?: CodexThreadRecord): string {
  const threadName = typeof thread?.name === "string" ? thread.name.trim() : "";
  if (threadName) {
    return threadName;
  }

  return formatFallbackJobLabel(threadId);
}

export function normalizeWindow(window: ButlerWindow, thread?: CodexThreadRecord): ButlerWindow {
  return {
    threadId: window.threadId,
    title: formatWindowTitle(window.threadId, thread),
    openedAt: window.openedAt
  };
}

export function buildThreadSupervisor(thread: CodexThreadRecord): CodexThreadSupervisorView {
  const project = resolveWorkspaceProjectInfo(thread.cwd);
  const latestUserPrompt = deriveThreadTaskTitle(thread);
  const previewSummary = summarizePreviewText(thread.preview, 120);
  const flattenedItems = thread.turns.flatMap((turn) => turn.items.map((item) => ({ turn, item })));
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
  const memorySummary = summarizeJobMemory(thread.jobMemory, thread.status);

  let summary = "No supervisor summary yet.";
  if (blocked) {
    const blockerLead = thread.jobMemory?.blockers[0] ?? null;
    summary = latestTurn?.error
      ? `Blocked after ${latestUserPrompt ? `"${latestUserPrompt}"` : "the latest prompt"}. Error: ${clipText(latestTurn.error, 120)}`
      : blockerLead
        ? `Blocked after ${latestUserPrompt ? `"${latestUserPrompt}"` : "the latest prompt"}. Blocker: ${clipText(blockerLead, 120)}`
        : `Blocked after ${latestUserPrompt ? `"${latestUserPrompt}"` : "the latest prompt"}.`;
  } else if (thread.status === "active") {
    summary = memorySummary
      ? latestUserPrompt
        ? `Working on "${latestUserPrompt}". ${memorySummary}`
        : memorySummary
      : latestUserPrompt
        ? `Working on "${latestUserPrompt}".`
        : previewSummary
          ? `Working on ${previewSummary}.`
          : "Work is in progress.";
  } else if (latestAgentReply) {
    summary = latestUserPrompt
      ? `Idle after "${latestUserPrompt}". Latest result: ${clipText(latestAgentReply, 120)}`
      : `Idle. Latest result: ${clipText(latestAgentReply, 120)}`;
  } else if (memorySummary) {
    summary = latestUserPrompt ? `Idle after "${latestUserPrompt}". ${memorySummary}` : `Idle. ${memorySummary}`;
  } else if (previewSummary) {
    summary = `Idle. Task: ${previewSummary}`;
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

export function buildProjectSummary(
  threads: CodexThreadRecord[],
  projectMemories?: Map<string, ProjectMemoryView>
): CodexProjectSummaryView[] {
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
      const projectMemory = projectMemories?.get(id) ?? null;
      const statusBits = [
        activeCount > 0 ? `${activeCount} active` : null,
        blockedCount > 0 ? `${blockedCount} blocked` : null,
        completedCount > 0 ? `${completedCount} idle` : null
      ].filter(Boolean);
      const pendingPromotionCount = sorted.reduce(
        (count, thread) => count + (thread.jobMemory?.promotionCandidates.filter((entry) => entry.status === "pending").length ?? 0),
        0
      );

      return {
        id,
        label: lead?.supervisor.projectLabel ?? id,
        threadCount: sorted.length,
        activeCount,
        blockedCount,
        completedCount,
        updatedAt: lead?.updatedAt ?? Date.now(),
        summary: [
          `${statusBits.length > 0 ? `${statusBits.join(", ")}.` : "No active work."}`,
          projectMemory?.summary ? `Memory: ${projectMemory.summary}` : `Latest: ${lead?.supervisor.summary ?? "No supervisor summary yet."}`,
          pendingPromotionCount > 0 ? `${pendingPromotionCount} promotion candidate${pendingPromotionCount === 1 ? "" : "s"} pending.` : null
        ]
          .filter(Boolean)
          .join(" "),
        threadIds: sorted.map((thread) => thread.id),
        memorySummary: projectMemory?.summary ?? null,
        pendingPromotionCount
      };
    })
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

export function buildSupervisorSummary(projects: CodexProjectSummaryView[], threads: CodexThreadRecord[]): ButlerSupervisorSummaryView {
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

export function inferPersistedThreadExecutionContract(thread: CodexThreadRecord): CodexThreadExecutionContractView | null {
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

export function normalizeStatus(status: unknown): CodexThreadStatus {
  if (status && typeof status === "object" && "type" in status && typeof status.type === "string") {
    if (status.type === "active" || status.type === "idle") {
      return status.type;
    }
  }

  return "unknown";
}

export function normalizePreviewVerificationArtifact(
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

export function normalizePreviewVerificationConsoleMessage(
  message: PreviewVerificationConsoleMessageView
): PreviewVerificationConsoleMessageView {
  return {
    type: typeof message.type === "string" && message.type.trim() ? message.type.trim() : "log",
    text: typeof message.text === "string" ? message.text : "",
    location: typeof message.location === "string" && message.location.trim() ? message.location.trim() : null
  };
}

export function normalizePreviewVerificationFailedRequest(
  request: PreviewVerificationFailedRequestView
): PreviewVerificationFailedRequestView {
  return {
    url: typeof request.url === "string" ? request.url : "",
    method: typeof request.method === "string" && request.method.trim() ? request.method.trim() : "GET",
    errorText: typeof request.errorText === "string" && request.errorText.trim() ? request.errorText.trim() : null
  };
}

export function normalizePreviewVerification(
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
      verification.failureKind === "verifier" ||
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

export function buildPreviewProofRecordId(previewId: string, verificationRunId: string): string {
  return `${previewId}:${verificationRunId}`;
}

export function summarizeItem(item: Record<string, unknown>): string {
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

export function normalizeItem(item: Record<string, unknown>, status: "started" | "completed"): CodexItemRecord {
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

export function shouldExposeCodexItem(item: CodexItemRecord): boolean {
  if (item.type !== "agentMessage" && item.type !== "userMessage") {
    return false;
  }

  return item.text.trim().length > 0;
}

export function normalizeTurn(turn: Record<string, unknown>): CodexTurnRecord {
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

export function restorePersistedItem(item: {
  id?: unknown;
  type?: unknown;
  status?: unknown;
  text?: unknown;
  at?: unknown;
}): CodexItemRecord {
  return {
    id: typeof item.id === "string" ? item.id : crypto.randomUUID(),
    type: typeof item.type === "string" ? item.type : "unknown",
    status: item.status === "started" ? "started" : "completed",
    text: typeof item.text === "string" ? item.text : "",
    at: typeof item.at === "number" && Number.isFinite(item.at) ? item.at : Date.now(),
    raw: {}
  };
}

export function restorePersistedTurn(turn: {
  id?: unknown;
  status?: unknown;
  error?: unknown;
  startedAt?: unknown;
  completedAt?: unknown;
  items?: unknown;
}): CodexTurnRecord {
  return {
    id: typeof turn.id === "string" ? turn.id : crypto.randomUUID(),
    status: typeof turn.status === "string" ? turn.status : "unknown",
    error: typeof turn.error === "string" ? turn.error : null,
    startedAt: typeof turn.startedAt === "number" && Number.isFinite(turn.startedAt) ? turn.startedAt : Date.now(),
    completedAt: typeof turn.completedAt === "number" && Number.isFinite(turn.completedAt) ? turn.completedAt : null,
    items: Array.isArray(turn.items) ? turn.items.map((item) => restorePersistedItem((item ?? {}) as Record<string, unknown>)) : []
  };
}
