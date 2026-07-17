import assert from "node:assert/strict";
import test from "node:test";

import {
  acknowledgedWorkerOperation,
  reconcileWorkerWatchdog,
  renewWorkerWatchdogActivity,
  workerWatchdogProbeDue
} from "../../src/server/worker-watchdog.js";
import { shouldHydratePendingWorkerCallback } from "../../src/server/butler-worker-watchdog.js";
import type { ButlerThreadCallbackView, CodexThreadRecord } from "../../src/server/types.js";

const stopped = { state: "stopped", detail: null } as const;

function callback(overrides: Partial<ButlerThreadCallbackView> = {}): ButlerThreadCallbackView {
  return {
    threadId: "worker-1",
    callbackState: "waiting",
    resolutionState: null,
    requestedAt: 1_000,
    lastEventAt: 1_000,
    lastWorkerStatusSeen: "active",
    lastTerminalReportAt: null,
    lastPrivateSteerText: null,
    lastPrivateSteerAt: null,
    nextWorkerReportAction: "review",
    operatorCloseoutStatus: "owed",
    owesOperatorReply: true,
    closeoutChannel: "none",
    reviewState: "idle",
    reviewReason: null,
    closedAt: null,
    updatedAt: 1_000,
    ...overrides
  };
}

function thread(itemType: string, itemStatus: "started" | "completed" = "started"): CodexThreadRecord {
  return {
    id: "worker-1",
    name: null,
    status: "active",
    cwd: "/workspace",
    source: "pi-rpc",
    modelProvider: "ollama-cloud",
    modelId: "glm-5.2",
    requestedReasoningEffort: null,
    createdAt: 1_000,
    updatedAt: 1_000,
    turnCount: 1,
    turns: [{
      id: "turn-1",
      requestedReasoningEffort: null,
      status: "in_progress",
      error: null,
      startedAt: 1_000,
      completedAt: null,
      items: [{ id: "item-1", type: itemType, status: itemStatus, text: "", at: 1_000, raw: {} }]
    }]
  } as CodexThreadRecord;
}

test("watchdog recognizes an in-progress command or tool as an acknowledged operation", () => {
  assert.equal(acknowledgedWorkerOperation(thread("commandExecution")), "commandExecution");
  assert.equal(acknowledgedWorkerOperation(thread("webSearch")), "webSearch");
  assert.equal(acknowledgedWorkerOperation(thread("commandExecution", "completed")), null);
  assert.equal(acknowledgedWorkerOperation(thread("reasoning")), null);
});

test("active callback checks avoid full thread hydration while terminal transitions hydrate once", () => {
  const active = thread("reasoning");
  const current = callback({ lastWorkerStatusSeen: "active" });
  assert.equal(shouldHydratePendingWorkerCallback(current, active), false);
  assert.equal(shouldHydratePendingWorkerCallback(current, { ...active, status: "idle" }), true);
  current.lastWorkerStatusSeen = "idle";
  assert.equal(shouldHydratePendingWorkerCallback(current, { ...active, status: "idle" }), false);
  assert.equal(shouldHydratePendingWorkerCallback({ ...current, dispatchState: "reserving" }, active), true);
  assert.equal(shouldHydratePendingWorkerCallback(current, null), true);
});

test("watchdog uses a shorter retry lease only after an unreachable probe", () => {
  const current = callback({ lastEventAt: 1_000 });
  assert.equal(workerWatchdogProbeDue(current, 6_000, { silenceMs: 10_000, retryMs: 2_000 }), false);
  assert.equal(workerWatchdogProbeDue(current, 11_000, { silenceMs: 10_000, retryMs: 2_000 }), true);

  current.watchdogLastProbeAt = 11_000;
  current.watchdogProbeFailures = 1;
  current.watchdogProbeState = "unreachable";
  assert.equal(workerWatchdogProbeDue(current, 12_999, { silenceMs: 10_000, retryMs: 2_000 }), false);
  assert.equal(workerWatchdogProbeDue(current, 13_000, { silenceMs: 10_000, retryMs: 2_000 }), true);
});

