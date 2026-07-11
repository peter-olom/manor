import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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
    setThinkingLevel?: (level: string) => Promise<void>;
  };
  mapper: PiProviderRuntimeMapper;
  unsubscribe: (() => void) | null;
  cwd: string;
  provider?: string;
  model?: string;
  activityVersion: number;
  acceptedEventVersion: number | null;
  eventStreamVersion: number | null;
  pendingPromptGenerations: number[];
};

type TestClient = {
  sessions: Map<string, FakeSession>;
  availableModels: Array<Record<string, unknown>>;
  selectedProvider: string | null;
  selectedModel: string | null;
  selectedEffort: "low" | "medium" | "high" | "xhigh" | null;
  createSession: (threadId: string, cwd: string, provider: string, model: string, sessionPath?: string) => Promise<FakeSession>;
  startThread: (options: { task: string; cwd?: string; provider?: string; model?: string; effort?: "low" | "medium" | "high" | "xhigh" | null; input?: (threadId: string) => Promise<string> }) => Promise<{ threadId: string; turnId: string | null }>;
  sendMessage: (threadId: string, input: string) => Promise<{ threadId: string; turnId: string | null }>;
  stopThread: (threadId: string) => Promise<boolean>;
  deleteThread: (threadId: string) => Promise<boolean>;
  loadThread: (threadId: string) => Promise<void>;
  webToolsExtensionArgs: (provider?: string | null) => Promise<string[]>;
  handleSessionEvent: (session: FakeSession, event: Record<string, unknown>) => void;
  applyPatch: (session: FakeSession, generation: number | null, patch: ProviderRuntimeLivePatch) => void;
  on: (event: "threadPatch", listener: (patch: ProviderRuntimeLivePatch) => void) => void;
};

