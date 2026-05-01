import crypto from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

import {
  buildEmptyJobMemory,
  buildEmptyProjectMemory,
  buildPreviewProofRecordId,
  emptyCodexCompaction,
  emptyCodexContextUsage,
  emptyCodexSupervision,
  emptyThreadSupervisor,
  MAX_EVENT_LOG,
  normalizeJobMemoryEntryKind,
  normalizeStringList,
  normalizePreviewVerification,
  normalizeStatus,
  normalizeWindow,
  restorePersistedTurn
} from "./state-store-helpers.js";
import type {
  ButlerWindow,
  CodexEventEntry,
  CodexThreadDetailView,
  CodexThreadExecutionContractView,
  CodexThreadRecord,
  CodexThreadSummary,
  CodexWorkerReportView,
  ButlerMemoryEntryView,
  JobMemoryDecisionView,
  JobMemoryEntryView,
  JobMemoryPromotionCandidateView,
  JobMemoryView,
  PersistedUiState,
  PreviewLeaseView,
  PreviewProofRecordView,
  PreviewVerificationArtifactView,
  ProjectArtifactView,
  ProjectMemoryEntryView,
  ProjectMemoryView,
  ProjectPolicyView,
  RuntimeCleanupTaskView,
  ServiceLeaseView,
  StackLeaseView,
  SupervisionChecklistView
} from "./types.js";

export type StateStoreInternalAccess = {
  uiStatePath: string;
  threads: Map<string, CodexThreadRecord>;
  stackLeases: Map<string, StackLeaseView>;
  previewLeases: Map<string, PreviewLeaseView>;
  serviceLeases: Map<string, ServiceLeaseView>;
  runtimeCleanupTasks: Map<string, RuntimeCleanupTaskView>;
  previewProofs: Map<string, PreviewProofRecordView>;
  persistedSupervisionByThreadId: Map<string, { butlerTurnsUsed: number; maxButlerTurns: number | null }>;
  persistedWorkerReportsByThreadId: Map<string, CodexWorkerReportView[]>;
  persistedExecutionContractsByThreadId: Map<string, CodexThreadExecutionContractView>;
  persistedSupervisionChecklistsByThreadId: Map<string, SupervisionChecklistView>;
  persistedJobMemoriesByThreadId: Map<string, JobMemoryView>;
  persistedProjectMemoriesByProjectId: Map<string, ProjectMemoryView>;
  persistedButlerMemoryEntries: ButlerMemoryEntryView[];
  persistedProjectArtifactsByProjectId: Map<string, ProjectArtifactView[]>;
  persistedProjectPoliciesByProjectId: Map<string, ProjectPolicyView[]>;
  windows: ButlerWindow[];
  focusedWindowId: string | null;
  saveTimer: NodeJS.Timeout | null;
  threadInventoryReady: boolean;
  previewLeaseTtlMs: number;
  stackLeaseTtlMs: number;
  serviceLeaseTtlMs: number;
  leaseReapGraceMs: number;
  artifactRetentionMs: number;
  getOrCreateThread(id: string): CodexThreadRecord;
  refreshDerivedThreadState(thread: CodexThreadRecord, activityAt?: number): void;
  listThreads(): CodexThreadSummary[];
  toThreadDetailView(thread: CodexThreadRecord): CodexThreadDetailView;
  primeThreadMilestones(threadId: string): void;
  emit(event: "change"): boolean;
};

function normalizeSupervisionChecklist(raw: SupervisionChecklistView): SupervisionChecklistView {
  const now = Date.now();
  const items = raw.items
    .filter((item) => item && typeof item === "object" && typeof item.text === "string" && item.text.trim())
    .map((item, index) => {
      const status: SupervisionChecklistView["items"][number]["status"] =
        item.status === "accepted" || item.status === "rejected" || item.status === "waived" ? item.status : "pending";
      return {
        id: typeof item.id === "string" && item.id.trim() ? item.id.trim() : `point-${index + 1}`,
        text: item.text.trim(),
        status,
        butlerNote: typeof item.butlerNote === "string" && item.butlerNote.trim() ? item.butlerNote.trim() : null,
        queuedInstruction:
          typeof item.queuedInstruction === "string" && item.queuedInstruction.trim() ? item.queuedInstruction.trim() : null,
        decidedAt: typeof item.decidedAt === "number" && Number.isFinite(item.decidedAt) ? item.decidedAt : null,
        evidence: Array.isArray(item.evidence)
          ? item.evidence
              .filter((entry) => entry && typeof entry === "object" && typeof entry.summary === "string")
              .map((entry) => ({
                id: typeof entry.id === "string" && entry.id.trim() ? entry.id.trim() : crypto.randomUUID(),
                source: entry.source === "butler_review" ? ("butler_review" as const) : ("worker_report" as const),
                summary: entry.summary.trim(),
                details: typeof entry.details === "string" && entry.details.trim() ? entry.details.trim() : null,
                reportTurnId: typeof entry.reportTurnId === "string" && entry.reportTurnId.trim() ? entry.reportTurnId.trim() : null,
                createdAt: typeof entry.createdAt === "number" && Number.isFinite(entry.createdAt) ? entry.createdAt : now
              }))
          : []
      };
    });

  return {
    threadId: raw.threadId,
    projectId: typeof raw.projectId === "string" && raw.projectId.trim() ? raw.projectId.trim() : "unknown",
    projectLabel: typeof raw.projectLabel === "string" && raw.projectLabel.trim() ? raw.projectLabel.trim() : "Unknown",
    requestedTask: typeof raw.requestedTask === "string" && raw.requestedTask.trim() ? raw.requestedTask.trim() : "Carry out the delegated task.",
    items,
    heartbeat: {
      lastThreadEventAt:
        typeof raw.heartbeat?.lastThreadEventAt === "number" && Number.isFinite(raw.heartbeat.lastThreadEventAt)
          ? raw.heartbeat.lastThreadEventAt
          : null,
      lastWorkerReportAt:
        typeof raw.heartbeat?.lastWorkerReportAt === "number" && Number.isFinite(raw.heartbeat.lastWorkerReportAt)
          ? raw.heartbeat.lastWorkerReportAt
          : null,
      lastKnownThreadStatus:
        raw.heartbeat?.lastKnownThreadStatus === "active" || raw.heartbeat?.lastKnownThreadStatus === "idle"
          ? raw.heartbeat.lastKnownThreadStatus
          : "unknown",
      stale: Boolean(raw.heartbeat?.stale)
    },
    reviewState: raw.reviewState === "reviewed" ? "reviewed" : "needs_review",
    createdAt: typeof raw.createdAt === "number" && Number.isFinite(raw.createdAt) ? raw.createdAt : now,
    updatedAt: typeof raw.updatedAt === "number" && Number.isFinite(raw.updatedAt) ? raw.updatedAt : now
  };
}

