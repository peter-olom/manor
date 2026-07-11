import { execFile } from "node:child_process";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import express from "express";

import { buildButlerCodexTools } from "../../src/server/butler-agent-codex-tools.js";
import type { ButlerAgentToolAccess } from "../../src/server/butler-agent-tool-access.js";
import { commitSelfImprovementRequest, configureSelfImprovementPairCleanup, discardSelfImprovementRequest, openSelfImprovementPullRequest, reconcileInterruptedSelfImprovementRequests, runSerializedSelfImprovementAction } from "../../src/server/self-improvement-actions.js";
import { resolveSelfImprovementEligibility } from "../../src/server/self-improvement-eligibility.js";
import { configureSelfImprovementRequestState, SelfImprovementRequestState } from "../../src/server/self-improvement-request-state.js";
import { registerSelfImprovementRoutes } from "../../src/server/self-improvement-routes.js";
import { ButlerStateStore } from "../../src/server/state-store.js";
import { sendWorkerMessage } from "../../src/server/worker-client-router.js";

const execFileAsync = promisify(execFile);

async function createRequestState(prefix = "manor-self-improvement-queue-") {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  const state = new SelfImprovementRequestState(path.join(dir, "requests.json"), () => undefined, () => undefined);
  await state.load();
  configureSelfImprovementRequestState(state);
  return { dir, state };
}

async function createStore() {
  const dir = await mkdtemp(path.join(tmpdir(), "manor-self-improvement-store-"));
  const store = new ButlerStateStore(path.join(dir, "state.json"));
  await store.load();
  return { dir, store };
}

async function removeTempDir(dir: string): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 250));
  await rm(dir, { recursive: true, force: true });
}

async function listen(app: express.Express): Promise<{ origin: string; close: () => Promise<void> }> {
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return {
    origin: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve()))
  };
}

function requestInput() {
  return {
    trigger: "Preview broker blocked a Manor-managed job.",
    symptoms: "Worker could not start a preview.",
    logs: "runtime-broker stale network removal failed",
    observations: "The blocker repeats after retry and is inside Manor infrastructure.",
    suspectedCause: "Broker cleanup does not retry stale network removal.",
    proposedChange: "Add retry handling around broker cleanup.",
    risk: "May affect preview cleanup behavior.",
    desiredOutcome: "Preview starts after stale network cleanup."
  };
}

async function createGitSource(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "manor-self-improvement-source-"));
  await execFileAsync("git", ["init"], { cwd: dir });
  await execFileAsync("git", ["config", "user.email", "test@example.com"], { cwd: dir });
  await execFileAsync("git", ["config", "user.name", "Test User"], { cwd: dir });
  await writeFile(path.join(dir, "README.md"), "test\n", "utf8");
  await execFileAsync("git", ["add", "README.md"], { cwd: dir });
  await execFileAsync("git", ["commit", "-m", "Initial commit"], { cwd: dir });
  return dir;
}

test("self-improvement request state persists required evidence and dismissal reason", async () => {
  const { dir, state } = await createRequestState();
  try {
    const created = state.create(requestInput());
    const dismissed = state.dismiss(created.id, "Already covered by another fix.");
    const reloaded = new SelfImprovementRequestState(path.join(dir, "requests.json"), () => undefined, () => undefined);
    await state.flush();
    await reloaded.load();

    assert.equal(dismissed.status, "dismissed");
    assert.equal(dismissed.dismissedReason, "Already covered by another fix.");
    assert.equal(reloaded.get(created.id)?.proposedChange, "Add retry handling around broker cleanup.");
  } finally {
    await removeTempDir(dir);
  }
});

test("an interrupted approved request can be closed after reload", async () => {
  const { dir, state } = await createRequestState();
  try {
    const created = state.create(requestInput());
    state.update(created.id, { status: "approved", approvedAt: Date.now() });
    await state.flush();
    const reloaded = new SelfImprovementRequestState(path.join(dir, "requests.json"), () => undefined, () => undefined);
    await reloaded.load();

    assert.equal(reloaded.get(created.id)?.status, "approved");
    assert.equal(reloaded.hasSourceCheckoutOwner(), true);
    const closed = await discardSelfImprovementRequest(reloaded, {} as never, created.id);
    assert.equal(closed.status, "discarded");
    assert.equal(reloaded.hasSourceCheckoutOwner(), false);
  } finally {
    await removeTempDir(dir);
  }
});

test("startup releases checkout ownership when approval created no Worker or pair", async () => {
  const { dir, state } = await createRequestState();
  try {
    const created = state.create(requestInput());
    state.update(created.id, { status: "approved", approvedAt: Date.now() });
    await state.flush();
    const reloaded = new SelfImprovementRequestState(path.join(dir, "requests.json"), () => undefined, () => undefined);
    await reloaded.load();

    await reconcileInterruptedSelfImprovementRequests(
      reloaded,
      { getThread: () => null, getWorkerReport: () => null },
      { getPair: () => null, findPairByWorkerThread: () => null },
      { createWorkerPair: async () => { throw new Error("should not attach"); } }
    );

    assert.equal(reloaded.get(created.id)?.status, "pending");
    assert.equal(reloaded.hasSourceCheckoutOwner(), false);
  } finally {
    await removeTempDir(dir);
  }
});

