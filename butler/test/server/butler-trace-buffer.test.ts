import assert from "node:assert/strict";
import test from "node:test";

import { ButlerTraceBuffer } from "../../src/server/butler-trace-buffer.js";

test("ButlerTraceBuffer accumulates items per turn and consumes on assistant complete", () => {
  const buffer = new ButlerTraceBuffer();
  buffer.startTurn("turn-1", 1000);
  buffer.setAssistantItem("turn-1", "assistant-1", 1100);
  buffer.upsertItem({
    turnId: "turn-1",
    itemId: "reasoning-1",
    type: "reasoning",
    status: "in_progress",
    text: "",
    at: 1001
  });
  buffer.upsertItem({
    turnId: "turn-1",
    itemId: "reasoning-1",
    type: "reasoning",
    status: "in_progress",
    text: "Plan A",
    at: 1001
  });
  buffer.upsertItem({
    turnId: "turn-1",
    itemId: "reasoning-1",
    type: "reasoning",
    status: "in_progress",
    text: " works",
    at: 1002
  });
  buffer.upsertItem({
    turnId: "turn-1",
    itemId: "reasoning-1",
    type: "reasoning",
    status: "completed",
    text: "Plan A works",
    at: 1003,
    completedAt: 1003
  });
  buffer.upsertItem({
    turnId: "turn-1",
    itemId: "tool-1",
    type: "command_execution",
    status: "completed",
    text: "ls -la",
    at: 1004,
    completedAt: 1004
  });
  const meta = buffer.consumeForAssistantItem("assistant-1");
  assert.ok(meta, "expected a trace meta");
  assert.equal(meta.turnId, "turn-1");
  assert.equal(meta.startedAt, 1000);
  assert.equal(meta.completedAt, 1100);
  assert.equal(meta.items.length, 2);
  const [reasoning, tool] = meta.items;
  assert.equal(reasoning.type, "reasoning");
  assert.equal(reasoning.text, "Plan A works");
  assert.equal(reasoning.status, "completed");
  assert.equal(tool.type, "command_execution");
  assert.equal(tool.text, "ls -la");
  const secondConsume = buffer.consumeForAssistantItem("assistant-1");
  assert.equal(secondConsume, null);
});

test("ButlerTraceBuffer ignores user_message and assistant_message items", () => {
  const buffer = new ButlerTraceBuffer();
  buffer.startTurn("turn-2", 2000);
  buffer.setAssistantItem("turn-2", "assistant-1", 2100);
  buffer.upsertItem({
    turnId: "turn-2",
    itemId: "user-1",
    type: "user_message",
    status: "completed",
    text: "hello",
    at: 2001
  });
  buffer.upsertItem({
    turnId: "turn-2",
    itemId: "assistant-1",
    type: "assistant_message",
    status: "completed",
    text: "hi",
    at: 2002
  });
  const meta = buffer.consumeForAssistantItem("assistant-1");
  assert.ok(meta);
  assert.equal(meta.items.length, 0);
});

test("ButlerTraceBuffer clamps overly long text", () => {
  const buffer = new ButlerTraceBuffer();
  buffer.startTurn("turn-3", 3000);
  buffer.setAssistantItem("turn-3", "assistant-3", 3100);
  const huge = "x".repeat(10_000);
  buffer.upsertItem({
    turnId: "turn-3",
    itemId: "reasoning-huge",
    type: "reasoning",
    status: "in_progress",
    text: huge,
    at: 3001
  });
  const meta = buffer.consumeForAssistantItem("assistant-3");
  assert.ok(meta);
  assert.ok(meta.items[0].text.length <= 4001);
});
