import { LEASE_ACTIVITY_WRITE_THROTTLE_MS } from "./state-store-helpers.js";
import {
  emitStateStoreChange,
  normalizeStateStorePreviewLease,
  normalizeStateStoreServiceLease,
  normalizeStateStoreStackLease,
  queueStateStoreSave,
  type StateStoreInternalAccess
} from "./state-store-internals.js";
import type { PreviewLeaseView, RuntimeCleanupTaskView, ServiceLeaseView, StackLeaseView } from "./types.js";

function refreshStackChildLeaseLifecycles(access: StateStoreInternalAccess, stackId: string, now: number): void {
  for (const [leaseId, lease] of access.previewLeases.entries()) {
    if (lease.stackId === stackId && lease.status !== "stopped") {
      access.previewLeases.set(leaseId, normalizeStateStorePreviewLease(access, lease, now));
    }
  }

  for (const [leaseId, lease] of access.serviceLeases.entries()) {
    if (lease.stackId === stackId && lease.status !== "stopped") {
      access.serviceLeases.set(leaseId, normalizeStateStoreServiceLease(access, lease, now));
    }
  }
}

export function noteStateStoreThreadLeaseActivity(access: StateStoreInternalAccess, threadId: string, at = Date.now()): void {
  let changed = false;

  for (const lease of access.stackLeases.values()) {
    if (lease.threadId !== threadId || lease.status === "stopped") {
      continue;
    }
    if (typeof lease.lastActivityAt === "number" && at - lease.lastActivityAt < LEASE_ACTIVITY_WRITE_THROTTLE_MS) {
      continue;
    }
    access.stackLeases.set(
      lease.id,
      normalizeStateStoreStackLease(access, { ...lease, lastActivityAt: at, ttlAnchorAt: at, updatedAt: Math.max(lease.updatedAt, at) }, at)
    );
    changed = true;
  }

  for (const lease of access.previewLeases.values()) {
    if (lease.threadId !== threadId || lease.status === "stopped") {
      continue;
    }
    if (typeof lease.lastActivityAt === "number" && at - lease.lastActivityAt < LEASE_ACTIVITY_WRITE_THROTTLE_MS) {
      continue;
    }
    access.previewLeases.set(
      lease.id,
      normalizeStateStorePreviewLease(access, { ...lease, lastActivityAt: at, ttlAnchorAt: at, updatedAt: Math.max(lease.updatedAt, at) }, at)
    );
    changed = true;
  }

  for (const lease of access.serviceLeases.values()) {
    if (lease.threadId !== threadId || lease.status === "stopped") {
      continue;
    }
    if (typeof lease.lastActivityAt === "number" && at - lease.lastActivityAt < LEASE_ACTIVITY_WRITE_THROTTLE_MS) {
      continue;
    }
    access.serviceLeases.set(
      lease.id,
      normalizeStateStoreServiceLease(access, { ...lease, lastActivityAt: at, ttlAnchorAt: at, updatedAt: Math.max(lease.updatedAt, at) }, at)
    );
    changed = true;
  }

  if (changed) {
    queueStateStoreSave(access);
  }
}

export function noteStateStoreStackLeaseActivity(access: StateStoreInternalAccess, leaseId: string, at = Date.now()): StackLeaseView | null {
  const lease = access.stackLeases.get(leaseId);
  if (!lease) {
    return null;
  }
  if (typeof lease.lastActivityAt === "number" && at - lease.lastActivityAt < LEASE_ACTIVITY_WRITE_THROTTLE_MS) {
    return normalizeStateStoreStackLease(access, lease, at);
  }

  const nextLease = normalizeStateStoreStackLease(
    access,
    {
      ...lease,
      lastActivityAt: at,
      updatedAt: Math.max(lease.updatedAt, at)
    },
    at
  );
  access.stackLeases.set(leaseId, nextLease);
  queueStateStoreSave(access);
  emitStateStoreChange(access);
  return nextLease;
}

export function noteStateStorePreviewLeaseActivity(access: StateStoreInternalAccess, leaseId: string, at = Date.now()): PreviewLeaseView | null {
  const lease = access.previewLeases.get(leaseId);
  if (!lease) {
    return null;
  }
  if (typeof lease.lastActivityAt === "number" && at - lease.lastActivityAt < LEASE_ACTIVITY_WRITE_THROTTLE_MS) {
    return normalizeStateStorePreviewLease(access, lease, at);
  }

  const nextLease = normalizeStateStorePreviewLease(
    access,
    {
      ...lease,
      lastActivityAt: at,
      updatedAt: Math.max(lease.updatedAt, at)
    },
    at
  );
  access.previewLeases.set(leaseId, nextLease);
  if (nextLease.stackId) {
    noteStateStoreStackLeaseActivity(access, nextLease.stackId, at);
  } else {
    queueStateStoreSave(access);
  }
  emitStateStoreChange(access);
  return nextLease;
}

