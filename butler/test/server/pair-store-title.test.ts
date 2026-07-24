import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
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

test("load permanently discards pairs backed by a retired Worker harness", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "manor-retired-worker-pair-"));
  const pairPath = path.join(dir, "pairs.json");
  await writeFile(pairPath, JSON.stringify({
    pairs: [{ id: "old-pair", worker: { threadId: "019f-old-worker", runtime: "app-server", harness: "codex" } }],
    lastUsedCompose: { workerHarness: "codex", workerModel: "openai-codex/gpt-5.4" },
    workerAffinity: { hasSuccessfulDelegation: true, lastHarness: "codex", lastProvider: "openai-codex", modelByProvider: { "openai-codex": "openai-codex/gpt-5.4" } }
  }));
  const store = new ButlerStateStore(path.join(dir, "state.json"));
  const pairStore = new PairStore(pairPath, store);

  await pairStore.load();

  assert.deepEqual(pairStore.listSummaries(), []);
  assert.equal(pairStore.getLastUsedCompose(), null);
  assert.equal(pairStore.getWorkerAffinity(), null);
});

test("worker affinity records successful selections without treating picker changes as use", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "manor-worker-affinity-test-"));
  const statePath = path.join(dir, "state.json");
  const pairPath = path.join(dir, "pairs.json");
  const store = new ButlerStateStore(statePath);
  const pairStore = new PairStore(pairPath, store);
  await pairStore.load();
  const pair = pairStore.createPair();

  pairStore.updatePairComposeOverrides(pair.id, { workerModel: "ollama-cloud/preview" });
  assert.equal(pairStore.getWorkerAffinity(), null);

  pairStore.recordSuccessfulWorkerSelection({
    harness: "pi",
    provider: "ollama-cloud",
    model: "ollama-cloud/glm-5.2",
    effort: "high"
  });
  assert.deepEqual(pairStore.getWorkerAffinity(), {
    hasSuccessfulDelegation: true,
    lastProvider: "ollama-cloud",
    lastHarness: "pi",
    modelByProvider: { "ollama-cloud": "ollama-cloud/glm-5.2" },
    effortByProvider: { "ollama-cloud": "high" },
    modelByRoute: { ["pi\u001follama-cloud"]: "ollama-cloud/glm-5.2" },
    effortByRoute: { ["pi\u001follama-cloud"]: "high" },
    updatedAt: pairStore.getWorkerAffinity()?.updatedAt ?? null
  });
  assert.equal(pairStore.getLastUsedCompose()?.workerHarness, "pi");
  assert.equal(pairStore.createPair().workerModel, null);

  await pairStore.flushPendingSave();
  const reloaded = new PairStore(pairPath, store);
  await reloaded.load();
  assert.equal(reloaded.getWorkerAffinity()?.modelByProvider["ollama-cloud"], "ollama-cloud/glm-5.2");
  assert.equal(reloaded.getWorkerAffinity()?.lastHarness, "pi");
  assert.equal(reloaded.getLastUsedCompose()?.workerHarness, "pi");
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
  assert.equal(updated.defaultCwd, null);
  assert.equal(updated.worker?.runtime, null);
  assert.equal(updated.status, "worker_running");
});

test("same-thread attachment refresh preserves the recorded worker identity", async () => {
  const pairStore = await createPairStore();
  const created = pairStore.createPair();
  const first = pairStore.attachWorker(created.id, {
    threadId: "thread-identity",
    runtime: "pi-rpc",
    provider: "ollama-cloud",
    model: "ollama-cloud/glm-5.2",
    effort: "high",
    task: "Original task"
  });

  const refreshed = pairStore.attachWorker(created.id, {
    threadId: "thread-identity",
    task: "Refreshed task"
  });

  assert.equal(refreshed?.worker?.runtime, "pi-rpc");
  assert.equal(refreshed?.worker?.provider, "ollama-cloud");
  assert.equal(refreshed?.worker?.model, "ollama-cloud/glm-5.2");
  assert.equal(refreshed?.worker?.requestedReasoningEffort, "high");
  assert.equal(refreshed?.worker?.startedAt, first?.worker?.startedAt);
  assert.equal(refreshed?.worker?.task, "Refreshed task");
});

