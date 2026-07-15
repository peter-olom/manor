import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { acceptedDirectWorkerDispatchTurnId, directWorkerDispatchMarker } from "../../src/server/butler-callback-state.js";
import { PiProviderRuntimeMapper } from "../../src/server/pi-provider-events.js";
import { PiRpcWorkerClient } from "../../src/server/pi-rpc-worker-client.js";
import { ButlerStateStore } from "../../src/server/state-store.js";
import type { ButlerThreadCallbackView } from "../../src/server/types.js";

async function createHarness(remoteStreaming: boolean) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "manor-pi-atomic-dispatch-"));
  const store = new ButlerStateStore(path.join(dir, "state.json"));
  await store.load();
  const threadId = "pi-atomic-dispatch";
  store.upsertThreadSummary({
    id: threadId,
    source: "pi-rpc",
    cwd: dir,
    status: "active",
    turns: [{ id: "turn-active", status: "in_progress", startedAt: 500, items: [] }]
  });
  let getStateCalls = 0;
  let startedPrompts = 0;
  let queuedSteers = 0;
  let command: Record<string, unknown> | null = null;
  const session = {
    threadId,
    client: {
      getState: async () => { getStateCalls += 1; return { isStreaming: remoteStreaming, isCompacting: false }; },
      prompt: async () => undefined,
      steer: async () => undefined,
      send: async (next: Record<string, unknown>) => {
        command = next;
        if (remoteStreaming) queuedSteers += 1;
        else startedPrompts += 1;
      }
    },
    mapper: new PiProviderRuntimeMapper(threadId), unsubscribe: null, cwd: dir,
    provider: "ollama-cloud", model: "glm-5.2", modelContextWindow: null,
    activityVersion: 1, acceptedEventVersion: 1, eventStreamVersion: 1,
    pendingPromptGenerations: [], transportClosed: false
  };
  const client = new PiRpcWorkerClient({ store, piAuthPath: path.join(dir, "auth.json"), sessionRootDir: path.join(dir, "sessions") }) as unknown as {
    sessions: Map<string, typeof session>;
    sendMessage(threadId: string, text: string): Promise<{ threadId: string; turnId: string | null }>;
    handleSessionEvent(session: typeof session, event: Record<string, unknown>): void;
  };
  client.sessions.set(threadId, session);
  return { client, command: () => command, dir, getStateCalls: () => getStateCalls, queuedSteers: () => queuedSteers, session, setRemoteStreaming: (value: boolean) => { remoteStreaming = value; }, startedPrompts: () => startedPrompts, store, threadId };
}

test("Pi follow-ups dispatch atomically when an active turn becomes idle", async () => {
  const harness = await createHarness(true);
  try {
    harness.setRemoteStreaming(false);
    assert.deepEqual(await harness.client.sendMessage(harness.threadId, "Continue safely."), { threadId: harness.threadId, turnId: null });
    assert.equal(harness.getStateCalls(), 0);
    assert.equal(harness.startedPrompts(), 1);
    assert.equal(harness.queuedSteers(), 0);
    assert.deepEqual(harness.command(), { type: "prompt", message: "Continue safely.", images: undefined, streamingBehavior: "steer" });
  } finally {
    await rm(harness.dir, { recursive: true, force: true });
  }
});

test("Pi follow-ups queue once and their dispatch marker binds the active turn", async () => {
  const harness = await createHarness(true);
  try {
    const requestedAt = 1_000;
    const marker = directWorkerDispatchMarker(harness.threadId, requestedAt);
    assert.deepEqual(await harness.client.sendMessage(harness.threadId, `Continue safely.\n${marker}`), { threadId: harness.threadId, turnId: null });
    assert.equal(harness.getStateCalls(), 0);
    assert.equal(harness.startedPrompts(), 0);
    assert.equal(harness.queuedSteers(), 1);
    harness.store.updateItem(harness.threadId, "turn-active", { id: "accepted-steer", type: "userMessage", text: marker, at: requestedAt }, "completed");
    assert.equal(acceptedDirectWorkerDispatchTurnId({ threadId: harness.threadId, requestedAt } as ButlerThreadCallbackView, harness.store.getThread(harness.threadId)), "turn-active");
  } finally {
    await rm(harness.dir, { recursive: true, force: true });
  }
});

test("an old settle event during atomic dispatch cannot consume the new operation generation", async () => {
  const harness = await createHarness(false);
  try {
    harness.session.client.send = async () => {
      harness.client.handleSessionEvent(harness.session, { type: "agent_settled" });
    };
    await harness.client.sendMessage(harness.threadId, "Start after the old run settles.");
    const generation = harness.session.activityVersion;
    assert.equal(harness.session.acceptedEventVersion, generation);
    assert.equal(harness.session.eventStreamVersion, generation);

    harness.client.handleSessionEvent(harness.session, { type: "agent_start" });
    harness.client.handleSessionEvent(harness.session, { type: "turn_start" });
    harness.client.handleSessionEvent(harness.session, { type: "message_start", message: { role: "assistant", content: [{ type: "text", text: "new run" }], timestamp: 1_200 } });
    assert.equal(harness.session.eventStreamVersion, generation);
    assert.equal(harness.store.getThread(harness.threadId)?.status, "active");
    assert.equal(harness.store.getThread(harness.threadId)?.turns.length, 2);
    assert.equal(harness.store.getThread(harness.threadId)?.turns.at(-1)?.items.length, 1);
  } finally {
    await rm(harness.dir, { recursive: true, force: true });
  }
});
