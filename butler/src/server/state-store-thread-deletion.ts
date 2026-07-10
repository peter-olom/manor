import {
  emitStateStoreChange,
  queueStateStoreSave,
  type StateStoreInternalAccess
} from "./state-store-internals.js";
import type {
  ButlerWindow,
  CodexThreadExecutionContractView,
  CodexThreadRecord,
  PreviewLeaseView,
  PreviewProofRecordView,
  ServiceLeaseView,
  StackLeaseView,
  SupervisionChecklistView
} from "./types.js";

type ThreadDeletionSnapshot = {
  thread: CodexThreadRecord;
  stackLeases: Array<[string, StackLeaseView]>;
  previewLeases: Array<[string, PreviewLeaseView]>;
  serviceLeases: Array<[string, ServiceLeaseView]>;
  previewProofs: Array<[string, PreviewProofRecordView]>;
  supervision: { butlerTurnsUsed: number; maxButlerTurns: number | null } | undefined;
  executionContract: CodexThreadExecutionContractView | undefined;
  supervisionChecklist: SupervisionChecklistView | undefined;
  latestStartedTurnId: string | undefined;
  latestCompletedTurnId: string | undefined;
  latestBlockedTurnId: string | undefined;
  threadWindows: Array<{ index: number; window: ButlerWindow }>;
  focusedWindowId: string | null;
};

function entriesForThread<Value extends { threadId: string | null }>(entries: Map<string, Value>, threadId: string): Array<[string, Value]> {
  return [...entries].filter(([, entry]) => entry.threadId === threadId);
}

function captureThreadDeletion(access: StateStoreInternalAccess, threadId: string): ThreadDeletionSnapshot | null {
  const thread = access.threads.get(threadId);
  if (!thread) return null;
  return {
    thread,
    stackLeases: entriesForThread(access.stackLeases, threadId),
    previewLeases: entriesForThread(access.previewLeases, threadId),
    serviceLeases: entriesForThread(access.serviceLeases, threadId),
    previewProofs: [...access.previewProofs].filter(([, proof]) => proof.threadId === threadId),
    supervision: access.persistedSupervisionByThreadId.get(threadId),
    executionContract: access.persistedExecutionContractsByThreadId.get(threadId),
    supervisionChecklist: access.persistedSupervisionChecklistsByThreadId.get(threadId),
    latestStartedTurnId: access.latestStartedTurnIds.get(threadId),
    latestCompletedTurnId: access.latestCompletedTurnIds.get(threadId),
    latestBlockedTurnId: access.latestBlockedTurnIds.get(threadId),
    threadWindows: access.windows.flatMap((window, index) => window.threadId === threadId ? [{ index, window }] : []),
    focusedWindowId: access.focusedWindowId
  };
}

function restoreEntry<Value>(entries: Map<string, Value>, key: string, value: Value | undefined): void {
  if (value !== undefined) entries.set(key, value);
}

function restoreThreadDeletion(access: StateStoreInternalAccess, threadId: string, snapshot: ThreadDeletionSnapshot, focusedAfterRemoval: string | null): void {
  access.threads.set(threadId, snapshot.thread);
  for (const [id, lease] of snapshot.stackLeases) access.stackLeases.set(id, lease);
  for (const [id, lease] of snapshot.previewLeases) access.previewLeases.set(id, lease);
  for (const [id, lease] of snapshot.serviceLeases) access.serviceLeases.set(id, lease);
  for (const [id, proof] of snapshot.previewProofs) access.previewProofs.set(id, proof);
  restoreEntry(access.persistedSupervisionByThreadId, threadId, snapshot.supervision);
  restoreEntry(access.persistedExecutionContractsByThreadId, threadId, snapshot.executionContract);
  restoreEntry(access.persistedSupervisionChecklistsByThreadId, threadId, snapshot.supervisionChecklist);
  restoreEntry(access.latestStartedTurnIds, threadId, snapshot.latestStartedTurnId);
  restoreEntry(access.latestCompletedTurnIds, threadId, snapshot.latestCompletedTurnId);
  restoreEntry(access.latestBlockedTurnIds, threadId, snapshot.latestBlockedTurnId);
  const windows = [...access.windows];
  for (const entry of snapshot.threadWindows) {
    if (!windows.some((window) => window.threadId === threadId)) windows.splice(Math.min(entry.index, windows.length), 0, entry.window);
  }
  access.windows = windows;
  if (snapshot.focusedWindowId === threadId && access.focusedWindowId === focusedAfterRemoval) access.focusedWindowId = threadId;
  queueStateStoreSave(access);
  emitStateStoreChange(access);
}

export async function removeStateStoreThreadDurably(
  access: StateStoreInternalAccess,
  threadId: string,
  remove: () => void,
  flush: () => Promise<void>
): Promise<boolean> {
  const snapshot = captureThreadDeletion(access, threadId);
  if (!snapshot) return false;
  remove();
  const focusedAfterRemoval = access.focusedWindowId;
  try {
    await flush();
    return true;
  } catch (error) {
    restoreThreadDeletion(access, threadId, snapshot, focusedAfterRemoval);
    await flush().catch(() => undefined);
    throw error;
  }
}
