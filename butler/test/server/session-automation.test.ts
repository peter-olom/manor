import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { PairStore } from "../../src/server/pair-store.js";
import { SessionAutomationScheduler } from "../../src/server/session-automation-scheduler.js";
import { createOnceSchedule, createWeeklySchedule, createWindowSchedule, nextAutomationRunAt, nextDailyRunAt, normalizeDailyTimes, upcomingAutomationRuns, withAutomationLabels } from "../../src/server/session-automation.js";
import { ButlerStateStore } from "../../src/server/state-store.js";
import { setActiveManorSettings } from "../../src/server/manor-settings-runtime.js";
import { normalizeManorSettings } from "../../src/server/manor-settings-schema.js";

async function createStore() {
  const directory = await mkdtemp(path.join(tmpdir(), "manor-automation-test-"));
  const state = new ButlerStateStore(path.join(directory, "state.json"));
  const pairPath = path.join(directory, "pairs.json");
  const pairs = new PairStore(pairPath, state);
  await pairs.load();
  return { pairs, pairPath, state };
}

test("daily automation times are validated, deduplicated, and use the operator wall clock (UTC by default)", () => {
  assert.deepEqual(normalizeDailyTimes(["18:00", "12:00", "18:00"]), ["12:00", "18:00"]);
  assert.throws(() => normalizeDailyTimes(["24:00"]), /HH:mm/);
  const morning = Date.UTC(2026, 6, 14, 11, 30);
  assert.equal(nextDailyRunAt(["12:00", "18:00"], morning), Date.UTC(2026, 6, 14, 12, 0));
  assert.equal(nextDailyRunAt(["12:00", "18:00"], Date.UTC(2026, 6, 14, 18, 0)), Date.UTC(2026, 6, 15, 12, 0));
});

test("daily automation can run indefinitely or through an inclusive local end date", async () => {
  const { pairs } = await createStore();
  const pair = pairs.createPair();
  const after = Date.UTC(2026, 7, 2, 18, 0);
  const unbounded = pairs.configureAutomation(pair.id, { instruction: "Daily", dailyTimes: ["17:00"] }, after)!;
  assert.deepEqual(unbounded.automation?.schedule, { kind: "daily", times: ["17:00"] });
  assert.equal(unbounded.automation?.nextRunAt, Date.UTC(2026, 7, 3, 17, 0));

  const bounded = pairs.configureAutomation(pair.id, { instruction: "Bounded", dailyTimes: ["17:00"], endDate: "2026-08-03" }, after)!;
  assert.equal(bounded.automation?.nextRunAt, Date.UTC(2026, 7, 3, 17, 0));
  const run = pairs.claimAutomationRun(pair.id, bounded.automation!.id, Date.UTC(2026, 7, 3, 17, 0))!;
  pairs.finishAutomationRun(pair.id, bounded.automation!.id, run.id, { outcome: "succeeded", summary: "done" }, Date.UTC(2026, 7, 3, 17, 1));
  assert.equal(pairs.getPair(pair.id)?.automation?.nextRunAt, null);
  assert.equal(pairs.getPair(pair.id)?.automation?.state, "completed");
});

test("daily windows include both boundaries and preserve cross-midnight ownership", () => {
  const schedule = createWindowSchedule(60, "19:00", "00:00", "2026-08-03");
  assert.deepEqual(
    upcomingAutomationRuns(schedule, Date.UTC(2026, 7, 3, 18, 30), "UTC", 6),
    [19, 20, 21, 22, 23].map((hour) => Date.UTC(2026, 7, 3, hour)).concat(Date.UTC(2026, 7, 4, 0))
  );
  assert.equal(nextAutomationRunAt(schedule, Date.UTC(2026, 7, 4, 0), "UTC"), null);
});

test("a singular weekday is one-off while plural weekdays recur weekly", async () => {
  const friday = Date.UTC(2026, 6, 17, 10, 0);
  const once = createOnceSchedule("sunday", "17:00", friday, "UTC");
  assert.deepEqual(once, { kind: "once", date: "2026-07-19", time: "17:00" });
  assert.equal(nextAutomationRunAt(once, friday, "UTC"), Date.UTC(2026, 6, 19, 17, 0));
  assert.equal(nextAutomationRunAt(once, Date.UTC(2026, 6, 19, 17, 0), "UTC"), null);

  const weekly = createWeeklySchedule(["sunday"], ["17:00"]);
  assert.equal(nextAutomationRunAt(weekly, friday, "UTC"), Date.UTC(2026, 6, 19, 17, 0));
  assert.equal(nextAutomationRunAt(weekly, Date.UTC(2026, 6, 19, 17, 0), "UTC"), Date.UTC(2026, 6, 26, 17, 0));
  const boundedWeekly = createWeeklySchedule(["sunday"], ["17:00"], "2026-07-19");
  assert.equal(nextAutomationRunAt(boundedWeekly, friday, "UTC"), Date.UTC(2026, 6, 19, 17, 0));
  assert.equal(nextAutomationRunAt(boundedWeekly, Date.UTC(2026, 6, 19, 17, 0), "UTC"), null);
});

