import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import test from "node:test";
import express from "express";

import { registerPairRoutes } from "../../src/server/pair-routes.js";
import type { PairDetail, PairSummary } from "../../src/shared/pairing.js";

function makePair(overrides: Partial<PairDetail> = {}): PairDetail {
  const now = Date.now();
  const id = overrides.id ?? "pair-1";
  return {
    id,
    title: "New session",
    status: "idle",
    projectId: null,
    projectLabel: null,
    createdAt: now,
    updatedAt: now,
    defaultCwd: null,
    butlerSessionId: id,
    butlerReady: true,
    butlerPending: false,
    butlerLastError: null,
    worker: null,
    memoryQuery: null,
    lastHandoffPrompt: null,
    messageCount: 0,
    lastMessage: null,
    messages: [],
    loadedStart: 0,
    hasMore: false,
    ...overrides
  };
}

function createFakePairSessions(initialPair: PairDetail = makePair()) {
  const pairs = new Map<string, PairDetail>([[initialPair.id, initialPair]]);
  const sentMessages: Array<{ pairId: string; text: string; imageReferenceIds: string[]; fileReferenceIds: string[] }> = [];
  return {
    sentMessages,
    manager: {
      async listSummaries(): Promise<PairSummary[]> {
        return [...pairs.values()].map(({ messages: _messages, loadedStart: _loadedStart, hasMore: _hasMore, ...pair }) => pair);
      },
      async createPair(input: { title?: string | null; defaultCwd?: string | null }): Promise<PairDetail> {
        const pair = makePair({
          id: "pair-created",
          title: input.title || "New session",
          defaultCwd: input.defaultCwd ?? null
        });
        pairs.set(pair.id, pair);
        return pair;
      },
      async getPairDetail(pairId: string): Promise<PairDetail | null> {
        return pairs.get(pairId) ?? null;
      },
      updatePairTitle(pairId: string, title: string): PairDetail | null {
        const pair = pairs.get(pairId);
        if (!pair) return null;
        const updated = { ...pair, title, updatedAt: Date.now() };
        pairs.set(pairId, updated);
        return updated;
      },
      async deletePair(pairId: string): Promise<boolean> {
        return pairs.delete(pairId);
      },
      async getWorkerThread(pairId: string): Promise<unknown | null> {
        return pairs.get(pairId)?.worker ? { id: pairs.get(pairId)?.worker?.threadId } : null;
      },
      async sendOperatorMessage(input: { pairId: string; text: string; imageReferenceIds: string[]; fileReferenceIds: string[] }): Promise<PairDetail | null> {
        const pair = pairs.get(input.pairId);
        if (!pair) return null;
        sentMessages.push(input);
        const message = {
          id: `message-${sentMessages.length}`,
          role: "user" as const,
          lane: "butler" as const,
          text: input.text,
          at: Date.now(),
          sourceThreadId: null,
          memoryObservationId: null,
          metadata: {}
        };
        const updated = {
          ...pair,
          messageCount: pair.messageCount + 1,
          lastMessage: message,
          messages: [...pair.messages, message]
        };
        pairs.set(input.pairId, updated);
        return updated;
      }
    }
  };
}

function mountRoutes(pairSessions: unknown): express.Express {
  const app = express();
  app.use(express.json());
  registerPairRoutes({
    app,
    pairSessions: pairSessions as never
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

test("PATCH /api/pairs/:pairId renames through the pair session manager", async () => {
  const fake = createFakePairSessions(makePair({ title: "Untouched" }));
  const app = mountRoutes(fake.manager);
  const { url, close } = await listen(app);
  try {
    const res = await fetch(`${url}/api/pairs/pair-1`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Renamed via PATCH" })
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { pair: { id: string; title: string; messages: unknown[] } };
    assert.equal(body.pair.id, "pair-1");
    assert.equal(body.pair.title, "Renamed via PATCH");
    assert.equal(body.pair.messages.length, 0);
  } finally {
    await close();
  }
});

test("PATCH /api/pairs/:pairId returns 400 for an empty title", async () => {
  const fake = createFakePairSessions();
  const app = mountRoutes(fake.manager);
  const { url, close } = await listen(app);
  try {
    const res = await fetch(`${url}/api/pairs/pair-1`, {
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
  const fake = createFakePairSessions();
  const app = mountRoutes(fake.manager);
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

test("POST /api/pairs creates an empty Butler-backed pair", async () => {
  const fake = createFakePairSessions();
  const app = mountRoutes(fake.manager);
  const { url, close } = await listen(app);
  try {
    const res = await fetch(`${url}/api/pairs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Fresh session" })
    });
    assert.equal(res.status, 201);
    const body = (await res.json()) as { pair: { title: string; messages: unknown[]; butlerSessionId: string | null } };
    assert.equal(body.pair.title, "Fresh session");
    assert.equal(body.pair.butlerSessionId, "pair-created");
    assert.equal(body.pair.messages.length, 0);
  } finally {
    await close();
  }
});

test("POST /api/pairs/:pairId/messages sends operator text to Butler", async () => {
  const fake = createFakePairSessions();
  const app = mountRoutes(fake.manager);
  const { url, close } = await listen(app);
  try {
    const res = await fetch(`${url}/api/pairs/pair-1/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "Hi", target: "butler" })
    });
    assert.equal(res.status, 202);
    assert.equal(fake.sentMessages.length, 1);
    assert.equal(fake.sentMessages[0]?.pairId, "pair-1");
    assert.equal(fake.sentMessages[0]?.text, "Hi");
    const body = (await res.json()) as { pair: { messageCount: number; messages: Array<{ role: string; text: string }> } };
    assert.equal(body.pair.messageCount, 1);
    assert.deepEqual(body.pair.messages.map((message) => [message.role, message.text]), [["user", "Hi"]]);
  } finally {
    await close();
  }
});

test("POST /api/pairs/:pairId/messages rejects direct worker messages", async () => {
  const fake = createFakePairSessions();
  const app = mountRoutes(fake.manager);
  const { url, close } = await listen(app);
  try {
    const res = await fetch(`${url}/api/pairs/pair-1/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "Do this directly", target: "worker" })
    });
    assert.equal(res.status, 409);
    assert.equal(fake.sentMessages.length, 0);
  } finally {
    await close();
  }
});
