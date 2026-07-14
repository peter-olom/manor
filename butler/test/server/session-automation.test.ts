import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { PairStore } from "../../src/server/pair-store.js";
import { SessionAutomationScheduler } from "../../src/server/session-automation-scheduler.js";
import { nextDailyRunAt, normalizeDailyTimes, withAutomationLabels } from "../../src/server/session-automation.js";
import { ButlerStateStore } from "../../src/server/state-store.js";

async function createStore() {
  const directory = await mkdtemp(path.join(tmpdir(), "manor-automation-test-"));
  const state = new ButlerStateStore(path.join(directory, "state.json"));
  const pairPath = path.join(directory, "pairs.json");
  const pairs = new PairStore(pairPath, state);
  await pairs.load();
  return { pairs, pairPath, state };
}

test("daily automation times are validated, deduplicated, and use local wall clock", () => {
  assert.deepEqual(normalizeDailyTimes(["18:00", "12:00", "18:00"]), ["12:00", "18:00"]);
  assert.throws(() => normalizeDailyTimes(["24:00"]), /HH:mm/);
  const morning = new Date(2026, 6, 14, 11, 30).getTime();
  assert.equal(nextDailyRunAt(["12:00", "18:00"], morning), new Date(2026, 6, 14, 12, 0).getTime());
  assert.equal(nextDailyRunAt(["12:00", "18:00"], new Date(2026, 6, 14, 18, 0).getTime()), new Date(2026, 6, 15, 12, 0).getTime());
});

test("pair automations persist and support pause, resume, and guarded run completion", async () => {
  const { pairs, pairPath, state } = await createStore();
  const pair = pairs.createPair({ title: "Daily report" });
  const configured = pairs.configureAutomation(pair.id, { instruction: "Prepare the report", dailyTimes: ["12:00", "18:00"] }, new Date(2026, 6, 14, 10).getTime());
  assert.equal(configured?.automation?.scheduleLabel, "Daily at 12:00 PM, 6:00 PM");
  assert.ok(configured?.automation?.nextRunLabel?.endsWith("Butler clock"));
  assert.equal(pairs.setAutomationEnabled(pair.id, false)?.automation?.nextRunAt, null);
  const resumed = pairs.setAutomationEnabled(pair.id, true, new Date(2026, 6, 14, 11).getTime())!;
  const run = pairs.claimAutomationRun(pair.id, resumed.automation!.id, new Date(2026, 6, 14, 12, 1).getTime());
  assert.ok(run);
  assert.equal(pairs.claimAutomationRun(pair.id, resumed.automation!.id, new Date(2026, 6, 14, 12, 2).getTime()), null);
  pairs.finishAutomationRun(pair.id, resumed.automation!.id, run!.id, { outcome: "succeeded", summary: "Saved." }, new Date(2026, 6, 14, 12, 5).getTime());
  assert.equal(pairs.getPair(pair.id)?.automation?.lastRun?.outcome, "succeeded");
  await pairs.flushPendingSave();
  const reloaded = new PairStore(pairPath, state); await reloaded.load();
  assert.equal(reloaded.getPair(pair.id)?.automation?.instruction, "Prepare the report");
});

test("scheduler runs due work once and skips an active session", async () => {
  const { pairs } = await createStore();
  const base = new Date(2026, 6, 14, 7).getTime();
  const dueAt = new Date(2026, 6, 14, 8, 1).getTime();
  const idle = pairs.createPair({ title: "Idle" });
  const busy = pairs.createPair({ title: "Busy" });
  pairs.configureAutomation(idle.id, { instruction: "Run idle task", dailyTimes: ["08:00"] }, base);
  pairs.configureAutomation(busy.id, { instruction: "Run busy task", dailyTimes: ["08:00"] }, base);
  pairs.updatePairSnapshot(busy.id, { butlerPending: true, updatedAt: dueAt });
  const dispatched: string[] = [];
  const scheduler = new SessionAutomationScheduler({
    pairStore: pairs, now: () => dueAt,
    dispatch: async ({ pairId }) => { dispatched.push(pairId); return { outcome: "succeeded", summary: "Done" }; }
  });
  await scheduler.tick();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(dispatched, [idle.id]);
  assert.equal(pairs.getPair(idle.id)?.automation?.lastRun?.outcome, "succeeded");
  assert.equal(pairs.getPair(busy.id)?.automation?.lastRun?.outcome, "skipped");
  await scheduler.tick();
  assert.deepEqual(dispatched, [idle.id]);
});

test("scheduler persists its run claim before dispatch", async () => {
  const { pairs } = await createStore();
  const pair = pairs.createPair();
  const base = new Date(2026, 6, 14, 7).getTime();
  const dueAt = new Date(2026, 6, 14, 8, 1).getTime();
  pairs.configureAutomation(pair.id, { instruction: "Persist first", dailyTimes: ["08:00"] }, base);
  await pairs.flushPendingSave();
  let release!: () => void;
  const persisted = new Promise<void>((resolve) => { release = resolve; });
  const originalFlush = pairs.flushPendingSave.bind(pairs);
  pairs.flushPendingSave = () => persisted;
  const dispatched: string[] = [];
  const scheduler = new SessionAutomationScheduler({ pairStore: pairs, now: () => dueAt, dispatch: async ({ pairId }) => {
    dispatched.push(pairId); return { outcome: "succeeded", summary: "Done" };
  } });
  const tick = scheduler.tick();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(dispatched, []);
  release(); await tick; await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(dispatched, [pair.id]);
  pairs.flushPendingSave = originalFlush;
  await pairs.flushPendingSave();
});