test("calendar schedules recompute immediately when the operator timezone changes", async (t) => {
  setActiveManorSettings(normalizeManorSettings({ overview: { operatorTimezone: "Europe/Berlin" } }));
  t.after(() => setActiveManorSettings(null));
  const { pairs } = await createStore();
  const now = Date.UTC(2026, 6, 17, 10, 0);
  const oncePair = pairs.createPair();
  const weeklyPair = pairs.createPair();
  const windowPair = pairs.createPair();
  pairs.configureOnceAutomation(oncePair.id, { instruction: "Once", on: "2026-07-19", time: "17:00" }, now);
  pairs.configureWeeklyAutomation(weeklyPair.id, { instruction: "Weekly", weekdays: ["sunday"], times: ["17:00"] }, now);
  pairs.configureWindowAutomation(windowPair.id, { instruction: "Window", everyMinutes: 60, startTime: "19:00", endTime: "00:00" }, now);
  assert.equal(pairs.getPair(oncePair.id)?.automation?.nextRunAt, Date.UTC(2026, 6, 19, 15, 0));
  assert.equal(pairs.getPair(weeklyPair.id)?.automation?.nextRunAt, Date.UTC(2026, 6, 19, 15, 0));
  assert.equal(pairs.getPair(windowPair.id)?.automation?.nextRunAt, Date.UTC(2026, 6, 17, 17, 0));

  setActiveManorSettings(normalizeManorSettings({ overview: { operatorTimezone: "America/New_York" } }));
  assert.equal(pairs.recomputeAutomationSchedules(now), 3);
  assert.equal(pairs.getPair(oncePair.id)?.automation?.nextRunAt, Date.UTC(2026, 6, 19, 21, 0));
  assert.equal(pairs.getPair(weeklyPair.id)?.automation?.nextRunAt, Date.UTC(2026, 6, 19, 21, 0));
  assert.equal(pairs.getPair(windowPair.id)?.automation?.nextRunAt, Date.UTC(2026, 6, 17, 23, 0));
});

test("a delayed daily window run advances to the next future slot without replaying backlog", async () => {
  const { pairs } = await createStore();
  const pair = pairs.createPair();
  const configured = pairs.configureWindowAutomation(pair.id, { instruction: "Window", everyMinutes: 60, startTime: "19:00", endTime: "00:00" }, Date.UTC(2026, 6, 17, 18, 30))!;
  const run = pairs.claimAutomationRun(pair.id, configured.automation!.id, Date.UTC(2026, 6, 17, 21, 30))!;
  assert.equal(run.scheduledFor, Date.UTC(2026, 6, 17, 19, 0));
  assert.equal(pairs.getPair(pair.id)?.automation?.nextRunAt, Date.UTC(2026, 6, 17, 22, 0));

  const boundaryPair = pairs.createPair();
  const boundary = pairs.configureWindowAutomation(boundaryPair.id, { instruction: "Boundary", everyMinutes: 60, startTime: "19:00", endTime: "00:00" }, Date.UTC(2026, 6, 17, 22, 30))!;
  const boundaryRun = pairs.claimAutomationRun(boundaryPair.id, boundary.automation!.id, Date.UTC(2026, 6, 17, 23, 0))!;
  pairs.finishAutomationRun(boundaryPair.id, boundary.automation!.id, boundaryRun.id, { outcome: "succeeded", summary: "done" }, Date.UTC(2026, 6, 17, 23, 1));
  assert.equal(pairs.getPair(boundaryPair.id)?.automation?.nextRunAt, Date.UTC(2026, 6, 18, 0, 0));
});

test("new calendar schedule kinds persist and reload without losing their bounds", async () => {
  const { pairs, pairPath, state } = await createStore();
  const pair = pairs.createPair();
  pairs.configureWeeklyAutomation(pair.id, { instruction: "Weekly", weekdays: ["sunday"], times: ["17:00"], endDate: "2026-08-03" }, Date.UTC(2026, 6, 17, 10, 0));
  await pairs.flushPendingSave();
  const reloaded = new PairStore(pairPath, state);
  await reloaded.load();
  assert.deepEqual(reloaded.getPair(pair.id)?.automation?.schedule, { kind: "weekly", weekdays: ["sunday"], times: ["17:00"], endsOn: "2026-08-03" });
});

