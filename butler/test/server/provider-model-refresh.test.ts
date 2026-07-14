import assert from "node:assert/strict";
import test from "node:test";

import { ProviderModelRefreshCoordinator } from "../../src/server/provider-model-refresh.js";

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test("provider model refresh waits for idle and coalesces requests", async (t) => {
  let idle = false;
  let refreshes = 0;
  const coordinator = new ProviderModelRefreshCoordinator({
    isIdle: () => idle,
    refresh: async () => { refreshes += 1; },
    retryMs: 5
  });
  t.after(() => coordinator.dispose());

  coordinator.request();
  coordinator.request();
  await wait(15);
  assert.equal(refreshes, 0);

  idle = true;
  await wait(15);
  assert.equal(refreshes, 1);

  coordinator.request();
  coordinator.request();
  await wait(10);
  assert.equal(refreshes, 2);
});

test("provider model refresh bounds retries after repeated failures", async (t) => {
  let refreshes = 0;
  const coordinator = new ProviderModelRefreshCoordinator({
    isIdle: () => true,
    refresh: async () => { refreshes += 1; throw new Error("offline"); },
    retryMs: 5,
    maxAttempts: 3
  });
  t.after(() => coordinator.dispose());

  coordinator.request();
  await wait(40);
  assert.equal(refreshes, 3);
});

test("provider model refresh defers a busy refresh without consuming failure retries", async (t) => {
  let refreshes = 0;
  const coordinator = new ProviderModelRefreshCoordinator({
    isIdle: () => true,
    refresh: async () => { refreshes += 1; return refreshes > 1; },
    retryMs: 5
  });
  t.after(() => coordinator.dispose());

  coordinator.request();
  await wait(25);
  assert.equal(refreshes, 2);
});