test("startup reattaches an interrupted running self-improvement Worker", async () => {
  const { dir, state } = await createRequestState();
  try {
    const created = state.create(requestInput());
    state.update(created.id, {
      status: "running",
      threadId: "worker-after-restart",
      workspaceCwd: dir,
      startedAt: Date.now()
    });
    await state.flush();
    const reloaded = new SelfImprovementRequestState(path.join(dir, "requests.json"), () => undefined, () => undefined);
    await reloaded.load();
    const attached: string[] = [];

    await reconcileInterruptedSelfImprovementRequests(
      reloaded,
      { getThread: () => ({ id: "worker-after-restart" }) as never, getWorkerReport: () => null },
      { getPair: () => null, findPairByWorkerThread: () => null },
      { createWorkerPair: async (input) => {
        attached.push(input.threadId);
        return { id: "recovered-pair" } as never;
      } }
    );

    assert.deepEqual(attached, ["worker-after-restart"]);
    assert.equal(reloaded.get(created.id)?.status, "running");
    assert.equal(reloaded.get(created.id)?.pairId, "recovered-pair");
  } finally {
    await removeTempDir(dir);
  }
});

test("failed startup reattachment leaves the request closable", async () => {
  const { dir, state } = await createRequestState();
  try {
    const created = state.create(requestInput());
    state.update(created.id, {
      status: "running",
      threadId: "worker-reattach-failure",
      workspaceCwd: dir,
      startedAt: Date.now()
    });
    await state.flush();

    await reconcileInterruptedSelfImprovementRequests(
      state,
      { getThread: () => ({ id: "worker-reattach-failure" }) as never, getWorkerReport: () => null },
      { getPair: () => null, findPairByWorkerThread: () => null },
      { createWorkerPair: async () => { throw new Error("pair unavailable"); } }
    );

    assert.equal(state.get(created.id)?.status, "running");
    assert.equal(state.get(created.id)?.threadId, "worker-reattach-failure");
  } finally {
    await removeTempDir(dir);
  }
});

test("startup reuses a durable pair when the request link is missing or stale", async () => {
  const { dir, state } = await createRequestState();
  try {
    const created = state.create(requestInput());
    state.update(created.id, { status: "running", threadId: "worker-with-pair", pairId: "stale-pair", workspaceCwd: dir, startedAt: Date.now() });
    let createdPairs = 0;
    await reconcileInterruptedSelfImprovementRequests(
      state,
      { getThread: () => ({ id: "worker-with-pair" }) as never, getWorkerReport: () => null },
      {
        getPair: () => ({ id: "stale-pair", worker: { threadId: "different-worker" } }) as never,
        findPairByWorkerThread: () => ({ id: "existing-pair", worker: { threadId: "worker-with-pair" } }) as never
      },
      { createWorkerPair: async () => { createdPairs += 1; return { id: "duplicate" } as never; } }
    );
    assert.equal(createdPairs, 0);
    assert.equal(state.get(created.id)?.pairId, "existing-pair");
  } finally {
    await removeTempDir(dir);
  }
});

test("startup repairs a handoff when the request advanced before the durable pair", async () => {
  const { dir, state } = await createRequestState();
  try {
    const created = state.create(requestInput());
    state.update(created.id, {
      status: "running",
      threadId: "replacement-worker",
      workerThreadIds: ["source-worker"],
      pairId: "handoff-pair",
      workspaceCwd: dir,
      startedAt: Date.now()
    });
    let pair = { id: "handoff-pair", worker: { threadId: "source-worker", handedOffFrom: null } };
    let pairFlushes = 0;
    let createdPairs = 0;

    await reconcileInterruptedSelfImprovementRequests(
      state,
      { getThread: (threadId) => ({ id: threadId }) as never, getWorkerReport: () => null },
      {
        getPair: () => pair as never,
        findPairByWorkerThread: () => null,
        attachWorker: (_pairId, input) => {
          assert.equal(input.threadId, "replacement-worker");
          assert.equal(input.replacesThreadId, "source-worker");
          pair = { id: "handoff-pair", worker: { threadId: "replacement-worker", handedOffFrom: { threadId: "source-worker" } } } as never;
          return pair as never;
        },
        flushPendingSave: async () => { pairFlushes += 1; }
      },
      { createWorkerPair: async () => { createdPairs += 1; return { id: "duplicate" } as never; } }
    );

    assert.equal(createdPairs, 0);
    assert.equal(pairFlushes, 1);
    assert.equal(pair.worker.threadId, "replacement-worker");
    assert.equal(state.get(created.id)?.threadId, "replacement-worker");
    assert.deepEqual(state.get(created.id)?.workerThreadIds, ["source-worker", "replacement-worker"]);
  } finally {
    await state.flush();
    await removeTempDir(dir);
  }
});

