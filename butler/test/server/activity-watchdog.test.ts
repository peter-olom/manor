import assert from "node:assert/strict";
import test from "node:test";

import { ActivityWatchdogService } from "../../src/server/activity-watchdog.js";

test("registered callbacks run at their own intervals", (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const watchdog = new ActivityWatchdogService();
  let fastChecks = 0;
  let slowChecks = 0;

  watchdog.register({ id: "fast", intervalMs: 10, callback: () => { fastChecks += 1; } });
  watchdog.register({ id: "slow", intervalMs: 25, callback: () => { slowChecks += 1; } });

  t.mock.timers.tick(50);

  assert.equal(fastChecks, 5);
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
    intervalMs: 10,
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
  watchdog.register({ id: "worker", intervalMs: 100, callback: () => undefined });

  assert.throws(
    () => watchdog.register({ id: "worker", intervalMs: 100, callback: () => undefined }),
    /already exists/
  );
  assert.throws(
    () => watchdog.register({ id: "other", intervalMs: 0, callback: () => undefined }),
    /greater than zero/
  );
  assert.throws(
    () => watchdog.register({ id: " ", intervalMs: 100, callback: () => undefined }),
    /id is required/
  );
  watchdog.clear();
});

test("clear unregisters every item", (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const watchdog = new ActivityWatchdogService();
  let checks = 0;
  watchdog.register({ id: "one", intervalMs: 10, callback: () => { checks += 1; } });
  watchdog.register({ id: "two", intervalMs: 10, callback: () => { checks += 1; } });

  watchdog.clear();
  t.mock.timers.tick(30);

  assert.equal(checks, 0);
  assert.equal(watchdog.size, 0);
});
