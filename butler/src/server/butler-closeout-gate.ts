import type { ButlerStateStore } from "./state-store.js";
import { getOrchestrationCloseoutBlocker } from "./butler-orchestration.js";
import { contractRequiresVisualProof } from "./proof-policy.js";
import { evaluateOperatorCloseoutGate } from "./supervision-checklist.js";
import type { ButlerCallbackResolutionState, ButlerThreadCallbackView, CodexThreadRecord, CodexWorkerReportView } from "./types.js";
import { workerThreadIsRunning } from "./worker-thread-status.js";

export function relevantTerminalWorkerReport(
  thread: CodexThreadRecord | null | undefined,
  report: CodexWorkerReportView | null | undefined,
  requestedAt: number
): CodexWorkerReportView | null {
  if (!report || report.updatedAt < requestedAt) return null;
  if (report.status === "completed") return report;
  return workerThreadIsRunning(thread) ? null : report;
}

export function getOperatorCloseoutBlocker(
  store: ButlerStateStore,
  threadId: string,
  options: { thread?: CodexThreadRecord | null; workerReport?: CodexWorkerReportView | null } = {}
): string | null {
  const thread = options.thread ?? store.getThread(threadId);
  const workerReport = "workerReport" in options ? options.workerReport : store.getWorkerReport(threadId);
  const gate = evaluateOperatorCloseoutGate(thread?.supervisionChecklist, workerReport);
  if (!gate.ok) {
    return gate.reason;
  }
  const orchestrationBlocker = getOrchestrationCloseoutBlocker({ thread, workerReport });
  if (orchestrationBlocker) {
    return orchestrationBlocker;
  }
  if (workerReport?.status === "completed" && contractRequiresVisualProof(thread?.executionContract)) {
    const referencedRunIds = [...new Set(workerReport.evidence.map((entry) => entry.proofRunId).filter((id): id is string => Boolean(id)))];
    if (referencedRunIds.length === 0) return "Completed UI closeout requires referenced visual proof.";
    const proofs = store.listPreviewProofs().filter((proof) => proof.threadId === threadId && referencedRunIds.includes(proof.verification.runId));
    for (const runId of referencedRunIds) {
      const proof = proofs.find((entry) => entry.verification.runId === runId);
      const latestReview = proof?.proofReviews.slice().sort((left, right) => right.reviewedAt - left.reviewedAt)[0];
      if (!latestReview) return `Visual proof ${runId} must be reviewed by Butler before completed closeout.`;
      if (latestReview.verdict !== "credible") {
        return `Visual proof ${runId} cannot support completed closeout because Butler's latest review is ${latestReview.verdict}.`;
      }
    }
  }
  return null;
}

export function recordGatedCloseout(store: ButlerStateStore, threadId: string, reason: string): void {
  store.addEvent(threadId, "butler.closeout.gated", reason);
}

export function queueCloseoutReview(callback: ButlerThreadCallbackView, reason: "worker_callback" | "thread_recovery"): void {
  callback.nextWorkerReportAction = "review";
  callback.reviewState = "queued";
  callback.reviewStage = "queued";
  callback.reviewReason = reason;
  callback.reviewStartedAt = null;
  callback.reviewDeadlineAt = null;
  callback.reviewNextAttemptAt = null;
  callback.reviewLastError = null;
  callback.blockedCloseoutReason = null;
  callback.blockedCloseoutReportAt = null;
  callback.updatedAt = Date.now();
}

export function idleCloseoutReview(callback: ButlerThreadCallbackView): void {
  callback.reviewState = "idle";
  callback.reviewStage = null;
  callback.reviewStartedAt = null;
  callback.reviewDeadlineAt = null;
  callback.reviewNextAttemptAt = null;
  callback.reviewLastError = null;
  callback.blockedCloseoutReason = null;
  callback.blockedCloseoutReportAt = null;
  callback.updatedAt = Date.now();
}

export function blockCloseoutReview(
  callback: ButlerThreadCallbackView,
  input: {
    reason: string;
    reviewReason: "worker_callback" | "thread_recovery";
    workerReportUpdatedAt: number | null;
  }
): void {
  callback.nextWorkerReportAction = "review";
  callback.reviewState = "blocked";
  callback.reviewStage = "blocked";
  callback.reviewDeadlineAt = null;
  callback.reviewNextAttemptAt = null;
  callback.reviewLastError = null;
  callback.reviewReason = input.reviewReason;
  callback.blockedCloseoutReason = input.reason;
  callback.blockedCloseoutReportAt = input.workerReportUpdatedAt;
  callback.updatedAt = Date.now();
}

export function isSameBlockedCloseout(
  callback: ButlerThreadCallbackView,
  input: { reason: string; workerReportUpdatedAt: number | null }
): boolean {
  return callback.reviewState === "blocked" &&
    callback.blockedCloseoutReason === input.reason &&
    callback.blockedCloseoutReportAt === input.workerReportUpdatedAt;
}

export function applyPostedCloseout(
  callback: ButlerThreadCallbackView,
  input: {
    resolutionState: NonNullable<ButlerCallbackResolutionState>;
    threadStatus: ButlerThreadCallbackView["lastWorkerStatusSeen"];
    postedAt: number;
    workerReportUpdatedAt: number | null;
  }
): void {
  callback.callbackState = "closed";
  callback.resolutionState = input.resolutionState;
  callback.lastWorkerStatusSeen = input.threadStatus;
  callback.lastEventAt = input.postedAt;
  callback.lastTerminalReportAt = input.workerReportUpdatedAt ?? callback.lastTerminalReportAt;
  callback.lastPrivateSteerText = callback.lastPrivateSteerText ?? null;
  callback.lastPrivateSteerAt = callback.lastPrivateSteerAt ?? null;
  callback.nextWorkerReportAction = "review";
  callback.operatorCloseoutStatus = "posted";
  callback.owesOperatorReply = false;
  callback.closeoutChannel = "main_chat";
  callback.reviewState = "idle";
  callback.reviewStage = null;
  callback.reviewReason = null;
  callback.reviewStartedAt = null;
  callback.reviewDeadlineAt = null;
  callback.reviewNextAttemptAt = null;
  callback.reviewLastActivityAt = input.postedAt;
  callback.reviewLastActivity = "Review complete.";
  callback.reviewLastTool = null;
  callback.reviewLastError = null;
  callback.blockedCloseoutReason = null;
  callback.blockedCloseoutReportAt = null;
  callback.closedAt = input.postedAt;
  callback.updatedAt = Date.now();
}

export function recordPostedCloseoutEvents(
  store: ButlerStateStore,
  threadId: string,
  resolutionState: NonNullable<ButlerCallbackResolutionState>
): void {
  store.addEvent(threadId, resolutionState === "received_worker_callback" ? "butler.job.closed" : "butler.recovery.invoked", resolutionState === "received_worker_callback"
    ? "Butler posted the operator-facing closeout after reviewing the worker callback."
    : "Butler posted the operator-facing closeout after recovering from thread state.");
  if (resolutionState === "recovered_from_thread_state") {
    store.addEvent(threadId, "butler.job.closed", "Butler closed the delegated job after thread-state recovery.");
  }
}
