import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { PairStore } from "../../src/server/pair-store.js";
import { ButlerStateStore } from "../../src/server/state-store.js";

async function createPairStore(): Promise<PairStore> {
  return (await createPairHarness()).pairStore;
}

async function createPairHarness(): Promise<{ pairStore: PairStore; store: ButlerStateStore }> {
  const dir = await mkdtemp(path.join(tmpdir(), "manor-pair-store-test-"));
  const store = new ButlerStateStore(path.join(dir, "state.json"));
  const pairStore = new PairStore(path.join(dir, "pairs.json"), store);
  await pairStore.load();
  return { pairStore, store };
}

test("createPair starts with empty Butler-backed state", async () => {
  const pairStore = await createPairStore();
  const pair = pairStore.createPair({ title: "Empty session" });
  assert.equal(pair.title, "Empty session");
  assert.equal(pair.butlerSessionId, pair.id);
  assert.equal(pair.butlerReady, false);
  assert.equal(pair.butlerPending, false);
  assert.equal(pair.messageCount, 0);
  assert.equal(pair.lastMessage, null);
  assert.equal(pair.status, "idle");
});

test("createPair defaults the title to 'New session'", async () => {
  const pairStore = await createPairStore();
  const pair = pairStore.createPair();
  assert.equal(pair.title, "New session");
  assert.equal(pair.messageCount, 0);
});

test("worker affinity records successful selections without treating picker changes as use", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "manor-worker-affinity-test-"));
  const statePath = path.join(dir, "state.json");
  const pairPath = path.join(dir, "pairs.json");
  const store = new ButlerStateStore(statePath);
  const pairStore = new PairStore(pairPath, store);
  await pairStore.load();
  const pair = pairStore.createPair();

  pairStore.updatePairComposeOverrides(pair.id, { codexModel: "ollama-cloud/preview" });
  assert.equal(pairStore.getWorkerAffinity(), null);

  pairStore.recordSuccessfulWorkerSelection({
    provider: "ollama-cloud",
    model: "ollama-cloud/glm-5.2",
    effort: "high"
  });
  assert.deepEqual(pairStore.getWorkerAffinity(), {
    hasSuccessfulDelegation: true,
    lastProvider: "ollama-cloud",
    modelByProvider: { "ollama-cloud": "ollama-cloud/glm-5.2" },
    effortByProvider: { "ollama-cloud": "high" },
    updatedAt: pairStore.getWorkerAffinity()?.updatedAt ?? null
  });
  assert.equal(pairStore.createPair().codexModel, null);

  await pairStore.flushPendingSave();
  const reloaded = new PairStore(pairPath, store);
  await reloaded.load();
  assert.equal(reloaded.getWorkerAffinity()?.modelByProvider["ollama-cloud"], "ollama-cloud/glm-5.2");
});

test("updatePairTitle renames the session", async () => {
  const pairStore = await createPairStore();
  const created = pairStore.createPair();

  const updated = pairStore.updatePairTitle(created.id, "Review checkout flow");
  assert.ok(updated);
  assert.equal(updated.title, "Review checkout flow");

  const refreshed = pairStore.getPair(created.id);
  assert.ok(refreshed);
  assert.equal(refreshed.title, "Review checkout flow");
});

test("updatePairTitle rejects an empty title and returns null", async () => {
  const pairStore = await createPairStore();
  const created = pairStore.createPair();
  const originalTitle = created.title;

  const empty = pairStore.updatePairTitle(created.id, "   ");
  assert.equal(empty, null);

  const refreshed = pairStore.getPair(created.id);
  assert.ok(refreshed);
  assert.equal(refreshed.title, originalTitle);
});

test("updatePairTitle truncates long titles to 72 chars", async () => {
  const pairStore = await createPairStore();
  const created = pairStore.createPair();

  const longTitle = "a".repeat(200);
  const updated = pairStore.updatePairTitle(created.id, longTitle);
  assert.ok(updated);
  assert.ok(updated.title.length <= 72);
  assert.ok(updated.title.endsWith("..."));
});

