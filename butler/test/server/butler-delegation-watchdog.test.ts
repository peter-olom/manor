import assert from "node:assert/strict";
import test from "node:test";

import { ActivityWatchdogService } from "../../src/server/activity-watchdog.js";
import { ButlerDelegationWatchdogs } from "../../src/server/butler-delegation-watchdog.js";

test("delegation watchdogs check each outstanding job and remove settled jobs", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const watchdogs = new ActivityWatchdogService();
  const outstanding = new Set(["one", "two"]);
  const checks: string[] = [];
  const delegations = new ButlerDelegationWatchdogs({
    watchdogs,
    isOutstanding: (threadId) => outstanding.has(threadId),
    check: async (threadId) => { checks.push(threadId); },
    onError: (error) => { throw error; }
  });

  delegations.register("one");
  delegations.register("two");
  t.mock.timers.tick(10_000);
  await Promise.resolve();
  assert.deepEqual(checks.sort(), ["one", "two"]);

  outstanding.delete("one");
  t.mock.timers.tick(10_000);
  await Promise.resolve();
  assert.equal(watchdogs.size, 1);
  watchdogs.clear();
});

test("delegation watchdogs do not overlap checks for the same job", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const watchdogs = new ActivityWatchdogService();
  let checks = 0;
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  const delegations = new ButlerDelegationWatchdogs({
    watchdogs,
    isOutstanding: () => true,
    check: async () => { checks += 1; await blocked; },
    onError: (error) => { throw error; }
  });

  delegations.register("worker");
  t.mock.timers.tick(30_000);
  assert.equal(checks, 1);

  release();
  await Promise.resolve();
  await Promise.resolve();
  t.mock.timers.tick(10_000);
  assert.equal(checks, 2);
  watchdogs.clear();
});

test("re-registering a delegation preserves its in-flight check guard", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const watchdogs = new ActivityWatchdogService();
  let checks = 0;
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  const delegations = new ButlerDelegationWatchdogs({
    watchdogs,
    isOutstanding: () => true,
    check: async () => { checks += 1; await blocked; },
    onError: (error) => { throw error; }
  });

  delegations.register("worker");
  t.mock.timers.tick(10_000);
  assert.equal(checks, 1);

  delegations.register("worker");
  t.mock.timers.tick(30_000);
  assert.equal(checks, 1);

  release();
  await Promise.resolve();
  await Promise.resolve();
  t.mock.timers.tick(10_000);
  assert.equal(checks, 2);
  watchdogs.clear();
});
