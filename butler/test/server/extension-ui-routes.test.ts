import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";

import express from "express";

import { ExtensionUiBroker } from "../../src/server/extension-ui-broker.js";
import { registerExtensionUiRoutes } from "../../src/server/extension-ui-routes.js";

test("Pair extension UI routes resolve only the active scoped request", async () => {
  const app = express();
  app.use(express.json());
  const broker = new ExtensionUiBroker();
  registerExtensionUiRoutes({
    app,
    broker,
    pairStore: { getPair: () => ({ worker: { threadId: "worker-1", runtime: "pi-rpc" } }) } as never
  });
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Test server did not start");
  const url = `http://127.0.0.1:${address.port}`;
  try {
    const pending = broker.createContext("butler:pair-1", "butler").confirm("Apply?", "Run the change");
    const viewResponse = await fetch(`${url}/api/pairs/pair-1/extension-ui`);
    const view = await viewResponse.json() as { extensionUi: { dialog: { id: string } } };
    const stale = await fetch(`${url}/api/pairs/pair-1/extension-ui/respond`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ requestId: "stale", response: { confirmed: true } })
    });
    assert.equal(stale.status, 409);
    const accepted = await fetch(`${url}/api/pairs/pair-1/extension-ui/respond`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ requestId: view.extensionUi.dialog.id, response: { confirmed: true } })
    });
    assert.equal(accepted.status, 200);
    assert.equal(await pending, true);
  } finally {
    server.close();
  }
});
