import assert from "node:assert/strict";
import test from "node:test";

import { CodexAppServerTransport, type JsonRpcMessage } from "../../src/server/codex-app-server-transport.js";

test("server requests cannot resolve a colliding pending client call", async () => {
  const sent: JsonRpcMessage[] = [];
  const transport = new CodexAppServerTransport("ws://unused") as unknown as {
    socket: { readyState: number; send: (payload: string) => void };
    handleMessage: (message: JsonRpcMessage) => void;
    call: (method: string, params: Record<string, unknown>) => Promise<Record<string, unknown>>;
    on: (event: "notification", listener: (message: JsonRpcMessage) => void) => void;
  };
  transport.socket = {
    readyState: 1,
    send: (payload) => sent.push(JSON.parse(payload) as JsonRpcMessage)
  };
  const notifications: JsonRpcMessage[] = [];
  transport.on("notification", (message) => notifications.push(message));

  const pending = transport.call("thread/read", { threadId: "worker-1" });
  transport.handleMessage({
    jsonrpc: "2.0",
    id: 1,
    method: "item/tool/requestUserInput",
    params: { threadId: "worker-1", turnId: "turn-1", questions: [] }
  } as JsonRpcMessage);

  assert.equal(notifications.length, 1);
  assert.equal(sent.length, 2);
  assert.equal(sent[1]?.id, 1);
  assert.equal(sent[1]?.error?.code, -32601);
  let settled = false;
  void pending.finally(() => { settled = true; });
  await Promise.resolve();
  assert.equal(settled, false);

  transport.handleMessage({ id: 1, result: { thread: { id: "worker-1" } } });
  assert.deepEqual(await pending, { thread: { id: "worker-1" } });
});
