import { promises as fs } from "node:fs";

import type { PendingChatCallback } from "./butler-agent-helpers.js";
import { writeJsonStateFileAtomic } from "./json-state-file.js";
import { repairEpochMilliseconds } from "./state-store-helpers.js";
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
  const now = Date.now();
  const requestedAt = repairEpochMilliseconds(entry.requestedAt, now, now);
  const updatedAt = repairEpochMilliseconds(entry.updatedAt, requestedAt, now);
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
    lastEventAt: repairEpochMilliseconds(entry.lastEventAt, updatedAt, now),
    lastWorkerStatusSeen:
      entry.lastWorkerStatusSeen === "active" || entry.lastWorkerStatusSeen === "idle" || entry.lastWorkerStatusSeen === "unknown"
        ? entry.lastWorkerStatusSeen
        : null,
    lastTerminalReportAt:
      typeof entry.lastTerminalReportAt === "number" && Number.isFinite(entry.lastTerminalReportAt)
        ? entry.lastTerminalReportAt
        : null,
    watchdogLastProbeAt:
      typeof entry.watchdogLastProbeAt === "number" && Number.isFinite(entry.watchdogLastProbeAt)
        ? repairEpochMilliseconds(entry.watchdogLastProbeAt, updatedAt, now)
        : null,
    watchdogLastProbeId:
      typeof entry.watchdogLastProbeId === "string" && entry.watchdogLastProbeId.trim()
        ? entry.watchdogLastProbeId.trim().slice(0, 200)
        : null,
    watchdogProbeFailures:
      typeof entry.watchdogProbeFailures === "number" && Number.isFinite(entry.watchdogProbeFailures)
        ? Math.max(0, Math.floor(entry.watchdogProbeFailures))
        : 0,
    watchdogProbeState:
      entry.watchdogProbeState === "busy" || entry.watchdogProbeState === "idle" || entry.watchdogProbeState === "unreachable"
        ? entry.watchdogProbeState
        : null,
    watchdogProtectedOperation:
      typeof entry.watchdogProtectedOperation === "string" && entry.watchdogProtectedOperation.trim()
        ? entry.watchdogProtectedOperation.trim().slice(0, 200)
        : null,
    watchdogIntervenedAt:
      typeof entry.watchdogIntervenedAt === "number" && Number.isFinite(entry.watchdogIntervenedAt)
        ? entry.watchdogIntervenedAt
        : null,
    watchdogAttentionAt:
      typeof entry.watchdogAttentionAt === "number" && Number.isFinite(entry.watchdogAttentionAt)
        ? entry.watchdogAttentionAt
        : null,
    watchdogAttentionReason:
      typeof entry.watchdogAttentionReason === "string" && entry.watchdogAttentionReason.trim()
        ? entry.watchdogAttentionReason.trim().slice(0, 500)
        : null,
    watchdogInterventionFailures:
      typeof entry.watchdogInterventionFailures === "number" && Number.isFinite(entry.watchdogInterventionFailures)
        ? Math.max(0, Math.floor(entry.watchdogInterventionFailures))
        : 0,
    acceptedWorkerTurnId:
      typeof entry.acceptedWorkerTurnId === "string" && entry.acceptedWorkerTurnId.trim()
        ? entry.acceptedWorkerTurnId.trim().slice(0, 300)
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
  callbackReviewFailureCount: Map<string, number>;
  callbackReviewNotBefore: Map<string, number>;
}): Promise<void> {
  input.callbackReviewFailureCount.clear();
  input.callbackReviewNotBefore.clear();
  try {
    const raw = await fs.readFile(input.callbackStatePath, "utf8");
    if (!raw.trim()) return;
    const parsed = JSON.parse(raw) as PersistedCallbackState;

    input.pendingChatCallbacks.clear();
    for (const entry of parsed.callbackRecords ?? parsed.pendingCallbacks ?? []) {
      const normalized = normalizeCallbackEntry(entry);
      if (!normalized) continue;
      input.pendingChatCallbacks.set(normalized.threadId, normalized);
      if (normalized.reviewState === "queued" && normalized.reviewStage === "retry_wait") {
        input.callbackReviewFailureCount.set(normalized.threadId, Math.max(1, normalized.reviewAttempt ?? 0));
        if (typeof normalized.reviewNextAttemptAt === "number") input.callbackReviewNotBefore.set(normalized.threadId, normalized.reviewNextAttemptAt);
      }
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

export function replaceCallbackPreservingRunningReview(
  existing: PendingChatCallback | undefined,
  next: PendingChatCallback,
  preserveRunningReview: boolean
): PendingChatCallback {
  if (!preserveRunningReview || existing?.reviewState !== "running") return next;
  const runningReview = {
    reviewState: existing.reviewState,
    reviewReason: existing.reviewReason,
    reviewModelProvider: existing.reviewModelProvider,
    reviewModelId: existing.reviewModelId,
    reviewReasoningLevel: existing.reviewReasoningLevel,
    reviewStage: existing.reviewStage,
    reviewAttempt: existing.reviewAttempt,
    reviewStartedAt: existing.reviewStartedAt,
    reviewDeadlineAt: existing.reviewDeadlineAt,
    reviewNextAttemptAt: existing.reviewNextAttemptAt,
    reviewLastActivityAt: existing.reviewLastActivityAt,
    reviewLastActivity: existing.reviewLastActivity,
    reviewLastTool: existing.reviewLastTool,
    reviewLastError: existing.reviewLastError,
    reviewErrors: existing.reviewErrors
  } satisfies Partial<PendingChatCallback>;
  return Object.assign(existing, next, runningReview);
}

export function reconcileReservedCallbackDispatch(callback: PendingChatCallback, thread: CodexThreadRecord | undefined): "ready" | null {
  if (callback.dispatchState !== "reserving") return null;
  if (!thread) return Date.now() - callback.requestedAt >= RESERVED_CALLBACK_RECOVERY_GRACE_MS ? "ready" : null;
  const acceptedTurnId = acceptedDirectWorkerDispatchTurnId(callback, thread);
  if (acceptedTurnId) {
    callback.acceptedWorkerTurnId = acceptedTurnId;
    return "ready";
  }
  // A missing marker cannot prove that the Worker rejected the dispatch. The
  // transport may have accepted it before disconnecting or may omit the marker
  // while steering an active turn. Keep the operator closeout obligation and
  // let report/thread recovery settle it instead of deleting it permanently.
  return Date.now() - callback.requestedAt >= RESERVED_CALLBACK_RECOVERY_GRACE_MS ? "ready" : null;
}

export function acceptedDirectWorkerDispatchTurnId(callback: PendingChatCallback, thread: CodexThreadRecord | undefined): string | null {
  if (!thread) return null;
  const marker = directWorkerDispatchMarker(callback.threadId, callback.requestedAt);
  const acceptedTurn = thread.turns.find((turn) => turn.items.some((item) => {
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
  return acceptedTurn?.id?.trim() || null;
}

export function reconcileAcceptedWorkerTurn(callback: PendingChatCallback, thread: CodexThreadRecord | undefined): boolean {
  if (callback.acceptedWorkerTurnId) return false;
  const acceptedWorkerTurnId = acceptedDirectWorkerDispatchTurnId(callback, thread);
  if (!acceptedWorkerTurnId) return false;
  callback.acceptedWorkerTurnId = acceptedWorkerTurnId;
  return true;
}

export function acceptedWorkerTurnCompletionAt(thread: CodexThreadRecord | undefined, turnId: string | null | undefined, after = 0): number | null {
  if (!turnId) return null;
  const turn = thread?.turns.find((entry) => entry.id === turnId);
  if (!turn || !["completed", "failed", "interrupted", "cancelled"].includes(turn.status)) return null;
  const completedAt = typeof turn.completedAt === "number" && Number.isFinite(turn.completedAt) ? turn.completedAt : null;
  return completedAt !== null && completedAt >= after ? completedAt : null;
}
