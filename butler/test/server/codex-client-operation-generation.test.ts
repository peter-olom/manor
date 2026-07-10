import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { CodexAppServerClient } from "../../src/server/codex-client.js";
import { StaleWorkerOperationError } from "../../src/server/stale-worker-operation-error.js";
import { ButlerStateStore } from "../../src/server/state-store.js";

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
};

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function createStore(dir: string): Promise<ButlerStateStore> {
  const store = new ButlerStateStore(path.join(dir, "state.json"));
  await store.load();
  return store;
}

async function waitFor(predicate: () => boolean, timeoutMs = 500): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(predicate(), true);
}

test("a load that completes after deletion cannot restore the thread", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "manor-codex-load-generation-"));
  try {
    const threadId = "thread-load";
    const store = await createStore(dir);
    store.upsertThreadSummary({ id: threadId, cwd: dir, status: "idle", turns: [] });

    const loadStarted = deferred<void>();
    const loadResult = deferred<{
      threadId: string;
      thread: Record<string, unknown>;
      turns: [];
    }>();
    let capabilityReadyCalls = 0;
    let resumeCalls = 0;
    const client = new CodexAppServerClient("ws://127.0.0.1:1", store, dir, {
      onThreadCapabilityReady: async () => {
        capabilityReadyCalls += 1;
      }
    }) as unknown as {
      codexProviderAdapter: {
        loadThread: (threadId: string) => Promise<unknown>;
        resumeThread: (threadId: string) => Promise<unknown>;
        unsubscribeThread: (threadId: string) => Promise<void>;
      };
      deleteThreadArtifacts: () => Promise<number>;
      loadThread: (threadId: string) => Promise<void>;
      deleteThread: (threadId: string, options: { waitForCleanup: boolean }) => Promise<unknown>;
    };
    client.codexProviderAdapter = {
      loadThread: async () => {
        loadStarted.resolve();
        return loadResult.promise;
      },
      resumeThread: async (id) => {
        resumeCalls += 1;
        return { threadId: id };
      },
      unsubscribeThread: async () => undefined
    };
    client.deleteThreadArtifacts = async () => 0;

    const loading = client.loadThread(threadId);
    await loadStarted.promise;
    await client.deleteThread(threadId, { waitForCleanup: true });
    loadResult.resolve({
      threadId,
      thread: { id: threadId, cwd: dir, status: "idle", turns: [] },
      turns: []
    });
    await loading;

    assert.equal(store.getThread(threadId), undefined);
    assert.equal(capabilityReadyCalls, 0);
    assert.equal(resumeCalls, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a send that completes after stop is interrupted without updating thread state", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "manor-codex-send-stop-generation-"));
  try {
    const threadId = "thread-send-stop";
    const store = await createStore(dir);
    store.upsertThreadSummary({ id: threadId, cwd: dir, status: "idle", turns: [] });

    const sendStarted = deferred<void>();
    const sendResult = deferred<{
      threadId: string;
      turnId?: string;
      turn: Record<string, unknown>;
    }>();
    const interrupted: Array<{ threadId: string; turnId?: string }> = [];
    const client = new CodexAppServerClient("ws://127.0.0.1:1", store, dir) as unknown as {
      codexProviderAdapter: {
        sendTurn: (threadId: string, input: Record<string, unknown>) => Promise<unknown>;
        interruptTurn: (threadId: string, turnId?: string) => Promise<void>;
      };
      directControlThreadIds: Set<string>;
      sendMessage: (threadId: string, input: string) => Promise<{ threadId: string; turnId: string | null }>;
      stopThread: (threadId: string) => Promise<boolean>;
    };
    client.directControlThreadIds.add(threadId);
    client.codexProviderAdapter = {
      sendTurn: async () => {
        sendStarted.resolve();
        return sendResult.promise;
      },
      interruptTurn: async (id, turnId) => {
        interrupted.push({ threadId: id, turnId });
      }
    };

    const sending = client.sendMessage(threadId, "Do the work");
    await sendStarted.promise;
    assert.equal(await client.stopThread(threadId), false);
    sendResult.resolve({
      threadId,
      turn: { id: "late-turn", status: "inProgress", items: [] }
    });

    await assert.rejects(sending, StaleWorkerOperationError);
    assert.deepEqual(interrupted, [{ threadId, turnId: "late-turn" }]);
    assert.equal(store.getThread(threadId)?.turns.some((turn) => turn.id === "late-turn"), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a newer send supersedes an older pending send", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "manor-codex-send-supersession-"));
  try {
    const threadId = "thread-send-supersession";
    const store = await createStore(dir);
    store.upsertThreadSummary({ id: threadId, cwd: dir, status: "idle", turns: [] });

    const sends = [
      deferred<{ threadId: string; turnId: string; turn: Record<string, unknown> }>(),
      deferred<{ threadId: string; turnId: string; turn: Record<string, unknown> }>()
    ];
    const interrupted: string[] = [];
    let sendIndex = 0;
    const client = new CodexAppServerClient("ws://127.0.0.1:1", store, dir) as unknown as {
      codexProviderAdapter: {
        sendTurn: (threadId: string, input: Record<string, unknown>) => Promise<unknown>;
        interruptTurn: (threadId: string, turnId?: string) => Promise<void>;
      };
      directControlThreadIds: Set<string>;
      sendMessage: (threadId: string, input: string) => Promise<{ threadId: string; turnId: string | null }>;
    };
    client.directControlThreadIds.add(threadId);
    client.codexProviderAdapter = {
      sendTurn: async () => sends[sendIndex++]!.promise,
      interruptTurn: async (_id, turnId) => {
        if (turnId) interrupted.push(turnId);
      }
    };

    const older = client.sendMessage(threadId, "First");
    await waitFor(() => sendIndex >= 1);
    const newer = client.sendMessage(threadId, "Second");
    await waitFor(() => sendIndex >= 2);

    sends[1]!.resolve({
      threadId,
      turnId: "new-turn",
      turn: { id: "new-turn", status: "inProgress", items: [] }
    });
    assert.deepEqual(await newer, { threadId, turnId: "new-turn" });

    sends[0]!.resolve({
      threadId,
      turnId: "old-turn",
      turn: { id: "old-turn", status: "inProgress", items: [] }
    });
    await assert.rejects(older, StaleWorkerOperationError);

    assert.deepEqual(interrupted, ["old-turn"]);
    assert.equal(store.getThread(threadId)?.turns.some((turn) => turn.id === "new-turn"), true);
    assert.equal(store.getThread(threadId)?.turns.some((turn) => turn.id === "old-turn"), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("late Codex events from an unresolved send cannot pollute a newer operation", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "manor-codex-event-generation-"));
  try {
    const threadId = "thread-event-generation";
    const store = await createStore(dir);
    store.upsertThreadSummary({ id: threadId, cwd: dir, status: "idle", turns: [] });

    const sends = [
      deferred<{ threadId: string; turnId: string; turn: Record<string, unknown> }>(),
      deferred<{ threadId: string; turnId: string; turn: Record<string, unknown> }>()
    ];
    const interrupted: string[] = [];
    let sendIndex = 0;
    const client = new CodexAppServerClient("ws://127.0.0.1:1", store, dir) as unknown as {
      codexProviderAdapter: {
        sendTurn: (threadId: string, input: Record<string, unknown>) => Promise<unknown>;
        interruptTurn: (threadId: string, turnId?: string) => Promise<void>;
        emit: (event: "runtimeEvent", payload: unknown) => boolean;
      };
      providerRuntimeIngestion: { drain: () => Promise<void> };
      directControlThreadIds: Set<string>;
      sendMessage: (threadId: string, input: string) => Promise<{ threadId: string; turnId: string | null }>;
      stopThread: (threadId: string) => Promise<boolean>;
    };
    client.directControlThreadIds.add(threadId);
    client.codexProviderAdapter.sendTurn = async () => sends[sendIndex++]!.promise;
    client.codexProviderAdapter.interruptTurn = async (_id, turnId) => {
      if (turnId) interrupted.push(turnId);
    };
    const emitRuntimeEvent = (event: Record<string, unknown>) => client.codexProviderAdapter.emit("runtimeEvent", {
      id: `event-${Math.random()}`,
      provider: "codex",
      threadId,
      at: Date.now(),
      ...event
    });

    const older = client.sendMessage(threadId, "Old operation");
    await waitFor(() => sendIndex === 1);
    assert.equal(await client.stopThread(threadId), false);
    emitRuntimeEvent({ type: "turn.started", turnId: "stopped-turn", payload: {} });
    await client.providerRuntimeIngestion.drain();
    assert.equal(store.getThread(threadId)?.turns.length, 0);

    const newer = client.sendMessage(threadId, "New operation");
    await waitFor(() => sendIndex === 2);
    emitRuntimeEvent({ type: "turn.started", turnId: "old-turn", payload: {} });
    emitRuntimeEvent({
      type: "item.started",
      turnId: "old-turn",
      itemId: "old-item",
      payload: { itemType: "assistant_message", status: "in_progress", detail: "old" }
    });
    emitRuntimeEvent({ type: "turn.started", turnId: "new-turn", payload: {} });
    emitRuntimeEvent({
      type: "item.started",
      turnId: "new-turn",
      itemId: "new-item",
      payload: { itemType: "assistant_message", status: "in_progress", detail: "new" }
    });

    sends[1]!.resolve({
      threadId,
      turnId: "new-turn",
      turn: { id: "new-turn", status: "inProgress", items: [] }
    });
    assert.deepEqual(await newer, { threadId, turnId: "new-turn" });
    await client.providerRuntimeIngestion.drain();

    assert.equal(store.getThread(threadId)?.turns.some((turn) => turn.id === "old-turn"), false);
    assert.equal(store.getThread(threadId)?.turns.some((turn) => turn.id === "new-turn"), true);
    assert.equal(store.getThread(threadId)?.turns.find((turn) => turn.id === "new-turn")?.items[0]?.text, "new");

    emitRuntimeEvent({
      type: "item.started",
      turnId: "old-turn",
      itemId: "late-old-item",
      payload: { itemType: "assistant_message", status: "in_progress", detail: "late old" }
    });
    emitRuntimeEvent({ type: "thread.state.changed", payload: { state: "active" } });
    await client.providerRuntimeIngestion.drain();
    assert.equal(store.getThread(threadId)?.turns.some((turn) => turn.id === "old-turn"), false);
    assert.equal(store.getThread(threadId)?.status, "active");

    sends[0]!.resolve({
      threadId,
      turnId: "old-turn",
      turn: { id: "old-turn", status: "inProgress", items: [] }
    });
    await assert.rejects(older, StaleWorkerOperationError);
    assert.deepEqual(interrupted, ["old-turn"]);
    assert.equal(store.getThread(threadId)?.turns.some((turn) => turn.id === "new-turn"), true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("initial Codex turn events are released when startThread binds the provider turn", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "manor-codex-start-event-generation-"));
  try {
    const threadId = "thread-initial-event-generation";
    const store = await createStore(dir);
    const turnResult = deferred<{ threadId: string; turnId: string; turn: Record<string, unknown> }>();
    let turnStarted = false;
    const client = new CodexAppServerClient("ws://127.0.0.1:1", store, dir) as unknown as {
      codexProviderAdapter: {
        startThread: () => Promise<unknown>;
        sendTurn: () => Promise<unknown>;
        emit: (event: "runtimeEvent", payload: unknown) => boolean;
      };
      providerRuntimeIngestion: { drain: () => Promise<void> };
      startThread: (options: { task: string; cwd: string }) => Promise<{ threadId: string; turnId: string | null }>;
    };
    client.codexProviderAdapter.startThread = async () => ({
      threadId,
      thread: { id: threadId, cwd: dir, status: "idle", turns: [] }
    });
    client.codexProviderAdapter.sendTurn = async () => {
      turnStarted = true;
      return turnResult.promise;
    };

    const starting = client.startThread({ task: "Initial operation", cwd: dir });
    await waitFor(() => turnStarted);
    client.codexProviderAdapter.emit("runtimeEvent", {
      id: "initial-turn-start",
      type: "turn.started",
      provider: "codex",
      threadId,
      turnId: "initial-turn",
      at: Date.now(),
      payload: {}
    });
    client.codexProviderAdapter.emit("runtimeEvent", {
      id: "initial-item-start",
      type: "item.started",
      provider: "codex",
      threadId,
      turnId: "initial-turn",
      itemId: "initial-item",
      at: Date.now(),
      payload: { itemType: "assistant_message", status: "in_progress", detail: "streaming" }
    });
    assert.equal(store.getThread(threadId)?.turns.length, 0);

    turnResult.resolve({
      threadId,
      turnId: "initial-turn",
      turn: { id: "initial-turn", status: "inProgress", items: [] }
    });
    assert.deepEqual(await starting, { threadId, turnId: "initial-turn" });
    await client.providerRuntimeIngestion.drain();

    assert.equal(store.getThread(threadId)?.turns.length, 1);
    assert.equal(store.getThread(threadId)?.turns[0]?.items[0]?.text, "streaming");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("Codex preflight does not suppress live events from the active turn", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "manor-codex-preflight-events-"));
  try {
    const threadId = "thread-preflight-events";
    const store = await createStore(dir);
    store.upsertThreadSummary({ id: threadId, cwd: dir, status: { type: "idle" }, turns: [] });
    const capabilityEntered = deferred<void>();
    const releaseCapability = deferred<void>();
    let blockCapability = false;
    const client = new CodexAppServerClient("ws://127.0.0.1:1", store, dir, {
      onThreadCapabilityReady: async () => {
        if (!blockCapability) return;
        capabilityEntered.resolve();
        await releaseCapability.promise;
      }
    }) as unknown as {
      codexProviderAdapter: {
        sendTurn: () => Promise<unknown>;
        steerTurn: () => Promise<void>;
        emit: (event: "runtimeEvent", payload: unknown) => boolean;
      };
      providerRuntimeIngestion: { drain: () => Promise<void> };
      directControlThreadIds: Set<string>;
      sendMessage: (threadId: string, input: string) => Promise<{ threadId: string; turnId: string | null }>;
    };
    client.directControlThreadIds.add(threadId);
    client.codexProviderAdapter.sendTurn = async () => ({
      threadId,
      turnId: "active-turn",
      turn: { id: "active-turn", status: "inProgress", items: [] }
    });
    client.codexProviderAdapter.steerTurn = async () => undefined;

    assert.deepEqual(await client.sendMessage(threadId, "Start"), { threadId, turnId: "active-turn" });
    blockCapability = true;
    const followUp = client.sendMessage(threadId, "Follow up");
    await capabilityEntered.promise;

    client.codexProviderAdapter.emit("runtimeEvent", {
      id: "preflight-live-item",
      type: "item.started",
      provider: "codex",
      threadId,
      turnId: "active-turn",
      itemId: "live-item",
      at: Date.now(),
      payload: { itemType: "assistant_message", status: "in_progress", detail: "still streaming" }
    });
    await client.providerRuntimeIngestion.drain();
    assert.equal(
      store.getThread(threadId)?.turns.find((turn) => turn.id === "active-turn")?.items[0]?.text,
      "still streaming"
    );

    releaseCapability.resolve();
    assert.deepEqual(await followUp, { threadId, turnId: "active-turn" });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("stopping Codex during send preflight rejects before provider dispatch", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "manor-codex-stopped-preflight-"));
  try {
    const threadId = "thread-stopped-preflight";
    const store = await createStore(dir);
    store.upsertThreadSummary({ id: threadId, cwd: dir, status: "idle", turns: [] });
    const capabilityEntered = deferred<void>();
    const releaseCapability = deferred<void>();
    let sendCalls = 0;
    const client = new CodexAppServerClient("ws://127.0.0.1:1", store, dir, {
      onThreadCapabilityReady: async () => {
        capabilityEntered.resolve();
        await releaseCapability.promise;
      }
    }) as unknown as {
      codexProviderAdapter: { sendTurn: () => Promise<unknown> };
      directControlThreadIds: Set<string>;
      sendMessage: (threadId: string, input: string) => Promise<{ threadId: string; turnId: string | null }>;
      stopThread: (threadId: string) => Promise<boolean>;
    };
    client.directControlThreadIds.add(threadId);
    client.codexProviderAdapter.sendTurn = async () => {
      sendCalls += 1;
      return { threadId };
    };

    const sending = client.sendMessage(threadId, "Never dispatch this");
    await capabilityEntered.promise;
    assert.equal(await client.stopThread(threadId), false);
    releaseCapability.resolve();

    await assert.rejects(sending, StaleWorkerOperationError);
    assert.equal(sendCalls, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a stopped initial Codex start rejects and removes the phantom thread", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "manor-codex-stopped-start-"));
  try {
    const threadId = "thread-stopped-start";
    const store = await createStore(dir);
    let sendCalls = 0;
    const client = new CodexAppServerClient("ws://127.0.0.1:1", store, dir) as unknown as {
      codexProviderAdapter: {
        startThread: () => Promise<unknown>;
        sendTurn: () => Promise<unknown>;
        unsubscribeThread: () => Promise<void>;
      };
      startThread: (options: { task: string; cwd: string; input: (threadId: string) => Promise<string> }) => Promise<{ threadId: string; turnId: string | null }>;
      stopThread: (threadId: string) => Promise<boolean>;
    };
    client.codexProviderAdapter = {
      startThread: async () => ({ threadId, thread: { id: threadId, cwd: dir, status: "idle", turns: [] } }),
      sendTurn: async () => {
        sendCalls += 1;
        return { threadId };
      },
      unsubscribeThread: async () => undefined
    };

    const starting = client.startThread({
      task: "Never started",
      cwd: dir,
      input: async (startedThreadId) => {
        assert.equal(await client.stopThread(startedThreadId), false);
        return "Never dispatch this";
      }
    });

    await assert.rejects(starting, StaleWorkerOperationError);
    assert.equal(sendCalls, 0);
    assert.equal(store.getThread(threadId), undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("an accepted Codex response may omit its turn id", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "manor-codex-null-turn-"));
  try {
    const threadId = "thread-null-turn";
    const store = await createStore(dir);
    store.upsertThreadSummary({ id: threadId, cwd: dir, status: "idle", turns: [] });
    const client = new CodexAppServerClient("ws://127.0.0.1:1", store, dir) as unknown as {
      codexProviderAdapter: { sendTurn: () => Promise<unknown> };
      directControlThreadIds: Set<string>;
      sendMessage: (threadId: string, input: string) => Promise<{ threadId: string; turnId: string | null }>;
    };
    client.directControlThreadIds.add(threadId);
    client.codexProviderAdapter.sendTurn = async () => ({ threadId });

    assert.deepEqual(await client.sendMessage(threadId, "Accepted without an id"), { threadId, turnId: null });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
