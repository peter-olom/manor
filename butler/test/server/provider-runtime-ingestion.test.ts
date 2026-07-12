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
  return { dir, store, ingestion, patches };
}

function baseEvent(overrides: Partial<ProviderRuntimeEvent>): ProviderRuntimeEvent {
  return {
    id: "event-1",
    harness: "codex",
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
      delta: "Working "
    }
  }));

  const thread = store.getThreadDetail("thread-1");
  assert.equal(thread?.turns[0]?.id, "turn-1");
  assert.equal(thread?.turns[0]?.items[0]?.type, "agentMessage");
  assert.equal(thread?.turns[0]?.items[0]?.text, "Working ");
  assert.deepEqual(patches.at(-1), {
    kind: "content-delta",
    threadId: "thread-1",
    turnId: "turn-1",
    itemId: "item-1",
    itemType: "assistant_message",
    streamKind: "assistant_text",
    delta: "Working ",
    itemTextLength: "Working ".length,
    at: 100
  });
});

test("provider runtime ingestion redacts credentials split across live deltas", async () => {
  const { store, ingestion, patches } = await createHarness();
  await ingestion.ingest(baseEvent({ type: "turn.started", turnId: "turn-secret", payload: {} }));
  await ingestion.ingest(baseEvent({
    id: "delta-1",
    type: "content.delta",
    turnId: "turn-secret",
    itemId: "reasoning-secret",
    payload: { streamKind: "reasoning_text", delta: "Checking sk-abc" }
  }));
  await ingestion.ingest(baseEvent({
    id: "delta-2",
    type: "content.delta",
    turnId: "turn-secret",
    itemId: "reasoning-secret",
    payload: { streamKind: "reasoning_text", delta: "defghijklmnop done" }
  }));
  await ingestion.ingest(baseEvent({
    id: "turn-secret-complete",
    type: "turn.completed",
    turnId: "turn-secret",
    payload: { state: "completed" }
  }));

  const livePayload = JSON.stringify(patches);
  assert.doesNotMatch(livePayload, /sk-abc/);
  assert.match(livePayload, /\[REDACTED\]/);
  assert.equal(store.getThreadDetail("thread-1")?.turns[0]?.items[0]?.text, "Checking [REDACTED] done");
});

test("provider runtime ingestion flushes and clears buffered text on abrupt failures", async () => {
  const { store, ingestion, patches } = await createHarness();
  await ingestion.ingest(baseEvent({ type: "turn.started", turnId: "turn-abrupt", payload: {} }));
  await ingestion.ingest(baseEvent({
    id: "delta-abrupt",
    type: "content.delta",
    turnId: "turn-abrupt",
    itemId: "reasoning-abrupt",
    payload: { streamKind: "reasoning_text", delta: "Checking sk-abcdefghijklmnop" }
  }));
  await ingestion.ingest(baseEvent({
    id: "runtime-abrupt",
    type: "runtime.error",
    turnId: "turn-abrupt",
    payload: { message: "Provider transport closed" }
  }));

  assert.equal(store.getThreadDetail("thread-1")?.turns[0]?.items[0]?.text, "Checking [REDACTED]");
  assert.doesNotMatch(JSON.stringify(patches), /sk-abcdefghijklmnop/);
  assert.equal((ingestion as unknown as { contentStreams: Map<string, unknown> }).contentStreams.size, 0);

  await ingestion.ingest(baseEvent({
    id: "delta-transport-close",
    type: "content.delta",
    turnId: "turn-transport-close",
    itemId: "assistant-transport-close",
    payload: { streamKind: "assistant_text", delta: "Last buffered response" }
  }));
  await ingestion.ingest(baseEvent({
    id: "session-exited",
    type: "session.exited",
    payload: { reason: "transport closed" }
  }));

  const transportTurn = store.getThreadDetail("thread-1")?.turns.find((turn) => turn.id === "turn-transport-close");
  assert.equal(transportTurn?.items[0]?.text, "Last buffered response");
  assert.equal((ingestion as unknown as { contentStreams: Map<string, unknown> }).contentStreams.size, 0);
});

test("provider runtime ingestion terminalizes aborted and cancelled turns", async () => {
  const { dir, store, ingestion, patches } = await createHarness();
  await ingestion.ingest(baseEvent({ type: "turn.started", turnId: "turn-aborted", payload: {} }));
  await ingestion.ingest(baseEvent({
    id: "delta-before-abort",
    type: "content.delta",
    turnId: "turn-aborted",
    itemId: "reasoning-before-abort",
    payload: { streamKind: "reasoning_text", delta: "Last diagnostic token" }
  }));
  await ingestion.ingest(baseEvent({
    id: "turn-aborted",
    type: "turn.aborted",
    turnId: "turn-aborted",
    payload: { reason: "Provider aborted Authorization: Bearer abort-secret-123456" }
  }));
  await ingestion.ingest(baseEvent({ type: "turn.started", turnId: "turn-cancelled", payload: {} }));
  await ingestion.ingest(baseEvent({
    id: "turn-cancelled",
    type: "turn.completed",
    turnId: "turn-cancelled",
    payload: { state: "cancelled" }
  }));

  const [aborted, cancelled] = store.getThreadDetail("thread-1")?.turns ?? [];
  assert.equal(aborted?.status, "interrupted");
  assert.equal(aborted?.error, "Provider aborted Authorization: Bearer [REDACTED]");
  assert.equal(aborted?.items[0]?.text, "Last diagnostic token");
  assert.equal(cancelled?.status, "cancelled");
  assert.equal(cancelled?.completedAt === null, false);
  assert.equal(store.getThread("thread-1")?.supervisor.blocked, true);
  assert.equal(patches.some((patch) => patch.kind === "turn-lifecycle" && patch.status === "interrupted"), true);
  assert.doesNotMatch(JSON.stringify(patches), /abort-secret/);

  await store.flushSave();
  const reloaded = new ButlerStateStore(path.join(dir, "state.json"));
  await reloaded.load();
  assert.equal(reloaded.getThread("thread-1")?.turns[1]?.status, "cancelled");
  assert.equal(reloaded.getThread("thread-1")?.turns[1]?.completedAt === null, false);
});