test("startup advances a handoff request when the durable pair committed first", async () => {
  const { dir, state } = await createRequestState();
  try {
    const created = state.create(requestInput());
    state.update(created.id, {
      status: "changes_ready",
      threadId: "source-worker",
      pairId: "handoff-pair",
      workspaceCwd: dir,
      completedAt: 123,
      commitSha: "old-commit"
    });
    const pair = {
      id: "handoff-pair",
      worker: { threadId: "replacement-worker", handedOffFrom: { threadId: "source-worker" } }
    };
    let createdPairs = 0;

    await reconcileInterruptedSelfImprovementRequests(
      state,
      { getThread: (threadId) => ({ id: threadId }) as never, getWorkerReport: () => null },
      {
        getPair: () => pair as never,
        findPairByWorkerThread: (threadId) => threadId === "replacement-worker" ? pair as never : null
      },
      { createWorkerPair: async () => { createdPairs += 1; return { id: "duplicate" } as never; } }
    );

    assert.equal(createdPairs, 0);
    assert.equal(state.get(created.id)?.status, "running");
    assert.equal(state.get(created.id)?.threadId, "replacement-worker");
    assert.deepEqual(state.get(created.id)?.workerThreadIds, ["source-worker", "replacement-worker"]);
    assert.equal(state.get(created.id)?.completedAt, null);
    assert.equal(state.get(created.id)?.commitSha, null);
  } finally {
    await state.flush();
    await removeTempDir(dir);
  }
});

test("startup promotes a completed report and repairs its stale pair link", async () => {
  const { dir, state } = await createRequestState();
  try {
    const created = state.create(requestInput());
    state.update(created.id, { status: "running", threadId: "completed-worker", pairId: "stale-completed-pair", workspaceCwd: dir, startedAt: Date.now() });
    await reconcileInterruptedSelfImprovementRequests(
      state,
      {
        getThread: () => ({ id: "completed-worker" }) as never,
        getWorkerReport: () => ({ status: "completed", updatedAt: 1234 }) as never
      },
      {
        getPair: () => ({ id: "stale-completed-pair", worker: { threadId: "different-worker" } }) as never,
        findPairByWorkerThread: () => ({ id: "completed-pair", worker: { threadId: "completed-worker" } }) as never
      },
      { createWorkerPair: async () => { throw new Error("should not attach"); } }
    );
    assert.equal(state.get(created.id)?.status, "changes_ready");
    assert.equal(state.get(created.id)?.completedAt, 1234);
    assert.equal(state.get(created.id)?.pairId, "completed-pair");
  } finally {
    await removeTempDir(dir);
  }
});

test("startup preserves ready and committed requests while repairing their Worker pair links", async () => {
  const { dir, state } = await createRequestState();
  try {
    const ready = state.create({ ...requestInput(), trigger: "Ready request with a stale pair." });
    const committed = state.create({ ...requestInput(), trigger: "Committed request with a stale pair." });
    state.update(ready.id, {
      status: "changes_ready",
      threadId: "ready-worker",
      pairId: "stale-ready-pair",
      workspaceCwd: dir,
      completedAt: 111
    });
    state.update(committed.id, {
      status: "committed",
      threadId: "committed-worker",
      pairId: "stale-committed-pair",
      workspaceCwd: dir,
      completedAt: 222,
      commitSha: "committed-sha"
    });
    let createdPairs = 0;

    await reconcileInterruptedSelfImprovementRequests(
      state,
      {
        getThread: (threadId) => ({ id: threadId }) as never,
        getWorkerReport: () => ({ status: "completed", updatedAt: 333 }) as never
      },
      {
        getPair: (pairId) => ({ id: pairId, worker: { threadId: "different-worker" } }) as never,
        findPairByWorkerThread: (threadId) => ({ id: `${threadId}-pair`, worker: { threadId } }) as never
      },
      { createWorkerPair: async () => { createdPairs += 1; return { id: "duplicate" } as never; } }
    );

    assert.equal(createdPairs, 0);
    assert.equal(state.get(ready.id)?.status, "changes_ready");
    assert.equal(state.get(ready.id)?.pairId, "ready-worker-pair");
    assert.equal(state.get(ready.id)?.completedAt, 111);
    assert.equal(state.get(committed.id)?.status, "committed");
    assert.equal(state.get(committed.id)?.pairId, "committed-worker-pair");
    assert.equal(state.get(committed.id)?.commitSha, "committed-sha");
  } finally {
    await state.flush();
    await removeTempDir(dir);
  }
});

test("startup waits for provider inventory before declaring a Worker missing", async () => {
  const { dir, state } = await createRequestState();
  try {
    const created = state.create(requestInput());
    state.update(created.id, { status: "running", threadId: "provider-worker", workspaceCwd: dir, startedAt: Date.now() });
    const store = { getThread: () => null, getWorkerReport: () => null };
    const pairs = { getPair: () => null, findPairByWorkerThread: () => null };
    const sessions = { createWorkerPair: async () => { throw new Error("should not attach"); } };
    await reconcileInterruptedSelfImprovementRequests(state, store, pairs, sessions, () => false);
    assert.equal(state.get(created.id)?.status, "running");
    await reconcileInterruptedSelfImprovementRequests(state, store, pairs, sessions, () => true);
    assert.equal(state.get(created.id)?.status, "pending");
  } finally {
    await removeTempDir(dir);
  }
});

