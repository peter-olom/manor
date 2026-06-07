import test from "node:test";
import assert from "node:assert/strict";

import {
  applyButlerLivePatchSnapshot,
  applyThreadPatchSnapshot,
  clearPendingManorRestartRequestSnapshot,
  mergeButlerLiveSnapshots,
  mergeOpenThreadSnapshots,
  selectBootstrapChannelsToApply,
  selectOutdatedBootstrapChannels,
  shouldApplyChannelEvent,
  shouldRefreshLiveStateOnPageEvent
} from "../../src/web/live-state.js";
import type { ButlerLiveSnapshot, CodexThreadDetail, ShellSnapshot } from "../../src/web/types.js";

function butlerLiveWithText(text: string): ButlerLiveSnapshot {
  return {
    messages: [{ id: "message-1", role: "assistant", text, at: 100, taskDurationMs: null, kind: "message" }],
    messageCount: 1,
    activityTurns: []
  };
}

function threadWithText(text: string, updatedAt: number): CodexThreadDetail {
  return {
    id: "thread-1",
    name: null,
    requestedReasoningEffort: null,
    preview: "Task",
    source: "vscode",
    cwd: null,
    createdAt: 1,
    updatedAt,
    status: "active",
    turnCount: 1,
    loaded: true,
    contextUsage: { tokens: null, contextWindow: null, percent: null },
    compaction: { active: false, count: 0, lastStartedAt: null, lastCompletedAt: null },
    supervision: { butlerTurnsUsed: 1, maxButlerTurns: null, capReached: false },
    supervisor: { projectId: "project", projectLabel: "Project", latestUserPrompt: null, latestAgentReply: null, summary: "Working", blocked: false },
    executionContract: null,
    supervisionChecklist: null,
    turns: [{ id: "turn-1", requestedReasoningEffort: null, status: "unknown", error: null, startedAt: 1, completedAt: null, items: [{ id: "item-1", type: "agentMessage", status: "started", text, at: updatedAt, taskDurationMs: null }] }],
    eventLog: [],
    workerReport: null
  };
}

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

test("thread patch appends streamed text without waiting for a full snapshot", () => {
  const current = { "thread-1": threadWithText("The cleanup", 100) };
  const next = applyThreadPatchSnapshot(current, {
    kind: "item-delta",
    threadId: "thread-1",
    turnId: "turn-1",
    itemId: "item-1",
    itemType: "agentMessage",
    delta: " task",
    itemTextLength: "The cleanup task".length,
    at: 120
  });

  assert.equal(next["thread-1"].turns[0].items[0].text, "The cleanup task");
  assert.equal(next["thread-1"].updatedAt, 120);
});

test("older full snapshots cannot replace a newer streamed patch", () => {
  const current = { "thread-1": threadWithText("The cleanup task", 120) };
  const stale = { "thread-1": threadWithText("The cleanup", 100) };
  const merged = mergeOpenThreadSnapshots(current, stale);

  assert.equal(merged["thread-1"].turns[0].items[0].text, "The cleanup task");
});

test("Butler live patch updates assistant text without waiting for a full snapshot", () => {
  const next = applyButlerLivePatchSnapshot(butlerLiveWithText("Working"), {
    messageCount: 1,
    messages: [{ id: "message-1", role: "assistant", text: "Working now", at: 100, taskDurationMs: null, kind: "message" }]
  });

  assert.equal(next?.messages[0].text, "Working now");
});

test("Butler live patch updates active activity turns", () => {
  const next = applyButlerLivePatchSnapshot(butlerLiveWithText("Working"), {
    messageCount: 1,
    activityTurns: [{
      id: "activity-1",
      status: "active",
      startedAt: 110,
      completedAt: null,
      items: [{ id: "activity-1:thinking:0", kind: "thinking", status: "active", title: "Thinking", text: "Checking", at: 110, updatedAt: 110, contentIndex: null, toolCallId: null }]
    }]
  });

  assert.equal(next?.activityTurns[0].items[0].text, "Checking");
});

test("older Butler live snapshots cannot replace a newer streamed message patch", () => {
  const merged = mergeButlerLiveSnapshots(butlerLiveWithText("Working now"), butlerLiveWithText("Working"));

  assert.equal(merged.messages[0].text, "Working now");
});
