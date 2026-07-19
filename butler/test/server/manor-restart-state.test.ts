import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import type { HostControllerClient, ManorRestartStartResult } from "../../src/server/host-controller-client.js";
import { ManorRestartRequestState } from "../../src/server/manor-restart-state.js";

function restartResult(): ManorRestartStartResult {
  return {
    ok: true,
    run: {
      id: "run-1",
      status: "running",
      target: "current",
      gitRef: null,
      includeDesktop: false,
      update: false,
      startedAt: 1,
      completedAt: null,
      error: null,
      steps: []
    }
  };
}

function completedRestartResult(): ManorRestartStartResult {
  const result = restartResult();
  return {
    ...result,
    run: {
      ...result.run,
      status: "completed",
      completedAt: 8,
      steps: [{
        label: "Check Butler health",
        status: "completed",
        startedAt: 5,
        completedAt: 8,
        exitCode: 0,
        stdoutTail: "sensitive output",
        stderrTail: ""
      }]
    }
  };
}

test("restart request persistence preserves the final consumed state", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "manor-restart-state-"));
  const statePath = path.join(dir, "restart-requests.json");
  const errors: unknown[] = [];
  const hostController = {
    restart: async () => restartResult()
  } as unknown as HostControllerClient;
  const state = new ManorRestartRequestState(statePath, hostController, (error) => errors.push(error), () => undefined);

  try {
    const pending = state.request({
      reason: "Restart only.",
      build: false,
      update: false
    });
    const authorized = state.authorize(pending.id);
    await state.start(authorized.id);

    const parsed = JSON.parse(await readFile(statePath, "utf8")) as {
      pendingManorRestartRequest: unknown;
      authorizedManorRestartRequest: unknown;
      trackedManorRestart: { requestId: string; runId: string } | null;
    };

    assert.equal(errors.length, 0);
    assert.equal(parsed.pendingManorRestartRequest, null);
    assert.equal(parsed.authorizedManorRestartRequest, null);
    assert.equal(parsed.trackedManorRestart?.requestId, pending.id);
    assert.equal(parsed.trackedManorRestart?.runId, "run-1");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("tracked restart progress survives reload and exposes only the matching run", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "manor-restart-state-"));
  const statePath = path.join(dir, "restart-requests.json");
  const completed = completedRestartResult().run;
  const hostController = {
    restart: async () => restartResult(),
    getStatus: async () => ({ ok: true, active: null, latestRun: completed })
  } as unknown as HostControllerClient;

  try {
    const state = new ManorRestartRequestState(statePath, hostController, () => undefined, () => undefined);
    const pending = state.request({ reason: "Track this restart." });
    state.authorize(pending.id);
    await state.start(pending.id);

    const reloaded = new ManorRestartRequestState(statePath, hostController, () => undefined, () => undefined);
    await reloaded.load();
    const progress = await reloaded.getProgress();

    assert.deepEqual(progress, {
      requestId: pending.id,
      runId: "run-1",
      startedAt: 1,
      status: "completed",
      completedAt: 8,
      currentStep: "Check Butler health",
      error: null
    });
    assert.equal(await reloaded.acknowledgeProgress(pending.id), true);
    assert.equal(await reloaded.getProgress(), null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("tracked restart progress stays unconfirmed when the controller reports another run", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "manor-restart-state-"));
  const statePath = path.join(dir, "restart-requests.json");
  const hostController = {
    restart: async () => restartResult(),
    getStatus: async () => ({
      ok: true,
      active: null,
      latestRun: { ...completedRestartResult().run, id: "run-2" }
    })
  } as unknown as HostControllerClient;

  try {
    const state = new ManorRestartRequestState(statePath, hostController, () => undefined, () => undefined);
    const pending = state.request({ reason: "Track the exact run." });
    state.authorize(pending.id);
    await state.start(pending.id);

    assert.equal((await state.getProgress())?.status, "unconfirmed");
    assert.equal(await state.acknowledgeProgress("another-request"), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("accepted restart reports a tracking persistence failure without forgetting the live run", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "manor-restart-state-"));
  const errors: unknown[] = [];
  const hostController = { restart: async () => restartResult() } as unknown as HostControllerClient;
  const state = new ManorRestartRequestState(dir, hostController, (error) => errors.push(error), () => undefined);

  try {
    const pending = state.request({ reason: "Keep the accepted run in memory." });
    state.authorize(pending.id);
    await assert.rejects(() => state.start(pending.id), /EISDIR/);

    assert.equal(state.trackedRestart?.requestId, pending.id);
    assert.equal(state.trackedRestart?.runId, "run-1");
    assert.ok(errors.length >= 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("failed acknowledgement persistence keeps the tracked run visible", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "manor-restart-state-"));
  const statePath = path.join(dir, "restart-requests.json");
  const errors: unknown[] = [];
  const hostController = { restart: async () => restartResult() } as unknown as HostControllerClient;
  const state = new ManorRestartRequestState(statePath, hostController, (error) => errors.push(error), () => undefined);

  try {
    const pending = state.request({ reason: "Keep tracking until acknowledgement is durable." });
    state.authorize(pending.id);
    await state.start(pending.id);
    await rm(statePath);
    await mkdir(statePath);

    await assert.rejects(() => state.acknowledgeProgress(pending.id), /EISDIR/);
    assert.equal(state.trackedRestart?.requestId, pending.id);
    assert.equal(state.trackedRestart?.runId, "run-1");
    assert.ok(errors.length >= 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("restart request loader rejects unknown persisted fields", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "manor-restart-state-"));
  const statePath = path.join(dir, "restart-requests.json");
  const hostController = { restart: async () => restartResult() } as unknown as HostControllerClient;
  const state = new ManorRestartRequestState(statePath, hostController, () => undefined, () => undefined);

  try {
    await writeFile(statePath, JSON.stringify({
      pendingManorRestartRequest: {
        id: "invalid-request",
        status: "pending",
        obsoleteField: true
      },
      authorizedManorRestartRequest: null
    }));
    await state.load();

    assert.equal(state.pendingRequest, null);
    assert.equal(state.authorizedRequest, null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("restart request returns to pending when the host controller rejects the start", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "manor-restart-state-"));
  const statePath = path.join(dir, "restart-requests.json");
  const hostController = {
    restart: async () => { throw new Error("A Manor restart is already running."); }
  } as unknown as HostControllerClient;
  const state = new ManorRestartRequestState(statePath, hostController, () => undefined, () => undefined);

  try {
    const pending = state.request({ reason: "Retry the active checkout." });
    state.authorize(pending.id);

    await assert.rejects(() => state.start(pending.id), /already running/);
    assert.equal(state.pendingRequest?.id, pending.id);
    assert.equal(state.pendingRequest?.status, "pending");
    assert.equal(state.authorizedRequest, null);

    const persisted = JSON.parse(await readFile(statePath, "utf8")) as {
      pendingManorRestartRequest: { id: string; status: string } | null;
      authorizedManorRestartRequest: unknown;
    };
    assert.equal(persisted.pendingManorRestartRequest?.id, pending.id);
    assert.equal(persisted.pendingManorRestartRequest?.status, "pending");
    assert.equal(persisted.authorizedManorRestartRequest, null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a new restart request cannot replace one while its start is pending", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "manor-restart-state-"));
  const statePath = path.join(dir, "restart-requests.json");
  let rejectStart: ((error: Error) => void) | null = null;
  const hostController = {
    restart: () => new Promise<ManorRestartStartResult>((_resolve, reject) => { rejectStart = reject; })
  } as unknown as HostControllerClient;
  const state = new ManorRestartRequestState(statePath, hostController, () => undefined, () => undefined);

  try {
    const pending = state.request({ reason: "Restart the active checkout." });
    state.authorize(pending.id);
    const start = state.start(pending.id);

    assert.throws(() => state.request({ reason: "Replace the active request." }), /already starting/);
    assert.ok(rejectStart);
    rejectStart(new Error("Host controller unavailable."));
    await assert.rejects(start, /Host controller unavailable/);
    assert.equal(state.pendingRequest?.id, pending.id);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
