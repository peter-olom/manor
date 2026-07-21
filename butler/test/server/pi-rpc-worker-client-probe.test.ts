import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { ExtensionUiBroker } from "../../src/server/extension-ui-broker.js";
import { PiProviderRuntimeMapper } from "../../src/server/pi-provider-events.js";
import { PiRpcWorkerClient } from "../../src/server/pi-rpc-worker-client.js";
import { ButlerStateStore } from "../../src/server/state-store.js";
import type { WorkerThreadRuntimeProbe } from "../../src/server/worker-thread-runtime-probe.js";

type ProbeClient = {
  sessions: Map<string, never>;
  lastRuntimeActivityAt: Map<string, number>;
  loadThread: (threadId: string) => Promise<void>;
  probeThread: (threadId: string) => Promise<WorkerThreadRuntimeProbe>;
  sendMessage: (threadId: string, input: string) => Promise<{ threadId: string; turnId: string | null }>;
  getLastRuntimeActivityAt: (threadId: string) => number | null;
  handleSessionEvent: (session: never, event: Record<string, unknown>) => void;
};

type AuthRefreshSession = {
  threadId: string;
  client: { getState: () => Promise<{ isStreaming: boolean; isCompacting: boolean }> };
};

type AuthRefreshClient = {
  sessions: Map<string, AuthRefreshSession>;
  authRefreshPendingThreadIds: Set<string>;
  loadModels: () => Promise<void>;
  restartSessionForModelContext: (session: AuthRefreshSession) => Promise<AuthRefreshSession>;
  refreshSessionAuth: (threadId: string, requireIdle: boolean) => Promise<boolean>;
  refreshAuth: () => Promise<void>;
};

async function createStore(dir: string): Promise<ButlerStateStore> {
  const store = new ButlerStateStore(path.join(dir, "state.json"));
  await store.load();
  return store;
}