test("approval source persists the Worker store before checkpointing its thread id", async () => {
  const source = await readFile(path.resolve("src/server/self-improvement-routes.ts"), "utf8");
  const inputCallback = source.slice(source.indexOf("input: async (threadId)"), source.indexOf("delegation = await", source.indexOf("input: async (threadId)")));
  assert.ok(inputCallback.indexOf("await store.flushSave()") < inputCallback.indexOf("requests.update(approved.id"));
  assert.ok(inputCallback.indexOf("requests.update(approved.id") < inputCallback.indexOf("await requests.flush()"));
});

test("request_self_improvement queues evidence without starting a worker session", async () => {
  const { dir: requestDir, state } = await createRequestState();
  const { dir: storeDir, store } = await createStore();
  let started = false;
  try {
    const definitions: Array<{ name: string; execute: (id: string, params: Record<string, unknown>) => Promise<unknown> }> = [];
    const access = {
      defineButlerTool: (definition: (typeof definitions)[number]) => {
        definitions.push(definition);
        return definition;
      },
      getToolUiEffects: () => [],
      store,
      codexClient: { startThread: async () => { started = true; throw new Error("should not start"); } },
      imageStore: { list: () => [] },
      fileStore: { list: () => [] },
      noteThreadFocus: () => undefined
    } as unknown as ButlerAgentToolAccess;
    buildButlerCodexTools(access);
    const tool = definitions.find((entry) => entry.name === "request_self_improvement");
    assert.ok(tool);
    store.upsertThreadSummary({
      id: "thread-blocked",
      status: "idle",
      turns: [{ id: "turn-1", status: "completed", items: [] }]
    });
    store.recordWorkerReport("thread-blocked", {
      turnId: "turn-1",
      status: "blocked",
      summary: "Preview broker blocked the worker.",
      details: "The worker hit a Manor platform blocker."
    });

    await tool.execute("call-1", { ...requestInput(), sourceThreadId: "thread-blocked" });

    assert.equal(started, false);
    assert.equal(state.list().length, 1);
    assert.equal(state.list()[0]?.status, "pending");
    assert.equal(state.list()[0]?.sourceThreadId, "thread-blocked");
  } finally {
    await removeTempDir(requestDir);
    await removeTempDir(storeDir);
  }
});

test("request_self_improvement rejects direct requests without a blocked source job", async () => {
  const { dir: requestDir } = await createRequestState();
  const { dir: storeDir, store } = await createStore();
  try {
    const definitions: Array<{ name: string; execute: (id: string, params: Record<string, unknown>) => Promise<unknown> }> = [];
    const access = {
      defineButlerTool: (definition: (typeof definitions)[number]) => {
        definitions.push(definition);
        return definition;
      },
      getToolUiEffects: () => [],
      store,
      codexClient: {},
      imageStore: { list: () => [] },
      fileStore: { list: () => [] },
      noteThreadFocus: () => undefined
    } as unknown as ButlerAgentToolAccess;
    buildButlerCodexTools(access);
    const tool = definitions.find((entry) => entry.name === "request_self_improvement");
    assert.ok(tool);

    await assert.rejects(() => tool.execute("call-1", requestInput()), /blocked source job/);
  } finally {
    await removeTempDir(requestDir);
    await removeTempDir(storeDir);
  }
});

test("approval is refused in image mode with an eligibility reason", async () => {
  const { dir, state } = await createRequestState();
  const app = express();
  app.use(express.json());
  const created = state.create(requestInput());
  registerSelfImprovementRoutes({
    app,
    requests: state,
    hostController: { getStatus: async () => ({ ok: true, active: null, latestRun: null, detectedMode: "image" }) } as never,
    store: {} as never,
    codexClient: {} as never,
    imageStore: { resolveViews: () => [] } as never,
    fileStore: { resolveViews: () => [] } as never,
    artifactsDir: dir
  });
  const server = await listen(app);
  try {
    const response = await fetch(`${server.origin}/api/self-improvement/requests/${created.id}/approve`, { method: "POST" });
    const payload = await response.json() as { error?: string };

    assert.equal(response.status, 409);
    assert.match(payload.error ?? "", /source-first mode/);
    assert.equal(state.get(created.id)?.status, "pending");
  } finally {
    await server.close();
    await removeTempDir(dir);
  }
});

