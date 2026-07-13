import assert from "node:assert/strict";
import { once } from "node:events";
import { test } from "node:test";

import express from "express";

import { registerButlerSessionControlRoutes } from "../../src/server/butler-session-control-routes.js";

test("Butler session control routes expose controls and forward exact actions", async () => {
  const calls: Array<{ action: string; input: unknown }> = [];
  const app = express();
  app.use(express.json());
  registerButlerSessionControlRoutes({
    app,
    pairSessions: {
      getButlerSessionControls: async () => ({ supported: true, runtime: "pi", forkPoints: [] }),
      runButlerSessionControl: async (_pairId: string, action: string, input: unknown) => { calls.push({ action, input }); return true; }
    } as never
  });
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Test server did not start");
  const url = `http://127.0.0.1:${address.port}`;
  try {
    const controls = await fetch(`${url}/api/pairs/pair-1/butler/controls`);
    assert.equal(controls.status, 200);
    assert.equal((await controls.json() as { controls: { runtime: string } }).controls.runtime, "pi");
    const action = await fetch(`${url}/api/pairs/pair-1/butler/controls/fork`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ entryId: "entry-1" })
    });
    assert.equal(action.status, 200);
    assert.deepEqual(calls, [{ action: "fork", input: { instructions: "", entryId: "entry-1", name: "" } }]);
  } finally {
    server.close();
  }
});
