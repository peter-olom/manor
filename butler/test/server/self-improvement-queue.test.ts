import { execFile } from "node:child_process";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import express from "express";

import { buildButlerCodexTools } from "../../src/server/butler-agent-codex-tools.js";
import type { ButlerAgentToolAccess } from "../../src/server/butler-agent-tool-access.js";
import { openSelfImprovementPullRequest } from "../../src/server/self-improvement-actions.js";
import { resolveSelfImprovementEligibility } from "../../src/server/self-improvement-eligibility.js";
import { configureSelfImprovementRequestState, SelfImprovementRequestState } from "../../src/server/self-improvement-request-state.js";
import { registerSelfImprovementRoutes } from "../../src/server/self-improvement-routes.js";
import { ButlerStateStore } from "../../src/server/state-store.js";

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
    await new Promise((resolve) => setTimeout(resolve, 20));
    await reloaded.load();

    assert.equal(dismissed.status, "dismissed");
    assert.equal(dismissed.dismissedReason, "Already covered by another fix.");
    assert.equal(reloaded.get(created.id)?.proposedChange, "Add retry handling around broker cleanup.");
  } finally {
    await removeTempDir(dir);
  }
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

test("approval creates a visible session linked to the self-improvement request", async () => {
  const { dir: requestDir, state } = await createRequestState();
  const { dir: storeDir, store } = await createStore();
  const sourceDir = await createGitSource();
  const previous = process.env.MANOR_SELF_IMPROVEMENT_SOURCE_CWD;
  process.env.MANOR_SELF_IMPROVEMENT_SOURCE_CWD = sourceDir;
  const app = express();
  app.use(express.json());
  const created = state.create(requestInput());
  const createdPairs: Array<{ threadId: string; cwd: string | null; task: string | null }> = [];
  registerSelfImprovementRoutes({
    app,
    requests: state,
    hostController: { getStatus: async () => ({ ok: true, active: null, latestRun: null, detectedMode: "source" }) } as never,
    store,
    codexClient: {
      startThread: async (options: { input: (threadId: string) => Promise<unknown>; cwd: string }) => {
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
    pairSessions: {
      createWorkerPair: async (input) => {
        createdPairs.push({ threadId: input.threadId, cwd: input.cwd ?? null, task: input.task ?? null });
        return { id: "pair-approved" };
      }
    } as never,
    prepareWorkspace: async ({ task }) => ({ cwd: sourceDir, branchName: "test-branch", repoRoot: sourceDir, created: false, task }) as never,
    imageStore: { resolveViews: () => [] } as never,
    fileStore: { resolveViews: () => [] } as never,
    artifactsDir: requestDir
  });
  const server = await listen(app);
  try {
    const response = await fetch(`${server.origin}/api/self-improvement/requests/${created.id}/approve`, { method: "POST" });
    const payload = await response.json() as { error?: string; request?: { status?: string; threadId?: string | null; pairId?: string | null } };

    assert.equal(response.status, 202, payload.error);
    assert.equal(payload.request?.status, "running");
    assert.equal(payload.request?.threadId, "thread-approved");
    assert.equal(payload.request?.pairId, "pair-approved");
    assert.equal(state.get(created.id)?.pairId, "pair-approved");
    assert.equal(createdPairs.length, 1);
    assert.equal(createdPairs[0]?.threadId, "thread-approved");
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
