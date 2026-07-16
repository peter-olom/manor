import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import test from "node:test";
import express from "express";

import { registerPairRoutes } from "../../src/server/pair-routes.js";
import { WorkspaceCwdError } from "../../src/server/repo-worktree.js";
import type { PairDetail, PairSummary, PairWorkspaceOption } from "../../src/shared/pairing.js";

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
    butlerActivity: [],
    butlerActivityOutcome: null,
    review: null,
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
      worker: {
        runtime: "openai",
        harness: "codex",
        provider: "openai-codex",
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
  const sentMessages: Array<{ pairId: string; text: string; imageReferenceIds: string[]; fileReferenceIds: string[]; inputItems?: unknown[] }> = [];
  const handoffs: Array<{ pairId: string; harness: string | null; model: string; effort: string | null }> = [];
  const workspaceChanges: Array<{ pairId: string; cwd: string }> = [];
  const workspaces: PairWorkspaceOption[] = [{ id: "workspace:shared", cwd: "/repos", label: "Shared workspace", kind: "workspace", gitBacked: false }];
  const questionAnswers: Array<{ pairId: string; messageId: string; questionId: string; optionId?: string; freeformText?: string }> = [];
  return {
    sentMessages,
    handoffs,
    workspaceChanges,
    workspaces,
    questionAnswers,
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
      async getActivityWatchdogs(pairId: string) {
        if (!pairs.has(pairId)) return null;
        return {
          activeCount: 1,
          watchdogs: [{
            id: "delegation:worker-one",
            policy: "delegation-reconciliation" as const,
            label: "Worker handoff",
            target: "worker-one",
            intervalMs: 10_000,
            registeredAt: 1,
            lastCheckedAt: 2,
            checkCount: 3
          }]
        };
      },
      async listWorkspaces(): Promise<PairWorkspaceOption[]> {
        return workspaces;
      },
      async setWorkspaceCwd(pairId: string, cwd: string): Promise<PairDetail | null> {
        const pair = pairs.get(pairId);
        if (!pair) return null;
        workspaceChanges.push({ pairId, cwd });
        const updated = { ...pair, defaultCwd: cwd, updatedAt: Date.now() };
        pairs.set(pairId, updated);
        return updated;
      },
      async listComposerSuggestions(pairId: string, trigger: "@" | "$" | "/") {
        if (!pairs.has(pairId)) return null;
        return [{ id: `${trigger}:one`, kind: trigger === "/" ? "command" : trigger === "$" ? "skill" : "file", label: "One", detail: null, insertText: `${trigger}one` }];
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
      async retryBlockedReview(pairId: string): Promise<PairDetail | null> {
        return pairs.get(pairId) ?? null;
      },
      async stopReview(pairId: string): Promise<PairDetail | null> {
        return pairs.get(pairId) ?? null;
      },
      async handoffWorker(pairId: string, model: string, harness: string | null, effort: string | null): Promise<PairDetail | null> {
        const pair = pairs.get(pairId);
        if (!pair) return null;
        handoffs.push({ pairId, harness, model, effort });
        return pair;
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
      async setWorkerEffort(pairId: string, effort: string): Promise<PairDetail | null> {
        const pair = pairs.get(pairId);
        if (!pair) return null;
        const updated: PairDetail = {
          ...pair,
          workerEffort: effort,
          compose: { ...pair.compose, worker: { ...pair.compose.worker, effort } },
          updatedAt: Date.now()
        };
        pairs.set(pairId, updated);
        return updated;
      },
      async setWorkerModel(pairId: string, model: string, harness?: string | null): Promise<PairDetail | null> {
        const pair = pairs.get(pairId);
        if (!pair) return null;
        const updated: PairDetail = {
          ...pair,
          workerHarness: harness ?? null,
          workerModel: model,
          compose: { ...pair.compose, worker: { ...pair.compose.worker, harness: harness ?? null, model } },
          updatedAt: Date.now()
        };
        pairs.set(pairId, updated);
        return updated;
      },
      async sendOperatorMessage(input: { pairId: string; text: string; imageReferenceIds: string[]; fileReferenceIds: string[]; inputItems?: unknown[] }): Promise<PairDetail | null> {
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
      },
      async answerOperatorQuestion(input: { pairId: string; messageId: string; questionId: string; optionId?: string; freeformText?: string }): Promise<PairDetail | null> {
        const pair = pairs.get(input.pairId);
        if (!pair) return null;
        questionAnswers.push(input);
        return pair;
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

test("POST /api/pairs rejects an invalid initial workspace", async () => {
  const fake = createFakePairSessions();
  const app = mountRoutes({
    ...fake.manager,
    async createPair(): Promise<PairDetail> {
      throw new WorkspaceCwdError("Workspace directory must be inside the shared workspace.");
    }
  });
  const { url, close } = await listen(app);
  try {
    const res = await fetch(`${url}/api/pairs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ defaultCwd: "/tmp" })
    });
    assert.equal(res.status, 400);
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

test("GET /api/pairs/:pairId/composer-suggestions scopes suggestions to the active pair", async () => {
  const fake = createFakePairSessions();
  const { url, close } = await listen(mountRoutes(fake.manager));
  try {
    const res = await fetch(`${url}/api/pairs/pair-1/composer-suggestions?trigger=%40&q=pair`);
    assert.equal(res.status, 200);
    const body = await res.json() as { suggestions: Array<{ kind: string }> };
    assert.deepEqual(body.suggestions.map((suggestion) => suggestion.kind), ["file"]);
  } finally {
    await close();
  }
});

test("GET /api/pairs/:pairId/activity-watchdogs returns selected-session supervision", async () => {
  const fake = createFakePairSessions();
  const { url, close } = await listen(mountRoutes(fake.manager));
  try {
    const res = await fetch(`${url}/api/pairs/pair-1/activity-watchdogs`);
    assert.equal(res.status, 200);
    const body = await res.json() as { activeCount: number; watchdogs: Array<{ policy: string; target: string; checkCount: number }> };
    assert.equal(body.activeCount, 1);
    assert.deepEqual(body.watchdogs.map(({ policy, target, checkCount }) => ({ policy, target, checkCount })), [
      { policy: "delegation-reconciliation", target: "worker-one", checkCount: 3 }
    ]);

    const missing = await fetch(`${url}/api/pairs/missing/activity-watchdogs`);
    assert.equal(missing.status, 404);
  } finally {
    await close();
  }
});

test("POST /api/pairs/:pairId/messages forwards structured composer context", async () => {
  const fake = createFakePairSessions();
  const { url, close } = await listen(mountRoutes(fake.manager));
  try {
    const inputItems = [{ type: "skill", name: "review", id: "skill_123", environment: "butler-pi" }];
    const res = await fetch(`${url}/api/pairs/pair-1/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "", target: "butler", inputItems })
    });
    assert.equal(res.status, 202);
    assert.deepEqual(fake.sentMessages[0]?.inputItems, inputItems);
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

test("POST /api/pairs/:pairId/operator-question-answer scopes an option answer to the pair", async () => {
  const fake = createFakePairSessions();
  const app = mountRoutes(fake.manager);
  const { url, close } = await listen(app);
  try {
    const res = await fetch(`${url}/api/pairs/pair-1/operator-question-answer`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messageId: "question-message", questionId: "question-1", optionId: "simple" })
    });
    assert.equal(res.status, 202);
    assert.deepEqual(fake.questionAnswers, [{ pairId: "pair-1", messageId: "question-message", questionId: "question-1", optionId: "simple", freeformText: undefined }]);
  } finally {
    await close();
  }
});

test("POST /api/pairs/:pairId/operator-question-answer accepts exactly one freeform answer", async () => {
  const fake = createFakePairSessions();
  const app = mountRoutes(fake.manager);
  const { url, close } = await listen(app);
  try {
    const accepted = await fetch(`${url}/api/pairs/pair-1/operator-question-answer`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messageId: "question-message", questionId: "question-1", freeformText: "My own answer" })
    });
    assert.equal(accepted.status, 202);

    const rejected = await fetch(`${url}/api/pairs/pair-1/operator-question-answer`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messageId: "question-message", questionId: "question-1", optionId: "simple", freeformText: "Both" })
    });
    assert.equal(rejected.status, 400);
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