test("updatePairTitle returns null for an unknown pair id", async () => {
  const pairStore = await createPairStore();
  const result = pairStore.updatePairTitle("no-such-pair", "Anything");
  assert.equal(result, null);
});

test("updateDefaultPairTitle renames only default-titled sessions", async () => {
  const pairStore = await createPairStore();
  const created = pairStore.createPair();

  const updated = pairStore.updateDefaultPairTitle(created.id, "Checkout retry flow");
  assert.ok(updated);
  assert.equal(updated.title, "Checkout retry flow");

  const ignored = pairStore.updateDefaultPairTitle(created.id, "Overwritten title");
  assert.equal(ignored, null);
  assert.equal(pairStore.getPair(created.id)?.title, "Checkout retry flow");
});

test("updateDefaultPairTitle preserves manual titles", async () => {
  const pairStore = await createPairStore();
  const created = pairStore.createPair({ title: "Manual title" });

  const updated = pairStore.updateDefaultPairTitle(created.id, "Generated title");
  assert.equal(updated, null);
  assert.equal(pairStore.getPair(created.id)?.title, "Manual title");
});

test("updatePairSnapshot stores live Butler status and latest message", async () => {
  const pairStore = await createPairStore();
  const created = pairStore.createPair();

  const updated = pairStore.updatePairSnapshot(created.id, {
    butlerSessionId: "provider-session",
    butlerReady: true,
    butlerPending: true,
    messageCount: 1,
    lastMessage: {
      id: "message-1",
      role: "user",
      lane: "butler",
      text: "How does the checkout flow handle retries?",
      at: created.createdAt + 10,
      sourceThreadId: null,
      memoryObservationId: null,
      metadata: {}
    }
  });
  assert.ok(updated);
  assert.equal(updated.butlerSessionId, "provider-session");
  assert.equal(updated.butlerReady, true);
  assert.equal(updated.butlerPending, true);
  assert.equal(updated.messageCount, 1);
  assert.equal(updated.lastMessage?.text, "How does the checkout flow handle retries?");
  assert.equal(updated.status, "butler_running");
});

test("updatePairSnapshot exposes blocked Butler closeout reason", async () => {
  const pairStore = await createPairStore();
  const created = pairStore.createPair();

  const updated = pairStore.updatePairSnapshot(created.id, {
    butlerReady: true,
    butlerPending: false,
    butlerPendingReason: "Closeout blocked: Codex review failed."
  });

  assert.ok(updated);
  assert.equal(updated.butlerPending, false);
  assert.equal(updated.butlerPendingReason, "Closeout blocked: Codex review failed.");
  assert.equal(updated.status, "blocked");
});

test("attachWorker records one Butler-managed worker", async () => {
  const pairStore = await createPairStore();
  const created = pairStore.createPair();

  const updated = pairStore.attachWorker(created.id, {
    threadId: "thread-1",
    task: "Fix the checkout retry bug",
    cwd: "/workspace",
    handoffPrompt: "Run the checks and report evidence."
  });
  assert.ok(updated);
  assert.equal(updated.worker?.threadId, "thread-1");
  assert.equal(updated.worker?.task, "Fix the checkout retry bug");
  assert.equal(updated.worker?.handoffPrompt, "Run the checks and report evidence.");
  assert.equal(updated.status, "worker_running");
});

test("attachWorker keeps the first worker as the primary pair pipe", async () => {
  const pairStore = await createPairStore();
  const created = pairStore.createPair();

  pairStore.attachWorker(created.id, {
    threadId: "thread-primary",
    task: "Build the requested app",
    cwd: "/workspace",
    handoffPrompt: "Primary job"
  });
  const updated = pairStore.attachWorker(created.id, {
    threadId: "thread-auxiliary",
    task: "Investigate a platform issue",
    cwd: "/workspace",
    handoffPrompt: "Auxiliary job"
  });

  assert.equal(updated?.worker?.threadId, "thread-primary");
  assert.equal(updated?.worker?.task, "Build the requested app");
});