export function reconcileStateStoreThreadWindows(access: StateStoreInternalAccess): boolean {
  if (!access.threadInventoryReady) {
    return false;
  }

  const knownThreadIds = new Set(access.threads.keys());
  const seenThreadIds = new Set<string>();
  const nextWindows: ButlerWindow[] = [];

  for (const window of access.windows) {
    const threadId = typeof window.threadId === "string" ? window.threadId.trim() : "";
    if (!threadId || !knownThreadIds.has(threadId) || seenThreadIds.has(threadId)) {
      continue;
    }

    seenThreadIds.add(threadId);
    const thread = access.threads.get(threadId);
    nextWindows.push(
      normalizeWindow(
        {
          threadId,
          title: window.title,
          openedAt: window.openedAt
        },
        thread
      )
    );
  }

  const nextFocusedWindowId =
    access.focusedWindowId && seenThreadIds.has(access.focusedWindowId)
      ? access.focusedWindowId
      : nextWindows[0]?.threadId ?? null;

  const windowsChanged =
    nextWindows.length !== access.windows.length ||
    nextWindows.some((window, index) => {
      const current = access.windows[index];
      return current?.threadId !== window.threadId || current?.openedAt !== window.openedAt || current?.title !== window.title;
    });
  const focusChanged = access.focusedWindowId !== nextFocusedWindowId;

  if (!windowsChanged && !focusChanged) {
    return false;
  }

  access.windows = nextWindows;
  access.focusedWindowId = nextFocusedWindowId;
  return true;
}

export function refreshStateStoreStackMembership(access: StateStoreInternalAccess, stackId: string, now = Date.now()): void {
  const lease = access.stackLeases.get(stackId);
  if (!lease) {
    return;
  }

  const previewIds = [...access.previewLeases.values()]
    .filter((entry) => entry.stackId === stackId && entry.status !== "stopped")
    .map((entry) => entry.id)
    .sort();
  const serviceIds = [...access.serviceLeases.values()]
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

  access.stackLeases.set(
    stackId,
    normalizeStateStoreStackLease(
      access,
      {
        ...lease,
        previewIds,
        serviceIds,
        updatedAt: Math.max(lease.updatedAt, now)
      },
      now
    )
  );
  queueStateStoreSave(access);
  emitStateStoreChange(access);
}