test("a bounded daily automation never dispatches after its overall end date", async () => {
  const { pairs } = await createStore();
  const pair = pairs.createPair();
  const configured = pairs.configureAutomation(pair.id, { instruction: "Hourly", dailyTimes: ["08:00", "09:00", "10:00", "11:00", "12:00", "13:00", "14:00", "15:00", "16:00", "17:00"], endDate: "2026-07-18" }, Date.UTC(2026, 6, 18, 7, 0))!;
  assert.equal(configured.automation?.nextRunAt, Date.UTC(2026, 6, 18, 8, 0));
  assert.equal(pairs.claimAutomationRun(pair.id, configured.automation!.id, Date.UTC(2026, 6, 19, 8, 0)), null);
  assert.equal(pairs.getPair(pair.id)?.automation?.state, "completed");
  assert.match(pairs.getPair(pair.id)?.automation?.lastRun?.summary ?? "", /ended before this delayed run/);
});

test("scheduler expires a bounded automation even while its session remains busy", async () => {
  const { pairs } = await createStore();
  const pair = pairs.createPair();
  const configured = pairs.configureAutomation(pair.id, {
    instruction: "Hourly",
    dailyTimes: ["08:00", "09:00", "10:00", "11:00", "12:00", "13:00", "14:00", "15:00", "16:00", "17:00"],
    endDate: "2026-07-18"
  }, Date.UTC(2026, 6, 18, 7, 0))!;
  const dispatched: string[] = [];
  const scheduler = new SessionAutomationScheduler({
    pairStore: pairs,
    now: () => Date.UTC(2026, 6, 19, 8, 0),
    isBusy: async () => true,
    dispatch: async ({ pairId }) => {
      dispatched.push(pairId);
      return { outcome: "succeeded", summary: "Done" };
    }
  });

  await scheduler.tick();

  assert.deepEqual(dispatched, []);
  assert.equal(pairs.getPair(pair.id)?.automation?.id, configured.automation?.id);
  assert.equal(pairs.getPair(pair.id)?.automation?.state, "completed");
  assert.equal(pairs.getPair(pair.id)?.automation?.nextRunAt, null);
});

test("daily automation times interpret in the operator timezone with DST awareness", () => {
  // Europe/Berlin is UTC+1 (CET) in winter and UTC+2 (CEST) in summer.
  const winterAfter = Date.UTC(2026, 0, 15, 7, 30); // 08:30 Berlin
  assert.equal(nextDailyRunAt(["09:00"], winterAfter, "Europe/Berlin"), Date.UTC(2026, 0, 15, 8, 0));
  const summerAfter = Date.UTC(2026, 6, 15, 6, 30); // 08:30 Berlin (CEST)
  assert.equal(nextDailyRunAt(["09:00"], summerAfter, "Europe/Berlin"), Date.UTC(2026, 6, 15, 7, 0));
  // A daily time inside the spring-forward gap (02:30 Berlin on 2026-03-29 does
  // not exist) still resolves to a valid later instant without throwing.
  const gapAfter = Date.UTC(2026, 2, 29, 0, 45); // 01:45 CET, after the old implementation's early result
  assert.equal(nextDailyRunAt(["02:30"], gapAfter, "Europe/Berlin"), Date.UTC(2026, 2, 29, 1, 30)); // 03:30 CEST
});

test("nextDailyRunAt keeps the later fold occurrence when the earlier one has already passed", () => {
  // Europe/Berlin falls back on 2026-10-25 03:00->02:00 CEST->CET, so 02:30
  // occurs twice: 00:30 UTC (CEST) and 01:30 UTC (CET). After 01:00 UTC the
  // earlier occurrence has passed, so the next 02:30 is the 01:30 UTC (02:30 CET)
  // occurrence — not skipped to the next day.
  assert.equal(nextDailyRunAt(["02:30"], Date.UTC(2026, 9, 25, 1, 0), "Europe/Berlin"), Date.UTC(2026, 9, 25, 1, 30));
  // Before the fold, the earlier occurrence is returned.
  assert.equal(nextDailyRunAt(["02:30"], Date.UTC(2026, 9, 25, 0, 0), "Europe/Berlin"), Date.UTC(2026, 9, 25, 0, 30));
});

test("upcoming runs show a folded wall-clock slot only once", () => {
  assert.deepEqual(
    upcomingAutomationRuns({ kind: "daily", times: ["02:30"] }, Date.UTC(2026, 9, 25, 0, 0), "Europe/Berlin", 2),
    [Date.UTC(2026, 9, 25, 0, 30), Date.UTC(2026, 9, 26, 1, 30)]
  );
});

test("nextDailyRunAt orders multiple folded slots by real instant", () => {
  // At 02:15 during Berlin's first folded hour, 02:30 CEST happens before the
  // second 02:10 CET even though 02:10 sorts first as wall-clock text.
  assert.equal(
    nextDailyRunAt(["02:10", "02:30"], Date.UTC(2026, 9, 25, 0, 15), "Europe/Berlin"),
    Date.UTC(2026, 9, 25, 0, 30)
  );
});