test("future watchdog timestamps cannot suppress probes indefinitely", () => {
  const current = callback({
    requestedAt: 1_000,
    lastEventAt: 86_400_000,
    watchdogLastProbeAt: 86_400_000
  });
  assert.equal(workerWatchdogProbeDue(current, 11_000, { silenceMs: 10_000 }), true);
});

test("successful busy probes extend the lease without fabricating Worker activity", () => {
  const current = callback({
    lastEventAt: 1_000,
    watchdogLastProbeAt: 10_000,
    watchdogProbeState: "busy",
    watchdogProbeFailures: 0
  });
  assert.equal(workerWatchdogProbeDue(current, 19_999, { silenceMs: 10_000 }), false);
  assert.equal(workerWatchdogProbeDue(current, 20_000, { silenceMs: 10_000 }), true);
  assert.equal(current.lastEventAt, 1_000);
});

test("real runtime activity clears watchdog suspicion and stale probe failures", () => {
  const current = callback({
    watchdogLastProbeAt: 4_000,
    watchdogProbeFailures: 2,
    watchdogProbeState: "unreachable",
    watchdogProtectedOperation: "commandExecution"
  });
  assert.equal(renewWorkerWatchdogActivity(current, 5_000), true);
  assert.equal(current.lastEventAt, 5_000);
  assert.equal(current.watchdogProbeFailures, 0);
  assert.equal(current.watchdogProbeState, null);
  assert.equal(current.watchdogProtectedOperation, null);
  assert.equal(renewWorkerWatchdogActivity(current, 4_999), false);
});

test("a responsive busy runtime keeps a silent long command protected", async () => {
  const current = callback({ lastEventAt: 1_000 });
  let interventions = 0;
  for (const now of [11_000, 21_000, 31_000]) {
    const result = await reconcileWorkerWatchdog({
      callback: current,
      thread: thread("commandExecution"),
      now,
      runtimeActivityAt: null,
      currentRuntimeActivityAt: () => null,
      probe: async () => ({ attemptId: `probe-${now}`, state: "busy", busy: true, compacting: false, pendingMessageCount: 0, activityAt: null, acknowledgedWait: null, confirmedDead: false }),
      intervene: async () => { interventions += 1; return stopped; },
      isCurrent: () => true,
      silenceMs: 10_000
    });
    assert.equal(result.probed, true);
    assert.equal(result.recovered, false);
  }
  assert.equal(interventions, 0);
  assert.equal(current.watchdogProbeFailures, 0);
  assert.equal(current.watchdogProtectedOperation, "commandExecution");
});

test("a first failed probe waits and a later success resets suspicion", async () => {
  const current = callback({ lastEventAt: 1_000 });
  const base = {
    callback: current,
    thread: thread("reasoning"),
    runtimeActivityAt: null,
    currentRuntimeActivityAt: () => null,
    intervene: async () => stopped,
    isCurrent: () => true,
    silenceMs: 10_000,
    retryMs: 2_000
  };
  await reconcileWorkerWatchdog({
    ...base,
    now: 11_000,
    probe: async () => ({ attemptId: "probe-1", state: "unreachable", busy: false, compacting: false, pendingMessageCount: 0, activityAt: null, acknowledgedWait: null, confirmedDead: false })
  });
  assert.equal(current.watchdogProbeFailures, 1);

  await reconcileWorkerWatchdog({
    ...base,
    now: 13_000,
    probe: async () => ({ attemptId: "probe-2", state: "busy", busy: true, compacting: false, pendingMessageCount: 0, activityAt: null, acknowledgedWait: "model response", confirmedDead: false })
  });
  assert.equal(current.watchdogProbeFailures, 0);
  assert.equal(current.watchdogProbeState, "busy");
});

