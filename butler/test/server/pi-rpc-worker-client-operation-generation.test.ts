import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { PiProviderRuntimeMapper } from "../../src/server/pi-provider-events.js";
import { PiRpcWorkerClient } from "../../src/server/pi-rpc-worker-client.js";
import { StaleWorkerOperationError } from "../../src/server/stale-worker-operation-error.js";
import { ButlerStateStore } from "../../src/server/state-store.js";
import type { ProviderRuntimeLivePatch } from "../../src/shared/provider-runtime.js";

type FakeSession = {
  threadId: string;
  client: {
    getState: () => Promise<{ isStreaming: boolean }>;
    prompt: (text: string) => Promise<void>;
    steer: (text: string) => Promise<void>;
    abort: () => Promise<void>;
    stop: () => Promise<void>;
  };
  mapper: PiProviderRuntimeMapper;
  unsubscribe: (() => void) | null;
  cwd: string;
  activityVersion: number;
  acceptedEventVersion: number | null;
  eventStreamVersion: number | null;
  pendingPromptGenerations: number[];
};

type TestClient = {
  sessions: Map<string, FakeSession>;
  createSession: (threadId: string, cwd: string) => Promise<FakeSession>;
  startThread: (options: { task: string; cwd?: string; input?: (threadId: string) => Promise<string> }) => Promise<{ threadId: string; turnId: string | null }>;
  sendMessage: (threadId: string, input: string) => Promise<{ threadId: string; turnId: string | null }>;
  stopThread: (threadId: string) => Promise<boolean>;
  deleteThread: (threadId: string) => Promise<boolean>;
  handleSessionEvent: (session: FakeSession, event: Record<string, unknown>) => void;
  applyPatch: (session: FakeSession, generation: number | null, patch: ProviderRuntimeLivePatch) => void;
  on: (event: "threadPatch", listener: (patch: ProviderRuntimeLivePatch) => void) => void;
};

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function never(): Promise<never> {
  return new Promise(() => undefined);
}

async function waitFor(predicate: () => boolean, timeoutMs = 500): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(predicate(), true);
}

async function createStore(dir: string): Promise<ButlerStateStore> {
  const store = new ButlerStateStore(path.join(dir, "state.json"));
  await store.load();
  return store;
}

