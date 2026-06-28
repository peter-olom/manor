import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { ProviderRuntimeIngestion } from "../../src/server/provider-runtime-ingestion.js";
import { ButlerStateStore } from "../../src/server/state-store.js";
import type { ProviderRuntimeEvent, ProviderRuntimeLivePatch } from "../../src/shared/provider-runtime.js";

async function createHarness() {
  const dir = await mkdtemp(path.join(tmpdir(), "manor-provider-runtime-ingestion-"));
  const store = new ButlerStateStore(path.join(dir, "state.json"));
  await store.load();
  const ingestion = new ProviderRuntimeIngestion(store);
  const patches: ProviderRuntimeLivePatch[] = [];
  ingestion.on("runtimePatch", (patch) => patches.push(patch));
  return { store, ingestion, patches };
}

function baseEvent(overrides: Partial<ProviderRuntimeEvent>): ProviderRuntimeEvent {
  return {
    id: "event-1",
    provider: "codex",
    threadId: "thread-1",
    at: 100,
    type: "thread.started",
    payload: {},
    ...overrides
  } as ProviderRuntimeEvent;
}

test("provider runtime ingestion projects content deltas and emits narrow patches", async () => {
  const { store, ingestion, patches } = await createHarness();

  await ingestion.ingest(baseEvent({
    id: "event-start",
    type: "turn.started",
    turnId: "turn-1",
    payload: { effort: "high" }
  }));
  await ingestion.ingest(baseEvent({
    id: "event-delta",
    type: "content.delta",
    turnId: "turn-1",
    itemId: "item-1",
    payload: {
      streamKind: "assistant_text",
      delta: "Working"
    }
  }));

  const thread = store.getThreadDetail("thread-1");
  assert.equal(thread?.turns[0]?.id, "turn-1");
  assert.equal(thread?.turns[0]?.items[0]?.type, "agentMessage");
  assert.equal(thread?.turns[0]?.items[0]?.text, "Working");
  assert.deepEqual(patches.at(-1), {
    kind: "content-delta",
    threadId: "thread-1",
    turnId: "turn-1",
    itemId: "item-1",
    itemType: "assistant_message",
    streamKind: "assistant_text",
    delta: "Working",
    itemTextLength: "Working".length,
    at: 100
  });
});

test("provider runtime ingestion projects lifecycle and token usage events", async () => {
  const { store, ingestion, patches } = await createHarness();

  await ingestion.ingest(baseEvent({
    id: "event-thread",
    type: "thread.state.changed",
    payload: { state: "idle" }
  }));
  await ingestion.ingest(baseEvent({
    id: "event-usage",
    type: "thread.tokenUsage.updated",
    payload: {
      tokens: 300,
      contextWindow: 1200,
      percent: 25
    }
  }));
  await ingestion.ingest(baseEvent({
    id: "event-item",
    type: "item.completed",
    turnId: "turn-1",
    itemId: "cmd-1",
    payload: {
      itemType: "command_execution",
      status: "completed",
      detail: "npm test"
    }
  }));
  await ingestion.ingest(baseEvent({
    id: "event-turn",
    type: "turn.completed",
    turnId: "turn-1",
    payload: { state: "completed" }
  }));

  const thread = store.getThreadDetail("thread-1");
  assert.equal(thread?.status, "idle");
  assert.equal(thread?.contextUsage?.tokens, 300);
  assert.equal(thread?.contextUsage?.contextWindow, 1200);
  assert.equal(thread?.turns[0]?.status, "completed");
  assert.equal(thread?.turns[0]?.items[0]?.type, "commandExecution");
  assert.equal(thread?.turns[0]?.items[0]?.text, "npm test");
  assert.equal(patches.some((patch) => patch.kind === "thread-state"), true);
  assert.equal(patches.some((patch) => patch.kind === "token-usage"), true);
  assert.equal(patches.some((patch) => patch.kind === "item-lifecycle"), true);
  assert.equal(patches.some((patch) => patch.kind === "turn-lifecycle"), true);
});