test("active workers with an interim blocked report stay running", async () => {
  const { pairStore, store } = await createPairHarness();
  const created = pairStore.createPair();
  store.upsertThreadSummary({
    id: "thread-active",
    status: "active",
    cwd: "/workspace",
    turns: [{ id: "turn-active", status: "inProgress", items: [] }]
  });
  pairStore.attachWorker(created.id, {
    threadId: "thread-active",
    task: "Build the requested app",
    cwd: "/workspace",
    handoffPrompt: "Primary job"
  });
  store.recordWorkerReport("thread-active", {
    turnId: "turn-active",
    status: "blocked",
    summary: "Reviewer context failed.",
    details: "A child reviewer could not read its payload."
  });

  pairStore.syncWorkerReports();

  assert.equal(pairStore.getPair(created.id)?.status, "worker_running");
});

test("completed worker report returns to idle after Butler posts the callback", async () => {
  const { pairStore, store } = await createPairHarness();
  const created = pairStore.createPair();
  store.upsertThreadSummary({
    id: "thread-done",
    status: "idle",
    cwd: "/workspace",
    turns: [{ id: "turn-done", status: "completed", items: [] }]
  });
  pairStore.attachWorker(created.id, {
    threadId: "thread-done",
    task: "Build the requested app",
    cwd: "/workspace",
    handoffPrompt: "Primary job"
  });
  const report = store.recordWorkerReport("thread-done", {
    turnId: "turn-done",
    status: "completed",
    summary: "Built the app.",
    details: "Verified locally."
  });

  pairStore.syncWorkerReports();
  assert.equal(pairStore.getPair(created.id)?.status, "needs_butler_review");

  const reviewed = pairStore.updatePairSnapshot(created.id, {
    butlerPending: false,
    lastMessage: {
      id: "callback-thread-done:turn-done",
      role: "butler",
      lane: "butler",
      text: "Done.",
      at: report.updatedAt + 1,
      sourceThreadId: null,
      memoryObservationId: null,
      metadata: {}
    },
    updatedAt: report.updatedAt + 1
  });

  assert.equal(reviewed?.status, "idle");
  assert.equal(reviewed?.worker?.lastReviewedReportAt, report.updatedAt);

  const later = pairStore.updatePairSnapshot(created.id, {
    lastMessage: {
      id: "operator-follow-up",
      role: "user",
      lane: "butler",
      text: "Thanks.",
      at: report.updatedAt + 2,
      sourceThreadId: null,
      memoryObservationId: null,
      metadata: {}
    },
    updatedAt: report.updatedAt + 2
  });

  assert.equal(later?.status, "idle");
});

test("a newer worker report needs review even after an earlier callback", async () => {
  const { pairStore, store } = await createPairHarness();
  const created = pairStore.createPair();
  store.upsertThreadSummary({
    id: "thread-retry",
    status: "idle",
    cwd: "/workspace",
    turns: [{ id: "turn-one", status: "completed", items: [] }]
  });
  pairStore.attachWorker(created.id, {
    threadId: "thread-retry",
    task: "Build the requested app",
    cwd: "/workspace",
    handoffPrompt: "Primary job"
  });
  const firstReport = store.recordWorkerReport("thread-retry", {
    turnId: "turn-one",
    status: "completed",
    summary: "First pass.",
    details: null
  });
  pairStore.updatePairSnapshot(created.id, {
    lastMessage: {
      id: "callback-thread-retry:turn-one",
      role: "butler",
      lane: "butler",
      text: "First pass done.",
      at: firstReport.updatedAt + 1,
      sourceThreadId: null,
      memoryObservationId: null,
      metadata: {}
    }
  });
  await new Promise((resolve) => setTimeout(resolve, 2));

  store.upsertThreadSummary({
    id: "thread-retry",
    status: "idle",
    cwd: "/workspace",
    turns: [
      { id: "turn-one", status: "completed", items: [] },
      { id: "turn-two", status: "completed", items: [] }
    ]
  });
  store.recordWorkerReport("thread-retry", {
    turnId: "turn-two",
    status: "completed",
    summary: "Second pass.",
    details: null
  });

  pairStore.syncWorkerReports();
  assert.equal(pairStore.getPair(created.id)?.status, "needs_butler_review");
});