test("provider system errors become idle, visible, terminal Worker failures", async () => {
  const { store, ingestion, patches } = await createHarness();
  await ingestion.ingest(baseEvent({ type: "turn.started", turnId: "turn-system-error", payload: {} }));
  await ingestion.ingest(baseEvent({
    id: "system-error",
    type: "thread.state.changed",
    payload: {
      state: "error",
      detail: { type: "systemError", error: { message: "Gateway crashed api_key=sk-system-error-abcdefghijklmnop" } }
    }
  }));

  const thread = store.getThread("thread-1");
  assert.equal(thread?.status, "idle");
  assert.equal(thread?.turns[0]?.status, "failed");
  assert.equal(thread?.turns[0]?.error, "Gateway crashed api_key=[REDACTED]");
  assert.equal(thread?.turns[0]?.completedAt === null, false);
  assert.equal(thread?.eventLog[0]?.summary, "Gateway crashed api_key=[REDACTED]");
  assert.equal(patches.some((patch) => patch.kind === "thread-state" && patch.state === "error"), true);
  assert.equal(patches.some((patch) => patch.kind === "runtime-message" && patch.message.includes("[REDACTED]")), true);
  assert.doesNotMatch(JSON.stringify(patches), /sk-system-error/);
});

test("unsupported direct Worker prompts and approvals are visible runtime errors", async () => {
  const { store, ingestion, patches } = await createHarness();
  await ingestion.ingest(baseEvent({ type: "turn.started", turnId: "turn-request", payload: {} }));
  await ingestion.ingest(baseEvent({
    id: "approval-request",
    type: "request.opened",
    turnId: "turn-request",
    requestId: "approval-1",
    payload: { requestType: "command_execution_approval", detail: "run release check" }
  }));
  await ingestion.ingest(baseEvent({
    id: "operator-question",
    type: "userInput.requested",
    turnId: "turn-request",
    requestId: "question-1",
    payload: { questions: [] }
  }));

  assert.match(store.getThread("thread-1")?.eventLog[0]?.summary ?? "", /requested operator input.*unsupported provider prompt/i);
  assert.match(store.getThread("thread-1")?.eventLog[1]?.summary ?? "", /unsupported.*command_execution_approval/i);
  assert.equal(patches.filter((patch) => patch.kind === "runtime-message" && patch.tone === "error").length, 2);
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

test("provider runtime ingestion persists exact redacted no-item turn failures", async () => {
  const { store, ingestion } = await createHarness();
  await ingestion.ingest(baseEvent({ type: "turn.started", turnId: "turn-failed", payload: {} }));
  await ingestion.ingest(baseEvent({
    id: "runtime-error",
    type: "runtime.error",
    payload: { message: "Gateway rejected api_key=sk-abcdefghijklmnop" }
  }));
  await ingestion.ingest(baseEvent({
    id: "turn-failed-complete",
    type: "turn.completed",
    turnId: "turn-failed",
    payload: { state: "failed", errorMessage: "Provider failed Authorization: Bearer opaque-token-123456" }
  }));

  const thread = store.getThreadDetail("thread-1");
  assert.equal(thread?.turns[0]?.status, "failed");
  assert.equal(thread?.turns[0]?.error, "Provider failed Authorization: Bearer [REDACTED]");
  assert.deepEqual(thread?.turns[0]?.items, []);
  assert.equal(thread?.eventLog.at(-1)?.summary, "Gateway rejected api_key=[REDACTED]");
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
  await ingestion.ingest(baseEvent({
    id: "event-complete",
    type: "turn.completed",
    turnId: "turn-1",
    payload: { state: "completed" }
  }));

  assert.equal(store.getThreadDetail("thread-1")?.turns[0]?.items[0]?.text, "AB");
});

test("provider runtime ingestion rechecks operation validity before queued mutation", async () => {
  const { store, ingestion, patches } = await createHarness();
  let operationIsCurrent = true;

  const pending = ingestion.ingest(baseEvent({
    id: "event-stale",
    type: "turn.started",
    turnId: "stale-turn",
    payload: {}
  }), () => operationIsCurrent);
  operationIsCurrent = false;
  await pending;

  assert.equal(store.getThreadDetail("thread-1")?.turns.length ?? 0, 0);
  assert.equal(patches.length, 0);
});
