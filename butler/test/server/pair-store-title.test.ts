import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { PairStore } from "../../src/server/pair-store.js";
import { ButlerStateStore } from "../../src/server/state-store.js";

async function createStore(): Promise<ButlerStateStore> {
  const dir = await mkdtemp(path.join(tmpdir(), "manor-pair-store-test-"));
  return new ButlerStateStore(path.join(dir, "state.json"));
}

test("createPair starts with an empty transcript", async () => {
  const store = await createStore();
  const pairStore = new PairStore("/tmp/pair-state.json", store);
  await pairStore.load();
  const pair = pairStore.createPair({ title: "Empty session" });
  assert.equal(pair.title, "Empty session");
  assert.equal(pair.messages.length, 0);
  assert.equal(pair.status, "idle");
});

test("createPair defaults the title to 'New session'", async () => {
  const store = await createStore();
  const pairStore = new PairStore("/tmp/pair-state-default.json", store);
  await pairStore.load();
  const pair = pairStore.createPair();
  assert.equal(pair.title, "New session");
  assert.equal(pair.messages.length, 0);
});

test("updatePairTitle renames the session", async () => {
  const store = await createStore();
  const pairStore = new PairStore("/tmp/pair-store-rename.json", store);
  await pairStore.load();
  const created = pairStore.createPair();

  const updated = pairStore.updatePairTitle(created.id, "Review checkout flow");
  assert.ok(updated);
  assert.equal(updated.title, "Review checkout flow");

  const refreshed = pairStore.getPair(created.id);
  assert.ok(refreshed);
  assert.equal(refreshed.title, "Review checkout flow");
});

test("updatePairTitle rejects an empty title and returns null", async () => {
  const store = await createStore();
  const pairStore = new PairStore("/tmp/pair-store-empty-title.json", store);
  await pairStore.load();
  const created = pairStore.createPair();
  const originalTitle = created.title;

  const empty = pairStore.updatePairTitle(created.id, "   ");
  assert.equal(empty, null);

  const refreshed = pairStore.getPair(created.id);
  assert.ok(refreshed);
  assert.equal(refreshed.title, originalTitle);
});

test("updatePairTitle truncates long titles to 72 chars", async () => {
  const store = await createStore();
  const pairStore = new PairStore("/tmp/pair-store-long-title.json", store);
  await pairStore.load();
  const created = pairStore.createPair();

  const longTitle = "a".repeat(200);
  const updated = pairStore.updatePairTitle(created.id, longTitle);
  assert.ok(updated);
  assert.ok(updated.title.length <= 72);
  assert.ok(updated.title.endsWith("..."));
});

test("updatePairTitle returns null for an unknown pair id", async () => {
  const store = await createStore();
  const pairStore = new PairStore("/tmp/pair-store-missing.json", store);
  await pairStore.load();
  const result = pairStore.updatePairTitle("no-such-pair", "Anything");
  assert.equal(result, null);
});

test("first user message auto-renames the default title but not an explicit rename", async () => {
  const store = await createStore();
  const pairStore = new PairStore("/tmp/pair-store-auto-rename.json", store);
  await pairStore.load();
  const created = pairStore.createPair();

  pairStore.appendMessage(created.id, {
    role: "user",
    lane: "butler",
    text: "How does the checkout flow handle retries?"
  });
  let refreshed = pairStore.getPair(created.id);
  assert.ok(refreshed);
  assert.equal(refreshed.title, "How does the checkout flow handle retries?");

  pairStore.updatePairTitle(created.id, "Checkout follow-ups");
  pairStore.appendMessage(created.id, {
    role: "user",
    lane: "butler",
    text: "Also clarify the proof requirements."
  });
  refreshed = pairStore.getPair(created.id);
  assert.ok(refreshed);
  assert.equal(refreshed.title, "Checkout follow-ups");
});
