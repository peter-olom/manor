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
    compose: {
      butler: {
        provider: "openai",
        model: "gpt-5",
        thinkingLevel: "medium",
        availableModels: [{ id: "gpt-5", label: "GPT-5", provider: "openai", supportedReasoningEfforts: ["low", "medium", "high"], defaultReasoningEffort: "medium" }],
        availableThinkingLevels: ["low", "medium", "high", "xhigh"]
      },
      codex: {
        model: "gpt-5-codex",
        effort: null,
        availableModels: [{ id: "gpt-5-codex", label: "GPT-5 Codex", provider: "openai", supportedReasoningEfforts: ["low", "medium", "high"], defaultReasoningEffort: "medium" }],
        availableEfforts: ["low", "medium", "high"]
      }
    },
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
      async setButlerThinkingLevel(pairId: string, level: string): Promise<PairDetail | null> {
        const pair = pairs.get(pairId);
        if (!pair) return null;
        const updated: PairDetail = {
          ...pair,
          butlerThinkingLevel: level,
          compose: { ...pair.compose, butler: { ...pair.compose.butler, thinkingLevel: level } },
          updatedAt: Date.now()
        };
        pairs.set(pairId, updated);
        return updated;
      },
      async setButlerModel(pairId: string, model: string): Promise<PairDetail | null> {
        const pair = pairs.get(pairId);
        if (!pair) return null;
        const updated: PairDetail = {
          ...pair,
          compose: { ...pair.compose, butler: { ...pair.compose.butler, model } },
          updatedAt: Date.now()
        };
        pairs.set(pairId, updated);
        return updated;
      },
      async setCodexEffort(pairId: string, effort: string): Promise<PairDetail | null> {
        const pair = pairs.get(pairId);
        if (!pair) return null;
        const updated: PairDetail = {
          ...pair,
          codexEffort: effort,
          compose: { ...pair.compose, codex: { ...pair.compose.codex, effort } },
          updatedAt: Date.now()
        };
        pairs.set(pairId, updated);
        return updated;
      },
      async setCodexModel(pairId: string, model: string): Promise<PairDetail | null> {
        const pair = pairs.get(pairId);
        if (!pair) return null;
        const updated: PairDetail = {
          ...pair,
          codexModel: model,
          compose: { ...pair.compose, codex: { ...pair.compose.codex, model } },
          updatedAt: Date.now()
        };
        pairs.set(pairId, updated);
        return updated;
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

test("PATCH /api/pairs/:pairId/settings updates the per-pair butler thinking level", async () => {
  const fake = createFakePairSessions();
  const app = mountRoutes(fake.manager);
  const { url, close } = await listen(app);
  try {
    const res = await fetch(`${url}/api/pairs/pair-1/settings`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ target: "butler", thinkingLevel: "high" })
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { pair: { butlerThinkingLevel: string; compose: { butler: { thinkingLevel: string } } } };
    assert.equal(body.pair.butlerThinkingLevel, "high");
    assert.equal(body.pair.compose.butler.thinkingLevel, "high");
  } finally {
    await close();
  }
});

test("PATCH /api/pairs/:pairId/settings updates the Butler model", async () => {
  const fake = createFakePairSessions();
  const app = mountRoutes(fake.manager);
  const { url, close } = await listen(app);
  try {
    const res = await fetch(`${url}/api/pairs/pair-1/settings`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ target: "butler", model: "gpt-5-pro" })
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { pair: { compose: { butler: { model: string | null } } } };
    assert.equal(body.pair.compose.butler.model, "gpt-5-pro");
  } finally {
    await close();
  }
});

test("PATCH /api/pairs/:pairId/settings updates the per-pair codex effort", async () => {
  const fake = createFakePairSessions();
  const app = mountRoutes(fake.manager);
  const { url, close } = await listen(app);
  try {
    const res = await fetch(`${url}/api/pairs/pair-1/settings`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ target: "codex", effort: "xhigh" })
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { pair: { codexEffort: string | null; compose: { codex: { effort: string | null } } } };
    assert.equal(body.pair.codexEffort, "xhigh");
    assert.equal(body.pair.compose.codex.effort, "xhigh");
  } finally {
    await close();
  }
});