test("PATCH /api/pairs/:pairId/settings updates the per-pair worker effort", async () => {
  const fake = createFakePairSessions();
  const app = mountRoutes(fake.manager);
  const { url, close } = await listen(app);
  try {
    const res = await fetch(`${url}/api/pairs/pair-1/settings`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ target: "worker", effort: "xhigh" })
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { pair: { workerEffort: string | null; compose: { worker: { effort: string | null } } } };
    assert.equal(body.pair.workerEffort, "xhigh");
    assert.equal(body.pair.compose.worker.effort, "xhigh");
  } finally {
    await close();
  }
});

test("PATCH /api/pairs/:pairId/settings updates the per-pair worker model", async () => {
  const fake = createFakePairSessions();
  const app = mountRoutes(fake.manager);
  const { url, close } = await listen(app);
  try {
    const res = await fetch(`${url}/api/pairs/pair-1/settings`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ target: "worker", harness: "codex", model: "gpt-5-codex-high" })
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { pair: { workerHarness: string | null; workerModel: string | null; compose: { worker: { harness: string | null; model: string | null } } } };
    assert.equal(body.pair.workerHarness, "codex");
    assert.equal(body.pair.workerModel, "gpt-5-codex-high");
    assert.equal(body.pair.compose.worker.harness, "codex");
    assert.equal(body.pair.compose.worker.model, "gpt-5-codex-high");
  } finally {
    await close();
  }
});