test("a folded daily slot runs once per local day", async (t) => {
  setActiveManorSettings(normalizeManorSettings({ overview: { operatorTimezone: "Europe/Berlin" } }));
  t.after(() => setActiveManorSettings(null));
  const { pairs } = await createStore();
  const pair = pairs.createPair();
  const configured = pairs.configureAutomation(pair.id, { instruction: "Fold", dailyTimes: ["02:30"] }, Date.UTC(2026, 9, 24, 23, 0))!;
  assert.equal(configured.automation!.nextRunAt, Date.UTC(2026, 9, 25, 0, 30));
  const run = pairs.claimAutomationRun(pair.id, configured.automation!.id, Date.UTC(2026, 9, 25, 0, 31))!;
  pairs.finishAutomationRun(pair.id, configured.automation!.id, run.id, { outcome: "succeeded", summary: "done" }, Date.UTC(2026, 9, 25, 0, 40));
  assert.equal(pairs.getPair(pair.id)?.automation?.nextRunAt, Date.UTC(2026, 9, 26, 1, 30));
});

test("changing the operator timezone recomputes already-scheduled daily runs in real time", async (t) => {
  // The Settings UI persists overview.operatorTimezone; the settings-apply hook
  // calls PairStore.recomputeAutomationSchedules so enabled daily automations move
  // to the new zone without a restart. Labels update live even before that.
  setActiveManorSettings(normalizeManorSettings({ overview: { operatorTimezone: "Europe/Berlin" } }));
  t.after(() => setActiveManorSettings(null));
  const { pairs } = await createStore();
  const pair = pairs.createPair();
  const after = Date.UTC(2026, 0, 15, 7, 30); // 08:30 Berlin
  const configured = pairs.configureAutomation(pair.id, { instruction: "Report", dailyTimes: ["09:00"] }, after)!;
  assert.equal(configured.automation!.nextRunAt, Date.UTC(2026, 0, 15, 8, 0)); // 09:00 Berlin = 08:00 UTC

  // Operator switches timezone to America/New_York (UTC-5 in winter).
  setActiveManorSettings(normalizeManorSettings({ overview: { operatorTimezone: "America/New_York" } }));

  // Labels already render in the new timezone immediately (live re-read)...
  assert.match(pairs.getPair(pair.id)?.automation?.nextRunLabel ?? "", /Jan 15, 3:00 AM UTC-5$/);
  // ...and the settings-change hook recomputes the stored nextRunAt into the new zone.
  const changed = pairs.recomputeAutomationSchedules(after);
  assert.equal(changed, 1);
  assert.equal(pairs.getPair(pair.id)?.automation?.nextRunAt, Date.UTC(2026, 0, 15, 14, 0)); // 09:00 New York = 14:00 UTC
});

test("recomputeAutomationSchedules skips running automations and interval schedules", async (t) => {
  setActiveManorSettings(normalizeManorSettings({ overview: { operatorTimezone: "Europe/Berlin" } }));
  t.after(() => setActiveManorSettings(null));
  const { pairs } = await createStore();
  const daily = pairs.createPair({ title: "Daily" });
  const interval = pairs.createPair({ title: "Interval" });
  const base = Date.UTC(2026, 0, 15, 7, 0); // 08:00 Berlin
  const configuredDaily = pairs.configureAutomation(daily.id, { instruction: "Daily", dailyTimes: ["09:00"] }, base)!;
  pairs.configureIntervalAutomation(interval.id, { instruction: "Interval", everyMinutes: 5, durationMinutes: 30 }, base);
  // Claim the daily run (due at 08:00 UTC) so it is running and its nextRunAt advances.
  pairs.claimAutomationRun(daily.id, configuredDaily.automation!.id, Date.UTC(2026, 0, 15, 8, 1));
  const dailyNextRun = pairs.getPair(daily.id)?.automation?.nextRunAt;
  const intervalNextRun = pairs.getPair(interval.id)?.automation?.nextRunAt;

  setActiveManorSettings(normalizeManorSettings({ overview: { operatorTimezone: "America/New_York" } }));
  const changed = pairs.recomputeAutomationSchedules(Date.UTC(2026, 0, 15, 8, 10));
  // The running daily automation and the (non-daily) interval are both skipped.
  assert.equal(changed, 0);
  assert.equal(pairs.getPair(daily.id)?.automation?.nextRunAt, dailyNextRun);
  assert.equal(pairs.getPair(interval.id)?.automation?.nextRunAt, intervalNextRun);
});

test("a running daily automation adopts a timezone change when it finishes", async (t) => {
  setActiveManorSettings(normalizeManorSettings({ overview: { operatorTimezone: "Europe/Berlin" } }));
  t.after(() => setActiveManorSettings(null));
  const { pairs } = await createStore();
  const pair = pairs.createPair();
  const configured = pairs.configureAutomation(pair.id, { instruction: "Report", dailyTimes: ["09:00"] }, Date.UTC(2026, 0, 15, 7, 0))!;
  const run = pairs.claimAutomationRun(pair.id, configured.automation!.id, Date.UTC(2026, 0, 15, 8, 1))!;
  setActiveManorSettings(normalizeManorSettings({ overview: { operatorTimezone: "America/New_York" } }));
  pairs.finishAutomationRun(pair.id, configured.automation!.id, run.id, { outcome: "succeeded", summary: "done" }, Date.UTC(2026, 0, 15, 8, 5));
  assert.equal(pairs.getPair(pair.id)?.automation?.nextRunAt, Date.UTC(2026, 0, 16, 14, 0));
});