test("approval creates a visible session and preserves immediate Worker completion", async () => {
  const { dir: requestDir, state } = await createRequestState();
  const { dir: storeDir, store } = await createStore();
  const sourceDir = await createGitSource();
  const previous = process.env.MANOR_SELF_IMPROVEMENT_SOURCE_CWD;
  process.env.MANOR_SELF_IMPROVEMENT_SOURCE_CWD = sourceDir;
  const app = express();
  app.use(express.json());
  const created = state.create(requestInput());
  const createdPairs: Array<{
    threadId: string;
    cwd: string | null;
    task: string | null;
    runtime: string | null;
    harness: string | null;
    provider: string | null;
    model: string | null;
    effort: string | null;
  }> = [];
  let workerDeveloperInstructions = "";
  registerSelfImprovementRoutes({
    app,
    requests: state,
    hostController: { getStatus: async () => ({ ok: true, active: null, latestRun: null, detectedMode: "source" }) } as never,
    store,
    codexClient: {
      getConnectionState: () => ({ compose: { model: "gpt-5-codex", effort: "high", availableModels: [{ id: "gpt-5-codex", label: "GPT-5 Codex", provider: null, supportsReasoning: true, supportedThinkingLevels: ["high"], supportedReasoningEfforts: ["high"], defaultReasoningEffort: "high" }] } }),
      updateComposeSettings: async () => undefined,
      startThread: async (options: { input: (threadId: string) => Promise<unknown>; cwd: string; developerInstructions?: string }) => {
        workerDeveloperInstructions = options.developerInstructions ?? "";
        await options.input("thread-approved");
        store.upsertThreadSummary({
          id: "thread-approved",
          status: "active",
          cwd: options.cwd,
          turns: [{ id: "turn-1", status: "inProgress", items: [] }]
        });
        return { threadId: "thread-approved", turnId: "turn-1" };
      }
    } as never,
    getCodexAuthStatus: () => ({ loggedIn: true }),
    getWorkerAffinity: () => null,
    recordSuccessfulWorkerSelection: () => undefined,
    pairSessions: {
      createWorkerPair: async (input) => {
        createdPairs.push({
          threadId: input.threadId,
          cwd: input.cwd ?? null,
          task: input.task ?? null,
          runtime: input.runtime ?? null,
          harness: input.harness ?? null,
          provider: input.provider ?? null,
          model: input.model ?? null,
          effort: input.effort ?? null
        });
        state.update(created.id, { status: "changes_ready", completedAt: Date.now() });
        return { id: "pair-approved" };
      }
    } as never,
    imageStore: { resolveViews: () => [] } as never,
    fileStore: { resolveViews: () => [] } as never,
    artifactsDir: requestDir
  });
  const server = await listen(app);
  try {
    const response = await fetch(`${server.origin}/api/self-improvement/requests/${created.id}/approve`, { method: "POST" });
    const payload = await response.json() as { error?: string; request?: { status?: string; threadId?: string | null; pairId?: string | null } };

    assert.equal(response.status, 202, payload.error);
    assert.equal(payload.request?.status, "changes_ready");
    assert.equal(payload.request?.threadId, "thread-approved");
    assert.equal(payload.request?.pairId, "pair-approved");
    assert.equal(state.get(created.id)?.pairId, "pair-approved");
    assert.equal(state.get(created.id)?.status, "changes_ready");
    assert.equal(createdPairs.length, 1);
    assert.equal(createdPairs[0]?.threadId, "thread-approved");
    assert.equal(createdPairs[0]?.cwd, sourceDir);
    assert.match(createdPairs[0]?.task ?? "", /active Manor source checkout/);
    assert.doesNotMatch(createdPairs[0]?.task ?? "", /isolated self-improvement worktree/);
    assert.match(workerDeveloperInstructions, /Stay on the existing checkout/);
    assert.doesNotMatch(workerDeveloperInstructions, /Create or reuse the explicitly requested isolated branch or worktree/);
    assert.deepEqual({
      runtime: createdPairs[0]?.runtime,
      harness: createdPairs[0]?.harness,
      provider: createdPairs[0]?.provider,
      model: createdPairs[0]?.model,
      effort: createdPairs[0]?.effort
    }, {
      runtime: "openai",
      harness: "codex",
      provider: "openai-codex",
      model: "gpt-5-codex",
      effort: "high"
    });
  } finally {
    await server.close();
    if (previous === undefined) {
      delete process.env.MANOR_SELF_IMPROVEMENT_SOURCE_CWD;
    } else {
      process.env.MANOR_SELF_IMPROVEMENT_SOURCE_CWD = previous;
    }
    await removeTempDir(sourceDir);
    await removeTempDir(requestDir);
    await removeTempDir(storeDir);
  }
});

test("approval is serialized while another self-improvement worker owns the checkout", async () => {
  const { dir: requestDir, state } = await createRequestState();
  const sourceDir = await createGitSource();
  const previous = process.env.MANOR_SELF_IMPROVEMENT_SOURCE_CWD;
  process.env.MANOR_SELF_IMPROVEMENT_SOURCE_CWD = sourceDir;
  const app = express();
  app.use(express.json());
  const active = state.create(requestInput());
  state.update(active.id, { status: "changes_ready", threadId: "thread-active" });
  const pending = state.create({ ...requestInput(), trigger: "Another Manor issue." });
  let started = false;
  registerSelfImprovementRoutes({
    app,
    requests: state,
    hostController: { getStatus: async () => ({ ok: true, active: null, latestRun: null, detectedMode: "source" }) } as never,
    store: {} as never,
    codexClient: { startThread: async () => { started = true; throw new Error("should not start"); } } as never,
    imageStore: { resolveViews: () => [] } as never,
    fileStore: { resolveViews: () => [] } as never,
    artifactsDir: requestDir
  });
  const server = await listen(app);
  try {
    const response = await fetch(`${server.origin}/api/self-improvement/requests/${pending.id}/approve`, { method: "POST" });
    const payload = await response.json() as { error?: string };

    assert.equal(response.status, 409);
    assert.match(payload.error ?? "", /already using the active Manor source checkout/);
    assert.equal(started, false);
    assert.equal(state.get(pending.id)?.status, "pending");
  } finally {
    await server.close();
    if (previous === undefined) {
      delete process.env.MANOR_SELF_IMPROVEMENT_SOURCE_CWD;
    } else {
      process.env.MANOR_SELF_IMPROVEMENT_SOURCE_CWD = previous;
    }
    await removeTempDir(sourceDir);
    await removeTempDir(requestDir);
  }
});

