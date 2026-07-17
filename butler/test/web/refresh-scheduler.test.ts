import assert from "node:assert/strict";
import test from "node:test";

import { createRefreshScheduler } from "../../src/web/refresh-scheduler.js";

test("a replacement aborts a stale refresh and runs a trailing refresh", async () => {
  let settleFirst: (() => void) | null = null;
  const signals: AbortSignal[] = [];
  const scheduler = createRefreshScheduler((signal) => {
    signals.push(signal);
    if (signals.length > 1) return Promise.resolve();
    return new Promise<void>((resolve) => { settleFirst = resolve; });
  });

  scheduler.request();
  scheduler.request(true);
  assert.equal(signals.length, 1);
  assert.equal(signals[0]?.aborted, true);

  settleFirst?.();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(signals.length, 2);
  assert.equal(signals[1]?.aborted, false);
  scheduler.dispose();
});

test("disposing prevents a queued refresh", async () => {
  let settle: (() => void) | null = null;
  let refreshes = 0;
  const scheduler = createRefreshScheduler(() => {
    refreshes += 1;
    return new Promise<void>((resolve) => { settle = resolve; });
  });

  scheduler.request();
  scheduler.request();
  scheduler.dispose();
  settle?.();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(refreshes, 1);
});
