import { EventEmitter } from "node:events";
import { promises as fs } from "node:fs";
import path from "node:path";

import {
  buildPreviewProofRecordId,
  buildProjectSummary,
  buildSupervisorSummary,
  buildThreadSupervisor,
  clipText,
  DEFAULT_ARTIFACT_RETENTION_MS,
  DEFAULT_BUTLER_THREAD_LIMIT,
  DEFAULT_LEASE_REAP_GRACE_MS,
  DEFAULT_PREVIEW_LEASE_TTL_MS,
  DEFAULT_SERVICE_LEASE_TTL_MS,
  DEFAULT_STACK_LEASE_TTL_MS,
  deriveThreadTaskTitle,
  emptyCodexCompaction,
  emptyCodexContextUsage,
  emptyCodexSupervision,
  emptyThreadSupervisor,
  formatFallbackJobLabel,
  formatWindowTitle,
  inferPersistedThreadExecutionContract,
  LEASE_ACTIVITY_WRITE_THROTTLE_MS,
  MAX_EVENT_LOG,
  normalizeItem,
  normalizePreviewVerification,
  normalizeStatus,
  normalizeTurn,
  normalizeWindow,
  restorePersistedTurn,
  shouldExposeCodexItem
} from "./state-store-helpers.js";
import {
  emitStateStoreChange,
  getOrCreateStateStoreThread,
  loadStateStore,
  normalizeStateStorePreviewLease,
  normalizeStateStorePreviewProofRecord,
  normalizeStateStoreServiceLease,
  normalizeStateStoreStackLease,
  queueStateStoreSave,
  reconcileStateStoreThreadWindows,
  recordStateStorePreviewProofFromLease,
  removeStateStorePreviewProofsForThread,
  refreshStateStoreStackMembership,
  restorePersistedStateStoreThread,
  persistStateStoreThreadSupervision,
  updateStateStoreArtifactAvailability,
  upsertStateStorePreviewProofRecord,
  applyStateStoreLeaseLifecycle,
  type StateStoreInternalAccess
} from "./state-store-internals.js";
import { parseThreadExecutionContract } from "./thread-contract.js";
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

  private getInternalAccess(): StateStoreInternalAccess {
    return this as unknown as StateStoreInternalAccess;
  }

  private reconcileThreadWindows(): boolean {
    return reconcileStateStoreThreadWindows(this.getInternalAccess());
  }

  private refreshStackMembership(stackId: string, now = Date.now()): void {
    refreshStateStoreStackMembership(this.getInternalAccess(), stackId, now);
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
    return applyStateStoreLeaseLifecycle(this.getInternalAccess(), lease, defaults);
  }

  private normalizePreviewLease(lease: PreviewLeaseView, now = Date.now()): PreviewLeaseView {
    return normalizeStateStorePreviewLease(this.getInternalAccess(), lease, now);
  }

  private normalizeStackLease(lease: StackLeaseView, now = Date.now()): StackLeaseView {
    return normalizeStateStoreStackLease(this.getInternalAccess(), lease, now);
  }

  private normalizeServiceLease(lease: ServiceLeaseView, now = Date.now()): ServiceLeaseView {
    return normalizeStateStoreServiceLease(this.getInternalAccess(), lease, now);
  }

  private normalizePreviewProofRecord(record: PreviewProofRecordView): PreviewProofRecordView {
    return normalizeStateStorePreviewProofRecord(this.getInternalAccess(), record);
  }

  private upsertPreviewProofRecord(record: PreviewProofRecordView, options?: { emitChange?: boolean }): PreviewProofRecordView {
    return upsertStateStorePreviewProofRecord(this.getInternalAccess(), record, options);
  }

  private recordPreviewProofFromLease(
    lease: Pick<PreviewLeaseView, "id" | "threadId" | "projectId" | "projectLabel" | "title" | "stackId" | "lastVerification">,
    options?: { emitChange?: boolean }
  ): PreviewProofRecordView | null {
    return recordStateStorePreviewProofFromLease(this.getInternalAccess(), lease, options);
  }

  private updateArtifactAvailability(
    filePath: string,
    mutate: (artifact: PreviewVerificationArtifactView) => PreviewVerificationArtifactView
  ): boolean {
    return updateStateStoreArtifactAvailability(this.getInternalAccess(), filePath, mutate);
  }

  async load(): Promise<void> {
    await loadStateStore(this.getInternalAccess());
  }

  private queueSave(): void {
    queueStateStoreSave(this.getInternalAccess());
  }

  private emitChange(): void {
    emitStateStoreChange(this.getInternalAccess());
  }

  private restorePersistedThread(thread: CodexThreadDetailView): void {
    restorePersistedStateStoreThread(this.getInternalAccess(), thread);
  }

  markThreadInventoryReady(): void {
    this.threadInventoryReady = true;
    if (this.reconcileThreadWindows()) {
      this.queueSave();
      this.emitChange();
    }
  }

  private getOrCreateThread(id: string): CodexThreadRecord {
    return getOrCreateStateStoreThread(this.getInternalAccess(), id);
  }

  private persistThreadSupervision(thread: CodexThreadRecord): void {
    persistStateStoreThreadSupervision(this.getInternalAccess(), thread);
  }

  private removePreviewProofsForThread(threadId: string): void {
    removeStateStorePreviewProofsForThread(this.getInternalAccess(), threadId);
  }

  upsertThreadSummary(thread: Record<string, unknown>): void {
    const id = typeof thread.id === "string" ? thread.id : undefined;
    if (!id) {
      return;
    }

    const record = this.getOrCreateThread(id);
    if (Object.prototype.hasOwnProperty.call(thread, "name")) {
      record.name = typeof thread.name === "string" && thread.name.trim() ? thread.name.trim() : null;
    }
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
    const thread = this.getOrCreateThread(threadId);
    if (!this.windows.find((window) => window.threadId === threadId)) {
      this.windows.unshift({
        threadId,
        title: formatWindowTitle(threadId, thread),
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
        name: thread.name,
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
      name: thread.name,
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
    this.windows = this.windows.map((window) => normalizeWindow(window, this.threads.get(window.threadId)));

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
    this.windows = this.windows.map((window) => normalizeWindow(window, this.threads.get(window.threadId)));
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