export function noteStateStoreServiceLeaseActivity(access: StateStoreInternalAccess, leaseId: string, at = Date.now()): ServiceLeaseView | null {
  const lease = access.serviceLeases.get(leaseId);
  if (!lease) {
    return null;
  }
  if (typeof lease.lastActivityAt === "number" && at - lease.lastActivityAt < LEASE_ACTIVITY_WRITE_THROTTLE_MS) {
    return normalizeStateStoreServiceLease(access, lease, at);
  }

  const nextLease = normalizeStateStoreServiceLease(
    access,
    {
      ...lease,
      lastActivityAt: at,
      updatedAt: Math.max(lease.updatedAt, at)
    },
    at
  );
  access.serviceLeases.set(leaseId, nextLease);
  if (nextLease.stackId) {
    noteStateStoreStackLeaseActivity(access, nextLease.stackId, at);
  } else {
    queueStateStoreSave(access);
  }
  emitStateStoreChange(access);
  return nextLease;
}

export function setStateStoreStackLeasePinned(access: StateStoreInternalAccess, leaseId: string, pinned: boolean): StackLeaseView | null {
  const lease = access.stackLeases.get(leaseId);
  if (!lease) {
    return null;
  }

  const now = Date.now();
  const nextLease = normalizeStateStoreStackLease(access, { ...lease, pinned }, now);
  access.stackLeases.set(leaseId, nextLease);
  refreshStackChildLeaseLifecycles(access, leaseId, now);
  queueStateStoreSave(access);
  emitStateStoreChange(access);
  return nextLease;
}

export function setStateStorePreviewLeasePinned(access: StateStoreInternalAccess, leaseId: string, pinned: boolean): PreviewLeaseView | null {
  const lease = access.previewLeases.get(leaseId);
  if (!lease) {
    return null;
  }

  const nextLease = normalizeStateStorePreviewLease(access, { ...lease, pinned }, Date.now());
  access.previewLeases.set(leaseId, nextLease);
  queueStateStoreSave(access);
  emitStateStoreChange(access);
  return nextLease;
}

export function setStateStoreServiceLeasePinned(access: StateStoreInternalAccess, leaseId: string, pinned: boolean): ServiceLeaseView | null {
  const lease = access.serviceLeases.get(leaseId);
  if (!lease) {
    return null;
  }

  const nextLease = normalizeStateStoreServiceLease(access, { ...lease, pinned }, Date.now());
  access.serviceLeases.set(leaseId, nextLease);
  queueStateStoreSave(access);
  emitStateStoreChange(access);
  return nextLease;
}

export function listStateStoreExpiredLeaseIds(access: StateStoreInternalAccess, now = Date.now()): {
  stacks: string[];
  previews: string[];
  services: string[];
} {
  const stacks = [...access.stackLeases.values()]
    .map((lease) => normalizeStateStoreStackLease(access, lease, now))
    .filter((lease) => typeof lease.reapAfterAt === "number" && lease.reapAfterAt <= now)
    .map((lease) => lease.id);
  const previews = [...access.previewLeases.values()]
    .map((lease) => normalizeStateStorePreviewLease(access, lease, now))
    .filter((lease) => typeof lease.reapAfterAt === "number" && lease.reapAfterAt <= now)
    .map((lease) => lease.id);
  const services = [...access.serviceLeases.values()]
    .map((lease) => normalizeStateStoreServiceLease(access, lease, now))
    .filter((lease) => typeof lease.reapAfterAt === "number" && lease.reapAfterAt <= now)
    .map((lease) => lease.id);

  return { stacks, previews, services };
}

export function enqueueStateStoreRuntimeCleanupTask(
  access: StateStoreInternalAccess,
  input: {
    threadId: string;
    cwd: string | null;
    threadCreatedAt?: number | null;
    notifyOnError?: boolean;
    stacks: RuntimeCleanupTaskView["stacks"];
    previews: RuntimeCleanupTaskView["previews"];
    services: RuntimeCleanupTaskView["services"];
  }
): RuntimeCleanupTaskView {
  const now = Date.now();
  const task: RuntimeCleanupTaskView = {
    id: input.threadId,
    threadId: input.threadId,
    cwd: input.cwd,
    threadCreatedAt: typeof input.threadCreatedAt === "number" && Number.isFinite(input.threadCreatedAt) ? input.threadCreatedAt : null,
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
  access.runtimeCleanupTasks.set(task.id, task);
  queueStateStoreSave(access);
  emitStateStoreChange(access);
  return task;
}

export function listStateStoreDueRuntimeCleanupTasks(access: StateStoreInternalAccess, now = Date.now()): RuntimeCleanupTaskView[] {
  return [...access.runtimeCleanupTasks.values()]
    .filter((task) => task.nextAttemptAt <= now)
    .sort((left, right) => left.nextAttemptAt - right.nextAttemptAt);
}

export function completeStateStoreRuntimeCleanupTask(access: StateStoreInternalAccess, taskId: string): void {
  if (!access.runtimeCleanupTasks.delete(taskId)) {
    return;
  }
  queueStateStoreSave(access);
  emitStateStoreChange(access);
}

export function failStateStoreRuntimeCleanupTask(
  access: StateStoreInternalAccess,
  taskId: string,
  errorMessage: string,
  nextAttemptAt: number
): { task: RuntimeCleanupTaskView | null; notify: boolean } {
  const existing = access.runtimeCleanupTasks.get(taskId);
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
  access.runtimeCleanupTasks.set(taskId, nextTask);
  queueStateStoreSave(access);
  emitStateStoreChange(access);
  return { task: nextTask, notify };
}
