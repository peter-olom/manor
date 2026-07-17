import type { ButlerThreadCallbackView, CodexThreadRecord } from "./types.js";
import type { WorkerThreadInterventionResult } from "./worker-thread-runtime-probe.js";
import { MAX_TIMESTAMP_FUTURE_SKEW_MS } from "./state-store-helpers.js";

export const WORKER_WATCHDOG_SILENCE_MS = 5 * 60_000;
export const WORKER_WATCHDOG_PROBE_RETRY_MS = 30_000;
export const WORKER_WATCHDOG_MAX_PROBE_FAILURES = 3;
export const WORKER_WATCHDOG_PROTECTED_MAX_PROBE_FAILURES = 6;

export type WorkerWatchdogProbeResult = {
  attemptId: string;
  state: "busy" | "idle" | "unreachable";
  busy: boolean;
  compacting: boolean;
  pendingMessageCount: number;
  activityAt: number | null;
  acknowledgedWait: string | null;
  confirmedDead: boolean;
};

const ACTIVE_TURN_STATUSES = new Set(["started", "inProgress", "in_progress"]);
const PASSIVE_ITEM_TYPES = new Set(["agentMessage", "reasoning", "plan", "userMessage"]);

export function acknowledgedWorkerOperation(thread: CodexThreadRecord | null | undefined): string | null {
  const activeTurn = [...(thread?.turns ?? [])]
    .reverse()
    .find((turn) => ACTIVE_TURN_STATUSES.has(turn.status));
  if (!activeTurn) return null;

  const activeItem = [...activeTurn.items]
    .reverse()
    .find((item) => item.status === "started" && !PASSIVE_ITEM_TYPES.has(item.type));
  return activeItem?.type ?? null;
}

export function workerWatchdogProbeDue(
  callback: ButlerThreadCallbackView,
  now: number,
  options: { silenceMs?: number; retryMs?: number } = {}
): boolean {
  if (callback.watchdogIntervenedAt) return false;
  const requestedAt = callback.requestedAt > now + MAX_TIMESTAMP_FUTURE_SKEW_MS ? 0 : callback.requestedAt;
  const rawLastActivityAt = callback.lastEventAt ?? requestedAt;
  const lastActivityAt = rawLastActivityAt > now + MAX_TIMESTAMP_FUTURE_SKEW_MS ? requestedAt : rawLastActivityAt;
  const rawLastProbeAt = callback.watchdogLastProbeAt ?? 0;
  const lastProbeAt = rawLastProbeAt > now + MAX_TIMESTAMP_FUTURE_SKEW_MS ? 0 : rawLastProbeAt;
  const failures = callback.watchdogProbeFailures ?? 0;
  const failureLimit = callback.watchdogProtectedOperation
    ? WORKER_WATCHDOG_PROTECTED_MAX_PROBE_FAILURES
    : WORKER_WATCHDOG_MAX_PROBE_FAILURES;
  const waitMs = (failures > 0 && failures < failureLimit) ||
    (callback.watchdogProbeState === "unreachable" && failures < failureLimit)
    ? options.retryMs ?? WORKER_WATCHDOG_PROBE_RETRY_MS
    : options.silenceMs ?? WORKER_WATCHDOG_SILENCE_MS;
  return now - Math.max(lastActivityAt, lastProbeAt) >= waitMs;
}

export function renewWorkerWatchdogActivity(callback: ButlerThreadCallbackView, activityAt: number | null): boolean {
  if (activityAt === null || !Number.isFinite(activityAt) || activityAt < callback.requestedAt) return false;
  if (activityAt <= (callback.lastEventAt ?? 0)) return false;
  callback.lastEventAt = activityAt;
  callback.watchdogProbeFailures = 0;
  callback.watchdogProbeState = null;
  callback.watchdogProtectedOperation = null;
  callback.watchdogAttentionAt = null;
  callback.watchdogAttentionReason = null;
  callback.watchdogInterventionFailures = 0;
  return true;
}

