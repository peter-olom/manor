import test from "node:test";
import assert from "node:assert/strict";

import {
  selectBootstrapChannelsToApply,
  selectOutdatedBootstrapChannels,
  shouldRefreshLiveStateOnPageEvent
} from "../../src/web/live-state.js";

test("bootstrap correction applies stale channels even when another channel received a newer event", () => {
  assert.deepEqual(
    selectBootstrapChannelsToApply(
      {
        shell: 100,
        butlerLive: 260,
        runtime: 250,
        threads: 90
      },
      200
    ),
    ["shell", "threads"]
  );
});

test("heartbeat channel versions identify missed shell and thread updates", () => {
  assert.deepEqual(
    selectOutdatedBootstrapChannels(
      {
        shell: 1,
        butlerLive: 4,
        runtime: 3,
        threads: 1
      },
      {
        shell: 2,
        butlerLive: 4,
        runtime: 3,
        threads: 2
      }
    ),
    ["shell", "threads"]
  );
});

test("page activity refreshes stale visible live state without polling hidden tabs", () => {
  assert.equal(
    shouldRefreshLiveStateOnPageEvent({
      now: 1_000,
      lastRefreshAt: 900,
      minIntervalMs: 3_000,
      hasSnapshot: false,
      visibilityState: "visible"
    }),
    true
  );
  assert.equal(
    shouldRefreshLiveStateOnPageEvent({
      now: 5_000,
      lastRefreshAt: 1_000,
      minIntervalMs: 3_000,
      hasSnapshot: true,
      visibilityState: "visible"
    }),
    true
  );
  assert.equal(
    shouldRefreshLiveStateOnPageEvent({
      now: 2_000,
      lastRefreshAt: 1_000,
      minIntervalMs: 3_000,
      hasSnapshot: true,
      visibilityState: "visible"
    }),
    false
  );
  assert.equal(
    shouldRefreshLiveStateOnPageEvent({
      now: 5_000,
      lastRefreshAt: 1_000,
      minIntervalMs: 3_000,
      hasSnapshot: true,
      visibilityState: "hidden"
    }),
    false
  );
});