test("approval deletes the Worker and pair when post-pair setup fails", async () => {
  const { dir: requestDir, state } = await createRequestState();
  const { dir: storeDir, store } = await createStore();
  const sourceDir = await createGitSource();
  const previous = process.env.MANOR_SELF_IMPROVEMENT_SOURCE_CWD;
  process.env.MANOR_SELF_IMPROVEMENT_SOURCE_CWD = sourceDir;
  const app = express();
  app.use(express.json());
  const created = state.create(requestInput());
  const deletedWorkers: string[] = [];
  const deletedPairs: string[] = [];
  let failPairDeletion = false;
  let payloadWrites = 0;
  const routeStore = new Proxy(store, {
    get(target, property, receiver) {
      if (property === "setThreadJobPayload") return (...args: unknown[]) => {
        payloadWrites += 1;
        if (payloadWrites > 1) throw new Error("payload setup failed");
        return (target.setThreadJobPayload as (...input: unknown[]) => unknown).apply(target, args);
      };
      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    }
  });
  registerSelfImprovementRoutes({
    app,
    requests: state,
    hostController: { getStatus: async () => ({ ok: true, active: null, latestRun: null, detectedMode: "source" }) } as never,
    store: routeStore,
    codexClient: {
      getConnectionState: () => ({ compose: { model: "gpt-5-codex", effort: "high", availableModels: [{ id: "gpt-5-codex", label: "GPT-5 Codex", provider: null, supportsReasoning: true, supportedThinkingLevels: ["high"], supportedReasoningEfforts: ["high"], defaultReasoningEffort: "high" }] } }),
      updateComposeSettings: async () => undefined,
      startThread: async (options: { input: (threadId: string) => Promise<unknown>; cwd: string }) => {
        await options.input("thread-setup-failure");
        store.upsertThreadSummary({
          id: "thread-setup-failure",
          status: "active",
          cwd: options.cwd,
          turns: [{ id: "turn-1", status: "inProgress", items: [] }]
        });
        return { threadId: "thread-setup-failure", turnId: "turn-1" };
      },
      deleteThread: async (threadId: string) => {
        deletedWorkers.push(threadId);
        store.removeThread(threadId);
        return { deleted: true };
      }
    } as never,
    getCodexAuthStatus: () => ({ loggedIn: true }),
    getWorkerAffinity: () => null,
    recordSuccessfulWorkerSelection: () => undefined,
    pairSessions: {
      createWorkerPair: async () => ({ id: "pair-setup-failure" }),
      deletePair: async (pairId: string) => {
        deletedPairs.push(pairId);
        if (failPairDeletion) throw new Error("pair cleanup failed");
        return true;
      }
    } as never,
    imageStore: { resolveViews: () => [] } as never,
    fileStore: { resolveViews: () => [] } as never,
    artifactsDir: requestDir
  });
  const server = await listen(app);
  try {
    const response = await fetch(`${server.origin}/api/self-improvement/requests/${created.id}/approve`, { method: "POST" });
    const payload = await response.json() as { error?: string };

    assert.equal(response.status, 409);
    assert.match(payload.error ?? "", /payload setup failed/);
    assert.deepEqual(deletedWorkers, ["thread-setup-failure"]);
    assert.deepEqual(deletedPairs, ["pair-setup-failure"]);
    assert.equal(store.getThread("thread-setup-failure"), undefined);
    assert.equal(state.get(created.id)?.status, "pending");
    assert.equal(state.get(created.id)?.threadId, null);

    deletedWorkers.length = 0;
    deletedPairs.length = 0;
    payloadWrites = 0;
    failPairDeletion = true;
    const retained = state.create(requestInput());
    const failedCleanupResponse = await fetch(`${server.origin}/api/self-improvement/requests/${retained.id}/approve`, { method: "POST" });
    const failedCleanupPayload = await failedCleanupResponse.json() as { error?: string };

    assert.equal(failedCleanupResponse.status, 409);
    assert.match(failedCleanupPayload.error ?? "", /pair cleanup failed/);
    assert.deepEqual(deletedPairs, ["pair-setup-failure"]);
    assert.deepEqual(deletedWorkers, []);
    assert.ok(store.getThread("thread-setup-failure"));
    assert.equal(state.get(retained.id)?.status, "running");
    assert.equal(state.get(retained.id)?.threadId, "thread-setup-failure");
    assert.equal(state.get(retained.id)?.pairId, "pair-setup-failure");
  } finally {
    await server.close();
    if (previous === undefined) {
      delete process.env.MANOR_SELF_IMPROVEMENT_SOURCE_CWD;
    } else {
      process.env.MANOR_SELF_IMPROVEMENT_SOURCE_CWD = previous;
    }
    await removeTempDir(sourceDir);
    await removeTempDir(requestDir);
    await removeTempDir(storeDir);
  }
});

