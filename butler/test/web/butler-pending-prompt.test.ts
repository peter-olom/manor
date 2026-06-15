import test from "node:test";
import assert from "node:assert/strict";

import {
  applyButlerLivePatchSnapshot,
  mergeButlerLiveSnapshots
} from "../../src/web/live-state.js";
import type { ButlerLiveSnapshot } from "../../src/web/types.js";

function snapshot(messages: ButlerLiveSnapshot["messages"], pendingRevision = 0): ButlerLiveSnapshot {
  return {
    messages,
    messageCount: messages.length,
    pendingRevision,
    activityTurns: []
  };
}

test("committed Butler user lifecycle removes the matching server-owned pending row", () => {
  const current = snapshot([
    {
      id: "pending-operator-1",
      role: "user",
      text: "Review the current implementation",
      at: 100,
      taskDurationMs: null,
      kind: "message",
      pending: true
    }
  ]);

  const next = applyButlerLivePatchSnapshot(current, {
    kind: "item-lifecycle",
    threadId: "butler",
    turnId: "turn-1",
    itemId: "message-0",
    itemType: "user_message",
    status: "completed",
    text: "Review the current implementation",
    at: 120
  });

  assert.equal(next?.messages.length, 1);
  assert.equal(next?.messageCount, 1);
  assert.equal(next?.messages[0].id, "message-0");
  assert.equal(next?.messages[0].pending, undefined);
});

test("committed Butler user lifecycle removes pending row when provider normalizes text", () => {
  const current = snapshot([
    {
      id: "pending-operator-1",
      role: "user",
      text: "Original prompt",
      at: 100,
      taskDurationMs: null,
      kind: "message",
      pending: true
    }
  ]);

  const next = applyButlerLivePatchSnapshot(current, {
    kind: "item-lifecycle",
    threadId: "butler",
    turnId: "turn-1",
    itemId: "message-0",
    itemType: "user_message",
    status: "completed",
    text: "Normalized prompt",
    at: 120
  });

  assert.equal(next?.messages.length, 1);
  assert.equal(next?.messages[0].id, "message-0");
  assert.equal(next?.messages[0].text, "Normalized prompt");
});

test("duplicate server-owned pending prompts settle one committed row at a time", () => {
  const current = snapshot([
    { id: "pending-1", role: "user", text: "same", at: 100, taskDurationMs: null, kind: "message", pending: true },
    { id: "pending-2", role: "user", text: "same", at: 110, taskDurationMs: null, kind: "message", pending: true }
  ]);

  const next = applyButlerLivePatchSnapshot(current, {
    kind: "item-lifecycle",
    threadId: "butler",
    turnId: "turn-1",
    itemId: "message-0",
    itemType: "user_message",
    status: "completed",
    text: "same",
    at: 130
  });

  assert.equal(next?.messageCount, 2);
  assert.deepEqual(next?.messages.map((message) => message.id), ["pending-2", "message-0"]);
});

test("older Butler live snapshots preserve already-received pending user rows", () => {
  const current = snapshot([
    { id: "message-0", role: "assistant", text: "Ready", at: 80, taskDurationMs: null, kind: "message" },
    { id: "pending-1", role: "user", text: "queued prompt", at: 100, taskDurationMs: null, kind: "message", pending: true }
  ], 1);
  const stale = snapshot([
    { id: "message-0", role: "assistant", text: "Ready", at: 80, taskDurationMs: null, kind: "message" }
  ], 0);

  const merged = mergeButlerLiveSnapshots(current, stale);

  assert.equal(merged.messageCount, 2);
  assert.deepEqual(merged.messages.map((message) => message.id), ["message-0", "pending-1"]);
});

test("older Butler live snapshots preserve provider-independent committed user rows", () => {
  const current = snapshot([
    { id: "message-0", role: "assistant", text: "Ready", at: 80, taskDurationMs: null, kind: "message" },
    { id: "pending-operator-1", role: "user", text: "committed prompt", at: 100, taskDurationMs: null, kind: "message" }
  ], 2);
  const stale = snapshot([
    { id: "message-0", role: "assistant", text: "Ready", at: 80, taskDurationMs: null, kind: "message" }
  ], 1);

  const merged = mergeButlerLiveSnapshots(current, stale);

  assert.equal(merged.messageCount, 2);
  assert.deepEqual(merged.messages.map((message) => message.id), ["message-0", "pending-operator-1"]);
});

test("clear-style Butler live snapshots still remove pending rows", () => {
  const current = snapshot([
    { id: "message-0", role: "assistant", text: "Ready", at: 80, taskDurationMs: null, kind: "message" },
    { id: "pending-1", role: "user", text: "queued prompt", at: 100, taskDurationMs: null, kind: "message", pending: true }
  ], 1);
  const cleared = snapshot([], 2);

  const merged = mergeButlerLiveSnapshots(current, cleared);

  assert.equal(merged.messageCount, 0);
  assert.equal(merged.messages.length, 0);
});

test("empty Butler live snapshots remove a lone pending row", () => {
  const current = snapshot([
    { id: "pending-1", role: "user", text: "queued prompt", at: 100, taskDurationMs: null, kind: "message", pending: true }
  ], 1);
  const cleared = snapshot([], 2);

  const merged = mergeButlerLiveSnapshots(current, cleared);

  assert.equal(merged.messageCount, 0);
  assert.equal(merged.messages.length, 0);
});

test("newer Butler live snapshots remove pending rows when committed history remains", () => {
  const current = snapshot([
    { id: "message-0", role: "assistant", text: "Ready", at: 80, taskDurationMs: null, kind: "message" },
    { id: "pending-1", role: "user", text: "queued prompt", at: 100, taskDurationMs: null, kind: "message", pending: true }
  ], 1);
  const cleared = snapshot([
    { id: "message-0", role: "assistant", text: "Ready", at: 80, taskDurationMs: null, kind: "message" }
  ], 2);

  const merged = mergeButlerLiveSnapshots(current, cleared);

  assert.equal(merged.messageCount, 1);
  assert.deepEqual(merged.messages.map((message) => message.id), ["message-0"]);
});