test("repeated timeouts from one unresolved probe count as one failure", async () => {
  const current = callback({ lastEventAt: 1_000 });
  for (const now of [11_000, 13_000, 15_000]) {
    await reconcileWorkerWatchdog({
      callback: current,
      thread: thread("reasoning"),
      now,
      runtimeActivityAt: null,
      currentRuntimeActivityAt: () => null,
      probe: async () => ({ attemptId: "same-probe", state: "unreachable", busy: false, compacting: false, pendingMessageCount: 0, activityAt: null, acknowledgedWait: null, confirmedDead: false }),
      intervene: async () => stopped,
      isCurrent: () => true,
      silenceMs: 10_000,
      retryMs: 2_000
    });
  }
  assert.equal(current.watchdogProbeFailures, 1);
  assert.equal(current.watchdogIntervenedAt, undefined);
});

test("repeated distinct failures recover once and queue Butler immediately", async () => {
  const current = callback({ lastEventAt: 1_000 });
  let interventions = 0;
  for (const now of [11_000, 13_000, 15_000]) {
    await reconcileWorkerWatchdog({
      callback: current,
      thread: thread("reasoning"),
      now,
      runtimeActivityAt: null,
      currentRuntimeActivityAt: () => null,
      probe: async () => ({ attemptId: `probe-${now}`, state: "unreachable", busy: false, compacting: false, pendingMessageCount: 0, activityAt: null, acknowledgedWait: null, confirmedDead: false }),
      intervene: async () => { interventions += 1; return stopped; },
      isCurrent: () => true,
      silenceMs: 10_000,
      retryMs: 2_000,
      maxProbeFailures: 3
    });
  }
  assert.equal(interventions, 1);
  assert.equal(current.callbackState, "missing_worker_callback");
  assert.equal(current.reviewState, "queued");
  assert.equal(current.reviewReason, "thread_recovery");
  assert.equal(current.watchdogIntervenedAt, 15_000);
});

test("an acknowledged long operation gets an extended failure grace before recovery", async () => {
  const current = callback({ lastEventAt: 1_000 });
  let interventions = 0;
  for (const now of [11_000, 13_000, 15_000, 17_000, 19_000]) {
    const result = await reconcileWorkerWatchdog({
      callback: current,
      thread: thread("commandExecution"),
      now,
      runtimeActivityAt: null,
      currentRuntimeActivityAt: () => null,
      probe: async () => ({ attemptId: `probe-${now}`, state: "unreachable", busy: false, compacting: false, pendingMessageCount: 0, activityAt: null, acknowledgedWait: null, confirmedDead: false }),
      intervene: async () => { interventions += 1; return stopped; },
      isCurrent: () => true,
      silenceMs: 10_000,
      retryMs: 2_000,
      maxProbeFailures: 3
    });
    assert.equal(result.recovered, false);
  }
  assert.equal(interventions, 0);
  assert.equal(current.watchdogProbeFailures, 5);
  assert.equal(current.watchdogProtectedOperation, "commandExecution");

  const recovered = await reconcileWorkerWatchdog({
    callback: current,
    thread: thread("commandExecution"),
    now: 21_000,
    runtimeActivityAt: null,
    currentRuntimeActivityAt: () => null,
    probe: async () => ({ attemptId: "probe-21000", state: "unreachable", busy: false, compacting: false, pendingMessageCount: 0, activityAt: null, acknowledgedWait: null, confirmedDead: false }),
    intervene: async () => { interventions += 1; return stopped; },
    isCurrent: () => true,
    silenceMs: 10_000,
    retryMs: 2_000,
    maxProbeFailures: 3
  });
  assert.equal(recovered.recovered, true);
  assert.equal(interventions, 1);
});