test("a gap-shifted run retains its configured slot across an active timezone change", async (t) => {
  setActiveManorSettings(normalizeManorSettings({ overview: { operatorTimezone: "Europe/Berlin" } }));
  t.after(() => setActiveManorSettings(null));
  const { pairs } = await createStore();
  const pair = pairs.createPair();
  const configured = pairs.configureAutomation(pair.id, { instruction: "Gap", dailyTimes: ["02:30"] }, Date.UTC(2026, 2, 29, 0, 0))!;
  const run = pairs.claimAutomationRun(pair.id, configured.automation!.id, Date.UTC(2026, 2, 29, 1, 31))!;
  assert.equal(run.scheduledSlot, "02:30");
  setActiveManorSettings(normalizeManorSettings({ overview: { operatorTimezone: "Africa/Abidjan" } }));
  pairs.finishAutomationRun(pair.id, configured.automation!.id, run.id, { outcome: "succeeded", summary: "done" }, Date.UTC(2026, 2, 29, 1, 35));
  assert.equal(pairs.getPair(pair.id)?.automation?.nextRunAt, Date.UTC(2026, 2, 30, 2, 30));
});

test("restart rederives a future persisted daily run in the active timezone", async (t) => {
  setActiveManorSettings(normalizeManorSettings({ overview: { operatorTimezone: "Europe/Berlin" } }));
  t.after(() => setActiveManorSettings(null));
  const { pairs, pairPath, state } = await createStore();
  const pair = pairs.createPair();
  pairs.configureAutomation(pair.id, { instruction: "Report", dailyTimes: ["09:00"] }, Date.UTC(2026, 0, 15, 7, 0));
  await pairs.flushPendingSave();

  setActiveManorSettings(normalizeManorSettings({ overview: { operatorTimezone: "America/New_York" } }));
  const reloaded = new PairStore(pairPath, state);
  await reloaded.load();
  reloaded.reconcileAutomationsAfterRestart(Date.UTC(2026, 0, 15, 7, 30));
  assert.equal(reloaded.getPair(pair.id)?.automation?.nextRunAt, Date.UTC(2026, 0, 15, 14, 0));
});

test("recomputeAutomationSchedules does not schedule a duplicate same-day run after today's run fired", async (t) => {
  setActiveManorSettings(normalizeManorSettings({ overview: { operatorTimezone: "Europe/Berlin" } }));
  t.after(() => setActiveManorSettings(null));
  const { pairs } = await createStore();
  const pair = pairs.createPair();
  // Berlin summer (CEST, UTC+2): daily 09:00 = 07:00 UTC.
  const configured = pairs.configureAutomation(pair.id, { instruction: "Report", dailyTimes: ["09:00"] }, Date.UTC(2026, 6, 15, 6, 0))!;
  assert.equal(configured.automation!.nextRunAt, Date.UTC(2026, 6, 15, 7, 0));
  // Today's run fires at 07:05 UTC (09:05 Berlin) and finishes.
  const run = pairs.claimAutomationRun(pair.id, configured.automation!.id, Date.UTC(2026, 6, 15, 7, 5))!;
  pairs.finishAutomationRun(pair.id, configured.automation!.id, run.id, { outcome: "succeeded", summary: "done" }, Date.UTC(2026, 6, 15, 7, 6));
  assert.equal(pairs.getPair(pair.id)?.automation?.nextRunAt, Date.UTC(2026, 6, 16, 7, 0)); // tomorrow 09:00 Berlin

  // Operator switches to America/New_York (EDT, UTC-4) at 08:00 UTC. 09:00 NY
  // today is 13:00 UTC, still ahead of now. Without the guard this would fire
  // AGAIN today; the dedup schedules tomorrow instead (same NY calendar day as
  // the finished run).
  setActiveManorSettings(normalizeManorSettings({ overview: { operatorTimezone: "America/New_York" } }));
  const changed = pairs.recomputeAutomationSchedules(Date.UTC(2026, 6, 15, 8, 0));
  assert.equal(changed, 1);
  assert.equal(pairs.getPair(pair.id)?.automation?.nextRunAt, Date.UTC(2026, 6, 16, 13, 0)); // 09:00 NY tomorrow, not today 13:00
});

