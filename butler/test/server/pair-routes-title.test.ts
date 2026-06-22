import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import type { AddressInfo } from "node:net";
import path from "node:path";
import test from "node:test";
import express from "express";

import { registerPairRoutes } from "../../src/server/pair-routes.js";
import { PairStore } from "../../src/server/pair-store.js";
import { ButlerStateStore } from "../../src/server/state-store.js";

function mountRoutes(pairStore: PairStore, store: ButlerStateStore): express.Express {
  const app = express();
  app.use(express.json());
  registerPairRoutes({
    app,
    codexClient: {} as never,
    fileStore: {} as never,
    imageStore: {} as never,
    pairStore,
    store
  });
  return app;
}

async function listen(app: express.Express): Promise<{ url: string; close: () => Promise<void> }> {
  const server = app.listen(0);
  const address = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      })
  };
}

async function createPairStore() {
  const stateDir = await mkdtemp(path.join(tmpdir(), "manor-pair-routes-test-"));
  const statePath = path.join(stateDir, "state.json");
  const store = new ButlerStateStore(statePath);
  const pairStore = new PairStore(path.join(stateDir, "pairs.json"), store);
  await pairStore.load();
  return { store, pairStore };
}

test("PATCH /api/pairs/:pairId renames an existing pair", async () => {
  const { store, pairStore } = await createPairStore();
  const created = pairStore.createPair({ title: "Untouched" });
  const app = mountRoutes(pairStore, store);
  const { url, close } = await listen(app);
  try {
    const res = await fetch(`${url}/api/pairs/${encodeURIComponent(created.id)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Renamed via PATCH" })
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { pair: { id: string; title: string; messages: unknown[] } };
    assert.equal(body.pair.id, created.id);
    assert.equal(body.pair.title, "Renamed via PATCH");
    assert.equal(body.pair.messages.length, 0);
  } finally {
    await close();
  }
});

test("PATCH /api/pairs/:pairId returns 400 for an empty title", async () => {
  const { store, pairStore } = await createPairStore();
  const created = pairStore.createPair();
  const app = mountRoutes(pairStore, store);
  const { url, close } = await listen(app);
  try {
    const res = await fetch(`${url}/api/pairs/${encodeURIComponent(created.id)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "   " })
    });
    assert.equal(res.status, 400);
  } finally {
    await close();
  }
});

test("PATCH /api/pairs/:pairId returns 404 for an unknown pair", async () => {
  const { store, pairStore } = await createPairStore();
  const app = mountRoutes(pairStore, store);
  const { url, close } = await listen(app);
  try {
    const res = await fetch(`${url}/api/pairs/no-such-id`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Anything" })
    });
    assert.equal(res.status, 404);
  } finally {
    await close();
  }
});

test("new pairs created via POST /api/pairs start empty", async () => {
  const { store, pairStore } = await createPairStore();
  const app = mountRoutes(pairStore, store);
  const { url, close } = await listen(app);
  try {
    const res = await fetch(`${url}/api/pairs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Fresh session" })
    });
    assert.equal(res.status, 201);
    const body = (await res.json()) as { pair: { title: string; messages: unknown[] } };
    assert.equal(body.pair.title, "Fresh session");
    assert.equal(body.pair.messages.length, 0);
  } finally {
    await close();
  }
});
