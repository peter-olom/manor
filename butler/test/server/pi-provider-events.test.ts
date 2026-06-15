import assert from "node:assert/strict";
import test from "node:test";

import { PiProviderRuntimeMapper } from "../../src/server/pi-provider-events.js";

function session(messages: unknown[] = []) {
  return {
    sessionId: "session-1",
    messages
  };
}

test("Pi text deltas map to Butler assistant runtime content patches", () => {
  const mapper = new PiProviderRuntimeMapper();
  const fakeSession = session();

  const [turnPatch] = mapper.map({ type: "turn_start" } as never, fakeSession as never);
  assert.equal(turnPatch.kind, "turn-lifecycle");

  const [startPatch] = mapper.map({
    type: "message_start",
    message: {
      role: "assistant",
      content: [{ type: "text", text: "" }],
      timestamp: 100
    }
  } as never, fakeSession as never);
  assert.equal(startPatch.kind, "item-lifecycle");
  assert.equal(startPatch.itemId, "message-0");

  const [deltaPatch] = mapper.map({
    type: "message_update",
    message: {
      role: "assistant",
      content: [{ type: "text", text: "Hel" }],
      timestamp: 100
    },
    assistantMessageEvent: {
      type: "text_delta",
      contentIndex: 0,
      delta: "Hel",
      partial: {
        role: "assistant",
        content: [{ type: "text", text: "Hel" }]
      }
    }
  } as never, fakeSession as never);

  assert.equal(deltaPatch.kind, "content-delta");
  assert.equal(deltaPatch.itemId, "message-0");
  assert.equal(deltaPatch.streamKind, "assistant_text");
  assert.equal(deltaPatch.delta, "Hel");
  assert.equal(deltaPatch.itemTextLength, 3);
});

test("Pi background prompts do not leak assistant patches", () => {
  const mapper = new PiProviderRuntimeMapper();
  const fakeSession = session();

  mapper.map({
    type: "message_start",
    message: {
      role: "user",
      content: "[[BUTLER_BACKGROUND]]\nprivate grounding",
      timestamp: 100
    }
  } as never, fakeSession as never);

  assert.deepEqual(mapper.map({
    type: "message_start",
    message: {
      role: "assistant",
      content: [{ type: "text", text: "" }],
      timestamp: 110
    }
  } as never, fakeSession as never), []);

  assert.deepEqual(mapper.map({
    type: "message_update",
    message: {
      role: "assistant",
      content: [{ type: "text", text: "hidden" }],
      timestamp: 110
    },
    assistantMessageEvent: {
      type: "text_delta",
      contentIndex: 0,
      delta: "hidden",
      partial: {
        role: "assistant",
        content: [{ type: "text", text: "hidden" }]
      }
    }
  } as never, fakeSession as never), []);
});

test("Pi user message starts do not render provider placeholders", () => {
  const mapper = new PiProviderRuntimeMapper();
  const fakeSession = session();

  mapper.map({ type: "turn_start" } as never, fakeSession as never);

  assert.deepEqual(mapper.map({
    type: "message_start",
    message: {
      role: "user",
      content: [{ type: "text", text: "User message" }],
      timestamp: 100
    }
  } as never, fakeSession as never), []);

  const [endPatch] = mapper.map({
    type: "message_end",
    message: {
      role: "user",
      content: [{ type: "text", text: "Review the current implementation" }],
      timestamp: 110
    }
  } as never, fakeSession as never);

  assert.equal(endPatch.kind, "item-lifecycle");
  assert.equal(endPatch.itemType, "user_message");
  assert.equal(endPatch.itemId, "message-0");
  assert.equal(endPatch.text, "Review the current implementation");
});

test("Pi clears reserved user message ids when a turn ends without a user message end", () => {
  const mapper = new PiProviderRuntimeMapper();

  mapper.map({ type: "turn_start" } as never, session() as never);
  mapper.map({
    type: "message_start",
    message: {
      role: "user",
      content: [{ type: "text", text: "User message" }],
      timestamp: 100
    }
  } as never, session() as never);
  mapper.map({
    type: "turn_end",
    message: {
      role: "assistant",
      content: [{ type: "text", text: "done" }],
      timestamp: 110
    }
  } as never, session() as never);

  mapper.map({ type: "turn_start" } as never, session([{}]) as never);
  const [endPatch] = mapper.map({
    type: "message_end",
    message: {
      role: "user",
      content: [{ type: "text", text: "Fresh prompt" }],
      timestamp: 120
    }
  } as never, session([{}]) as never);

  assert.equal(endPatch.kind, "item-lifecycle");
  assert.equal(endPatch.itemId, "message-1");
  assert.equal(endPatch.text, "Fresh prompt");
});

test("Pi maps attachment-only user messages to visible attachment summaries", () => {
  const mapper = new PiProviderRuntimeMapper();
  mapper.map({ type: "turn_start" } as never, session() as never);
  mapper.map({
    type: "message_start",
    message: {
      role: "user-with-attachments",
      content: [{ type: "image", data: "abc", mimeType: "image/png" }],
      timestamp: 100
    }
  } as never, session() as never);

  const [endPatch] = mapper.map({
    type: "message_end",
    message: {
      role: "user-with-attachments",
      content: [{ type: "image", data: "abc", mimeType: "image/png" }],
      timestamp: 110
    }
  } as never, session() as never);

  assert.equal(endPatch.kind, "item-lifecycle");
  assert.equal(endPatch.itemType, "user_message");
  assert.equal(endPatch.text, "Attached 1 image");
});

test("Pi tool execution maps to runtime item lifecycle patches", () => {
  const mapper = new PiProviderRuntimeMapper();
  const fakeSession = session();
  mapper.map({ type: "turn_start" } as never, fakeSession as never);

  const [startPatch] = mapper.map({
    type: "tool_execution_start",
    toolCallId: "call-1",
    toolName: "read_file",
    args: { path: "README.md" }
  } as never, fakeSession as never);

  assert.equal(startPatch.kind, "item-lifecycle");
  assert.equal(startPatch.itemType, "dynamic_tool_call");
  assert.equal(startPatch.status, "in_progress");
  assert.equal(startPatch.title, "read_file");
  assert.match(startPatch.text, /README/);

  const [endPatch] = mapper.map({
    type: "tool_execution_end",
    toolCallId: "call-1",
    toolName: "read_file",
    result: { text: "done" },
    isError: false
  } as never, fakeSession as never);

  assert.equal(endPatch.kind, "item-lifecycle");
  assert.equal(endPatch.status, "completed");
  assert.equal(endPatch.title, "read_file");
});