test("recomputeAutomationSchedules leaves an overdue due-but-unfired run so the scheduler fires it", async (t) => {
  setActiveManorSettings(normalizeManorSettings({ overview: { operatorTimezone: "Europe/Berlin" } }));
  t.after(() => setActiveManorSettings(null));
  const { pairs } = await createStore();
  const pair = pairs.createPair();
  // Berlin winter (CET, UTC+1): daily 09:00 = 08:00 UTC.
  const configured = pairs.configureAutomation(pair.id, { instruction: "Report", dailyTimes: ["09:00"] }, Date.UTC(2026, 0, 15, 7, 0))!;
  const dueAt = Date.UTC(2026, 0, 15, 8, 0);
  assert.equal(configured.automation!.nextRunAt, dueAt);
  // "now" is after the scheduled time but the run never fired (overdue).
  const now = Date.UTC(2026, 0, 15, 10, 0); // 11:00 Berlin; run is 2h overdue
  assert.ok(dueAt <= now);

  // Operator switches to America/New_York. Without the guard the recompute would
  // move nextRunAt to tomorrow, silently dropping the overdue run. Instead it is
  // left due so the scheduler fires it now (catch-up), and the next cycle advances
  // into the new zone.
  setActiveManorSettings(normalizeManorSettings({ overview: { operatorTimezone: "America/New_York" } }));
  const changed = pairs.recomputeAutomationSchedules(now);
  assert.equal(changed, 0);
  assert.equal(pairs.getPair(pair.id)?.automation?.nextRunAt, dueAt);
});

test("an overdue daily run keeps its configured slot across a timezone change", async (t) => {
  setActiveManorSettings(normalizeManorSettings({ overview: { operatorTimezone: "Europe/Berlin" } }));
  t.after(() => setActiveManorSettings(null));
  const { pairs } = await createStore();
  const pair = pairs.createPair();
  const configured = pairs.configureAutomation(pair.id, { instruction: "Report", dailyTimes: ["09:00"] }, Date.UTC(2026, 0, 15, 7, 0))!;
  const dueAt = Date.UTC(2026, 0, 15, 8, 0);
  assert.equal(configured.automation!.nextRunAt, dueAt);

  const catchUpAt = Date.UTC(2026, 0, 15, 10, 0);
  setActiveManorSettings(normalizeManorSettings({ overview: { operatorTimezone: "America/New_York" } }));
  pairs.recomputeAutomationSchedules(catchUpAt);
  const run = pairs.claimAutomationRun(pair.id, configured.automation!.id, catchUpAt)!;
  assert.equal(run.scheduledSlot, "09:00");
  pairs.finishAutomationRun(pair.id, configured.automation!.id, run.id, { outcome: "succeeded", summary: "done" }, catchUpAt + 1);
  assert.equal(pairs.getPair(pair.id)?.automation?.nextRunAt, Date.UTC(2026, 0, 16, 14, 0));
});

test("recomputeAutomationSchedules keeps remaining same-day slots after one slot fires (multi-time schedule)", async (t) => {
  setActiveManorSettings(normalizeManorSettings({ overview: { operatorTimezone: "Europe/Berlin" } }));
  t.after(() => setActiveManorSettings(null));
  const { pairs } = await createStore();
  const pair = pairs.createPair();
  // Berlin summer (CEST, UTC+2): 09:00=07:00 UTC, 17:00=15:00 UTC.
  const configured = pairs.configureAutomation(pair.id, { instruction: "Report", dailyTimes: ["09:00", "17:00"] }, Date.UTC(2026, 6, 15, 6, 0))!;
  assert.equal(configured.automation!.nextRunAt, Date.UTC(2026, 6, 15, 7, 0)); // 09:00 Berlin today
  // 09:00 fires and finishes; nextRunAt advances to 17:00 Berlin today (15:00 UTC).
  const run = pairs.claimAutomationRun(pair.id, configured.automation!.id, Date.UTC(2026, 6, 15, 7, 5))!;
  assert.equal(run!.scheduledSlot, "09:00");
  pairs.finishAutomationRun(pair.id, configured.automation!.id, run.id, { outcome: "succeeded", summary: "done" }, Date.UTC(2026, 6, 15, 7, 6));
  assert.equal(pairs.getPair(pair.id)?.automation?.lastRun?.scheduledSlot, "09:00");
  assert.equal(pairs.getPair(pair.id)?.automation?.nextRunAt, Date.UTC(2026, 6, 15, 15, 0)); // 17:00 Berlin today

  // Operator switches to America/New_York (EDT, UTC-4) at 08:00 UTC. 09:00 NY today
  // is 13:00 UTC (still ahead). The per-slot dedup skips only the fired 09:00 slot
  // and keeps 17:00 NY today (21:00 UTC) — it must NOT drop to tomorrow.
  setActiveManorSettings(normalizeManorSettings({ overview: { operatorTimezone: "America/New_York" } }));
  const changed = pairs.recomputeAutomationSchedules(Date.UTC(2026, 6, 15, 8, 0));
  assert.equal(changed, 1);
  assert.equal(pairs.getPair(pair.id)?.automation?.nextRunAt, Date.UTC(2026, 6, 15, 21, 0)); // 17:00 NY today, not tomorrow
});