test("replacement attachment requires the expected worker and can restore it exactly", async () => {
  const pairStore = await createPairStore();
  const empty = pairStore.createPair();
  pairStore.attachWorker(empty.id, { threadId: "unexpected", replacesThreadId: "missing" });
  assert.equal(pairStore.getPair(empty.id)?.worker, null);

  const created = pairStore.createPair({ defaultCwd: "/repos/old" });
  pairStore.attachWorker(created.id, {
    threadId: "thread-old",
    cwd: "/repos/old",
    runtime: "pi-rpc",
    provider: "openai-codex",
    model: "gpt-5.4",
    effort: "high",
    task: "Keep this task"
  });
  const original = structuredClone(pairStore.getPair(created.id)?.worker ?? null);
  pairStore.attachWorker(created.id, {
    threadId: "thread-new",
    cwd: "/repos/new",
    runtime: "pi-rpc",
    provider: "opencode-go",
    model: "opencode-go/minimax-m3",
    replacesThreadId: "thread-old"
  });

  assert.equal(pairStore.restoreWorkerIfCurrent(created.id, "thread-new", original, "/repos/old"), true);
  assert.deepEqual(pairStore.getPair(created.id)?.worker, original);
  assert.equal(pairStore.getPair(created.id)?.defaultCwd, "/repos/old");
  assert.equal(pairStore.restoreWorkerIfCurrent(created.id, "thread-new", original), false);
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

test("attachWorker replaces only the named worker and preserves handoff identity", async () => {
  const pairStore = await createPairStore();
  const created = pairStore.createPair();
  pairStore.attachWorker(created.id, {
    threadId: "thread-codex",
    runtime: "pi-rpc",
    provider: "openai-codex",
    model: "gpt-5.4",
    effort: "high"
  });

  const updated = pairStore.attachWorker(created.id, {
    threadId: "thread-pi",
    runtime: "pi-rpc",
    provider: "opencode-go",
    model: "opencode-go/minimax-m3",
    effort: "medium",
    replacesThreadId: "thread-codex"
  });

  assert.deepEqual(updated?.worker && {
    threadId: updated.worker.threadId,
    runtime: updated.worker.runtime,
    harness: updated.worker.harness,
    provider: updated.worker.provider,
    model: updated.worker.model,
    effort: updated.worker.requestedReasoningEffort,
    handedOffFrom: updated.worker.handedOffFrom
  }, {
    threadId: "thread-pi",
    runtime: "pi-rpc",
    harness: "pi",
    provider: "opencode-go",
    model: "opencode-go/minimax-m3",
    effort: "medium",
    handedOffFrom: {
      threadId: "thread-codex",
      runtime: "pi-rpc",
      harness: "pi",
      provider: "openai-codex",
      model: "gpt-5.4"
    }
  });
});

test("attachWorker preserves the full Worker lineage across repeated handoffs", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "manor-pair-lineage-test-"));
  const pairPath = path.join(dir, "pairs.json");
  const store = new ButlerStateStore(path.join(dir, "state.json"));
  for (const id of ["thread-first", "thread-second", "thread-third"]) {
    store.upsertThreadSummary({ id, source: "pi-rpc", status: "idle", turns: [] });
  }
  const pairStore = new PairStore(pairPath, store);
  await pairStore.load();
  const created = pairStore.createPair();
  pairStore.attachWorker(created.id, { threadId: "thread-first", runtime: "pi-rpc" });
  pairStore.attachWorker(created.id, {
    threadId: "thread-second",
    runtime: "pi-rpc",
    replacesThreadId: "thread-first"
  });

  const updated = pairStore.attachWorker(created.id, {
    threadId: "thread-third",
    runtime: "pi-rpc",
    replacesThreadId: "thread-second"
  });

  assert.equal(updated?.worker?.threadId, "thread-third");
  assert.equal(updated?.worker?.handedOffFrom?.threadId, "thread-second");
  assert.equal(updated?.worker?.handedOffFrom?.handedOffFrom?.threadId, "thread-first");

  await pairStore.flushPendingSave();
  const reloaded = new PairStore(pairPath, store);
  await reloaded.load();
  assert.equal(reloaded.getPair(created.id)?.worker?.handedOffFrom?.handedOffFrom?.threadId, "thread-first");
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

test("deleted attached workers return the pair to the default worker state", async () => {
  const { pairStore, store } = await createPairHarness();
  const created = pairStore.createPair();
  store.upsertThreadSummary({
    id: "thread-deleted",
    status: "active",
    cwd: "/workspace",
    turns: [{ id: "turn-active", status: "inProgress", items: [] }]
  });
  pairStore.attachWorker(created.id, {
    threadId: "thread-deleted",
    model: "ollama-cloud/devstral-small-2:24b",
    effort: "high",
    task: "Build the requested app",
    handoffPrompt: "Primary job"
  });
  pairStore.updatePairComposeOverrides(created.id, {
    workerModel: "ollama-cloud/devstral-small-2:24b",
    workerEffort: "high"
  });

  store.removeThread("thread-deleted");
  pairStore.syncWorkerReports();

  const updated = pairStore.getPair(created.id);
  assert.equal(updated?.worker, null);
  assert.equal(updated?.status, "idle");
  assert.equal(updated?.lastHandoffPrompt, null);
  assert.equal(updated?.workerModel, null);
  assert.equal(updated?.workerEffort, null);
});

test("loading persisted state drops an attachment whose worker no longer exists", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "manor-missing-worker-reload-test-"));
  const statePath = path.join(dir, "state.json");
  const pairPath = path.join(dir, "pairs.json");
  const store = new ButlerStateStore(statePath);
  const pairStore = new PairStore(pairPath, store);
  await pairStore.load();
  const created = pairStore.createPair();
  store.upsertThreadSummary({ id: "pi-thread-missing-after-reload", source: "pi-rpc", status: "active", turns: [] });
  pairStore.attachWorker(created.id, {
    threadId: "pi-thread-missing-after-reload",
    model: "ollama-cloud/devstral-small-2:24b",
    task: "Build the requested app",
    handoffPrompt: "Primary job"
  });
  pairStore.updatePairComposeOverrides(created.id, {
    workerModel: "ollama-cloud/devstral-small-2:24b",
    workerEffort: "high"
  });
  await pairStore.flushPendingSave();
  store.removeThread("pi-thread-missing-after-reload");

  const reloaded = new PairStore(pairPath, store);
  await reloaded.load();

  const repaired = reloaded.getPair(created.id);
  assert.equal(repaired?.worker, null);
  assert.equal(repaired?.status, "idle");
  assert.equal(repaired?.lastHandoffPrompt, null);
  assert.equal(repaired?.workerModel, null);
  assert.equal(repaired?.workerEffort, null);
});

