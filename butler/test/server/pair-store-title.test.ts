import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { PairStore } from "../../src/server/pair-store.js";
import { ButlerStateStore } from "../../src/server/state-store.js";

async function createPairStore(): Promise<PairStore> {
  const dir = await mkdtemp(path.join(tmpdir(), "manor-pair-store-test-"));
  const store = new ButlerStateStore(path.join(dir, "state.json"));
  const pairStore = new PairStore(path.join(dir, "pairs.json"), store);
  await pairStore.load();
  return pairStore;
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