test("recomputeAutomationSchedules per-slot dedup handles schedules with 5+ daily times", async (t) => {
  setActiveManorSettings(normalizeManorSettings({ overview: { operatorTimezone: "Europe/Berlin" } }));
  t.after(() => setActiveManorSettings(null));
  const { pairs } = await createStore();
  const pair = pairs.createPair();
  const times = ["06:00", "09:00", "12:00", "15:00", "18:00"];
  // Berlin summer (UTC+2): 06:00=04:00 UTC.
  const configured = pairs.configureAutomation(pair.id, { instruction: "Report", dailyTimes: times }, Date.UTC(2026, 6, 15, 3, 0))!;
  assert.equal(configured.automation!.nextRunAt, Date.UTC(2026, 6, 15, 4, 0)); // 06:00 Berlin today
  // 06:00 fires; nextRunAt advances to 09:00 Berlin today (07:00 UTC).
  const run = pairs.claimAutomationRun(pair.id, configured.automation!.id, Date.UTC(2026, 6, 15, 4, 5))!;
  assert.equal(run!.scheduledSlot, "06:00");
  pairs.finishAutomationRun(pair.id, configured.automation!.id, run.id, { outcome: "succeeded", summary: "done" }, Date.UTC(2026, 6, 15, 4, 6));
  assert.equal(pairs.getPair(pair.id)?.automation?.nextRunAt, Date.UTC(2026, 6, 15, 7, 0)); // 09:00 Berlin today

  // Switch to America/New_York (EDT, UTC-4) at 05:00 UTC. The per-slot dedup skips
  // only the fired 06:00 slot and keeps the next same-day slot 09:00 NY (13:00 UTC).
  setActiveManorSettings(normalizeManorSettings({ overview: { operatorTimezone: "America/New_York" } }));
  const changed = pairs.recomputeAutomationSchedules(Date.UTC(2026, 6, 15, 5, 0));
  assert.equal(changed, 1);
  assert.equal(pairs.getPair(pair.id)?.automation?.nextRunAt, Date.UTC(2026, 6, 15, 13, 0)); // 09:00 NY today, not dropped
});

test("timezone recompute does not replay an earlier slot after a later slot fired", async (t) => {
  setActiveManorSettings(normalizeManorSettings({ overview: { operatorTimezone: "Europe/Berlin" } }));
  t.after(() => setActiveManorSettings(null));
  const { pairs } = await createStore();
  const pair = pairs.createPair();
  const configured = pairs.configureAutomation(pair.id, { instruction: "Report", dailyTimes: ["06:00", "09:00"] }, Date.UTC(2026, 6, 15, 3, 0))!;
  const first = pairs.claimAutomationRun(pair.id, configured.automation!.id, Date.UTC(2026, 6, 15, 4, 1))!;
  pairs.finishAutomationRun(pair.id, configured.automation!.id, first.id, { outcome: "succeeded", summary: "first" }, Date.UTC(2026, 6, 15, 4, 2));
  const second = pairs.claimAutomationRun(pair.id, configured.automation!.id, Date.UTC(2026, 6, 15, 7, 1))!;
  pairs.finishAutomationRun(pair.id, configured.automation!.id, second.id, { outcome: "succeeded", summary: "second" }, Date.UTC(2026, 6, 15, 7, 2));

  setActiveManorSettings(normalizeManorSettings({ overview: { operatorTimezone: "America/New_York" } }));
  pairs.recomputeAutomationSchedules(Date.UTC(2026, 6, 15, 9, 0)); // 05:00 EDT, before both local slots
  assert.equal(pairs.getPair(pair.id)?.automation?.nextRunAt, Date.UTC(2026, 6, 16, 10, 0));
});

test("automation labels render in the operator timezone with an offset suffix", () => {
  const winter = withAutomationLabels({
    id: "a", instruction: "Report", schedule: { kind: "daily", times: ["09:00"] },
    enabled: true, createdAt: 1, updatedAt: 1, nextRunAt: Date.UTC(2026, 0, 15, 8, 0), running: null, lastRun: null
  }, Date.UTC(2026, 0, 15, 7, 30), "Europe/Berlin");
  assert.equal(winter.scheduleLabel, "Daily at 9:00 AM");
  assert.match(winter.nextRunLabel ?? "", /Jan 15, 9:00 AM UTC\+1$/);
  const summer = withAutomationLabels({
    id: "a", instruction: "Report", schedule: { kind: "daily", times: ["09:00"] },
    enabled: true, createdAt: 1, updatedAt: 1, nextRunAt: Date.UTC(2026, 6, 15, 7, 0), running: null, lastRun: null
  }, Date.UTC(2026, 6, 15, 6, 30), "Europe/Berlin");
  assert.match(summer.nextRunLabel ?? "", /Jul 15, 9:00 AM UTC\+2$/);
  const utc = withAutomationLabels({
    id: "a", instruction: "Report", schedule: { kind: "daily", times: ["12:00"] },
    enabled: true, createdAt: 1, updatedAt: 1, nextRunAt: Date.UTC(2026, 6, 14, 12, 0), running: null, lastRun: null
  }, Date.UTC(2026, 6, 14, 11, 0));
  assert.match(utc.nextRunLabel ?? "", /Jul 14, 12:00 PM UTC$/);
});