test("provider runtime ingestion keeps completed turn time stable across repeated lifecycle events", async () => {
  const { store, ingestion } = await createHarness();
  const originalNow = Date.now;
  let now = 1_000;
  Date.now = () => now;
  try {
    await ingestion.ingest(baseEvent({
      id: "event-turn-start",
      type: "turn.started",
      turnId: "turn-1",
      payload: {}
    }));
    now = 2_000;
    await ingestion.ingest(baseEvent({
      id: "event-turn-complete",
      type: "turn.completed",
      turnId: "turn-1",
      payload: { state: "completed" }
    }));
    const firstCompletedAt = store.getThreadDetail("thread-1")?.turns[0]?.completedAt;

    now = 9_000;
    await ingestion.ingest(baseEvent({
      id: "event-turn-complete-repeat",
      type: "turn.completed",
      turnId: "turn-1",
      payload: { state: "completed" }
    }));

    assert.equal(store.getThreadDetail("thread-1")?.turns[0]?.completedAt, firstCompletedAt);
  } finally {
    Date.now = originalNow;
  }
});

test("provider runtime ingestion keeps generic message titles out of visible text", async () => {
  const { store, ingestion, patches } = await createHarness();

  await ingestion.ingest(baseEvent({
    id: "event-user-start",
    type: "item.started",
    turnId: "turn-1",
    itemId: "user-1",
    payload: {
      itemType: "user_message",
      status: "in_progress",
      title: "User message"
    }
  }));

  assert.equal(store.getThreadDetail("thread-1")?.turns[0]?.items.length, 0);
  assert.equal(patches.at(-1)?.kind, "item-lifecycle");
  assert.equal(patches.at(-1)?.text, "");

  await ingestion.ingest(baseEvent({
    id: "event-user-complete",
    type: "item.completed",
    turnId: "turn-1",
    itemId: "user-1",
    payload: {
      itemType: "user_message",
      status: "completed",
      title: "User message",
      detail: "Now review the current implementation"
    }
  }));

  const item = store.getThreadDetail("thread-1")?.turns[0]?.items[0];
  assert.equal(item?.type, "userMessage");
  assert.equal(item?.text, "Now review the current implementation");
});

test("provider runtime ingestion keeps generic assistant titles out of visible text", async () => {
  const { store, ingestion, patches } = await createHarness();

  await ingestion.ingest(baseEvent({
    id: "event-assistant-start",
    type: "item.started",
    turnId: "turn-1",
    itemId: "assistant-1",
    payload: {
      itemType: "assistant_message",
      status: "in_progress",
      title: "Assistant message"
    }
  }));

  assert.equal(store.getThreadDetail("thread-1")?.turns[0]?.items.length, 0);
  assert.equal(patches.at(-1)?.kind, "item-lifecycle");
  assert.equal(patches.at(-1)?.text, "");

  await ingestion.ingest(baseEvent({
    id: "event-assistant-complete",
    type: "item.completed",
    turnId: "turn-1",
    itemId: "assistant-1",
    payload: {
      itemType: "assistant_message",
      status: "completed",
      title: "Assistant message",
      detail: "Done"
    }
  }));

  const item = store.getThreadDetail("thread-1")?.turns[0]?.items[0];
  assert.equal(item?.type, "agentMessage");
  assert.equal(item?.text, "Done");
});

test("provider runtime ingestion serializes async event application", async () => {
  const { store, ingestion } = await createHarness();

  await Promise.all([
    ingestion.ingest(baseEvent({
      id: "event-1",
      type: "content.delta",
      turnId: "turn-1",
      itemId: "item-1",
      payload: { streamKind: "assistant_text", delta: "A" }
    })),
    ingestion.ingest(baseEvent({
      id: "event-2",
      type: "content.delta",
      turnId: "turn-1",
      itemId: "item-1",
      payload: { streamKind: "assistant_text", delta: "B" }
    }))
  ]);
  await ingestion.drain();

  assert.equal(store.getThreadDetail("thread-1")?.turns[0]?.items[0]?.text, "AB");
});
