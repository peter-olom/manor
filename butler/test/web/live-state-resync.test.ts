import test from "node:test";
import assert from "node:assert/strict";

import {
  clearPendingManorRestartRequestSnapshot,
  selectBootstrapChannelsToApply,
  selectOutdatedBootstrapChannels,
  shouldApplyChannelEvent,
  shouldRefreshLiveStateOnPageEvent
} from "../../src/web/live-state.js";
import type { ShellSnapshot } from "../../src/web/types.js";

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

test("version-gap repair selects stale channels independent of page refresh throttle", () => {
  assert.deepEqual(
    selectOutdatedBootstrapChannels(
      {
        shell: 10,
        butlerLive: 10,
        runtime: 10,
        threads: 10
      },
      {
        shell: 11,
        butlerLive: 10,
        runtime: 10,
        threads: 11
      }
    ),
    ["shell", "threads"]
  );
});

test("older versioned state events cannot overwrite a newer bootstrap correction", () => {
  assert.equal(shouldApplyChannelEvent(2, 1), false);
  assert.equal(shouldApplyChannelEvent(2, 2), true);
  assert.equal(shouldApplyChannelEvent(2, 3), true);
  assert.equal(shouldApplyChannelEvent(2, null), true);
});

test("restart approval can hide the pending dialog before the next live update", () => {
  const shell = {
    butler: {
      pendingManorRestartRequest: {
        id: "restart-request-1"
      }
    }
  } as unknown as ShellSnapshot;

  const unchanged = clearPendingManorRestartRequestSnapshot(shell, "restart-request-2");
  const cleared = clearPendingManorRestartRequestSnapshot(shell, "restart-request-1");

  assert.equal(unchanged, shell);
  assert.notEqual(cleared, shell);
  assert.equal(cleared?.butler.pendingManorRestartRequest, null);
});
