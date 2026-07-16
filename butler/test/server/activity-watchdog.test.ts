import assert from "node:assert/strict";
import test from "node:test";

import { ActivityWatchdogService } from "../../src/server/activity-watchdog.js";

test("registered callbacks run at their own intervals", (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const watchdog = new ActivityWatchdogService();
  let fastChecks = 0;
  let slowChecks = 0;

  watchdog.register({ id: "fast", policy: "callback-review-currency", callback: () => { fastChecks += 1; } });
  watchdog.register({ id: "slow", policy: "review-activity", callback: () => { slowChecks += 1; } });

  t.mock.timers.tick(200);

  assert.equal(fastChecks, 4);
  assert.equal(slowChecks, 2);
  assert.equal(watchdog.size, 2);
  watchdog.clear();
});

test("a registration can unregister itself", (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const watchdog = new ActivityWatchdogService();
  let checks = 0;
  const registration = watchdog.register({
    id: "worker",
    policy: "review-activity",
    maxIntervalMs: 10,
    callback: () => { checks += 1; }
  });

  t.mock.timers.tick(20);
  registration.unregister();
  t.mock.timers.tick(20);

  assert.equal(checks, 2);
  assert.equal(watchdog.size, 0);
});

test("duplicate ids and invalid registrations are rejected", () => {
  const watchdog = new ActivityWatchdogService();
  watchdog.register({ id: "worker", policy: "review-activity", callback: () => undefined });

  assert.throws(
    () => watchdog.register({ id: "worker", policy: "review-activity", callback: () => undefined }),
    /already exists/
  );
  assert.throws(
    () => watchdog.register({ id: "other", policy: "review-activity", maxIntervalMs: 0, callback: () => undefined }),
    /greater than zero/
  );
  assert.throws(
    () => watchdog.register({ id: " ", policy: "review-activity", callback: () => undefined }),
    /id is required/
  );
  watchdog.clear();
});

test("clear unregisters every item", (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const watchdog = new ActivityWatchdogService();
  let checks = 0;
  watchdog.register({ id: "one", policy: "review-activity", maxIntervalMs: 10, callback: () => { checks += 1; } });
  watchdog.register({ id: "two", policy: "review-activity", maxIntervalMs: 10, callback: () => { checks += 1; } });

  watchdog.clear();
  t.mock.timers.tick(30);

  assert.equal(checks, 0);
  assert.equal(watchdog.size, 0);
});

test("snapshot exposes policy metadata and live check counts without timer handles", (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const watchdog = new ActivityWatchdogService();
  watchdog.register({
    id: "delegation:worker-one",
    policy: "delegation-reconciliation",
    target: "worker-one",
    maxIntervalMs: 10,
    callback: () => undefined
  });

  t.mock.timers.tick(20);
  const snapshot = watchdog.snapshot();

  assert.equal(snapshot.length, 1);
  assert.deepEqual(snapshot[0], {
    id: "delegation:worker-one",
    policy: "delegation-reconciliation",
    label: "Worker handoff",
    target: "worker-one",
    intervalMs: 10,
    registeredAt: snapshot[0]?.registeredAt,
    lastCheckedAt: snapshot[0]?.lastCheckedAt,
    checkCount: 2
  });
  assert.equal("timer" in (snapshot[0] ?? {}), false);
  snapshot[0]!.checkCount = 999;
  assert.equal(watchdog.snapshot()[0]?.checkCount, 2);
  watchdog.clear();
});
