import assert from "node:assert/strict";
import { once } from "node:events";
import { test } from "node:test";

import express from "express";

import { registerWorkerSessionControlRoutes } from "../../src/server/worker-session-control-routes.js";

async function startServer(runtime: "pi-rpc" | "openai", client: Record<string, unknown>, compactions: Record<string, unknown> = {}) {
  const app = express();
  app.use(express.json());
  registerWorkerSessionControlRoutes({
    app,
    pairStore: {
      getPair: () => ({ worker: { threadId: "worker-1", runtime } })
    } as never,
    piRpcWorkerClient: client as never,
    compactions: {
      get: () => null,
      start: async () => ({ id: "compact-1", status: "starting", startedAt: 1, completedAt: null, error: null }),
      ...compactions
    } as never
  });
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Test server did not start");
  return { server, url: `http://127.0.0.1:${address.port}` };
}

test("Worker controls describe unavailable sessions without calling Pi", async () => {
  const { server, url } = await startServer("openai", {});
  try {
    const response = await fetch(`${url}/api/pairs/pair-1/worker/controls`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      controls: {
        supported: false,
        runtime: "pi",
        busy: false,
        compacting: false,
        autoCompactionEnabled: false,
        pendingMessageCount: 0,
        manualCompaction: null,
        sessionName: null,
        stats: null,
        forkPoints: [],
        leafId: null
      }
    });
  } finally {
    server.close();
  }
});

test("Worker controls expose Pi stats and run exact actions", async () => {
  const calls: string[] = [];
  const controls = {
    supported: true,
    runtime: "pi",
    busy: false,
    compacting: false,
    autoCompactionEnabled: true,
    pendingMessageCount: 0,
    manualCompaction: null,
    sessionName: "Review",
    stats: null,
    forkPoints: [{ entryId: "entry-1", text: "Start here" }],
    leafId: "entry-2"
  };
  const { server, url } = await startServer("pi-rpc", {
    getSessionControls: async () => controls,
    abortThreadRetry: async () => { calls.push("abort-retry"); },
    forkThread: async (_threadId: string, entryId: string) => { calls.push(`fork:${entryId}`); return { cancelled: false }; },
    cloneThread: async () => { calls.push("clone"); return { cancelled: false }; },
    renameThreadSession: async (_threadId: string, name: string) => { calls.push(`rename:${name}`); }
  }, {
    start: async (_threadId: string, instructions: string) => {
      calls.push(`compact:${instructions}`);
      return { id: "compact-1", status: "starting", startedAt: 1, completedAt: null, error: null };
    }
  });
  try {
    const response = await fetch(`${url}/api/pairs/pair-1/worker/controls`);
    assert.deepEqual(await response.json(), { controls });

    const actions = [
      ["compact", { instructions: "Keep decisions" }],
      ["abort-retry", {}],
      ["fork", { entryId: "entry-1" }],
      ["clone", {}],
      ["rename", { name: "New name" }]
    ] as const;
    for (const [action, body] of actions) {
      const result = await fetch(`${url}/api/pairs/pair-1/worker/controls/${action}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body)
      });
      assert.equal(result.status, action === "compact" ? 202 : 200);
    }
    assert.deepEqual(calls, ["compact:Keep decisions", "abort-retry", "fork:entry-1", "clone", "rename:New name"]);

    const compaction = await fetch(`${url}/api/pairs/pair-1/worker/controls/compaction`);
    assert.deepEqual(await compaction.json(), { operation: null });
  } finally {
    server.close();
  }
});

test("Worker fork rejects stale client supplied entry ids", async () => {
  let forked = false;
  const { server, url } = await startServer("pi-rpc", {
    getSessionControls: async () => ({ forkPoints: [] }),
    forkThread: async () => { forked = true; }
  });
  try {
    const response = await fetch(`${url}/api/pairs/pair-1/worker/controls/fork`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ entryId: "stale" })
    });
    assert.equal(response.status, 409);
    assert.equal(forked, false);
  } finally {
    server.close();
  }
});

test("Worker branch actions reject while supervised compaction is starting", async () => {
  const calls: string[] = [];
  const { server, url } = await startServer("pi-rpc", {
    getSessionControls: async () => ({ forkPoints: [{ entryId: "entry-1" }] }),
    forkThread: async () => { calls.push("fork"); },
    cloneThread: async () => { calls.push("clone"); }
  }, {
    get: () => ({ id: "compact-1", status: "starting", startedAt: 1, completedAt: null, error: null })
  });
  try {
    for (const [action, body] of [["fork", { entryId: "entry-1" }], ["clone", {}]] as const) {
      const response = await fetch(`${url}/api/pairs/pair-1/worker/controls/${action}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body)
      });
      assert.equal(response.status, 409);
      assert.match((await response.json()).error, /compaction to finish/);
    }
    assert.deepEqual(calls, []);
  } finally {
    server.close();
  }
});