export function applyStateStoreLeaseLifecycle<T extends PreviewLeaseView | StackLeaseView | ServiceLeaseView>(
  access: StateStoreInternalAccess,
  lease: T,
  defaults: { leaseTtlMs: number; now?: number; inheritedPinned?: boolean }
): T {
  const now = defaults.now ?? Date.now();
  const pinned = Boolean(lease.pinned);
  const effectivelyPinned = pinned || Boolean(defaults.inheritedPinned);
  const leaseTtlMs =
    typeof lease.leaseTtlMs === "number" && Number.isFinite(lease.leaseTtlMs) && lease.leaseTtlMs > 0
      ? lease.leaseTtlMs
      : defaults.leaseTtlMs;
  const lastActivityAt =
    typeof lease.lastActivityAt === "number" && Number.isFinite(lease.lastActivityAt)
      ? lease.lastActivityAt
      : lease.updatedAt ?? lease.createdAt ?? now;
  const ttlAnchorAt =
    typeof lease.ttlAnchorAt === "number" && Number.isFinite(lease.ttlAnchorAt) ? lease.ttlAnchorAt : lastActivityAt;
  const expiresAt = effectivelyPinned ? null : ttlAnchorAt + leaseTtlMs;
  const expired = !effectivelyPinned && expiresAt !== null && now >= expiresAt;
  const expiredAt =
    expired
      ? typeof lease.expiredAt === "number" && Number.isFinite(lease.expiredAt)
        ? lease.expiredAt
        : now
      : null;
  const reapAfterAt = expired && expiredAt !== null ? expiredAt + access.leaseReapGraceMs : null;
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

function stackPinProtectsChild(access: StateStoreInternalAccess, stackId: string | null): boolean {
  if (!stackId) {
    return false;
  }

  const stack = access.stackLeases.get(stackId);
  return Boolean(stack?.pinned && stack.status !== "stopped");
}

export function normalizeStateStorePreviewLease(
  access: StateStoreInternalAccess,
  lease: PreviewLeaseView,
  now = Date.now()
): PreviewLeaseView {
  const normalizedLease = {
    ...lease,
    workspaceMode: lease.workspaceMode === "snapshot" ? "snapshot" : "shared",
    stackId: typeof lease.stackId === "string" && lease.stackId.trim() ? lease.stackId.trim() : null,
    aliases: Array.isArray(lease.aliases)
      ? [...new Set(lease.aliases.map((alias) => (typeof alias === "string" ? alias.trim() : "")).filter(Boolean))]
      : [],
    publicPort: typeof lease.publicPort === "number" && Number.isFinite(lease.publicPort) && lease.publicPort > 0 ? lease.publicPort : null,
    publicUrl: typeof lease.publicUrl === "string" && lease.publicUrl.trim() ? lease.publicUrl.trim() : null,
    tailnetUrl: typeof lease.tailnetUrl === "string" && lease.tailnetUrl.trim() ? lease.tailnetUrl.trim() : null,
    lastVerification:
      lease.lastVerification && typeof lease.lastVerification === "object"
        ? normalizePreviewVerification(lease.lastVerification, access.artifactRetentionMs)
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

  return applyStateStoreLeaseLifecycle(access, normalizedLease, {
    leaseTtlMs: access.previewLeaseTtlMs,
    now,
    inheritedPinned: stackPinProtectsChild(access, normalizedLease.stackId)
  });
}

export function normalizeStateStoreStackLease(access: StateStoreInternalAccess, lease: StackLeaseView, now = Date.now()): StackLeaseView {
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
      typeof lease.cloneFromStorageKey === "string" && lease.cloneFromStorageKey.trim() ? lease.cloneFromStorageKey.trim() : null,
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

  return applyStateStoreLeaseLifecycle(access, normalizedLease, { leaseTtlMs: access.stackLeaseTtlMs, now });
}

export function normalizeStateStoreServiceLease(
  access: StateStoreInternalAccess,
  lease: ServiceLeaseView,
  now = Date.now()
): ServiceLeaseView {
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

  return applyStateStoreLeaseLifecycle(access, normalizedLease, {
    leaseTtlMs: access.serviceLeaseTtlMs,
    now,
    inheritedPinned: stackPinProtectsChild(access, normalizedLease.stackId)
  });
}

export function normalizeStateStorePreviewProofRecord(
  access: StateStoreInternalAccess,
  record: PreviewProofRecordView
): PreviewProofRecordView {
  const verification = normalizePreviewVerification(record.verification, access.artifactRetentionMs);
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

export function upsertStateStorePreviewProofRecord(
  access: StateStoreInternalAccess,
  record: PreviewProofRecordView,
  options?: { emitChange?: boolean }
): PreviewProofRecordView {
  const normalized = normalizeStateStorePreviewProofRecord(access, record);
  access.previewProofs.set(normalized.id, normalized);
  queueStateStoreSave(access);
  if (options?.emitChange !== false) {
    emitStateStoreChange(access);
  }
  return normalized;
}

export function recordStateStorePreviewProofFromLease(
  access: StateStoreInternalAccess,
  lease: Pick<PreviewLeaseView, "id" | "threadId" | "projectId" | "projectLabel" | "title" | "stackId" | "lastVerification">,
  options?: { emitChange?: boolean }
): PreviewProofRecordView | null {
  if (!lease.lastVerification) {
    return null;
  }

  const verification = normalizePreviewVerification(lease.lastVerification, access.artifactRetentionMs);
  return upsertStateStorePreviewProofRecord(
    access,
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

export function updateStateStoreArtifactAvailability(
  access: StateStoreInternalAccess,
  filePath: string,
  mutate: (artifact: PreviewVerificationArtifactView) => PreviewVerificationArtifactView
): boolean {
  const targetPath = path.resolve(filePath);
  const now = Date.now();
  let changed = false;

  for (const [proofId, proof] of access.previewProofs.entries()) {
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
      access.previewProofs.set(
        proofId,
        normalizeStateStorePreviewProofRecord(access, {
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

  for (const [leaseId, lease] of access.previewLeases.entries()) {
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
    access.previewLeases.set(
      leaseId,
      normalizeStateStorePreviewLease(
        access,
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
    queueStateStoreSave(access);
    emitStateStoreChange(access);
  }

  return changed;
}

export async function loadStateStore(access: StateStoreInternalAccess): Promise<void> {
  try {
    const raw = await fs.readFile(access.uiStatePath, "utf8");
    const data = JSON.parse(raw) as PersistedUiState;
    access.threadInventoryReady = false;
    access.threads.clear();
    access.windows = Array.isArray(data.windows)
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
    access.focusedWindowId = typeof data.focusedWindowId === "string" ? data.focusedWindowId : null;
    access.stackLeases.clear();
    for (const lease of Array.isArray(data.stackLeases) ? data.stackLeases : []) {
      if (lease && typeof lease === "object" && typeof lease.id === "string") {
        access.stackLeases.set(lease.id, normalizeStateStoreStackLease(access, lease as StackLeaseView));
      }
    }
    access.previewLeases.clear();
    for (const lease of Array.isArray(data.previewLeases) ? data.previewLeases : []) {
      if (lease && typeof lease === "object" && typeof lease.id === "string") {
        access.previewLeases.set(lease.id, normalizeStateStorePreviewLease(access, lease as PreviewLeaseView));
      }
    }
    access.previewProofs.clear();
    for (const proof of Array.isArray(data.previewProofs) ? data.previewProofs : []) {
      if (proof && typeof proof === "object" && typeof proof.previewId === "string") {
        const normalized = normalizeStateStorePreviewProofRecord(access, proof as PreviewProofRecordView);
        access.previewProofs.set(normalized.id, normalized);
      }
    }
    access.serviceLeases.clear();
    for (const lease of Array.isArray(data.serviceLeases) ? data.serviceLeases : []) {
      if (lease && typeof lease === "object" && typeof lease.id === "string") {
        access.serviceLeases.set(lease.id, normalizeStateStoreServiceLease(access, lease as ServiceLeaseView));
      }
    }
    access.runtimeCleanupTasks.clear();
    for (const task of Array.isArray(data.runtimeCleanupTasks) ? data.runtimeCleanupTasks : []) {
      if (task && typeof task === "object" && typeof task.id === "string" && typeof task.threadId === "string") {
        access.runtimeCleanupTasks.set(task.id, task as RuntimeCleanupTaskView);
      }
    }
    access.persistedSupervisionByThreadId.clear();
    access.persistedWorkerReportsByThreadId.clear();
    access.persistedExecutionContractsByThreadId.clear();
    access.persistedSupervisionChecklistsByThreadId.clear();
    access.persistedJobMemoriesByThreadId.clear();
    access.persistedProjectMemoriesByProjectId.clear();
    access.persistedButlerMemoryEntries.splice(0, access.persistedButlerMemoryEntries.length);
    access.persistedProjectArtifactsByProjectId.clear();
    access.persistedProjectPoliciesByProjectId.clear();
    for (const [threadId, policy] of Object.entries(data.supervisionByThreadId ?? {})) {
      access.persistedSupervisionByThreadId.set(threadId, {
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
        access.persistedWorkerReportsByThreadId.set(threadId, reports);
      }
    }
    for (const [threadId, contract] of Object.entries(data.executionContractsByThreadId ?? {})) {
      if (
        contract &&
        typeof contract === "object" &&
        typeof contract.threadId === "string" &&
        typeof contract.requestedTask === "string"
      ) {
        access.persistedExecutionContractsByThreadId.set(threadId, {
          ...contract,
          requestedTask:
            typeof contract.requestedTask === "string" && contract.requestedTask.trim()
              ? contract.requestedTask.trim()
              : "Carry out the delegated task.",
          operatorGoal: typeof contract.operatorGoal === "string" && contract.operatorGoal.trim() ? contract.operatorGoal.trim() : null,
          acceptancePoints: Array.isArray(contract.acceptancePoints)
            ? contract.acceptancePoints.filter((point): point is string => typeof point === "string" && Boolean(point.trim()))
            : [],
          proofExpectation: contract.proofExpectation === "requested" ? "requested" : "none",
          proofExpectationLabel:
            contract.proofExpectation === "requested" ? "proof requested" : "no explicit proof request",
          notes: Array.isArray(contract.notes) ? contract.notes.filter((note): note is string => typeof note === "string") : []
        });
      }
    }
    for (const [threadId, checklist] of Object.entries(data.supervisionChecklistsByThreadId ?? {})) {
      if (
        checklist &&
        typeof checklist === "object" &&
        typeof checklist.threadId === "string" &&
        Array.isArray(checklist.items)
      ) {
        access.persistedSupervisionChecklistsByThreadId.set(threadId, normalizeSupervisionChecklist(checklist));
      }
    }
    for (const [threadId, memory] of Object.entries(data.jobMemoriesByThreadId ?? {})) {
      if (!memory || typeof memory !== "object" || typeof memory.threadId !== "string") {
        continue;
      }
      access.persistedJobMemoriesByThreadId.set(threadId, {
        threadId,
        projectId: typeof memory.projectId === "string" && memory.projectId.trim() ? memory.projectId.trim() : "unknown",
        projectLabel:
          typeof memory.projectLabel === "string" && memory.projectLabel.trim()
            ? memory.projectLabel.trim()
            : typeof memory.projectId === "string" && memory.projectId.trim()
              ? memory.projectId.trim()
              : "Unknown",
        operatorGoal: typeof memory.operatorGoal === "string" && memory.operatorGoal.trim() ? memory.operatorGoal.trim() : null,
        requestedTask: typeof memory.requestedTask === "string" && memory.requestedTask.trim() ? memory.requestedTask.trim() : null,
        currentPlan: normalizeStringList(memory.currentPlan),
        latestCheckpoint:
          typeof memory.latestCheckpoint === "string" && memory.latestCheckpoint.trim() ? memory.latestCheckpoint.trim() : null,
        nextAction: typeof memory.nextAction === "string" && memory.nextAction.trim() ? memory.nextAction.trim() : null,
        blockers: normalizeStringList(memory.blockers),
        assumptions: normalizeStringList(memory.assumptions),
        proofRequirements: normalizeStringList(memory.proofRequirements),
        notes: normalizeStringList(memory.notes, 40),
        decisions: (Array.isArray(memory.decisions) ? memory.decisions : [])
          .filter(
            (entry): entry is JobMemoryDecisionView =>
              Boolean(entry) && typeof entry === "object" && typeof entry.id === "string" && typeof entry.summary === "string"
          )
          .map((entry) => ({
            id: entry.id,
            summary: entry.summary.trim(),
            details: typeof entry.details === "string" && entry.details.trim() ? entry.details.trim() : null,
            at: typeof entry.at === "number" ? entry.at : Date.now()
          }))
          .slice(-20),
        entries: (Array.isArray(memory.entries) ? memory.entries : [])
          .filter(
            (entry): entry is JobMemoryEntryView =>
              Boolean(entry) && typeof entry === "object" && typeof entry.id === "string" && typeof entry.summary === "string"
          )
          .map((entry) => ({
            id: entry.id,
            kind: normalizeJobMemoryEntryKind(entry.kind),
            summary: entry.summary.trim(),
            details: typeof entry.details === "string" && entry.details.trim() ? entry.details.trim() : null,
            nextAction: typeof entry.nextAction === "string" && entry.nextAction.trim() ? entry.nextAction.trim() : null,
            blockers: normalizeStringList(entry.blockers),
            plan: normalizeStringList(entry.plan),
            assumptions: normalizeStringList(entry.assumptions),
            proofRequirements: normalizeStringList(entry.proofRequirements),
            promote: Boolean(entry.promote),
            promotionCandidateId:
              typeof entry.promotionCandidateId === "string" && entry.promotionCandidateId.trim() ? entry.promotionCandidateId.trim() : null,
            at: typeof entry.at === "number" ? entry.at : Date.now()
          }))
          .slice(-40),
        promotionCandidates: (Array.isArray(memory.promotionCandidates) ? memory.promotionCandidates : [])
          .filter(
            (entry): entry is JobMemoryPromotionCandidateView =>
              Boolean(entry) &&
              typeof entry === "object" &&
              typeof entry.id === "string" &&
              typeof entry.sourceEntryId === "string" &&
              typeof entry.summary === "string"
          )
          .map((entry): JobMemoryPromotionCandidateView => {
            const status: JobMemoryPromotionCandidateView["status"] =
              entry.status === "accepted" ? "accepted" : entry.status === "rejected" ? "rejected" : "pending";

            return {
              id: entry.id,
              threadId,
              projectId:
                typeof entry.projectId === "string" && entry.projectId.trim()
                  ? entry.projectId.trim()
                  : typeof memory.projectId === "string" && memory.projectId.trim()
                    ? memory.projectId.trim()
                    : "unknown",
              projectLabel:
                typeof entry.projectLabel === "string" && entry.projectLabel.trim()
                  ? entry.projectLabel.trim()
                  : typeof memory.projectLabel === "string" && memory.projectLabel.trim()
                    ? memory.projectLabel.trim()
                    : "Unknown",
              kind: normalizeJobMemoryEntryKind(entry.kind),
              sourceEntryId: entry.sourceEntryId.trim(),
              summary: entry.summary.trim(),
              details: typeof entry.details === "string" && entry.details.trim() ? entry.details.trim() : null,
              status,
              createdAt: typeof entry.createdAt === "number" ? entry.createdAt : Date.now(),
              updatedAt: typeof entry.updatedAt === "number" ? entry.updatedAt : Date.now(),
              resolvedAt: typeof entry.resolvedAt === "number" ? entry.resolvedAt : null
            };
          })
          .slice(-20),
        updatedAt: typeof memory.updatedAt === "number" ? memory.updatedAt : Date.now()
      });
    }
    for (const [projectId, memory] of Object.entries(data.projectMemoriesByProjectId ?? {})) {
      if (!memory || typeof memory !== "object" || typeof memory.projectId !== "string") {
        continue;
      }
      access.persistedProjectMemoriesByProjectId.set(projectId, {
        projectId,
        projectLabel:
          typeof memory.projectLabel === "string" && memory.projectLabel.trim()
            ? memory.projectLabel.trim()
            : typeof memory.projectId === "string" && memory.projectId.trim()
              ? memory.projectId.trim()
              : "Unknown",
        summary: typeof memory.summary === "string" && memory.summary.trim() ? memory.summary.trim() : null,
        entries: (Array.isArray(memory.entries) ? memory.entries : [])
          .filter(
            (entry): entry is ProjectMemoryEntryView =>
              Boolean(entry) && typeof entry === "object" && typeof entry.id === "string" && typeof entry.summary === "string"
          )
          .map((entry) => ({
            id: entry.id,
            sourceThreadId: typeof entry.sourceThreadId === "string" && entry.sourceThreadId.trim() ? entry.sourceThreadId.trim() : "",
            kind: normalizeJobMemoryEntryKind(entry.kind),
            summary: entry.summary.trim(),
            details: typeof entry.details === "string" && entry.details.trim() ? entry.details.trim() : null,
            acceptedAt: typeof entry.acceptedAt === "number" ? entry.acceptedAt : Date.now()
          }))
          .slice(-60),
        updatedAt: typeof memory.updatedAt === "number" ? memory.updatedAt : Date.now()
      });
    }
    access.persistedButlerMemoryEntries.splice(
      0,
      access.persistedButlerMemoryEntries.length,
      ...(Array.isArray(data.butlerMemoryEntries) ? data.butlerMemoryEntries : [])
        .filter((entry): entry is ButlerMemoryEntryView => Boolean(entry) && typeof entry === "object" && typeof entry.summary === "string")
        .map((entry): ButlerMemoryEntryView => {
          const source: ButlerMemoryEntryView["source"] = entry.source === "manual_chat_save" ? "manual_chat_save" : "butler_tool";
          return {
            id: typeof entry.id === "string" && entry.id.trim() ? entry.id.trim() : crypto.randomUUID(),
            summary: entry.summary.trim(),
            details: typeof entry.details === "string" && entry.details.trim() ? entry.details.trim() : null,
            source,
            sourceMessageId: typeof entry.sourceMessageId === "string" && entry.sourceMessageId.trim() ? entry.sourceMessageId.trim() : null,
            tags: normalizeStringList(entry.tags, 12),
            createdAt: typeof entry.createdAt === "number" ? entry.createdAt : Date.now()
          };
        })
        .slice(-100)
    );
    for (const [projectId, artifacts] of Object.entries(data.projectArtifactsByProjectId ?? {})) {
      const entries = (Array.isArray(artifacts) ? artifacts : [])
        .filter(
          (entry): entry is ProjectArtifactView =>
            Boolean(entry) &&
            typeof entry === "object" &&
            typeof entry.id === "string" &&
            typeof entry.title === "string" &&
            typeof entry.fileName === "string" &&
            typeof entry.filePath === "string"
        )
        .map((entry) => ({
          id: entry.id.trim(),
          projectId,
          projectLabel:
            typeof entry.projectLabel === "string" && entry.projectLabel.trim() ? entry.projectLabel.trim() : projectId || "Unknown",
          kind: (
            entry.kind === "seed" ||
            entry.kind === "reference" ||
            entry.kind === "download" ||
            entry.kind === "research" ||
            entry.kind === "report"
              ? entry.kind
              : "other"
          ) as ProjectArtifactView["kind"],
          title: entry.title.trim(),
          description: typeof entry.description === "string" && entry.description.trim() ? entry.description.trim() : null,
          fileName: entry.fileName.trim(),
          filePath: entry.filePath.trim(),
          contentType: typeof entry.contentType === "string" && entry.contentType.trim() ? entry.contentType.trim() : "application/octet-stream",
          sizeBytes:
            typeof entry.sizeBytes === "number" && Number.isFinite(entry.sizeBytes) && entry.sizeBytes >= 0
              ? Math.trunc(entry.sizeBytes)
              : 0,
          tags: normalizeStringList(entry.tags),
          metadata:
            entry.metadata && typeof entry.metadata === "object"
              ? Object.fromEntries(
                  Object.entries(entry.metadata as Record<string, unknown>)
                    .filter((item): item is [string, string] => typeof item[0] === "string" && typeof item[1] === "string")
                    .map(([key, value]) => [key.trim(), value.trim()])
                    .filter(([key]) => key.length > 0)
                )
              : {},
          source: {
            kind: (
              entry.source?.kind === "inline" || entry.source?.kind === "url" ? entry.source.kind : "generated"
            ) as ProjectArtifactView["source"]["kind"],
            url: typeof entry.source?.url === "string" && entry.source.url.trim() ? entry.source.url.trim() : null,
            createdByThreadId:
              typeof entry.source?.createdByThreadId === "string" && entry.source.createdByThreadId.trim()
                ? entry.source.createdByThreadId.trim()
                : null,
            checksumSha256:
              typeof entry.source?.checksumSha256 === "string" && entry.source.checksumSha256.trim()
                ? entry.source.checksumSha256.trim()
                : null
          },
          textPreview: typeof entry.textPreview === "string" && entry.textPreview.trim() ? entry.textPreview : null,
          createdAt: typeof entry.createdAt === "number" ? entry.createdAt : Date.now(),
          updatedAt: typeof entry.updatedAt === "number" ? entry.updatedAt : Date.now()
        }))
        .sort((left, right) => right.updatedAt - left.updatedAt);
      if (entries.length > 0) {
        access.persistedProjectArtifactsByProjectId.set(projectId, entries);
      }
    }
    for (const [projectId, policies] of Object.entries(data.projectPoliciesByProjectId ?? {})) {
      const entries = (Array.isArray(policies) ? policies : [])
        .filter(
          (entry): entry is ProjectPolicyView =>
            Boolean(entry) &&
            typeof entry === "object" &&
            typeof entry.id === "string" &&
            typeof entry.title === "string" &&
            typeof entry.instruction === "string" &&
            Array.isArray(entry.artifacts) &&
            Array.isArray(entry.triggers)
        )
        .map((entry) => ({
          id: entry.id.trim(),
          projectId,
          projectLabel:
            typeof entry.projectLabel === "string" && entry.projectLabel.trim() ? entry.projectLabel.trim() : projectId || "Unknown",
          title: entry.title.trim(),
          instruction: entry.instruction.trim(),
          artifacts: normalizeStringList(entry.artifacts),
          triggers: normalizeStringList(entry.triggers),
          createdAt: typeof entry.createdAt === "number" ? entry.createdAt : Date.now(),
          updatedAt: typeof entry.updatedAt === "number" ? entry.updatedAt : Date.now()
        }))
        .sort((left, right) => right.updatedAt - left.updatedAt);
      if (entries.length > 0) {
        access.persistedProjectPoliciesByProjectId.set(projectId, entries);
      }
    }
    for (const thread of Array.isArray(data.threads) ? data.threads : []) {
      if (thread && typeof thread === "object" && typeof thread.id === "string") {
        restorePersistedStateStoreThread(access, thread as CodexThreadDetailView);
      }
    }
    const synthesizedThreadIds = new Set<string>([
      ...access.windows.map((window) => window.threadId),
      ...access.persistedSupervisionByThreadId.keys(),
      ...access.persistedWorkerReportsByThreadId.keys(),
      ...access.persistedExecutionContractsByThreadId.keys(),
      ...access.persistedJobMemoriesByThreadId.keys()
    ]);
    for (const threadId of synthesizedThreadIds) {
      const record = access.getOrCreateThread(threadId);
      if (!record.executionContract) {
        const persistedContract = access.persistedExecutionContractsByThreadId.get(threadId);
        if (persistedContract) {
          record.executionContract = { ...persistedContract };
        }
      }
      if (!record.workerReport) {
        const latestReport = access.persistedWorkerReportsByThreadId.get(threadId)?.at(-1) ?? null;
        if (latestReport) {
          record.workerReport = { ...latestReport };
        }
      }
      if (!record.jobMemory) {
        const persistedMemory = access.persistedJobMemoriesByThreadId.get(threadId);
        if (persistedMemory) {
          record.jobMemory = { ...persistedMemory };
        }
      }
      access.refreshDerivedThreadState(record);
    }
    for (const lease of access.previewLeases.values()) {
      if (lease.lastVerification) {
        recordStateStorePreviewProofFromLease(access, lease, { emitChange: false });
      }
    }
  } catch {
    access.threads.clear();
    access.windows = [];
    access.focusedWindowId = null;
    access.stackLeases.clear();
    access.previewLeases.clear();
    access.previewProofs.clear();
    access.serviceLeases.clear();
    access.runtimeCleanupTasks.clear();
    access.persistedSupervisionByThreadId.clear();
    access.persistedWorkerReportsByThreadId.clear();
    access.persistedExecutionContractsByThreadId.clear();
    access.persistedSupervisionChecklistsByThreadId.clear();
    access.persistedJobMemoriesByThreadId.clear();
    access.persistedProjectMemoriesByProjectId.clear();
    access.persistedButlerMemoryEntries.splice(0, access.persistedButlerMemoryEntries.length);
    access.persistedProjectArtifactsByProjectId.clear();
    access.persistedProjectPoliciesByProjectId.clear();
    access.threadInventoryReady = false;
  }
}

export function queueStateStoreSave(access: StateStoreInternalAccess): void {
  if (access.saveTimer) {
    clearTimeout(access.saveTimer);
  }

  access.saveTimer = setTimeout(async () => {
    access.saveTimer = null;
    access.windows = access.windows.map((window) => normalizeWindow(window, access.threads.get(window.threadId)));
    const payload: PersistedUiState = {
      threads: access.listThreads().map((thread) => access.toThreadDetailView(access.threads.get(thread.id) ?? access.getOrCreateThread(thread.id))),
      windows: access.windows,
      focusedWindowId: access.focusedWindowId,
      stackLeases: [...access.stackLeases.values()].sort((left, right) => right.updatedAt - left.updatedAt),
      previewLeases: [...access.previewLeases.values()].sort((left, right) => right.updatedAt - left.updatedAt),
      previewProofs: [...access.previewProofs.values()].sort((left, right) => right.verification.checkedAt - left.verification.checkedAt),
      serviceLeases: [...access.serviceLeases.values()].sort((left, right) => right.updatedAt - left.updatedAt),
      runtimeCleanupTasks: [...access.runtimeCleanupTasks.values()].sort((left, right) => left.nextAttemptAt - right.nextAttemptAt),
      workerReportsByThreadId: Object.fromEntries(
        [...access.persistedWorkerReportsByThreadId.entries()].map(([threadId, reports]) => [threadId, reports])
      ),
      supervisionByThreadId: Object.fromEntries(
        [...access.persistedSupervisionByThreadId.entries()].map(([threadId, policy]) => [
          threadId,
          {
            butlerTurnsUsed: policy.butlerTurnsUsed,
            maxButlerTurns: policy.maxButlerTurns
          }
        ])
      ),
      executionContractsByThreadId: Object.fromEntries(
        [...access.persistedExecutionContractsByThreadId.entries()].map(([threadId, contract]) => [threadId, contract])
      ),
      supervisionChecklistsByThreadId: Object.fromEntries(
        [...access.persistedSupervisionChecklistsByThreadId.entries()].map(([threadId, checklist]) => [threadId, checklist])
      ),
      jobMemoriesByThreadId: Object.fromEntries(
        [...access.persistedJobMemoriesByThreadId.entries()].map(([threadId, memory]) => [threadId, memory])
      ),
      projectMemoriesByProjectId: Object.fromEntries(
        [...access.persistedProjectMemoriesByProjectId.entries()].map(([projectId, memory]) => [projectId, memory])
      ),
      butlerMemoryEntries: access.persistedButlerMemoryEntries,
      projectArtifactsByProjectId: Object.fromEntries(
        [...access.persistedProjectArtifactsByProjectId.entries()].map(([projectId, artifacts]) => [projectId, artifacts])
      ),
      projectPoliciesByProjectId: Object.fromEntries(
        [...access.persistedProjectPoliciesByProjectId.entries()].map(([projectId, policies]) => [projectId, policies])
      )
    };
    await fs.mkdir(path.dirname(access.uiStatePath), { recursive: true });
    await fs.writeFile(access.uiStatePath, JSON.stringify(payload, null, 2));
  }, 150);
}

export function emitStateStoreChange(access: StateStoreInternalAccess): void {
  access.emit("change");
}

export function restorePersistedStateStoreThread(access: StateStoreInternalAccess, thread: CodexThreadDetailView): void {
  const threadId = typeof thread.id === "string" ? thread.id : null;
  if (!threadId) {
    return;
  }

  const record = access.getOrCreateThread(threadId);
  record.name = typeof thread.name === "string" && thread.name.trim() ? thread.name.trim() : null;
  record.preview = typeof thread.preview === "string" ? thread.preview : record.preview;
  record.source = typeof thread.source === "string" ? thread.source : record.source;
  record.cwd = typeof thread.cwd === "string" ? thread.cwd : record.cwd;
  record.createdAt = typeof thread.createdAt === "number" && Number.isFinite(thread.createdAt) ? thread.createdAt : record.createdAt;
  record.updatedAt = typeof thread.updatedAt === "number" && Number.isFinite(thread.updatedAt) ? thread.updatedAt : record.updatedAt;
  record.status = normalizeStatus(thread.status);
  record.modelProvider = typeof thread.modelProvider === "string" ? thread.modelProvider : record.modelProvider;
  record.turnCount = typeof thread.turnCount === "number" && Number.isFinite(thread.turnCount) ? thread.turnCount : record.turnCount;
  record.loaded = Boolean(thread.loaded);
  record.contextUsage =
    thread.contextUsage && typeof thread.contextUsage === "object"
      ? {
          tokens: typeof thread.contextUsage.tokens === "number" ? thread.contextUsage.tokens : null,
          contextWindow: typeof thread.contextUsage.contextWindow === "number" ? thread.contextUsage.contextWindow : null,
          percent: typeof thread.contextUsage.percent === "number" ? thread.contextUsage.percent : null
        }
      : record.contextUsage;
  record.compaction =
    thread.compaction && typeof thread.compaction === "object"
      ? {
          active: Boolean(thread.compaction.active),
          count: typeof thread.compaction.count === "number" ? thread.compaction.count : 0,
          lastStartedAt: typeof thread.compaction.lastStartedAt === "number" ? thread.compaction.lastStartedAt : null,
          lastCompletedAt: typeof thread.compaction.lastCompletedAt === "number" ? thread.compaction.lastCompletedAt : null
        }
      : record.compaction;
  record.supervision =
    thread.supervision && typeof thread.supervision === "object"
      ? {
          butlerTurnsUsed: typeof thread.supervision.butlerTurnsUsed === "number" ? thread.supervision.butlerTurnsUsed : 0,
          maxButlerTurns: typeof thread.supervision.maxButlerTurns === "number" ? thread.supervision.maxButlerTurns : null,
          capReached: Boolean(thread.supervision.capReached)
        }
      : record.supervision;
  record.executionContract = thread.executionContract ? { ...thread.executionContract } : record.executionContract;
  record.supervisionChecklist = thread.supervisionChecklist
    ? normalizeSupervisionChecklist(thread.supervisionChecklist)
    : record.supervisionChecklist;
  record.jobMemory = thread.jobMemory ? { ...thread.jobMemory } : record.jobMemory;
  record.turns = Array.isArray(thread.turns) ? thread.turns.map((turn) => restorePersistedTurn(turn)) : record.turns;
  record.turnCount = Math.max(record.turnCount, record.turns.length);
  record.eventLog = Array.isArray(thread.eventLog)
    ? thread.eventLog
        .filter(
          (entry): entry is CodexEventEntry =>
            Boolean(entry) &&
            typeof entry === "object" &&
            typeof entry.at === "number" &&
            typeof entry.method === "string" &&
            typeof entry.summary === "string"
        )
        .slice(0, MAX_EVENT_LOG)
    : record.eventLog;
  record.workerReport =
    thread.workerReport &&
    typeof thread.workerReport === "object" &&
    typeof thread.workerReport.threadId === "string" &&
    typeof thread.workerReport.turnId === "string" &&
    (thread.workerReport.status === "completed" || thread.workerReport.status === "blocked") &&
    typeof thread.workerReport.summary === "string"
      ? {
          threadId: thread.workerReport.threadId,
          turnId: thread.workerReport.turnId,
          status: thread.workerReport.status,
          summary: thread.workerReport.summary,
          details: typeof thread.workerReport.details === "string" ? thread.workerReport.details : null,
          createdAt: typeof thread.workerReport.createdAt === "number" ? thread.workerReport.createdAt : record.updatedAt,
          updatedAt: typeof thread.workerReport.updatedAt === "number" ? thread.workerReport.updatedAt : record.updatedAt
        }
      : record.workerReport;
  access.refreshDerivedThreadState(record);
  access.primeThreadMilestones(threadId);
}

export function getOrCreateStateStoreThread(access: StateStoreInternalAccess, id: string): CodexThreadRecord {
  const existing = access.threads.get(id);
  if (existing) {
    return existing;
  }

  const created: CodexThreadRecord = {
    id,
    name: null,
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
    supervisionChecklist: null,
    jobMemory: buildEmptyJobMemory({
      threadId: id,
      projectId: "unknown",
      projectLabel: "Unknown",
      contract: null
    }),
    turns: [],
    eventLog: [],
    milestones: [],
    workerReport: null
  };
  const persisted = access.persistedSupervisionByThreadId.get(id);
  if (persisted) {
    created.supervision.butlerTurnsUsed = persisted.butlerTurnsUsed;
    created.supervision.maxButlerTurns = persisted.maxButlerTurns;
    created.supervision.capReached = persisted.maxButlerTurns !== null && persisted.butlerTurnsUsed >= persisted.maxButlerTurns;
  }
  const persistedReports = access.persistedWorkerReportsByThreadId.get(id);
  const persistedReport = persistedReports?.at(-1) ?? null;
  if (persistedReport) {
    created.workerReport = { ...persistedReport };
  }
  const persistedContract = access.persistedExecutionContractsByThreadId.get(id);
  if (persistedContract) {
    created.executionContract = { ...persistedContract };
  }
  const persistedChecklist = access.persistedSupervisionChecklistsByThreadId.get(id);
  if (persistedChecklist) {
    created.supervisionChecklist = { ...persistedChecklist };
  } else if (created.executionContract) {
    const now = Date.now();
    created.supervisionChecklist = {
      threadId: id,
      projectId: created.executionContract.projectId,
      projectLabel: created.executionContract.projectLabel,
      requestedTask: created.executionContract.requestedTask,
      items: created.executionContract.acceptancePoints.map((point, index) => ({
        id: `point-${index + 1}`,
        text: point,
        status: "pending",
        butlerNote: null,
        queuedInstruction: null,
        decidedAt: null,
        evidence: []
      })),
      heartbeat: {
        lastThreadEventAt: null,
        lastWorkerReportAt: null,
        lastKnownThreadStatus: created.status,
        stale: false
      },
      reviewState: "needs_review",
      createdAt: now,
      updatedAt: now
    };
  }
  const persistedJobMemory = access.persistedJobMemoriesByThreadId.get(id);
  if (persistedJobMemory) {
    created.jobMemory = { ...persistedJobMemory };
  } else {
    created.jobMemory = buildEmptyJobMemory({
      threadId: id,
      projectId: created.supervisor.projectId,
      projectLabel: created.supervisor.projectLabel,
      contract: created.executionContract
    });
  }
  access.threads.set(id, created);
  return created;
}

export function persistStateStoreThreadSupervision(access: StateStoreInternalAccess, thread: CodexThreadRecord): void {
  access.persistedSupervisionByThreadId.set(thread.id, {
    butlerTurnsUsed: thread.supervision.butlerTurnsUsed,
    maxButlerTurns: thread.supervision.maxButlerTurns
  });
}

export function removeStateStorePreviewProofsForThread(access: StateStoreInternalAccess, threadId: string): void {
  for (const [proofId, proof] of access.previewProofs.entries()) {
    if (proof.threadId === threadId) {
      access.previewProofs.delete(proofId);
    }
  }
}
