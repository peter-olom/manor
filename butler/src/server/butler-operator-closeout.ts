import { buildCloseoutId, getFallbackTurnId, isCallbackOutstanding, type PendingChatCallback } from "./butler-agent-helpers.js";
import { buildOperatorCloseoutText } from "./butler-agent-closeout-text.js";
import { applyPostedCloseout, blockCloseoutReview, getOperatorCloseoutBlocker, recordGatedCloseout, recordPostedCloseoutEvents, relevantTerminalWorkerReport } from "./butler-closeout-gate.js";
import { assertCallbackReviewCurrent, runSerializedCallbackReplacement } from "./butler-job-mutation-guard.js";
import { upsertOperatorMessage } from "./butler-operator-messages.js";
import type { ButlerOperatorSink } from "./butler-agent-options.js";
import type { ButlerStateStore } from "./state-store.js";
import { elapsedTaskDurationMs } from "./task-timing.js";
import type { ButlerMessageView, ButlerTraceItemView } from "./types.js";
import { rotateWorkerReviewBaseline } from "./worker-review-baseline.js";

export type OperatorJobReplyAccess = {
  store: ButlerStateStore;
  pendingChatCallbacks: Map<string, PendingChatCallback>;
  operatorMessages: ButlerMessageView[];
  operatorSink: ButlerOperatorSink | null;
  deliveredCloseoutIds: Set<string>;
  artifactsDir: string;
  noteThreadFocus(threadId: string, reason: string): void;
  saveOperatorMessageState(): Promise<void>;
  saveCallbackState(): Promise<void>;
  emit(event: "change"): boolean;
};

async function rotateAcceptedBaseline(access: OperatorJobReplyAccess, threadId: string, completed: boolean): Promise<void> {
  const contract = access.store.getThread(threadId)?.executionContract;
  if (!completed || !contract?.reviewBaselineTreeSha || !contract.reviewBaselineObjectDir) return;
  if (!await rotateWorkerReviewBaseline(access.store, threadId, access.artifactsDir)) {
    throw new Error("Butler could not persist the accepted Worker baseline. Closeout will retry before the next Worker turn.");
  }
}

function callbackReviewTrace(callback: PendingChatCallback, completedAt: number): ButlerTraceItemView[] {
  if (!callback.reviewStartedAt && !callback.reviewAttempt && !(callback.reviewErrors?.length)) return [];
  const errors: ButlerTraceItemView[] = (callback.reviewErrors ?? []).map((error, index) => ({
    id: `review-error-${error.at}-${index}`,
    type: "error",
    status: "failed",
    title: error.tool ? `Review tool: ${error.tool}` : "Review attempt",
    text: error.message,
    at: error.at,
    completedAt: error.at
  }));
  return [...errors, {
    id: `review-complete-${completedAt}`,
    type: "reasoning",
    status: "completed",
    title: "Adversarial review",
    text: `Completed attempt ${Math.max(1, callback.reviewAttempt ?? 1)} with ${callback.reviewModelProvider ?? "unknown provider"}/${callback.reviewModelId ?? "unknown model"}.`,
    at: callback.reviewStartedAt ?? callback.requestedAt,
    completedAt
  }];
}

export async function postOperatorJobReply(access: OperatorJobReplyAccess, threadId: string, text: string): Promise<void> {
  await runSerializedCallbackReplacement(threadId, async () => {
    assertCallbackReviewCurrent(threadId);
    const callback = access.pendingChatCallbacks.get(threadId);
    if (!callback || !isCallbackOutstanding(callback)) throw new Error(`Job ${threadId} does not have an outstanding operator reply obligation.`);
    const thread = access.store.getThread(threadId);
    if (!thread) throw new Error(`Job ${threadId} is no longer available.`);
    const workerReport = access.store.getWorkerReport(threadId);
    const relevantWorkerReport = relevantTerminalWorkerReport(thread, workerReport, callback.requestedAt);
    const closeoutTurnId = relevantWorkerReport?.turnId ?? getFallbackTurnId(thread);
    if (!closeoutTurnId) throw new Error(`Job ${threadId} does not have a turn Butler can close against yet.`);
    const closeoutId = buildCloseoutId(threadId, closeoutTurnId);
    const messageId = relevantWorkerReport ? `callback-${closeoutId}` : `callback-fallback-${closeoutId}`;
    const completedAt = relevantWorkerReport?.updatedAt ?? thread.updatedAt;
    const at = Math.min(completedAt, callback.requestedAt + 1);
    const resolutionState = relevantWorkerReport ? "received_worker_callback" : "recovered_from_thread_state";
    const closeoutWasAlreadyPosted = access.deliveredCloseoutIds.has(closeoutId) || access.operatorMessages.some((message) => message.id === messageId);
    if (closeoutWasAlreadyPosted) {
      await rotateAcceptedBaseline(access, threadId, relevantWorkerReport?.status === "completed");
      access.deliveredCloseoutIds.add(closeoutId);
      applyPostedCloseout(callback, { resolutionState, threadStatus: thread.status, postedAt: completedAt, workerReportUpdatedAt: relevantWorkerReport?.updatedAt ?? null });
      await access.saveCallbackState();
      access.emit("change");
      return;
    }
    const closeoutBlocker = getOperatorCloseoutBlocker(access.store, threadId, { thread, workerReport: relevantWorkerReport });
    if (closeoutBlocker) {
      recordGatedCloseout(access.store, threadId, closeoutBlocker);
      blockCloseoutReview(callback, { reason: closeoutBlocker, reviewReason: relevantWorkerReport ? "worker_callback" : "thread_recovery", workerReportUpdatedAt: relevantWorkerReport?.updatedAt ?? null });
      await access.saveCallbackState();
      access.emit("change");
      throw new Error(closeoutBlocker);
    }
    await rotateAcceptedBaseline(access, threadId, relevantWorkerReport?.status === "completed");
    const closeoutText = buildOperatorCloseoutText({ store: access.store, thread, workerReport: relevantWorkerReport, text });
    upsertOperatorMessage(access.operatorMessages, messageId, closeoutText, at, elapsedTaskDurationMs(callback.requestedAt, completedAt), { trace: callbackReviewTrace(callback, completedAt) });
    await access.saveOperatorMessageState();
    access.operatorSink?.onOperatorReply?.({ threadId, text: closeoutText, at });
    access.noteThreadFocus(threadId, "closeout");
    access.deliveredCloseoutIds.add(closeoutId);
    applyPostedCloseout(callback, { resolutionState, threadStatus: thread.status, postedAt: completedAt, workerReportUpdatedAt: relevantWorkerReport?.updatedAt ?? null });
    recordPostedCloseoutEvents(access.store, threadId, resolutionState);
    await access.saveCallbackState();
    access.emit("change");
  });
}
