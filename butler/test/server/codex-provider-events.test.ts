import assert from "node:assert/strict";
import test from "node:test";

import { mapCodexProviderEvent } from "../../src/server/codex-provider-events.js";

test("maps Codex assistant deltas to canonical content deltas", () => {
  const events = mapCodexProviderEvent({
    eventId: "event-1",
    at: 100,
    method: "item/agentMessage/delta",
    params: {
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "item-1",
      delta: "Hello"
    }
  });

  assert.equal(events.length, 1);
  assert.equal(events[0]?.type, "content.delta");
  assert.equal(events[0]?.harness, "codex");
  assert.equal(events[0]?.threadId, "thread-1");
  assert.equal(events[0]?.turnId, "turn-1");
  assert.equal(events[0]?.itemId, "item-1");
  assert.deepEqual(events[0]?.payload, {
    streamKind: "assistant_text",
    delta: "Hello"
  });
  assert.equal(events[0]?.providerRefs?.providerItemId, "item-1");
  assert.equal(events[0]?.raw?.method, "item/agentMessage/delta");
});

test("maps command, file-change, and reasoning deltas by stream kind", () => {
  const command = mapCodexProviderEvent({
    eventId: "event-command",
    method: "item/commandExecution/outputDelta",
    params: {
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "cmd-1",
      deltaBase64: Buffer.from("npm test\n").toString("base64")
    }
  });
  const fileChange = mapCodexProviderEvent({
    eventId: "event-file",
    method: "item/fileChange/outputDelta",
    params: {
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "file-1",
      delta: "updated"
    }
  });
  const reasoning = mapCodexProviderEvent({
    eventId: "event-reasoning",
    method: "item/reasoning/summaryTextDelta",
    params: {
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "reasoning-1",
      summaryIndex: 2,
      delta: "Inspecting"
    }
  });

  assert.equal(command[0]?.type, "content.delta");
  assert.equal(command[0]?.payload.streamKind, "command_output");
  assert.equal(command[0]?.payload.delta, "npm test\n");
  assert.equal(fileChange[0]?.payload.streamKind, "file_change_output");
  assert.equal(reasoning[0]?.payload.streamKind, "reasoning_summary_text");
  assert.equal(reasoning[0]?.payload.summaryIndex, 2);
});

test("maps item lifecycle events to canonical item lifecycle", () => {
  const events = mapCodexProviderEvent({
    eventId: "event-1",
    at: 100,
    method: "item/completed",
    params: {
      threadId: "thread-1",
      turnId: "turn-1",
      item: {
        id: "cmd-1",
        type: "commandExecution",
        command: "npm run build"
      }
    }
  });

  assert.equal(events.length, 1);
  assert.equal(events[0]?.type, "item.completed");
  assert.equal(events[0]?.itemId, "cmd-1");
  assert.equal(events[0]?.payload.itemType, "command_execution");
  assert.equal(events[0]?.payload.status, "completed");
  assert.equal(events[0]?.payload.detail, "npm run build");
});

test("does not treat Codex user-message titles as message text", () => {
  const started = mapCodexProviderEvent({
    eventId: "event-started",
    at: 100,
    method: "item/started",
    params: {
      threadId: "thread-1",
      turnId: "turn-1",
      item: {
        id: "user-1",
        type: "userMessage",
        title: "User message"
      }
    }
  });
  const completed = mapCodexProviderEvent({
    eventId: "event-completed",
    at: 110,
    method: "item/completed",
    params: {
      threadId: "thread-1",
      turnId: "turn-1",
      item: {
        id: "user-1",
        type: "userMessage",
        title: "User message",
        text: "Now review the current implementation"
      }
    }
  });

  assert.equal(started[0]?.payload.title, "User message");
  assert.equal("detail" in started[0]!.payload, false);
  assert.equal(completed[0]?.payload.detail, "Now review the current implementation");
});

test("does not treat Codex assistant-message titles as message text", () => {
  const events = mapCodexProviderEvent({
    eventId: "event-started",
    at: 100,
    method: "item/started",
    params: {
      threadId: "thread-1",
      turnId: "turn-1",
      item: {
        id: "assistant-1",
        type: "agentMessage",
        title: "Assistant message"
      }
    }
  });

  assert.equal(events[0]?.payload.title, "Assistant message");
  assert.equal("detail" in events[0]!.payload, false);
});

