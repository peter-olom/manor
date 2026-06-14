import assert from "node:assert/strict";
import test from "node:test";

import { CodexProviderAdapter } from "../../src/server/codex-provider-adapter.js";
import type { CodexAppServerTransport } from "../../src/server/codex-app-server-transport.js";
import type { ProviderRuntimeEvent } from "../../src/shared/provider-runtime.js";

function createAdapter(
  call: (method: string, params: Record<string, unknown>) => Promise<Record<string, unknown>> = async (method, params) => ({ method, params })
) {
  return new CodexProviderAdapter({
    call
  } as unknown as CodexAppServerTransport);
}

test("Codex provider adapter emits canonical runtime events", () => {
  const adapter = createAdapter();
  const events: ProviderRuntimeEvent[] = [];
  adapter.on("runtimeEvent", (event) => events.push(event));

  adapter.handleNotification({
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
  assert.equal(events[0]?.payload.streamKind, "assistant_text");
  assert.equal(events[0]?.payload.delta, "Hello");
});

test("Codex provider adapter emits unmapped native notifications", () => {
  const adapter = createAdapter();
  const unmapped: string[] = [];
  adapter.on("unmappedNotification", (message) => {
    if (message.method) {
      unmapped.push(message.method);
    }
  });

  adapter.handleNotification({
    method: "unhandled/native",
    params: {
      threadId: "thread-1"
    }
  });

  assert.deepEqual(unmapped, ["unhandled/native"]);
});

test("Codex provider adapter delegates JSON-RPC calls to transport", async () => {
  const adapter = createAdapter();

  assert.deepEqual(await adapter.call("thread/read", { threadId: "thread-1" }), {
    method: "thread/read",
    params: { threadId: "thread-1" }
  });
});

test("Codex provider adapter owns thread and turn operations", async () => {
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  const adapter = createAdapter(async (method, params) => {
    calls.push({ method, params });
    if (method === "thread/start") {
      return { thread: { id: "thread-1", cwd: "/repo" } };
    }
    if (method === "turn/start") {
      return { turn: { id: "turn-1" } };
    }
    return {};
  });

  assert.deepEqual(await adapter.startThread({ cwd: "/repo" }), {
    threadId: "thread-1",
    thread: { id: "thread-1", cwd: "/repo" }
  });
  assert.deepEqual(await adapter.sendTurn("thread-1", { input: [{ type: "text", text: "hello" }] }), {
    threadId: "thread-1",
    turnId: "turn-1",
    turn: { id: "turn-1" }
  });
  await adapter.steerTurn("thread-1", "turn-1", [{ type: "text", text: "more" }]);
  await adapter.interruptTurn("thread-1", "turn-1");

  assert.deepEqual(calls.map((call) => call.method), ["thread/start", "turn/start", "turn/steer", "turn/interrupt"]);
  assert.deepEqual(calls[2]?.params, {
    threadId: "thread-1",
    expectedTurnId: "turn-1",
    input: [{ type: "text", text: "more" }]
  });
});