test("PATCH /api/pairs/:pairId/settings returns 400 when worker model and effort are missing", async () => {
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

test("PATCH /api/pairs/:pairId/settings returns 400 when worker effort is missing", async () => {
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

test("PATCH /api/pairs/:pairId/settings returns 400 for an invalid worker effort", async () => {
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

test("PATCH /api/pairs/:pairId/settings returns 502 when worker provider rejects effort", async () => {
  const fake = createFakePairSessions();
  const failingManager = {
    ...fake.manager,
    async setWorkerEffort(_pairId: string, _effort: string): Promise<PairDetail | null> {
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

test("POST /api/pairs/:pairId/retry-review retries a paused adversarial review", async () => {
  const fake = createFakePairSessions();
  const app = mountRoutes(fake.manager);
  const { url, close } = await listen(app);
  try {
    const res = await fetch(`${url}/api/pairs/pair-1/retry-review`, { method: "POST" });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { pair: { id: string } };
    assert.equal(body.pair.id, "pair-1");
  } finally {
    await close();
  }
});

test("POST /api/pairs/:pairId/stop-review stops an active adversarial review", async () => {
  const fake = createFakePairSessions();
  const app = mountRoutes(fake.manager);
  const { url, close } = await listen(app);
  try {
    const res = await fetch(`${url}/api/pairs/pair-1/stop-review`, { method: "POST" });
    assert.equal(res.status, 200);
    assert.equal(((await res.json()) as { pair: PairDetail }).pair.id, "pair-1");
  } finally {
    await close();
  }
});

test("POST /api/pairs/:pairId/worker/handoff starts an explicit model handoff", async () => {
  const fake = createFakePairSessions();
  const app = mountRoutes(fake.manager);
  const { url, close } = await listen(app);
  try {
    const res = await fetch(`${url}/api/pairs/pair-1/worker/handoff`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ harness: "pi", model: "opencode-go/minimax-m3", effort: "high" })
    });
    assert.equal(res.status, 201);
    assert.deepEqual(fake.handoffs, [{ pairId: "pair-1", harness: "pi", model: "opencode-go/minimax-m3", effort: "high" }]);
  } finally {
    await close();
  }
});

test("GET /api/workspaces lists valid workspace choices", async () => {
  const fake = createFakePairSessions();
  const app = mountRoutes(fake.manager);
  const { url, close } = await listen(app);
  try {
    const res = await fetch(`${url}/api/workspaces`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { workspaces: fake.workspaces });
  } finally {
    await close();
  }
});

test("PATCH /api/pairs/:pairId/workspace changes the session workspace", async () => {
  const fake = createFakePairSessions();
  const app = mountRoutes(fake.manager);
  const { url, close } = await listen(app);
  try {
    const res = await fetch(`${url}/api/pairs/pair-1/workspace`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cwd: "/repos/manor" })
    });
    assert.equal(res.status, 200);
    assert.equal(((await res.json()) as { pair: PairDetail }).pair.defaultCwd, "/repos/manor");
    assert.deepEqual(fake.workspaceChanges, [{ pairId: "pair-1", cwd: "/repos/manor" }]);
  } finally {
    await close();
  }
});

test("PATCH /api/pairs/:pairId/workspace maps invalid paths and conflicts", async () => {
  const fake = createFakePairSessions();
  const app = mountRoutes({
    ...fake.manager,
    async setWorkspaceCwd(_pairId: string, cwd: string): Promise<PairDetail | null> {
      if (cwd === "/invalid") throw new WorkspaceCwdError("Workspace must be inside the shared workspace");
      throw new Error("Wait for the current Worker turn to finish");
    }
  });
  const { url, close } = await listen(app);
  try {
    for (const [cwd, status] of [["/invalid", 400], ["/repos/busy", 409]] as const) {
      const res = await fetch(`${url}/api/pairs/pair-1/workspace`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cwd })
      });
      assert.equal(res.status, status);
    }
  } finally {
    await close();
  }
});
