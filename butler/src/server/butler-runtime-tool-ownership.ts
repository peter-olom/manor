import type { ButlerAgentToolAccess } from "./butler-agent-tool-access.js";

type RuntimeOwnedResource = {
  threadId?: string | null;
};

function normalizeThreadId(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function getRuntimeOwnerThreadIds(access: ButlerAgentToolAccess): string[] {
  const runtimeThreadId = normalizeThreadId(access.runtimeThreadId) ?? "butler";
  const workerDefaults = access.getWorkerDefaults?.();
  const attachedWorkerThreadId = normalizeThreadId(workerDefaults?.threadId);
  const pairWorkerThreadIds = (workerDefaults?.runtimeOwnerThreadIds ?? [])
    .map(normalizeThreadId)
    .filter((entry): entry is string => Boolean(entry));
  return [...new Set([runtimeThreadId, attachedWorkerThreadId, ...pairWorkerThreadIds].filter((entry): entry is string => Boolean(entry)))];
}

export function getRuntimeStartThreadId(
  access: ButlerAgentToolAccess,
  requestedThreadId: unknown,
  action: string
): string {
  const ownerThreadIds = getRuntimeOwnerThreadIds(access);
  const attachedWorkerThreadId = normalizeThreadId(access.getWorkerDefaults?.()?.threadId);
  const effectiveThreadId = attachedWorkerThreadId ?? ownerThreadIds[0]!;
  const requested = normalizeThreadId(requestedThreadId);
  if (requested && requested !== effectiveThreadId) {
    throw new Error(
      `${action} cannot bind to job ${requested}. This Butler session can only create runtime resources for ${effectiveThreadId}.`
    );
  }
  return effectiveThreadId;
}

export function isRuntimeResourceOwned(
  access: ButlerAgentToolAccess,
  resource: RuntimeOwnedResource | null | undefined
): boolean {
  const threadId = normalizeThreadId(resource?.threadId);
  return Boolean(threadId && getRuntimeOwnerThreadIds(access).includes(threadId));
}

export function assertRuntimeResourceOwned(
  access: ButlerAgentToolAccess,
  resource: RuntimeOwnedResource | null | undefined,
  resourceLabel: string
): void {
  const threadId = normalizeThreadId(resource?.threadId);
  if (!threadId) {
    throw new Error(`${resourceLabel} is unowned and cannot be changed from a Butler session.`);
  }
  if (!getRuntimeOwnerThreadIds(access).includes(threadId)) {
    throw new Error(`${resourceLabel} belongs to another Butler session and cannot be changed here.`);
  }
}

export function assertRuntimeAttachedThreadsOwned(
  access: ButlerAgentToolAccess,
  attachedThreadIds: unknown,
  action: string
): void {
  if (!Array.isArray(attachedThreadIds)) return;
  const allowed = new Set(getRuntimeOwnerThreadIds(access));
  const foreign = attachedThreadIds
    .map(normalizeThreadId)
    .filter((entry): entry is string => entry !== null)
    .filter((entry) => !allowed.has(entry));
  if (foreign.length > 0) {
    throw new Error(`${action} cannot attach jobs from another Butler session.`);
  }
}