test("restart recovery skips missed and interrupted runs without catch-up", async () => {
  const { pairs } = await createStore();
  const pair = pairs.createPair();
  const base = new Date(2026, 6, 14, 7).getTime();
  const configured = pairs.configureAutomation(pair.id, { instruction: "Run once daily", dailyTimes: ["08:00"] }, base)!;
  pairs.claimAutomationRun(pair.id, configured.automation!.id, new Date(2026, 6, 14, 8, 1).getTime());
  const restart = new Date(2026, 6, 15, 9).getTime();
  pairs.reconcileAutomationsAfterRestart(restart);
  const recovered = pairs.getPair(pair.id)!.automation!;
  assert.equal(recovered.running, null);
  assert.equal(recovered.lastRun?.outcome, "skipped");
  assert.equal(recovered.lastRun?.summary, "Run was interrupted when Butler restarted.");
  assert.ok(recovered.nextRunAt! > restart);
});

test("bounded interval automation runs on anchored slots and completes at its deadline", async () => {
  const { pairs } = await createStore();
  const start = new Date(2026, 6, 14, 20, 0).getTime();
  const pair = pairs.createPair();
  const configured = pairs.configureIntervalAutomation(pair.id, { instruction: "Check the score", everyMinutes: 5, durationMinutes: 30 }, start)!;
  assert.equal(configured.automation?.scheduleLabel, "Every 5 min for 30 min");
  assert.equal(configured.automation?.nextRunAt, start + 5 * 60_000);
  assert.equal(configured.automation?.schedule.kind, "interval");

  const first = pairs.claimAutomationRun(pair.id, configured.automation!.id, start + 7 * 60_000)!;
  assert.equal(first.scheduledFor, start + 5 * 60_000);
  assert.equal(pairs.getPair(pair.id)?.automation?.nextRunAt, start + 10 * 60_000);
  pairs.finishAutomationRun(pair.id, configured.automation!.id, first.id, { outcome: "succeeded", summary: "0–2" }, start + 8 * 60_000);

  const final = pairs.claimAutomationRun(pair.id, configured.automation!.id, start + 30 * 60_000)!;
  assert.equal(final.scheduledFor, start + 30 * 60_000);
  assert.equal(pairs.getPair(pair.id)?.automation?.nextRunAt, null);
  pairs.finishAutomationRun(pair.id, configured.automation!.id, final.id, { outcome: "succeeded", summary: "Full time" }, start + 31 * 60_000);
  const finished = pairs.getPair(pair.id)!.automation!;
  assert.equal(withAutomationLabels(finished, start + 31 * 60_000).state, "completed");
});

test("bounded interval automation validates load, pause, resume, and expiry", async () => {
  const { pairs } = await createStore();
  const start = Date.now() + 60 * 60_000;
  const pair = pairs.createPair();
  assert.throws(() => pairs.configureIntervalAutomation(pair.id, { instruction: "Too much", everyMinutes: 1, durationMinutes: 10_080 }, start), /288 runs/);
  const configured = pairs.configureIntervalAutomation(pair.id, { instruction: "Check", everyMinutes: 5, durationMinutes: 30 }, start)!;
  pairs.setAutomationEnabled(pair.id, false, start + 6 * 60_000);
  assert.equal(pairs.getPair(pair.id)?.automation?.state, "paused");
  pairs.setAutomationEnabled(pair.id, true, start + 11 * 60_000);
  assert.equal(pairs.getPair(pair.id)?.automation?.nextRunAt, start + 15 * 60_000);
  pairs.setAutomationEnabled(pair.id, false, start + 20 * 60_000);
  assert.throws(() => pairs.setAutomationEnabled(pair.id, true, start + 31 * 60_000), /has completed/);
  assert.equal(pairs.getPair(pair.id)?.automation?.nextRunAt, null);
  assert.equal(configured.automation?.schedule.kind, "interval");
});

test("restart advances bounded intervals without catch-up and expires old windows", async () => {
  const { pairs } = await createStore();
  const start = Date.now() + 60 * 60_000;
  const pair = pairs.createPair();
  const configured = pairs.configureIntervalAutomation(pair.id, { instruction: "Check", everyMinutes: 5, durationMinutes: 30 }, start)!;
  pairs.reconcileAutomationsAfterRestart(start + 12 * 60_000);
  assert.equal(pairs.getPair(pair.id)?.automation?.nextRunAt, start + 15 * 60_000);
  assert.equal(pairs.getPair(pair.id)?.automation?.lastRun?.summary, "Missed while Butler was offline.");
  pairs.reconcileAutomationsAfterRestart(start + 31 * 60_000);
  assert.equal(pairs.getPair(pair.id)?.automation?.nextRunAt, null);
  const expired = pairs.getPair(pair.id)!.automation!;
  assert.equal(withAutomationLabels(expired, start + 31 * 60_000).state, "completed");
  assert.equal(configured.automation?.id, pairs.getPair(pair.id)?.automation?.id);
});