test("PATCH /api/pairs/:pairId/settings updates the per-pair codex model", async () => {
  const fake = createFakePairSessions();
  const app = mountRoutes(fake.manager);
  const { url, close } = await listen(app);
  try {
    const res = await fetch(`${url}/api/pairs/pair-1/settings`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ target: "codex", model: "gpt-5-codex-high" })
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { pair: { codexModel: string | null; compose: { codex: { model: string | null } } } };
    assert.equal(body.pair.codexModel, "gpt-5-codex-high");
    assert.equal(body.pair.compose.codex.model, "gpt-5-codex-high");
  } finally {
    await close();
  }
});

test("PATCH /api/pairs/:pairId/settings returns 400 when codex model and effort are missing", async () => {
  const fake = createFakePairSessions();
  const app = mountRoutes(fake.manager);
  const { url, close } = await listen(app);
  try {
    const res = await fetch(`${url}/api/pairs/pair-1/settings`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ target: "codex" })
    });
    assert.equal(res.status, 400);
  } finally {
    await close();
  }
});

test("PATCH /api/pairs/:pairId/settings returns 400 when thinkingLevel missing", async () => {
  const fake = createFakePairSessions();
  const app = mountRoutes(fake.manager);
  const { url, close } = await listen(app);
  try {
    const res = await fetch(`${url}/api/pairs/pair-1/settings`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ target: "butler" })
    });
    assert.equal(res.status, 400);
  } finally {
    await close();
  }
});

test("PATCH /api/pairs/:pairId/settings returns 404 for unknown pair", async () => {
  const fake = createFakePairSessions();
  const app = mountRoutes(fake.manager);
  const { url, close } = await listen(app);
  try {
    const res = await fetch(`${url}/api/pairs/no-such/settings`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ target: "butler", thinkingLevel: "high" })
    });
    assert.equal(res.status, 404);
  } finally {
    await close();
  }
});

test("PATCH /api/pairs/:pairId/settings returns 400 for an invalid butler thinkingLevel", async () => {
  const fake = createFakePairSessions();
  const app = mountRoutes(fake.manager);
  const { url, close } = await listen(app);
  try {
    const res = await fetch(`${url}/api/pairs/pair-1/settings`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ target: "butler", thinkingLevel: "banana" })
    });
    assert.equal(res.status, 400);
  } finally {
    await close();
  }
});

test("PATCH /api/pairs/:pairId/settings returns 400 when codex effort missing", async () => {
  const fake = createFakePairSessions();
  const app = mountRoutes(fake.manager);
  const { url, close } = await listen(app);
  try {
    const res = await fetch(`${url}/api/pairs/pair-1/settings`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ target: "codex" })
    });
    assert.equal(res.status, 400);
  } finally {
    await close();
  }
});

test("PATCH /api/pairs/:pairId/settings returns 400 for an invalid codex effort", async () => {
  const fake = createFakePairSessions();
  const app = mountRoutes(fake.manager);
  const { url, close } = await listen(app);
  try {
    const res = await fetch(`${url}/api/pairs/pair-1/settings`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ target: "codex", effort: "turbo" })
    });
    assert.equal(res.status, 400);
  } finally {
    await close();
  }
});

test("PATCH /api/pairs/:pairId/settings returns 502 when codex provider rejects effort", async () => {
  const fake = createFakePairSessions();
  const failingManager = {
    ...fake.manager,
    async setCodexEffort(_pairId: string, _effort: string): Promise<PairDetail | null> {
      throw new Error("codex provider rejected effort");
    }
  };
  const app = mountRoutes(failingManager);
  const { url, close } = await listen(app);
  try {
    const res = await fetch(`${url}/api/pairs/pair-1/settings`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ target: "codex", effort: "xhigh" })
    });
    assert.equal(res.status, 502);
    const body = (await res.json()) as { error: string };
    assert.match(body.error, /codex provider rejected effort/);
  } finally {
    await close();
  }
});
