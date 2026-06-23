import { promises as fs } from "node:fs";

import type { PendingChatCallback } from "./butler-agent-helpers.js";

type PersistedCallbackState = {
  callbackRecords?: PendingChatCallback[];
  pendingCallbacks?: PendingChatCallback[];
  deliveredCloseoutIds?: string[];
  deliveredMilestoneIds?: string[];
};

function normalizeCallbackEntry(entry: PendingChatCallback): PendingChatCallback | null {
  if (!entry || typeof entry !== "object" || typeof entry.threadId !== "string") {
    return null;
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
  const reviewState =
    entry.reviewState === "blocked" ||
    entry.reviewState === "running" ||
    entry.reviewState === "queued" ||
    entry.reviewState === "idle"
      ? entry.reviewState
      : normalizedReviewReason
        ? "queued"
        : "idle";

  return {
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
    reviewState,
    reviewReason: normalizedReviewReason,
    blockedCloseoutReason:
      reviewState === "blocked" && typeof entry.blockedCloseoutReason === "string" && entry.blockedCloseoutReason.trim()
        ? entry.blockedCloseoutReason
        : null,
    blockedCloseoutReportAt:
      reviewState === "blocked" && typeof entry.blockedCloseoutReportAt === "number" && Number.isFinite(entry.blockedCloseoutReportAt)
        ? entry.blockedCloseoutReportAt
        : null,
    closedAt: typeof entry.closedAt === "number" && Number.isFinite(entry.closedAt) ? entry.closedAt : null,
    updatedAt
  };
}

export async function loadButlerCallbackState(input: {
  callbackStatePath: string;
  pendingChatCallbacks: Map<string, PendingChatCallback>;
  deliveredCloseoutIds: Set<string>;
}): Promise<void> {
  try {
    const raw = await fs.readFile(input.callbackStatePath, "utf8");
    if (!raw.trim()) return;
    const parsed = JSON.parse(raw) as PersistedCallbackState;

    input.pendingChatCallbacks.clear();
    for (const entry of parsed.callbackRecords ?? parsed.pendingCallbacks ?? []) {
      const normalized = normalizeCallbackEntry(entry);
      if (normalized) input.pendingChatCallbacks.set(normalized.threadId, normalized);
    }

    input.deliveredCloseoutIds.clear();
    for (const closeoutId of [...(parsed.deliveredCloseoutIds ?? []), ...(parsed.deliveredMilestoneIds ?? [])]) {
      if (typeof closeoutId === "string" && closeoutId.trim()) input.deliveredCloseoutIds.add(closeoutId);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
  }
}

export async function saveButlerCallbackState(input: {
  callbackStatePath: string;
  pendingChatCallbacks: Map<string, PendingChatCallback>;
  deliveredCloseoutIds: Set<string>;
}): Promise<void> {
  await fs.writeFile(
    input.callbackStatePath,
    JSON.stringify(
      {
        callbackRecords: [...input.pendingChatCallbacks.values()],
        deliveredCloseoutIds: [...input.deliveredCloseoutIds]
      },
      null,
      2
    ),
    "utf8"
  );
}