test("source-first eligibility requires source mode and a writable Git checkout", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "manor-self-improvement-source-"));
  const previous = process.env.MANOR_SELF_IMPROVEMENT_SOURCE_CWD;
  process.env.MANOR_SELF_IMPROVEMENT_SOURCE_CWD = dir;
  try {
    await execFileAsync("git", ["init"], { cwd: dir });
    const enabled = await resolveSelfImprovementEligibility({
      getStatus: async () => ({ ok: true, active: null, latestRun: null, detectedMode: "source" })
    } as never);
    const disabled = await resolveSelfImprovementEligibility({
      getStatus: async () => ({ ok: true, active: null, latestRun: null, detectedMode: "image" })
    } as never);

    assert.equal(enabled.enabled, true);
    assert.equal(disabled.enabled, false);
    assert.match(disabled.reasons.join(" "), /source-first mode/);
  } finally {
    if (previous === undefined) {
      delete process.env.MANOR_SELF_IMPROVEMENT_SOURCE_CWD;
    } else {
      process.env.MANOR_SELF_IMPROVEMENT_SOURCE_CWD = previous;
    }
    await removeTempDir(dir);
  }
});

test("completed self-improvement worker report marks local changes ready", async () => {
  const { dir: requestDir, state } = await createRequestState();
  const { dir: storeDir, store } = await createStore();
  try {
    const created = state.create(requestInput());
    state.update(created.id, { status: "running", threadId: "thread-self-improvement" });
    store.upsertThreadSummary({
      id: "thread-self-improvement",
      status: "idle",
      turns: [{ id: "turn-1", status: "completed", items: [] }]
    });

    store.recordWorkerReport("thread-self-improvement", {
      turnId: "turn-1",
      status: "completed",
      summary: "Implemented local changes.",
      details: "Changes are ready for operator review."
    });

    assert.equal(state.get(created.id)?.status, "changes_ready");
  } finally {
    await removeTempDir(requestDir);
    await removeTempDir(storeDir);
  }
});

test("pull request action requires a local commit first", async () => {
  const { dir, state } = await createRequestState();
  try {
    const created = state.create(requestInput());
    state.update(created.id, { status: "changes_ready", workspaceCwd: dir });

    await assert.rejects(
      () => openSelfImprovementPullRequest(state, created.id, "Title", null),
      /Commit the self-improvement changes locally/
    );
  } finally {
    await removeTempDir(dir);
  }
});

