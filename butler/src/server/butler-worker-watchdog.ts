import { isCallbackOutstanding, latestCompletedAgentMessageAt, latestTerminalWorkerActivityAt, type PendingChatCallback } from "./butler-agent-helpers.js";
import { relevantTerminalWorkerReport } from "./butler-closeout-gate.js";
import { upsertOperatorMessage } from "./butler-operator-messages.js";
import type { ButlerMessageView, CodexThreadRecord } from "./types.js";
import {
  getWorkerThreadRuntimeActivityAt,
  probeWorkerThreadWithin,
  reconcileAuthoritativeIdleWorkerThread,
  reconcileConfirmedDeadWorkerThread,
  stopWorkerThreadWithin,
  type WorkerClientAccess
} from "./worker-client-router.js";
import { reconcileWorkerWatchdog, renewWorkerWatchdogActivity } from "./worker-watchdog.js";

export async function reconcilePendingCallbackWorkerWatchdog(input: {
  callback: PendingChatCallback;
  thread: CodexThreadRecord | null | undefined;
  now: number;
  workerAccess: WorkerClientAccess;
  hasRelevantWorkerReport: boolean;
  isOwned: () => boolean;
}): Promise<{ changed: boolean; attentionRequired: boolean }> {
  const { callback, thread, now, workerAccess } = input;
  let changed = renewWorkerWatchdogActivity(callback, getWorkerThreadRuntimeActivityAt(workerAccess, callback.threadId));
  const acceptedTurn = callback.acceptedWorkerTurnId
    ? thread?.turns.find((turn) => turn.id === callback.acceptedWorkerTurnId)
    : null;
  const acceptedTurnStillActive = acceptedTurn ? ["started", "inProgress", "in_progress"].includes(acceptedTurn.status) : false;
  const acceptedIdle = thread?.status === "idle" && callback.dispatchState !== "reserving" &&
    (acceptedTurnStillActive || (!callback.acceptedWorkerTurnId && latestCompletedAgentMessageAt(thread, callback.requestedAt) === null && latestTerminalWorkerActivityAt(thread, callback.requestedAt) === null));
  if (input.hasRelevantWorkerReport || (thread?.status !== "active" && !acceptedIdle) || callback.callbackState !== "waiting") {
    return { changed, attentionRequired: false };
  }

  const isCurrent = () => input.isOwned() && isCallbackOutstanding(callback) &&
    !relevantTerminalWorkerReport(workerAccess.store.getThread(callback.threadId), workerAccess.store.getWorkerReport(callback.threadId), callback.requestedAt, callback.acceptedWorkerTurnId);
  const result = await reconcileWorkerWatchdog({
    callback,
    thread,
    now,
    runtimeActivityAt: getWorkerThreadRuntimeActivityAt(workerAccess, callback.threadId),
    currentRuntimeActivityAt: () => getWorkerThreadRuntimeActivityAt(workerAccess, callback.threadId),
    probe: () => probeWorkerThreadWithin(workerAccess, callback.threadId),
    intervene: (probe) => probe.state === "idle"
      ? reconcileAuthoritativeIdleWorkerThread(workerAccess, callback.threadId)
      : probe.confirmedDead
        ? reconcileConfirmedDeadWorkerThread(workerAccess, callback.threadId)
        : stopWorkerThreadWithin(workerAccess, callback.threadId),
    isCurrent,
    allowIdleProbe: acceptedIdle
  });
  if (result.changed) callback.updatedAt = now;
  if (result.recovered) {
    workerAccess.store.addEvent(callback.threadId, "butler.watchdog.recovered", "Worker health checks confirmed that the active turn had stopped, so Butler queued thread recovery.");
  } else if (result.attentionRequired) {
    workerAccess.store.addEvent(callback.threadId, "butler.watchdog.blocked", "Worker health checks could not safely stop the unresponsive active turn. Manor will keep monitoring it without treating it as idle.");
  }
  return { changed: changed || result.changed, attentionRequired: result.attentionRequired };
}

export async function postWorkerWatchdogAttentionNotice(input: {
  callback: PendingChatCallback;
  messages: ButlerMessageView[];
  save: () => Promise<void>;
  emit: () => void;
}): Promise<void> {
  const { callback } = input;
  if (!callback.watchdogAttentionAt) return;
  const reason = callback.watchdogAttentionReason ? ` Last stop attempt: ${callback.watchdogAttentionReason}` : "";
  upsertOperatorMessage(
    input.messages,
    `worker-watchdog-attention-${callback.threadId}-${callback.watchdogAttentionAt}`,
    `Worker needs attention. Manor could not safely stop its unresponsive turn after repeated health checks. I am keeping the job supervised and will continue checking it.${reason}`,
    callback.watchdogAttentionAt
  );
  await input.save();
  input.emit();
}

export async function postWorkerHydrationAttentionNotice(input: {
  callback: PendingChatCallback;
  messages: ButlerMessageView[];
  save: () => Promise<void>;
  emit: () => void;
}): Promise<void> {
  const { callback } = input;
  if (!callback.watchdogAttentionAt) return;
  upsertOperatorMessage(
    input.messages,
    `worker-hydration-attention-${callback.threadId}-${callback.watchdogAttentionAt}`,
    "Worker recovery needs attention. Manor could not reload this Worker session after restart. I kept the operator closeout pending and will continue retrying instead of dropping it.",
    callback.watchdogAttentionAt
  );
  await input.save();
  input.emit();
}

export function shouldHydratePendingWorkerCallback(callback: PendingChatCallback, thread: CodexThreadRecord | null | undefined): boolean {
  if (!thread || callback.dispatchState === "reserving") return true;
  return thread.status !== "active" && callback.lastWorkerStatusSeen !== thread.status;
}