export async function reconcileWorkerWatchdog(input: {
  callback: ButlerThreadCallbackView;
  thread: CodexThreadRecord;
  now: number;
  runtimeActivityAt: number | null;
  currentRuntimeActivityAt: () => number | null;
  probe: () => Promise<WorkerWatchdogProbeResult>;
  intervene: (probe: WorkerWatchdogProbeResult) => Promise<WorkerThreadInterventionResult>;
  isCurrent: () => boolean;
  silenceMs?: number;
  retryMs?: number;
  maxProbeFailures?: number;
  allowIdleProbe?: boolean;
}): Promise<{ changed: boolean; recovered: boolean; attentionRequired: boolean; probed: boolean }> {
  const { callback } = input;
  let changed = renewWorkerWatchdogActivity(callback, input.runtimeActivityAt);
  if ((input.thread.status !== "active" && !input.allowIdleProbe) || !workerWatchdogProbeDue(callback, input.now, input)) {
    return { changed, recovered: false, attentionRequired: false, probed: false };
  }

  const activityBeforeProbe = callback.lastEventAt ?? callback.requestedAt;
  const transcriptOperation = acknowledgedWorkerOperation(input.thread);
  const probe = await input.probe();
  if (!input.isCurrent()) return { changed, recovered: false, attentionRequired: false, probed: true };

  const activityAfterProbe = Math.max(probe.activityAt ?? 0, input.currentRuntimeActivityAt() ?? 0) || null;
  if (activityAfterProbe !== null && activityAfterProbe > activityBeforeProbe) {
    changed = renewWorkerWatchdogActivity(callback, activityAfterProbe) || changed;
    return { changed, recovered: false, attentionRequired: false, probed: true };
  }

  callback.watchdogLastProbeAt = input.now;
  const repeatedAttempt = callback.watchdogLastProbeId === probe.attemptId;
  callback.watchdogLastProbeId = probe.attemptId;
  callback.watchdogProbeState = probe.state;
  changed = true;

  if (probe.state === "busy") {
    callback.watchdogProbeFailures = 0;
    callback.watchdogProtectedOperation = transcriptOperation ?? probe.acknowledgedWait;
    callback.watchdogAttentionAt = null;
    callback.watchdogAttentionReason = null;
    callback.watchdogInterventionFailures = 0;
    return { changed, recovered: false, attentionRequired: false, probed: true };
  }

  const protectedOperation = transcriptOperation ?? probe.acknowledgedWait;
  callback.watchdogProtectedOperation = probe.confirmedDead ? null : protectedOperation;
  const failures = probe.state === "idle"
    ? input.maxProbeFailures ?? WORKER_WATCHDOG_MAX_PROBE_FAILURES
    : repeatedAttempt
      ? callback.watchdogProbeFailures ?? 0
      : (callback.watchdogProbeFailures ?? 0) + 1;
  callback.watchdogProbeFailures = failures;
  const baseFailureLimit = input.maxProbeFailures ?? WORKER_WATCHDOG_MAX_PROBE_FAILURES;
  const failureLimit = protectedOperation && !probe.confirmedDead
    ? Math.max(baseFailureLimit + 1, baseFailureLimit * 2)
    : baseFailureLimit;
  if (probe.state !== "idle" && !probe.confirmedDead && failures < failureLimit) {
    return { changed, recovered: false, attentionRequired: false, probed: true };
  }

  const intervention = await input.intervene(probe);
  if (!input.isCurrent()) return { changed, recovered: false, attentionRequired: false, probed: true };
  if (intervention.state !== "stopped" && intervention.state !== "idle") {
    const firstAttention = !callback.watchdogAttentionAt;
    callback.watchdogAttentionAt ??= input.now;
    callback.watchdogAttentionReason = intervention.detail ?? intervention.state;
    callback.watchdogInterventionFailures = (callback.watchdogInterventionFailures ?? 0) + 1;
    callback.updatedAt = input.now;
    return { changed: true, recovered: false, attentionRequired: firstAttention, probed: true };
  }

  callback.watchdogIntervenedAt = input.now;
  callback.watchdogProbeState = "idle";
  callback.callbackState = "missing_worker_callback";
  callback.reviewState = "queued";
  callback.reviewReason = "thread_recovery";
  callback.lastWorkerStatusSeen = "idle";
  callback.updatedAt = input.now;
  return { changed: true, recovered: true, attentionRequired: false, probed: true };
}
