import { promises as fs } from "node:fs";

import type { PendingChatCallback } from "./butler-agent-helpers.js";
import { writeJsonStateFileAtomic } from "./json-state-file.js";
import type { CodexThreadRecord } from "./types.js";

const RESERVED_CALLBACK_RECOVERY_GRACE_MS = 5 * 60_000;
const REVIEW_STAGES = new Set(["queued", "preparing", "reviewing_changes", "supervising_closeout", "retry_wait", "blocked"]);

export function directWorkerDispatchMarker(threadId: string, requestedAt: number): string {
  return `<!-- manor-direct-dispatch:${threadId}:${requestedAt} -->`;
}

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
  const interruptedAutomationReview = entry.reviewState === "running" ||
    (entry.reviewState === "queued" && entry.reviewStage === "retry_wait") ||
    (entry.reviewState === "blocked" && entry.blockedCloseoutReason?.startsWith("Adversarial review paused") === true);
  const reviewState =
    interruptedAutomationReview
      ? "blocked"
      : entry.reviewState === "blocked" || entry.reviewState === "queued" || entry.reviewState === "idle"
      ? entry.reviewState
      : normalizedReviewReason
        ? "queued"
        : "idle";
  const reviewStage = reviewState === "queued"
    ? (entry.reviewStage === "retry_wait" ? "retry_wait" : "queued")
    : reviewState === "blocked"
      ? "blocked"
      : null;
  const reviewErrors = Array.isArray(entry.reviewErrors)
    ? entry.reviewErrors.flatMap((error) => {
        if (!error || typeof error !== "object" || typeof error.message !== "string" || !error.message.trim()) return [];
        const stage = typeof error.stage === "string" && REVIEW_STAGES.has(error.stage) ? error.stage as NonNullable<PendingChatCallback["reviewStage"]> : "blocked";
        return [{ at: typeof error.at === "number" && Number.isFinite(error.at) ? error.at : updatedAt, stage, tool: typeof error.tool === "string" && error.tool.trim() ? error.tool.trim().slice(0, 200) : null, message: error.message.trim().slice(0, 2000) }];
      }).slice(-12)
    : [];

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
    dispatchState: entry.dispatchState === "reserving" ? "reserving" : "ready",
    reviewState,
    reviewReason: normalizedReviewReason,
    reviewModelProvider: typeof entry.reviewModelProvider === "string" && entry.reviewModelProvider.trim() ? entry.reviewModelProvider.trim() : null,
    reviewModelId: typeof entry.reviewModelId === "string" && entry.reviewModelId.trim() ? entry.reviewModelId.trim() : null,
    reviewReasoningLevel: typeof entry.reviewReasoningLevel === "string" ? entry.reviewReasoningLevel : null,
    reviewStage,
    reviewAttempt: typeof entry.reviewAttempt === "number" && Number.isFinite(entry.reviewAttempt) ? Math.max(0, Math.floor(entry.reviewAttempt)) : 0,
    reviewStartedAt: null,
    reviewDeadlineAt: null,
    reviewNextAttemptAt: reviewState === "queued" && typeof entry.reviewNextAttemptAt === "number" && Number.isFinite(entry.reviewNextAttemptAt) ? entry.reviewNextAttemptAt : null,
    reviewLastActivityAt: typeof entry.reviewLastActivityAt === "number" && Number.isFinite(entry.reviewLastActivityAt) ? entry.reviewLastActivityAt : null,
    reviewLastActivity: typeof entry.reviewLastActivity === "string" && entry.reviewLastActivity.trim() ? entry.reviewLastActivity.trim().slice(0, 800) : null,
    reviewLastTool: typeof entry.reviewLastTool === "string" && entry.reviewLastTool.trim() ? entry.reviewLastTool.trim().slice(0, 200) : null,
    reviewLastError: typeof entry.reviewLastError === "string" && entry.reviewLastError.trim() ? entry.reviewLastError.trim().slice(0, 2000) : null,
    reviewErrors,
    blockedCloseoutReason: reviewState === "blocked"
      ? typeof entry.blockedCloseoutReason === "string" && entry.blockedCloseoutReason.trim()
        ? entry.blockedCloseoutReason
        : `Adversarial review paused after restart during attempt ${Math.max(1, entry.reviewAttempt ?? 1)}. Retry with the current Butler model when ready.`
      : null,
    blockedCloseoutReportAt:
      reviewState === "blocked" && typeof entry.blockedCloseoutReportAt === "number" && Number.isFinite(entry.blockedCloseoutReportAt)
        ? entry.blockedCloseoutReportAt
        : reviewState === "blocked" && typeof entry.lastTerminalReportAt === "number" && Number.isFinite(entry.lastTerminalReportAt)
          ? entry.lastTerminalReportAt
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
  await writeJsonStateFileAtomic(input.callbackStatePath, {
    callbackRecords: [...input.pendingChatCallbacks.values()],
    deliveredCloseoutIds: [...input.deliveredCloseoutIds]
  });
}

export function reconcileReservedCallbackDispatch(callback: PendingChatCallback, thread: CodexThreadRecord | undefined): "ready" | "drop" | null {
  if (callback.dispatchState !== "reserving") return null;
  if (!thread) return "drop";
  const marker = directWorkerDispatchMarker(callback.threadId, callback.requestedAt);
  const markerWasAccepted = thread.turns.some((turn) => turn.items.some((item) => {
    if (item.type !== "userMessage") return false;
    let rawText = "";
    try {
      const serialized = JSON.stringify(item.raw);
      rawText = typeof serialized === "string" ? serialized : "";
    } catch {
      rawText = "";
    }
    return item.text.includes(marker) || rawText.includes(marker);
  }));
  if (markerWasAccepted) return "ready";
  return Date.now() - callback.requestedAt >= RESERVED_CALLBACK_RECOVERY_GRACE_MS ? "drop" : null;
}