test("pair automations persist and support pause, resume, and guarded run completion", async () => {
  const { pairs, pairPath, state } = await createStore();
  const pair = pairs.createPair({ title: "Daily report" });
  const configured = pairs.configureAutomation(pair.id, { instruction: "Prepare the report", dailyTimes: ["12:00", "18:00"] }, Date.UTC(2026, 6, 14, 10));
  assert.equal(configured?.automation?.scheduleLabel, "Daily at 12:00 PM, 6:00 PM");
  assert.ok(configured?.automation?.nextRunLabel?.endsWith("UTC"));
  assert.equal(pairs.setAutomationEnabled(pair.id, false)?.automation?.nextRunAt, null);
  const resumed = pairs.setAutomationEnabled(pair.id, true, Date.UTC(2026, 6, 14, 11))!;
  const run = pairs.claimAutomationRun(pair.id, resumed.automation!.id, Date.UTC(2026, 6, 14, 12, 1));
  assert.ok(run);
  assert.equal(pairs.claimAutomationRun(pair.id, resumed.automation!.id, Date.UTC(2026, 6, 14, 12, 2)), null);
  pairs.finishAutomationRun(pair.id, resumed.automation!.id, run!.id, { outcome: "succeeded", summary: "Saved." }, Date.UTC(2026, 6, 14, 12, 5));
  assert.equal(pairs.getPair(pair.id)?.automation?.lastRun?.outcome, "succeeded");
  await pairs.flushPendingSave();
  const reloaded = new PairStore(pairPath, state); await reloaded.load();
  assert.equal(reloaded.getPair(pair.id)?.automation?.instruction, "Prepare the report");
});

test("scheduler runs due work once and defers an active session until idle", async () => {
  const { pairs } = await createStore();
  const base = Date.UTC(2026, 6, 14, 7);
  const dueAt = Date.UTC(2026, 6, 14, 8, 1);
  const idle = pairs.createPair({ title: "Idle" });
  const busy = pairs.createPair({ title: "Busy" });
  pairs.configureAutomation(idle.id, { instruction: "Run idle task", dailyTimes: ["08:00"] }, base);
  pairs.configureAutomation(busy.id, { instruction: "Run busy task", dailyTimes: ["08:00"] }, base);
  let runtimeBusy = true;
  const dispatched: string[] = [];
  const scheduler = new SessionAutomationScheduler({
    pairStore: pairs, now: () => dueAt,
    isBusy: async (pair) => pair.id === busy.id && runtimeBusy,
    dispatch: async ({ pairId }) => { dispatched.push(pairId); return { outcome: "succeeded", summary: "Done" }; }
  });
  await scheduler.tick();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(dispatched, [idle.id]);
  assert.equal(pairs.getPair(idle.id)?.automation?.lastRun?.outcome, "succeeded");
  assert.equal(pairs.getPair(busy.id)?.automation?.lastRun, null);
  assert.equal(pairs.getPair(busy.id)?.automation?.nextRunAt, Date.UTC(2026, 6, 14, 8));
  await scheduler.tick();
  assert.deepEqual(dispatched, [idle.id]);
  runtimeBusy = false;
  await scheduler.tick();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(dispatched, [idle.id, busy.id]);
  assert.equal(pairs.getPair(busy.id)?.automation?.lastRun?.outcome, "succeeded");
});

test("scheduler persists its run claim before dispatch", async () => {
  const { pairs } = await createStore();
  const pair = pairs.createPair();
  const base = Date.UTC(2026, 6, 14, 7);
  const dueAt = Date.UTC(2026, 6, 14, 8, 1);
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
  const base = Date.UTC(2026, 6, 14, 7);
  const configured = pairs.configureAutomation(pair.id, { instruction: "Run once daily", dailyTimes: ["08:00"] }, base)!;
  pairs.claimAutomationRun(pair.id, configured.automation!.id, Date.UTC(2026, 6, 14, 8, 1));
  const restart = Date.UTC(2026, 6, 15, 9);
  pairs.reconcileAutomationsAfterRestart(restart);
  const recovered = pairs.getPair(pair.id)!.automation!;
  assert.equal(recovered.running, null);
  assert.equal(recovered.lastRun?.outcome, "skipped");
  assert.equal(recovered.lastRun?.summary, "Run was interrupted when Butler restarted.");
  assert.ok(recovered.nextRunAt! > restart);
});

test("bounded interval automation runs on anchored slots and completes at its deadline", async () => {
  const { pairs } = await createStore();
  const start = Date.UTC(2026, 6, 14, 20, 0);
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
