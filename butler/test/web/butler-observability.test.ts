import assert from "node:assert/strict";
import test from "node:test";

import { durableActivitySupersedesLive, findActiveOperatorQuestionMessage, persistedButlerMessageCoversLive } from "../../src/web/ButlerPane.js";
import { applyPatchToState, type LiveTurnState } from "../../src/web/useLiveButlerTurn.js";

const idle: LiveTurnState = {
  turnId: "turn-1",
  items: new Map(),
  assistantItemId: null,
  assistantText: "",
  status: "streaming",
  startedAt: 100,
  completedAt: null
};

const disconnected: LiveTurnState = {
  turnId: null,
  items: new Map(),
  assistantItemId: null,
  assistantText: "",
  status: "idle",
  startedAt: null,
  completedAt: null
};

test("the first tool lifecycle patch after reconnect is retained", () => {
  const next = applyPatchToState(disconnected, {
    kind: "item-lifecycle",
    threadId: "butler:pair-1",
    turnId: "turn-reconnected",
    itemId: "tool-1",
    itemType: "dynamic_tool_call",
    status: "in_progress",
    title: "inspect_filesystem",
    text: "path: /repos",
    at: 200
  }, () => undefined);

  assert.equal(next.turnId, "turn-reconnected");
  assert.equal(next.status, "streaming");
  assert.deepEqual([...next.items.values()].map((item) => ({ title: item.title, text: item.text, status: item.status })), [{
    title: "inspect_filesystem",
    text: "path: /repos",
    status: "in_progress"
  }]);
});

test("the first reasoning delta after reconnect is retained", () => {
  const next = applyPatchToState(disconnected, {
    kind: "content-delta",
    threadId: "butler:pair-1",
    turnId: "turn-reconnected",
    itemId: "thinking-1",
    itemType: "reasoning",
    streamKind: "reasoning_text",
    delta: "Checking the current state. ",
    itemTextLength: 28,
    at: 210
  }, () => undefined);

  assert.equal(next.turnId, "turn-reconnected");
  assert.equal(next.status, "streaming");
  assert.equal(next.items.get("thinking-1")?.text, "Checking the current state. ");
  assert.equal(next.items.get("thinking-1")?.status, "in_progress");
});

test("runtime errors become visible failed trace items", () => {
  const next = applyPatchToState(idle, {
    kind: "runtime-message",
    threadId: "butler:pair-1",
    tone: "error",
    message: "Provider request failed after retry: invalid tool schema",
    at: 200
  }, () => undefined);

  assert.equal(next.status, "failed");
  assert.deepEqual([...next.items.values()].map((item) => ({ type: item.type, status: item.status, text: item.text })), [{
    type: "error",
    status: "failed",
    text: "Provider request failed after retry: invalid tool schema"
  }]);
});

test("persisted Butler reply suppresses its live duplicate before turn completion", () => {
  const message = {
    id: "message-1",
    role: "butler",
    lane: "butler",
    text: "There are 9 floating files.",
    at: 200,
    sourceThreadId: null,
    memoryObservationId: null,
    metadata: {}
  } as const;

  assert.equal(persistedButlerMessageCoversLive(message, "There are 9 floating files.", 100, null), true);
  assert.equal(persistedButlerMessageCoversLive(message, "Still drafting.", 100, null), false);
});

test("an active operator decision stays after later Butler narration until delivery completes", () => {
  const questionMessage = {
    id: "question-message",
    role: "butler",
    lane: "butler",
    text: "Approve this change?",
    at: 2,
    sourceThreadId: null,
    memoryObservationId: null,
    metadata: {},
    question: {
      id: "question-1",
      prompt: "Approve this change?",
      context: null,
      options: [{ id: "approve", label: "Approve", description: null }],
      allowFreeform: false,
      createdAt: 2,
      selectedOptionId: null,
      freeformAnswer: null,
      answeredAt: null,
      deliveryState: "idle" as const
    }
  } as const;
  const messages = [
    { ...questionMessage, id: "request", role: "user" as const, text: "Install it", at: 1, question: undefined },
    questionMessage,
    { ...questionMessage, id: "narration", text: "I am waiting for your approval.", at: 3, question: undefined }
  ];

  assert.equal(findActiveOperatorQuestionMessage(messages)?.id, "question-message");
  assert.equal(findActiveOperatorQuestionMessage([
    ...messages,
    { ...questionMessage, id: "queued-user", role: "user", text: "A queued follow-up", at: 4, question: undefined }
  ])?.id, "question-message");
  assert.equal(findActiveOperatorQuestionMessage(messages.map((message) => message.id === "question-message"
    ? { ...message, question: { ...questionMessage.question, selectedOptionId: "approve", answeredAt: 4, deliveryState: "pending" as const } }
    : message))?.id, "question-message");
  assert.equal(findActiveOperatorQuestionMessage(messages.map((message) => message.id === "question-message"
    ? { ...message, question: { ...questionMessage.question, selectedOptionId: "approve", answeredAt: 4, deliveryState: "delivered" as const } }
    : message)), null);
});

test("a polled terminal outcome supersedes a stale streaming patch after reconnect", () => {
  assert.equal(durableActivitySupersedesLive("streaming", 100, {
    status: "failed",
    startedAt: 100,
    completedAt: 200,
    detail: "Provider failed."
  }), true);
  assert.equal(durableActivitySupersedesLive("streaming", 300, {
    status: "failed",
    startedAt: 100,
    completedAt: 200,
    detail: "Older failure."
  }), false);
});