test("loading persisted state ignores retired Worker compose fields", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "manor-worker-field-migration-test-"));
  const statePath = path.join(dir, "state.json");
  const pairPath = path.join(dir, "pairs.json");
  const store = new ButlerStateStore(statePath);
  store.upsertThreadSummary({ id: "legacy-thread", source: "pi-rpc", status: "idle", turns: [] });
  await writeFile(pairPath, JSON.stringify({
    pairs: [{
      id: "legacy-pair",
      title: "Legacy pair",
      worker: { threadId: "legacy-thread", runtime: "pi-rpc", provider: "ollama-cloud", model: "ollama-cloud/glm-5.2", status: "idle" },
      codexModel: "ollama-cloud/glm-5.2",
      codexEffort: "high"
    }]
  }));

  const pairStore = new PairStore(pairPath, store);
  await pairStore.load();

  const migrated = pairStore.getPair("legacy-pair");
  assert.equal(migrated?.workerModel, null);
  assert.equal(migrated?.workerHarness, null);
  assert.equal(migrated?.workerEffort, null);
  assert.equal(migrated?.worker?.harness, "pi");
  assert.equal("codexModel" in (migrated ?? {}), false);
  assert.equal("codexEffort" in (migrated ?? {}), false);
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
      id: "callback-thread-done:node-current-scope:turn-done",
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

test("thread-recovery closeout marks the stored worker report reviewed", async () => {
  const { pairStore, store } = await createPairHarness();
  const created = pairStore.createPair();
  store.upsertThreadSummary({
    id: "thread-recovered",
    status: "idle",
    cwd: "/workspace",
    turns: [
      { id: "turn-with-report", status: "completed", items: [] },
      { id: "turn-recovered", status: "completed", items: [] }
    ]
  });
  pairStore.attachWorker(created.id, {
    threadId: "thread-recovered",
    task: "Research the requested topic",
    cwd: "/workspace",
    handoffPrompt: "Primary job"
  });
  const report = store.recordWorkerReport("thread-recovered", {
    turnId: "turn-with-report",
    status: "completed",
    summary: "Stored report.",
    details: null
  });

  pairStore.syncWorkerReports();
  assert.equal(pairStore.getPair(created.id)?.status, "needs_butler_review");

  const recovered = pairStore.updatePairSnapshot(created.id, {
    butlerPending: false,
    lastMessage: {
      id: "callback-fallback-thread-recovered:node-current-scope:turn-recovered",
      role: "butler",
      lane: "butler",
      text: "Recovered from the latest Worker response.",
      at: report.updatedAt - 1,
      sourceThreadId: null,
      memoryObservationId: null,
      metadata: {},
      trace: [{
        id: `review-complete-${report.updatedAt + 1}`,
        type: "reasoning",
        status: "completed",
        title: "Adversarial review",
        text: "Completed attempt 1.",
        at: report.updatedAt - 1,
        completedAt: report.updatedAt + 1
      }]
    },
    updatedAt: report.updatedAt + 1
  });

  assert.equal(recovered?.status, "idle");
  assert.equal(recovered?.worker?.lastReviewedReportAt, report.updatedAt);
  assert.equal(recovered?.worker?.lastReviewedReportTurnId, report.turnId);

  store.upsertThreadSummary({
    id: "thread-recovered",
    status: "idle",
    cwd: "/workspace",
    turns: [
      { id: "turn-with-report", status: "completed", items: [] },
      { id: "turn-recovered", status: "completed", items: [] },
      { id: "turn-new-report", status: "completed", items: [] }
    ]
  });
  const originalDateNow = Date.now;
  Date.now = () => report.updatedAt;
  let newerReport;
  try {
    newerReport = store.recordWorkerReport("thread-recovered", {
      turnId: "turn-new-report",
      status: "completed",
      summary: "New report requiring review.",
      details: null
    });
  } finally {
    Date.now = originalDateNow;
  }
  assert.equal(newerReport.updatedAt, report.updatedAt);
  pairStore.syncWorkerReports();
  assert.equal(pairStore.getPair(created.id)?.status, "needs_butler_review");
  assert.equal(pairStore.getPair(created.id)?.worker?.lastReviewedReportTurnId, report.turnId);
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