test("maps Codex message lifecycle content text without using generic titles", () => {
  const user = mapCodexProviderEvent({
    eventId: "event-user",
    at: 100,
    method: "item/completed",
    params: {
      threadId: "thread-1",
      turnId: "turn-1",
      item: {
        id: "user-1",
        type: "userMessage",
        title: "User message",
        content: [{ type: "text", text: "Review the current implementation" }]
      }
    }
  });
  const assistant = mapCodexProviderEvent({
    eventId: "event-assistant",
    at: 110,
    method: "item/completed",
    params: {
      threadId: "thread-1",
      turnId: "turn-1",
      item: {
        id: "assistant-1",
        type: "agentMessage",
        title: "Assistant message",
        content: { type: "text", text: "Done" }
      }
    }
  });

  assert.equal(user[0]?.payload.detail, "Review the current implementation");
  assert.equal(assistant[0]?.payload.detail, "Done");
});

test("maps thread and turn lifecycle events", () => {
  const thread = mapCodexProviderEvent({
    eventId: "event-thread",
    method: "thread/status/changed",
    params: {
      threadId: "thread-1",
      status: { type: "idle" }
    }
  });
  const started = mapCodexProviderEvent({
    eventId: "event-turn-started",
    method: "turn/started",
    params: {
      threadId: "thread-1",
      turnId: "turn-1",
      model: "gpt-test",
      effort: "high"
    }
  });
  const completed = mapCodexProviderEvent({
    eventId: "event-turn-completed",
    method: "turn/completed",
    params: {
      threadId: "thread-1",
      turnId: "turn-1",
      turn: { id: "turn-1", status: "failed", error: { message: "boom" } }
    }
  });

  assert.equal(thread[0]?.type, "thread.state.changed");
  assert.equal(thread[0]?.payload.state, "idle");
  assert.equal(started[0]?.type, "turn.started");
  assert.deepEqual(started[0]?.payload, { model: "gpt-test", effort: "high" });
  assert.equal(completed[0]?.type, "turn.completed");
  assert.equal(completed[0]?.payload.state, "failed");
  assert.equal(completed[0]?.payload.errorMessage, "boom");
});

test("maps token usage to current context usage", () => {
  const events = mapCodexProviderEvent({
    eventId: "event-usage",
    method: "thread/tokenUsage/updated",
    params: {
      threadId: "thread-1",
      tokenUsage: {
        total: { totalTokens: 1000 },
        last: { totalTokens: 240 },
        modelContextWindow: 1200
      }
    }
  });

  assert.equal(events.length, 1);
  assert.equal(events[0]?.type, "thread.tokenUsage.updated");
  assert.deepEqual(events[0]?.payload, {
    tokens: 240,
    contextWindow: 1200,
    percent: 20
  });
});

test("maps approval requests and resolutions", () => {
  const request = mapCodexProviderEvent({
    eventId: "event-request",
    method: "item/commandExecution/requestApproval",
    params: {
      threadId: "thread-1",
      turnId: "turn-1",
      requestId: "request-1",
      command: "rm -rf dist"
    }
  });
  const resolved = mapCodexProviderEvent({
    eventId: "event-resolved",
    method: "item/requestApproval/decision",
    params: {
      threadId: "thread-1",
      turnId: "turn-1",
      requestId: "request-1",
      decision: "approved"
    }
  });

  assert.equal(request[0]?.type, "request.opened");
  assert.equal(request[0]?.requestId, "request-1");
  assert.equal(request[0]?.payload.requestType, "command_execution_approval");
  assert.equal(request[0]?.payload.detail, "rm -rf dist");
  assert.equal(resolved[0]?.type, "request.resolved");
  assert.equal(resolved[0]?.payload.decision, "approved");
});

test("ignores malformed or unsupported events at the adapter boundary", () => {
  assert.deepEqual(mapCodexProviderEvent({
    eventId: "event-missing-thread",
    method: "item/agentMessage/delta",
    params: {
      turnId: "turn-1",
      itemId: "item-1",
      delta: "Hello"
    }
  }), []);

  assert.deepEqual(mapCodexProviderEvent({
    eventId: "event-empty-delta",
    method: "item/agentMessage/delta",
    params: {
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "item-1",
      delta: ""
    }
  }), []);

  assert.deepEqual(mapCodexProviderEvent({
    eventId: "event-unknown",
    method: "not/a/real/event",
    params: {
      threadId: "thread-1"
    }
  }), []);
});