test("Worker Pi extensions use compiled runtime paths across the environment bridge", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "manor-pi-worker-extension-"));
  try {
    const client = new PiRpcWorkerClient({
      store: await createStore(dir),
      piAuthPath: path.join(dir, "auth.json"),
      sessionRootDir: path.join(dir, "sessions"),
      extensionDir: "/opt/manor/worker/dist/server"
    }) as unknown as TestClient;

    assert.deepEqual(await client.webToolsExtensionArgs("opencode-go"), [
      "--extension",
      "/opt/manor/worker/dist/server/pi-opencode-web-tools-extension.js"
    ]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("Pi resumes one persisted session after restart and reconciles the interrupted turn", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "manor-pi-resume-"));
  try {
    const threadId = "pi-resume-thread";
    const cwd = path.join(dir, "workspace");
    const sessionDir = path.join(dir, "sessions", threadId);
    const sessionPath = path.join(sessionDir, "2026-07-11T00-00-00-000Z_session.jsonl");
    await mkdir(sessionDir, { recursive: true });
    await writeFile(sessionPath, [
      JSON.stringify({ type: "session", cwd }),
      JSON.stringify({ type: "model_change", provider: "ollama-cloud", modelId: "glm-5.2" })
    ].join("\n"), "utf8");
    const store = await createStore(dir);
    store.upsertThreadSummary({
      id: threadId,
      cwd,
      source: "pi-rpc",
      modelProvider: "ollama-cloud",
      status: { type: "active" },
      turns: [{ id: "turn-interrupted", status: "in_progress", items: [] }]
    });
    const client = new PiRpcWorkerClient({
      store,
      piAuthPath: path.join(dir, "auth.json"),
      sessionRootDir: path.join(dir, "sessions")
    }) as unknown as TestClient;
    let createCount = 0;
    let resumedWith: string | undefined;
    client.createSession = async (id, sessionCwd, provider, model, persistedPath) => {
      createCount += 1;
      resumedWith = persistedPath;
      assert.deepEqual({ id, sessionCwd, provider, model }, { id: threadId, sessionCwd: cwd, provider: "ollama-cloud", model: "glm-5.2" });
      const session: FakeSession = {
        threadId,
        client: {
          getState: async () => ({ isStreaming: false }), prompt: async () => undefined, steer: async () => undefined,
          abort: async () => undefined, stop: async () => undefined
        },
        mapper: new PiProviderRuntimeMapper(threadId), unsubscribe: null, cwd, provider, model,
        activityVersion: 0, acceptedEventVersion: null, eventStreamVersion: null, pendingPromptGenerations: []
      };
      client.sessions.set(threadId, session);
      return session;
    };

    await Promise.all([client.loadThread(threadId), client.loadThread(threadId)]);

    assert.equal(createCount, 1);
    assert.equal(resumedWith, sessionPath);
    assert.equal(store.getThread(threadId)?.status, "idle");
    assert.equal(store.getThread(threadId)?.turns[0]?.status, "interrupted");
    assert.match(store.getThread(threadId)?.turns[0]?.error ?? "", /restarted/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("an idle Worker transport restart evicts and resumes the Pi session on the next follow-up", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "manor-pi-transport-resume-"));
  try {
    const threadId = "pi-transport-resume";
    const cwd = path.join(dir, "workspace");
    const sessionDir = path.join(dir, "sessions", threadId);
    const sessionPath = path.join(sessionDir, "2026-07-11T00-00-00-000Z_session.jsonl");
    await mkdir(sessionDir, { recursive: true });
    await writeFile(path.join(sessionDir, "manor-session.json"), JSON.stringify({
      threadId,
      cwd,
      provider: "ollama-cloud",
      model: "glm-5.2"
    }), "utf8");
    await writeFile(sessionPath, JSON.stringify({ type: "session", cwd }), "utf8");
    const store = await createStore(dir);
    store.upsertThreadSummary({
      id: threadId,
      cwd,
      source: "pi-rpc",
      modelProvider: "ollama-cloud",
      status: { type: "active" },
      turns: [{ id: "turn-restarting", status: "in_progress", items: [] }]
    });
    let unsubscribeCalls = 0;
    const staleSession: FakeSession = {
      threadId,
      client: {
        getState: async () => ({ isStreaming: false }), prompt: async () => undefined, steer: async () => undefined,
        abort: async () => undefined, stop: async () => undefined
      },
      mapper: new PiProviderRuntimeMapper(threadId), unsubscribe: () => { unsubscribeCalls += 1; }, cwd,
      provider: "ollama-cloud", model: "glm-5.2", activityVersion: 1, acceptedEventVersion: null,
      eventStreamVersion: null, pendingPromptGenerations: []
    };
    const client = new PiRpcWorkerClient({
      store,
      piAuthPath: path.join(dir, "auth.json"),
      sessionRootDir: path.join(dir, "sessions")
    }) as unknown as TestClient;
    client.sessions.set(threadId, staleSession);
    let createCalls = 0;
    let promptCalls = 0;
    client.createSession = async (id, sessionCwd, provider, model, persistedPath) => {
      createCalls += 1;
      assert.deepEqual(
        { id, sessionCwd, provider, model, persistedPath },
        { id: threadId, sessionCwd: cwd, provider: "ollama-cloud", model: "glm-5.2", persistedPath: sessionPath }
      );
      const resumed: FakeSession = {
        threadId,
        client: {
          getState: async () => ({ isStreaming: false }),
          prompt: async () => { promptCalls += 1; },
          steer: async () => undefined,
          abort: async () => undefined,
          stop: async () => undefined
        },
        mapper: new PiProviderRuntimeMapper(threadId), unsubscribe: null, cwd, provider, model,
        activityVersion: 0, acceptedEventVersion: null, eventStreamVersion: null, pendingPromptGenerations: []
      };
      client.sessions.set(threadId, resumed);
      return resumed;
    };

    client.handleSessionEvent(staleSession, { type: "manor_transport_closed", reason: "Worker restarted." });

    assert.equal(unsubscribeCalls, 1);
    assert.equal(client.sessions.has(threadId), false);
    assert.equal(store.getThread(threadId)?.status, "idle");
    assert.equal(store.getThread(threadId)?.turns[0]?.status, "interrupted");
    await client.sendMessage(threadId, "Continue after restart");
    assert.equal(createCalls, 1);
    assert.equal(promptCalls, 1);
    await store.flushSave();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("transport loss during the initial Pi prompt removes the unreturned thread", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "manor-pi-start-transport-close-"));
  try {
    const store = await createStore(dir);
    const lifecycle: string[] = [];
    let stopped = 0;
    let startedThreadId = "";
    let client!: TestClient;
    const implementation = new PiRpcWorkerClient({
      store,
      piAuthPath: path.join(dir, "auth.json"),
      sessionRootDir: path.join(dir, "sessions"),
      onThreadCapabilityReady: async () => { lifecycle.push("ready"); },
      onThreadCapabilityRemoved: async () => { lifecycle.push("removed"); }
    });
    client = implementation as unknown as TestClient;
    client.availableModels = [{ id: "glm-5.2", provider: "ollama-cloud" }];
    client.createSession = async (threadId, cwd, provider, model) => {
      startedThreadId = threadId;
      const session: FakeSession = {
        threadId,
        client: {
          getState: async () => ({ isStreaming: false }),
          prompt: async () => {
            client.handleSessionEvent(session, { type: "manor_transport_closed", reason: "Worker restarted." });
            throw new Error("transport closed");
          },
          steer: async () => undefined,
          abort: async () => undefined,
          stop: async () => { stopped += 1; }
        },
        mapper: new PiProviderRuntimeMapper(threadId), unsubscribe: null, cwd, provider, model,
        activityVersion: 0, acceptedEventVersion: null, eventStreamVersion: null, pendingPromptGenerations: []
      };
      client.sessions.set(threadId, session);
      return session;
    };

    await assert.rejects(() => client.startThread({
      task: "Never return this thread",
      cwd: dir,
      provider: "ollama-cloud",
      model: "ollama-cloud/glm-5.2"
    }), StaleWorkerOperationError);

    assert.deepEqual(lifecycle, ["ready", "removed"]);
    assert.equal(stopped, 1);
    assert.equal(client.sessions.has(startedThreadId), false);
    assert.equal(store.getThread(startedThreadId), undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("Pi stop surfaces abort failure and keeps the active turn supervised", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "manor-pi-stop-failure-"));
  try {
    const threadId = "pi-stop-failure";
    const store = await createStore(dir);
    store.upsertThreadSummary({ id: threadId, cwd: dir, source: "pi-rpc", status: { type: "active" }, turns: [{ id: "turn-active", status: "in_progress", items: [] }] });
    const session: FakeSession = {
      threadId,
      client: {
        getState: async () => ({ isStreaming: true }), prompt: async () => undefined, steer: async () => undefined,
        abort: async () => { throw new Error("abort failed"); }, stop: async () => undefined
      },
      mapper: new PiProviderRuntimeMapper(threadId), unsubscribe: null, cwd: dir,
      activityVersion: 4, acceptedEventVersion: 4, eventStreamVersion: 4, pendingPromptGenerations: []
    };
    const client = new PiRpcWorkerClient({ store, piAuthPath: path.join(dir, "auth.json"), sessionRootDir: path.join(dir, "sessions") }) as unknown as TestClient;
    client.sessions.set(threadId, session);

    await assert.rejects(() => client.stopThread(threadId), /abort failed/);
    assert.equal(store.getThread(threadId)?.status, "active");
    assert.equal(store.getThread(threadId)?.turns[0]?.status, "in_progress");
    assert.deepEqual({ activity: session.activityVersion, accepted: session.acceptedEventVersion, stream: session.eventStreamVersion }, { activity: 4, accepted: 4, stream: 4 });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("Pi stop terminalizes and durably saves the current turn", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "manor-pi-stop-terminal-"));
  try {
    const threadId = "pi-stop-terminal";
    const store = await createStore(dir);
    store.upsertThreadSummary({ id: threadId, cwd: dir, source: "pi-rpc", status: { type: "active" }, turns: [{ id: "turn-active", status: "in_progress", items: [] }] });
    const session: FakeSession = {
      threadId,
      client: {
        getState: async () => ({ isStreaming: true }), prompt: async () => undefined, steer: async () => undefined,
        abort: async () => undefined, stop: async () => undefined
      },
      mapper: new PiProviderRuntimeMapper(threadId), unsubscribe: null, cwd: dir,
      activityVersion: 2, acceptedEventVersion: 2, eventStreamVersion: 2, pendingPromptGenerations: [2]
    };
    const client = new PiRpcWorkerClient({ store, piAuthPath: path.join(dir, "auth.json"), sessionRootDir: path.join(dir, "sessions") }) as unknown as TestClient;
    client.sessions.set(threadId, session);

    assert.equal(await client.stopThread(threadId), true);
    const stopped = store.getThread(threadId);
    assert.equal(stopped?.status, "idle");
    assert.equal(stopped?.turns[0]?.status, "interrupted");
    assert.ok(Number.isFinite(stopped?.turns[0]?.completedAt));
    assert.equal(session.eventStreamVersion, null);

    const reloaded = await createStore(dir);
    assert.equal(reloaded.getThread(threadId)?.turns[0]?.status, "interrupted");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("deleting a Pi job while it resumes cannot resurrect the session", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "manor-pi-resume-delete-"));
  try {
    const threadId = "pi-resume-delete-thread";
    const cwd = path.join(dir, "workspace");
    const sessionDir = path.join(dir, "sessions", threadId);
    await mkdir(sessionDir, { recursive: true });
    await writeFile(path.join(sessionDir, "2026-07-11T00-00-00-000Z_session.jsonl"), [
      JSON.stringify({ type: "session", cwd }),
      JSON.stringify({ type: "model_change", provider: "ollama-cloud", modelId: "glm-5.2" })
    ].join("\n"), "utf8");
    const store = await createStore(dir);
    store.upsertThreadSummary({ id: threadId, cwd, source: "pi-rpc", modelProvider: "ollama-cloud", status: "idle", turns: [] });
    const client = new PiRpcWorkerClient({
      store,
      piAuthPath: path.join(dir, "auth.json"),
      sessionRootDir: path.join(dir, "sessions")
    }) as unknown as TestClient;
    const created = deferred<FakeSession>();
    let createStarted = false;
    let stopCalls = 0;
    client.createSession = async () => {
      createStarted = true;
      const session = await created.promise;
      client.sessions.set(threadId, session);
      return session;
    };
    const session: FakeSession = {
      threadId,
      client: {
        getState: async () => ({ isStreaming: false }), prompt: async () => undefined, steer: async () => undefined,
        abort: async () => undefined, stop: async () => { stopCalls += 1; }
      },
      mapper: new PiProviderRuntimeMapper(threadId), unsubscribe: null, cwd, provider: "ollama-cloud", model: "glm-5.2",
      activityVersion: 0, acceptedEventVersion: null, eventStreamVersion: null, pendingPromptGenerations: []
    };

    const resuming = client.loadThread(threadId);
    const rejectedResume = assert.rejects(resuming, /deleted while it was resuming/);
    await waitFor(() => createStarted);
    const deleting = client.deleteThread(threadId);
    created.resolve(session);

    await rejectedResume;
    assert.equal(await deleting, true);
    assert.equal(stopCalls, 1);
    assert.equal(client.sessions.has(threadId), false);
    assert.equal(store.getThread(threadId), undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

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
    client.availableModels = [{ id: "glm-5.2", provider: "ollama-cloud" }];
    let startedThreadId = "";
    client.createSession = async (createdThreadId, _cwd, provider, model) => {
      startedThreadId = createdThreadId;
      session.threadId = createdThreadId;
      session.provider = provider;
      session.model = model;
      client.sessions.set(createdThreadId, session);
      return session;
    };

    const starting = client.startThread({
      task: "Never started",
      cwd: dir,
      provider: "ollama-cloud",
      model: "ollama-cloud/glm-5.2",
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

test("Pi creates the harness capability before building the worker payload", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "manor-pi-capability-order-"));
  try {
    const store = await createStore(dir);
    const order: string[] = [];
    const client = new PiRpcWorkerClient({
      store,
      piAuthPath: path.join(dir, "auth.json"),
      sessionRootDir: path.join(dir, "sessions"),
      onThreadCapabilityReady: async (threadId) => {
        assert.ok(store.getThread(threadId));
        order.push("capability");
      }
    }) as unknown as TestClient;
    client.availableModels = [{ id: "glm-5.2", provider: "ollama-cloud" }];
    client.createSession = async (threadId, cwd, provider, model) => {
      const session: FakeSession = {
        threadId,
        client: {
          getState: async () => ({ isStreaming: false }),
          prompt: async () => { order.push("prompt"); },
          steer: async () => undefined,
          abort: async () => undefined,
          stop: async () => undefined
        },
        mapper: new PiProviderRuntimeMapper(threadId),
        unsubscribe: null,
        cwd,
        provider,
        model,
        activityVersion: 0,
        acceptedEventVersion: null,
        eventStreamVersion: null,
        pendingPromptGenerations: []
      };
      client.sessions.set(threadId, session);
      return session;
    };

    await client.startThread({
      task: "Read the Manor payload",
      cwd: dir,
      provider: "ollama-cloud",
      model: "ollama-cloud/glm-5.2",
      input: async () => {
        order.push("payload");
        return "Bound payload";
      }
    });

    assert.deepEqual(order, ["capability", "payload", "prompt"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("an exact Pi worker start preserves an explicit null effort", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "manor-pi-null-effort-"));
  try {
    const store = await createStore(dir);
    let thinkingCalls = 0;
    const client = new PiRpcWorkerClient({
      store,
      piAuthPath: path.join(dir, "auth.json"),
      sessionRootDir: path.join(dir, "sessions")
    }) as unknown as TestClient;
    client.availableModels = [{ id: "glm-5.2", provider: "ollama-cloud" }];
    client.selectedProvider = "ollama-cloud";
    client.selectedModel = "glm-5.2";
    client.selectedEffort = "high";
    client.createSession = async (threadId, cwd, provider, model) => {
      const session: FakeSession = {
        threadId,
        client: {
          getState: async () => ({ isStreaming: false }),
          prompt: async () => undefined,
          steer: async () => undefined,
          abort: async () => undefined,
          stop: async () => undefined,
          setThinkingLevel: async () => { thinkingCalls += 1; }
        },
        mapper: new PiProviderRuntimeMapper(threadId),
        unsubscribe: null,
        cwd,
        provider,
        model,
        activityVersion: 0,
        acceptedEventVersion: null,
        eventStreamVersion: null,
        pendingPromptGenerations: []
      };
      client.sessions.set(threadId, session);
      return session;
    };

    const started = await client.startThread({
      task: "Use provider defaults",
      cwd: dir,
      provider: "ollama-cloud",
      model: "ollama-cloud/glm-5.2",
      effort: null
    });

    assert.equal(thinkingCalls, 0);
    assert.equal(store.getThread(started.threadId)?.requestedReasoningEffort, null);
    assert.equal(client.selectedEffort, "high");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a failed Pi worker payload factory removes its thread, capability, and session", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "manor-pi-input-failure-"));
  try {
    const store = await createStore(dir);
    const lifecycle: string[] = [];
    let stopped = 0;
    let startedThreadId = "";
    const client = new PiRpcWorkerClient({
      store,
      piAuthPath: path.join(dir, "auth.json"),
      sessionRootDir: path.join(dir, "sessions"),
      onThreadCapabilityReady: async () => { lifecycle.push("ready"); },
      onThreadCapabilityRemoved: async () => { lifecycle.push("removed"); }
    }) as unknown as TestClient;
    client.availableModels = [{ id: "glm-5.2", provider: "ollama-cloud" }];
    client.createSession = async (threadId, cwd, provider, model) => {
      startedThreadId = threadId;
      const session: FakeSession = {
        threadId,
        client: {
          getState: async () => ({ isStreaming: false }),
          prompt: async () => undefined,
          steer: async () => undefined,
          abort: async () => undefined,
          stop: async () => { stopped += 1; }
        },
        mapper: new PiProviderRuntimeMapper(threadId),
        unsubscribe: null,
        cwd,
        provider,
        model,
        activityVersion: 0,
        acceptedEventVersion: null,
        eventStreamVersion: null,
        pendingPromptGenerations: []
      };
      client.sessions.set(threadId, session);
      return session;
    };

    await assert.rejects(() => client.startThread({
      task: "Build payload",
      cwd: dir,
      provider: "ollama-cloud",
      model: "ollama-cloud/glm-5.2",
      input: async () => { throw new Error("payload factory failed"); }
    }), /payload factory failed/);

    assert.deepEqual(lifecycle, ["ready", "removed"]);
    assert.equal(stopped, 1);
    assert.equal(client.sessions.has(startedThreadId), false);
    assert.equal(store.getThread(startedThreadId), undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a failed initial Pi prompt removes its thread, capability, and session", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "manor-pi-prompt-failure-"));
  try {
    const store = await createStore(dir);
    let capabilityRemovals = 0;
    let stopped = 0;
    let startedThreadId = "";
    const client = new PiRpcWorkerClient({
      store,
      piAuthPath: path.join(dir, "auth.json"),
      sessionRootDir: path.join(dir, "sessions"),
      onThreadCapabilityReady: async () => undefined,
      onThreadCapabilityRemoved: async () => { capabilityRemovals += 1; }
    }) as unknown as TestClient;
    client.availableModels = [{ id: "glm-5.2", provider: "ollama-cloud" }];
    client.createSession = async (threadId, cwd, provider, model) => {
      startedThreadId = threadId;
      const session: FakeSession = {
        threadId,
        client: {
          getState: async () => ({ isStreaming: false }),
          prompt: async () => { throw new Error("initial prompt failed"); },
          steer: async () => undefined,
          abort: async () => undefined,
          stop: async () => { stopped += 1; }
        },
        mapper: new PiProviderRuntimeMapper(threadId),
        unsubscribe: null,
        cwd,
        provider,
        model,
        activityVersion: 0,
        acceptedEventVersion: null,
        eventStreamVersion: null,
        pendingPromptGenerations: []
      };
      client.sessions.set(threadId, session);
      return session;
    };

    await assert.rejects(() => client.startThread({
      task: "Dispatch",
      cwd: dir,
      provider: "ollama-cloud",
      model: "ollama-cloud/glm-5.2"
    }), /initial prompt failed/);

    assert.equal(capabilityRemovals, 1);
    assert.equal(stopped, 1);
    assert.equal(client.sessions.has(startedThreadId), false);
    assert.equal(store.getThread(startedThreadId), undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