test("Worker authentication refresh restarts idle sessions and defers busy sessions", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "manor-pi-auth-refresh-"));
  try {
    const implementation = new PiRpcWorkerClient({
      store: await createStore(dir),
      piAuthPath: path.join(dir, "auth.json"),
      sessionRootDir: path.join(dir, "sessions")
    }) as unknown as AuthRefreshClient;
    const idle = { threadId: "idle", client: { getState: async () => ({ isStreaming: false, isCompacting: false }) } };
    const busy = { threadId: "busy", client: { getState: async () => ({ isStreaming: true, isCompacting: false }) } };
    implementation.sessions.set(idle.threadId, idle);
    implementation.sessions.set(busy.threadId, busy);
    implementation.loadModels = async () => undefined;
    const restarted: string[] = [];
    implementation.restartSessionForModelContext = async (session) => {
      restarted.push(session.threadId);
      return session;
    };

    await implementation.refreshAuth();

    assert.deepEqual(restarted, ["idle"]);
    assert.equal(implementation.authRefreshPendingThreadIds.has("idle"), false);
    assert.equal(implementation.authRefreshPendingThreadIds.has("busy"), true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("concurrent Worker authentication refreshes share one session restart", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "manor-pi-auth-refresh-race-"));
  try {
    const implementation = new PiRpcWorkerClient({
      store: await createStore(dir),
      piAuthPath: path.join(dir, "auth.json"),
      sessionRootDir: path.join(dir, "sessions")
    }) as unknown as AuthRefreshClient;
    const session = { threadId: "thread", client: { getState: async () => ({ isStreaming: false, isCompacting: false }) } };
    implementation.sessions.set(session.threadId, session);
    implementation.authRefreshPendingThreadIds.add(session.threadId);
    let releaseRestart = (): void => {};
    const restartGate = new Promise<void>((resolve) => { releaseRestart = resolve; });
    let restarts = 0;
    implementation.restartSessionForModelContext = async (current) => {
      restarts += 1;
      await restartGate;
      return current;
    };

    const first = implementation.refreshSessionAuth(session.threadId, false);
    const second = implementation.refreshSessionAuth(session.threadId, true);
    assert.equal(first, second);
    releaseRestart();
    assert.deepEqual(await Promise.all([first, second]), [true, true]);
    assert.equal(restarts, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("Pi Worker probes live RPC state without manufacturing runtime activity", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "manor-pi-probe-"));
  try {
    const threadId = "pi-live-probe";
    const store = await createStore(dir);
    store.upsertThreadSummary({ id: threadId, source: "pi-rpc", cwd: dir, status: "active", turns: [] });
    const client = new PiRpcWorkerClient({ store, piAuthPath: path.join(dir, "auth.json"), sessionRootDir: path.join(dir, "sessions") }) as unknown as ProbeClient;
    let stateCalls = 0;
    let rpcState = { isStreaming: true, isCompacting: true, pendingMessageCount: 2 };
    const session = {
      threadId,
      client: { getState: async () => { stateCalls += 1; return rpcState; } },
      mapper: new PiProviderRuntimeMapper(threadId), unsubscribe: null, cwd: dir, provider: "ollama-cloud", model: "glm-5.2",
      activityVersion: 1, acceptedEventVersion: 1, eventStreamVersion: 1, pendingPromptGenerations: [], transportClosed: false
    } as never;
    client.sessions.set(threadId, session);
    client.lastRuntimeActivityAt.set(threadId, 1234);

    assert.deepEqual(await client.probeThread(threadId), {
      state: "busy", busy: true, compacting: true, pendingMessageCount: 2,
      activityAt: 1234, acknowledgedWait: "Worker is compacting context.", confirmedDead: false
    });
    assert.equal(stateCalls, 1);
    assert.equal(client.getLastRuntimeActivityAt(threadId), 1234);

    rpcState = { isStreaming: false, isCompacting: false, pendingMessageCount: 0 };
    const eventAt = Date.now();
    client.handleSessionEvent(session, { type: "auto_retry_start", attempt: 2, maxAttempts: 3, delayMs: 1_000, errorMessage: "retry" });
    const retryProbe = await client.probeThread(threadId);
    assert.equal(retryProbe.state, "busy");
    assert.equal(retryProbe.acknowledgedWait, "Worker is waiting for retry attempt 2.");
    assert.equal((retryProbe.activityAt ?? 0) >= eventAt, true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("Pi probe evicts a dead process so the next follow-up can resume a fresh session", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "manor-pi-dead-probe-"));
  try {
    const threadId = "pi-dead-probe";
    const store = await createStore(dir);
    store.upsertThreadSummary({ id: threadId, source: "pi-rpc", cwd: dir, status: "active", turns: [{ id: "dead-turn", status: "in_progress", items: [] }] });
    const client = new PiRpcWorkerClient({ store, piAuthPath: path.join(dir, "auth.json"), sessionRootDir: path.join(dir, "sessions") }) as unknown as ProbeClient;
    const deadSession = {
      threadId,
      client: {
        getState: async () => { throw new Error("process exited"); },
        process: { exitCode: 1, signalCode: null, stdin: { destroyed: true, writable: false } }
      },
      mapper: new PiProviderRuntimeMapper(threadId), unsubscribe: null, cwd: dir, provider: "ollama-cloud", model: "glm-5.2",
      activityVersion: 1, acceptedEventVersion: 1, eventStreamVersion: 1, operationTurnIds: [], pendingPromptGenerations: [], transportClosed: false
    } as never;
    client.sessions.set(threadId, deadSession);

    await assert.rejects(() => client.probeThread(threadId), { name: "WorkerTransportDeadError" });
    assert.equal(client.sessions.has(threadId), false);
    assert.equal(store.getThread(threadId)?.status, "idle");
    assert.equal(store.getThread(threadId)?.turns.at(-1)?.status, "interrupted");

    let sends = 0;
    client.loadThread = async () => {
      const freshSession = {
        threadId,
        client: { send: async () => { sends += 1; } },
        mapper: new PiProviderRuntimeMapper(threadId), unsubscribe: null, cwd: dir, provider: "ollama-cloud", model: "glm-5.2",
        modelContextWindow: null, activityVersion: 0, acceptedEventVersion: null, eventStreamVersion: null,
        operationTurnIds: [], pendingPromptGenerations: [], transportClosed: false
      } as never;
      client.sessions.set(threadId, freshSession);
    };
    const dispatch = await client.sendMessage(threadId, "Continue after recovery.");
    assert.deepEqual(dispatch, { threadId, turnId: null });
    assert.equal(sends, 1);
    await store.flushSave();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("Pi extension dialog round-trips and remains a responsive acknowledged wait", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "manor-pi-dialog-probe-"));
  try {
    const broker = new ExtensionUiBroker();
    const writes: string[] = [];
    const threadId = "pi-dialog-probe";
    const client = new PiRpcWorkerClient({
      store: await createStore(dir),
      piAuthPath: path.join(dir, "auth.json"),
      sessionRootDir: path.join(dir, "sessions"),
      extensionUiBroker: broker
    }) as unknown as ProbeClient;
    const session = {
      threadId,
      client: {
        getState: async () => ({ isStreaming: false, isCompacting: false, pendingMessageCount: 0 }),
        process: { stdin: { destroyed: false, writable: true, write: (value: string) => { writes.push(value); return true; } } }
      },
      mapper: new PiProviderRuntimeMapper(threadId), unsubscribe: null, cwd: dir, provider: "ollama-cloud", model: "glm-5.2",
      activityVersion: 1, acceptedEventVersion: 1, eventStreamVersion: 1, pendingPromptGenerations: [], transportClosed: false
    } as never;
    client.sessions.set(threadId, session);
    client.handleSessionEvent(session, { type: "extension_ui_request", id: "select-1", method: "select", title: "Choose", options: ["A", "B"] });

    const probe = await client.probeThread(threadId);
    assert.equal(probe.state, "busy");
    assert.equal(probe.acknowledgedWait, "Worker is waiting for extension UI input.");
    broker.respond(threadId, "select-1", { value: "B" });
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(JSON.parse(writes[0]!), { type: "extension_ui_response", id: "select-1", value: "B" });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