test("stopped Pi operations reject late events while a newer operation remains live", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "manor-pi-operation-generation-"));
  try {
    const threadId = "pi-thread-generation";
    const store = await createStore(dir);
    store.upsertThreadSummary({ id: threadId, cwd: dir, source: "pi-rpc", status: { type: "idle" }, turns: [] });

    let promptCalls = 0;
    let abortCalls = 0;
    const session: FakeSession = {
      threadId,
      client: {
        getState: async () => ({ isStreaming: false }),
        prompt: async () => {
          promptCalls += 1;
          await never();
        },
        steer: async () => undefined,
        abort: async () => {
          abortCalls += 1;
          await never();
        },
        stop: async () => undefined
      },
      mapper: new PiProviderRuntimeMapper(threadId),
      unsubscribe: null,
      cwd: dir,
      activityVersion: 0,
      acceptedEventVersion: null,
      eventStreamVersion: null,
      pendingPromptGenerations: []
    };
    const client = new PiRpcWorkerClient({
      store,
      piAuthPath: path.join(dir, "auth.json"),
      sessionRootDir: path.join(dir, "sessions")
    }) as unknown as TestClient;
    client.sessions.set(threadId, session);
    const patches: ProviderRuntimeLivePatch[] = [];
    client.on("threadPatch", (patch) => patches.push(patch));

    void client.sendMessage(threadId, "First operation");
    await waitFor(() => promptCalls === 1);
    const stoppedGeneration = session.activityVersion;
    void client.stopThread(threadId);
    await waitFor(() => abortCalls === 1);

    client.applyPatch(session, stoppedGeneration, {
      kind: "turn-lifecycle",
      threadId,
      turnId: "late-turn",
      status: "started",
      at: 100
    });
    assert.equal(store.getThread(threadId)?.turns.length, 0);
    assert.equal(store.getThread(threadId)?.status, "idle");
    assert.equal(patches.length, 0);

    void client.sendMessage(threadId, "New operation");
    await waitFor(() => promptCalls === 2);
    const currentGeneration = session.activityVersion;
    assert.notEqual(currentGeneration, stoppedGeneration);

    client.handleSessionEvent(session, { type: "agent_start" });
    client.handleSessionEvent(session, { type: "turn_start" });
    client.handleSessionEvent(session, {
      type: "message_start",
      message: { role: "assistant", content: [{ type: "text", text: "late" }], timestamp: 101 }
    });
    client.handleSessionEvent(session, { type: "agent_end" });
    assert.equal(store.getThread(threadId)?.status, "idle");
    assert.equal(store.getThread(threadId)?.turns.length, 0);

    client.applyPatch(session, stoppedGeneration, {
      kind: "thread-state",
      threadId,
      state: "active",
      at: 101
    });
    assert.equal(store.getThread(threadId)?.status, "idle");

    client.handleSessionEvent(session, { type: "agent_start" });
    client.handleSessionEvent(session, { type: "turn_start" });
    client.handleSessionEvent(session, {
      type: "message_start",
      message: { role: "assistant", content: [{ type: "text", text: "" }], timestamp: 110 }
    });
    assert.equal(store.getThread(threadId)?.status, "active");
    assert.equal(store.getThread(threadId)?.turns.length, 1);
    assert.equal(store.getThread(threadId)?.turns[0]?.items.length, 1);
    assert.ok(patches.length >= 3);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("deleted Pi sessions reject stale applyPatch calls even if the thread id is reused", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "manor-pi-delete-generation-"));
  try {
    const threadId = "pi-thread-delete";
    const store = await createStore(dir);
    store.upsertThreadSummary({ id: threadId, cwd: dir, source: "pi-rpc", status: { type: "idle" }, turns: [] });
    const session: FakeSession = {
      threadId,
      client: {
        getState: async () => ({ isStreaming: false }),
        prompt: async () => undefined,
        steer: async () => undefined,
        abort: async () => undefined,
        stop: async () => undefined
      },
      mapper: new PiProviderRuntimeMapper(threadId),
      unsubscribe: null,
      cwd: dir,
      activityVersion: 1,
      acceptedEventVersion: 1,
      eventStreamVersion: 1,
      pendingPromptGenerations: []
    };
    const client = new PiRpcWorkerClient({
      store,
      piAuthPath: path.join(dir, "auth.json"),
      sessionRootDir: path.join(dir, "sessions")
    }) as unknown as TestClient;
    client.sessions.set(threadId, session);
    const staleGeneration = session.activityVersion;

    assert.equal(await client.deleteThread(threadId), true);
    store.upsertThreadSummary({ id: threadId, cwd: dir, source: "pi-rpc", status: { type: "idle" }, turns: [] });
    client.applyPatch(session, staleGeneration, {
      kind: "turn-lifecycle",
      threadId,
      turnId: "late-turn",
      status: "started",
      at: 200
    });

    assert.equal(store.getThread(threadId)?.turns.length, 0);
    assert.equal(store.getThread(threadId)?.status, "idle");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("Pi getState preflight keeps the existing stream generation live", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "manor-pi-preflight-generation-"));
  try {
    const threadId = "pi-thread-preflight";
    const store = await createStore(dir);
    store.upsertThreadSummary({ id: threadId, cwd: dir, source: "pi-rpc", status: { type: "active" }, turns: [] });
    const state = deferred<{ isStreaming: boolean }>();
    let stateRequested = false;
    let steerCalls = 0;
    const session: FakeSession = {
      threadId,
      client: {
        getState: async () => {
          stateRequested = true;
          return state.promise;
        },
        prompt: async () => undefined,
        steer: async () => { steerCalls += 1; },
        abort: async () => undefined,
        stop: async () => undefined
      },
      mapper: new PiProviderRuntimeMapper(threadId),
      unsubscribe: null,
      cwd: dir,
      activityVersion: 1,
      acceptedEventVersion: 1,
      eventStreamVersion: 1,
      pendingPromptGenerations: []
    };
    const client = new PiRpcWorkerClient({
      store,
      piAuthPath: path.join(dir, "auth.json"),
      sessionRootDir: path.join(dir, "sessions")
    }) as unknown as TestClient;
    client.sessions.set(threadId, session);

    const sending = client.sendMessage(threadId, "Steer the live turn");
    await waitFor(() => stateRequested);
    client.handleSessionEvent(session, { type: "turn_start" });
    client.handleSessionEvent(session, {
      type: "message_start",
      message: { role: "assistant", content: [{ type: "text", text: "live" }], timestamp: 300 }
    });
    assert.equal(store.getThread(threadId)?.turns.length, 1);
    assert.equal(store.getThread(threadId)?.turns[0]?.items.length, 1);

    state.resolve({ isStreaming: true });
    assert.deepEqual(await sending, { threadId, turnId: null });
    assert.equal(steerCalls, 1);
    assert.equal(session.activityVersion, 2);
    assert.equal(session.eventStreamVersion, 2);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("rejected Pi dispatch invalidates late provider events", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "manor-pi-rejected-generation-"));
  try {
    const threadId = "pi-thread-rejected";
    const store = await createStore(dir);
    store.upsertThreadSummary({ id: threadId, cwd: dir, source: "pi-rpc", status: { type: "idle" }, turns: [] });
    const session: FakeSession = {
      threadId,
      client: {
        getState: async () => ({ isStreaming: false }),
        prompt: async () => { throw new Error("dispatch failed"); },
        steer: async () => undefined,
        abort: async () => undefined,
        stop: async () => undefined
      },
      mapper: new PiProviderRuntimeMapper(threadId),
      unsubscribe: null,
      cwd: dir,
      activityVersion: 0,
      acceptedEventVersion: null,
      eventStreamVersion: null,
      pendingPromptGenerations: []
    };
    const client = new PiRpcWorkerClient({
      store,
      piAuthPath: path.join(dir, "auth.json"),
      sessionRootDir: path.join(dir, "sessions")
    }) as unknown as TestClient;
    client.sessions.set(threadId, session);
    const patches: ProviderRuntimeLivePatch[] = [];
    client.on("threadPatch", (patch) => patches.push(patch));

    await assert.rejects(client.sendMessage(threadId, "Rejected operation"), /dispatch failed/);
    assert.equal(session.acceptedEventVersion, null);
    assert.equal(session.pendingPromptGenerations.length, 0);

    client.handleSessionEvent(session, { type: "agent_start" });
    client.handleSessionEvent(session, { type: "turn_start" });
    client.handleSessionEvent(session, {
      type: "message_start",
      message: { role: "assistant", content: [{ type: "text", text: "late" }], timestamp: 400 }
    });
    assert.equal(store.getThread(threadId)?.status, "idle");
    assert.equal(store.getThread(threadId)?.turns.length, 0);
    assert.equal(patches.length, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("stopping Pi during getState preflight rejects before provider dispatch", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "manor-pi-stopped-preflight-"));
  try {
    const threadId = "pi-thread-stopped-preflight";
    const store = await createStore(dir);
    store.upsertThreadSummary({ id: threadId, cwd: dir, source: "pi-rpc", status: { type: "idle" }, turns: [] });
    const state = deferred<{ isStreaming: boolean }>();
    let stateRequested = false;
    let promptCalls = 0;
    let steerCalls = 0;
    const session: FakeSession = {
      threadId,
      client: {
        getState: async () => { stateRequested = true; return state.promise; },
        prompt: async () => { promptCalls += 1; },
        steer: async () => { steerCalls += 1; },
        abort: async () => undefined,
        stop: async () => undefined
      },
      mapper: new PiProviderRuntimeMapper(threadId),
      unsubscribe: null,
      cwd: dir,
      activityVersion: 0,
      acceptedEventVersion: null,
      eventStreamVersion: null,
      pendingPromptGenerations: []
    };
    const client = new PiRpcWorkerClient({ store, piAuthPath: path.join(dir, "auth.json"), sessionRootDir: path.join(dir, "sessions") }) as unknown as TestClient;
    client.sessions.set(threadId, session);

    const sending = client.sendMessage(threadId, "Never dispatch this");
    await waitFor(() => stateRequested);
    assert.equal(await client.stopThread(threadId), true);
    state.resolve({ isStreaming: false });

    await assert.rejects(sending, StaleWorkerOperationError);
    assert.equal(promptCalls, 0);
    assert.equal(steerCalls, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a Pi provider response that resolves after stop rejects the send", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "manor-pi-stopped-provider-"));
  try {
    const threadId = "pi-thread-stopped-provider";
    const store = await createStore(dir);
    store.upsertThreadSummary({ id: threadId, cwd: dir, source: "pi-rpc", status: { type: "idle" }, turns: [] });
    const prompt = deferred<void>();
    let promptCalls = 0;
    const session: FakeSession = {
      threadId,
      client: {
        getState: async () => ({ isStreaming: false }),
        prompt: async () => { promptCalls += 1; return prompt.promise; },
        steer: async () => undefined,
        abort: async () => undefined,
        stop: async () => undefined
      },
      mapper: new PiProviderRuntimeMapper(threadId),
      unsubscribe: null,
      cwd: dir,
      activityVersion: 0,
      acceptedEventVersion: null,
      eventStreamVersion: null,
      pendingPromptGenerations: []
    };
    const client = new PiRpcWorkerClient({ store, piAuthPath: path.join(dir, "auth.json"), sessionRootDir: path.join(dir, "sessions") }) as unknown as TestClient;
    client.sessions.set(threadId, session);

    const sending = client.sendMessage(threadId, "Stop this send");
    await waitFor(() => promptCalls === 1);
    assert.equal(await client.stopThread(threadId), true);
    prompt.resolve();

    await assert.rejects(sending, StaleWorkerOperationError);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a stopped initial Pi start rejects and removes the phantom session", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "manor-pi-stopped-start-"));
  try {
    const threadId = "pi-thread-stopped-start";
    const store = await createStore(dir);
    let promptCalls = 0;
    let stopCalls = 0;
    const session: FakeSession = {
      threadId,
      client: {
        getState: async () => ({ isStreaming: false }),
        prompt: async () => { promptCalls += 1; },
        steer: async () => undefined,
        abort: async () => undefined,
        stop: async () => { stopCalls += 1; }
      },
      mapper: new PiProviderRuntimeMapper(threadId),
      unsubscribe: null,
      cwd: dir,
      activityVersion: 0,
      acceptedEventVersion: null,
      eventStreamVersion: null,
      pendingPromptGenerations: []
    };
    const client = new PiRpcWorkerClient({ store, piAuthPath: path.join(dir, "auth.json"), sessionRootDir: path.join(dir, "sessions") }) as unknown as TestClient;
    let startedThreadId = "";
    client.createSession = async (createdThreadId) => {
      startedThreadId = createdThreadId;
      session.threadId = createdThreadId;
      client.sessions.set(createdThreadId, session);
      return session;
    };

    const starting = client.startThread({
      task: "Never started",
      cwd: dir,
      input: async (startedThreadId) => {
        assert.equal(await client.stopThread(startedThreadId), true);
        return "Never dispatch this";
      }
    });

    await assert.rejects(starting, StaleWorkerOperationError);
    assert.equal(promptCalls, 0);
    assert.equal(stopCalls, 1);
    assert.equal(client.sessions.has(startedThreadId), false);
    assert.equal(store.getThread(startedThreadId), undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