test("a failed intervention leaves the Worker active and callback waiting", async () => {
  const current = callback({
    lastEventAt: 1_000,
    watchdogProbeFailures: 2,
    watchdogLastProbeAt: 13_000,
    watchdogLastProbeId: "probe-2",
    watchdogProbeState: "unreachable"
  });
  const result = await reconcileWorkerWatchdog({
    callback: current,
    thread: thread("reasoning"),
    now: 15_000,
    runtimeActivityAt: null,
    currentRuntimeActivityAt: () => null,
    probe: async () => ({ attemptId: "probe-3", state: "unreachable", busy: false, compacting: false, pendingMessageCount: 0, activityAt: null, acknowledgedWait: null, confirmedDead: false }),
    intervene: async () => ({ state: "failed", detail: "interrupt failed" }),
    isCurrent: () => true,
    silenceMs: 10_000,
    retryMs: 2_000
  });
  assert.equal(result.recovered, false);
  assert.equal(current.callbackState, "waiting");
  assert.equal(current.watchdogIntervenedAt, undefined);
  assert.equal(current.watchdogProbeFailures, 3);
  assert.equal(current.watchdogAttentionAt, 15_000);
  assert.equal(current.watchdogAttentionReason, "interrupt failed");
  assert.equal(current.watchdogInterventionFailures, 1);
  assert.equal(result.attentionRequired, true);
  assert.equal(workerWatchdogProbeDue(current, 25_000, { silenceMs: 10_000, retryMs: 2_000 }), true);

  const healthyAgain = await reconcileWorkerWatchdog({
    callback: current,
    thread: thread("reasoning"),
    now: 25_000,
    runtimeActivityAt: null,
    currentRuntimeActivityAt: () => null,
    probe: async () => ({ attemptId: "probe-4", state: "busy", busy: true, compacting: false, pendingMessageCount: 0, activityAt: null, acknowledgedWait: null, confirmedDead: false }),
    intervene: async () => stopped,
    isCurrent: () => true,
    silenceMs: 10_000,
    retryMs: 2_000
  });
  assert.equal(healthyAgain.recovered, false);
  assert.equal(current.callbackState, "waiting");
  assert.equal(current.watchdogAttentionAt, null);
  assert.equal(current.watchdogInterventionFailures, 0);
});

test("activity arriving during a failed probe invalidates its result", async () => {
  const current = callback({ lastEventAt: 1_000 });
  let runtimeActivityAt: number | null = null;
  let resolveProbe!: (value: {
    attemptId: "probe-late";
    state: "unreachable";
    busy: false;
    compacting: false;
    pendingMessageCount: 0;
    activityAt: null;
    acknowledgedWait: null;
    confirmedDead: false;
  }) => void;
  const probe = new Promise<Parameters<typeof resolveProbe>[0]>((resolve) => { resolveProbe = resolve; });
  const checking = reconcileWorkerWatchdog({
    callback: current,
    thread: thread("reasoning"),
    now: 11_000,
    runtimeActivityAt: null,
    currentRuntimeActivityAt: () => runtimeActivityAt,
    probe: () => probe,
    intervene: async () => stopped,
    isCurrent: () => true,
    silenceMs: 10_000
  });
  runtimeActivityAt = 11_001;
  resolveProbe({ attemptId: "probe-late", state: "unreachable", busy: false, compacting: false, pendingMessageCount: 0, activityAt: null, acknowledgedWait: null, confirmedDead: false });
  const result = await checking;
  assert.equal(result.recovered, false);
  assert.equal(current.lastEventAt, 11_001);
  assert.equal(current.watchdogProbeFailures, 0);
});

test("a late probe result cannot mutate a closed or disposed callback", async () => {
  const current = callback({ lastEventAt: 1_000 });
  let active = true;
  let interventions = 0;
  let resolveProbe!: (value: {
    attemptId: "probe-stale";
    state: "idle";
    busy: false;
    compacting: false;
    pendingMessageCount: 0;
    activityAt: null;
    acknowledgedWait: null;
    confirmedDead: false;
  }) => void;
  const probe = new Promise<Parameters<typeof resolveProbe>[0]>((resolve) => { resolveProbe = resolve; });
  const checking = reconcileWorkerWatchdog({
    callback: current,
    thread: thread("reasoning"),
    now: 11_000,
    runtimeActivityAt: null,
    currentRuntimeActivityAt: () => null,
    probe: () => probe,
    intervene: async () => { interventions += 1; return stopped; },
    isCurrent: () => active,
    silenceMs: 10_000
  });
  active = false;
  resolveProbe({ attemptId: "probe-stale", state: "idle", busy: false, compacting: false, pendingMessageCount: 0, activityAt: null, acknowledgedWait: null, confirmedDead: false });
  const result = await checking;
  assert.equal(result.recovered, false);
  assert.equal(interventions, 0);
  assert.equal(current.watchdogProbeState, undefined);
});