test("pull request action publishes a dedicated branch without switching the checkout", async () => {
  const source = await readFile(path.resolve("src/server/self-improvement-actions.ts"), "utf8");
  const action = source.slice(source.indexOf("export async function openSelfImprovementPullRequest"));
  assert.match(action, /git\(\["branch", branchName, current\.commitSha\]/);
  assert.match(action, /git\(\["push", "--set-upstream", "origin", branchName\]/);
  assert.match(action, /"--head", branchName, "--base", baseBranch/);
  assert.doesNotMatch(action, /git\(\["checkout"/);
});

test("self-improvement actions reject invalid lifecycle transitions", async () => {
  const { dir, state } = await createRequestState();
  try {
    const pending = state.create(requestInput());
    await assert.rejects(
      () => discardSelfImprovementRequest(state, {} as never, pending.id),
      /approved or active/
    );
    state.update(pending.id, { status: "running", workspaceCwd: dir });
    await assert.rejects(
      () => commitSelfImprovementRequest(state, pending.id, "Do not commit"),
      /must be ready/
    );
  } finally {
    await removeTempDir(dir);
  }
});

test("conflicting self-improvement actions are serialized per request", async () => {
  const order: string[] = [];
  let releaseFirst!: () => void;
  const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
  const first = runSerializedSelfImprovementAction("request-lock", async () => {
    order.push("first-start");
    await firstGate;
    order.push("first-end");
  });
  const second = runSerializedSelfImprovementAction("request-lock", async () => {
    order.push("second-start");
  });
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.deepEqual(order, ["first-start"]);
  releaseFirst();
  await Promise.all([first, second]);
  assert.deepEqual(order, ["first-start", "first-end", "second-start"]);
});

test("dismiss endpoint rejects an active self-improvement request", async () => {
  const { dir, state } = await createRequestState();
  const app = express();
  app.use(express.json());
  const created = state.create(requestInput());
  state.update(created.id, { status: "running", threadId: "active-worker" });
  registerSelfImprovementRoutes({ app, requests: state } as never);
  const server = await listen(app);
  try {
    const response = await fetch(`${server.origin}/api/self-improvement/requests/${created.id}/dismiss`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ reason: "stale click" })
    });
    assert.equal(response.status, 409);
    assert.equal(state.get(created.id)?.status, "running");
  } finally {
    await server.close();
    await removeTempDir(dir);
  }
});

test("closing waits for an in-flight Worker follow-up and then stops that turn", async () => {
  const { dir: requestDir, state } = await createRequestState();
  const { dir: storeDir, store } = await createStore();
  try {
    const created = state.create(requestInput());
    state.update(created.id, { status: "running", threadId: "worker-follow-up" });
    store.upsertThreadSummary({ id: "worker-follow-up", source: "openai", status: "idle", turns: [] });
    const calls: string[] = [];
    let noteSendStarted!: () => void;
    const sendStarted = new Promise<void>((resolve) => { noteSendStarted = resolve; });
    let releaseSend!: () => void;
    const sendCanFinish = new Promise<void>((resolve) => { releaseSend = resolve; });
    const access = {
      store,
      codexClient: {
        sendMessage: async () => {
          calls.push("send:start");
          noteSendStarted();
          await sendCanFinish;
          calls.push("send:end");
          return { threadId: "worker-follow-up", turnId: "follow-up-turn" };
        },
        stopThread: async () => {
          calls.push("stop");
          return true;
        }
      }
    } as never;

    const followUp = sendWorkerMessage(access, "worker-follow-up", "Continue the investigation.");
    await sendStarted;
    const closing = discardSelfImprovementRequest(state, access, created.id);
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(calls, ["send:start"]);
    releaseSend();
    await followUp;
    const closed = await closing;

    assert.equal(closed.status, "discarded");
    assert.deepEqual(calls, ["send:start", "send:end", "stop"]);
  } finally {
    await state.flush();
    await store.flushSave();
    await removeTempDir(requestDir);
    await removeTempDir(storeDir);
  }
});

test("a Worker follow-up queued behind close cannot reactivate the discarded request", async () => {
  const { dir: requestDir, state } = await createRequestState();
  const { dir: storeDir, store } = await createStore();
  try {
    const created = state.create(requestInput());
    state.update(created.id, { status: "running", threadId: "worker-closing" });
    store.upsertThreadSummary({ id: "worker-closing", source: "openai", status: "idle", turns: [] });
    let noteStopStarted!: () => void;
    const stopStarted = new Promise<void>((resolve) => { noteStopStarted = resolve; });
    let releaseStop!: () => void;
    const stopCanFinish = new Promise<void>((resolve) => { releaseStop = resolve; });
    let sendCalled = false;
    const access = {
      store,
      codexClient: {
        sendMessage: async () => {
          sendCalled = true;
          return { threadId: "worker-closing", turnId: "late-turn" };
        },
        stopThread: async () => {
          noteStopStarted();
          await stopCanFinish;
          return true;
        }
      }
    } as never;

    const closing = discardSelfImprovementRequest(state, access, created.id);
    await stopStarted;
    const lateFollowUp = assert.rejects(
      () => sendWorkerMessage(access, "worker-closing", "Keep going after close."),
      /self-improvement Worker is closed/
    );
    releaseStop();
    const closed = await closing;
    await lateFollowUp;

    assert.equal(closed.status, "discarded");
    assert.equal(sendCalled, false);
  } finally {
    await state.flush();
    await store.flushSave();
    await removeTempDir(requestDir);
    await removeTempDir(storeDir);
  }
});

test("closing a self-improvement request leaves active source changes untouched", async () => {
  const { dir, state } = await createRequestState();
  const sourceDir = await createGitSource();
  const changedFile = path.join(sourceDir, "README.md");
  const deletedPairs: string[] = [];
  try {
    const created = state.create(requestInput());
    state.update(created.id, { status: "changes_ready", workspaceCwd: sourceDir, pairId: "pair-to-close" });
    configureSelfImprovementPairCleanup({
      quiescePair: async () => true,
      resumePair: async () => true,
      deletePair: async (pairId) => {
        deletedPairs.push(pairId);
        return true;
      }
    });
    await writeFile(changedFile, "uncommitted experiment\n", "utf8");

    const closed = await discardSelfImprovementRequest(state, {} as never, created.id);

    assert.equal(closed.status, "discarded");
    assert.equal(closed.pairId, null);
    assert.deepEqual(deletedPairs, ["pair-to-close"]);
    assert.equal(await readFile(changedFile, "utf8"), "uncommitted experiment\n");
  } finally {
    configureSelfImprovementPairCleanup(null);
    await removeTempDir(sourceDir);
    await removeTempDir(dir);
  }
});

test("closing a self-improvement request reports worker stop failures", async () => {
  const { dir, state } = await createRequestState();
  const deletedPairs: string[] = [];
  const lifecycle: string[] = [];
  try {
    const created = state.create(requestInput());
    state.update(created.id, { status: "running", threadId: "thread-running", pairId: "pair-running" });
    configureSelfImprovementPairCleanup({
      quiescePair: async (pairId) => {
        lifecycle.push(`quiesce:${pairId}`);
        return true;
      },
      resumePair: async (pairId) => {
        lifecycle.push(`resume:${pairId}`);
        return true;
      },
      deletePair: async (pairId) => {
        deletedPairs.push(pairId);
        return true;
      }
    });

    await assert.rejects(
      () => discardSelfImprovementRequest(state, {
        store: { getThread: () => null },
        codexClient: { stopThread: async () => { throw new Error("worker stop failed"); } }
      } as never, created.id),
      /worker stop failed/
    );

    assert.equal(state.get(created.id)?.status, "running");
    assert.equal(state.get(created.id)?.pairId, "pair-running");
    assert.deepEqual(deletedPairs, []);
    assert.deepEqual(lifecycle, ["quiesce:pair-running", "resume:pair-running"]);
  } finally {
    configureSelfImprovementPairCleanup(null);
    await removeTempDir(dir);
  }
});
