import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { CodexAppServerClient } from "../../src/server/codex-client.js";
import { ButlerStateStore } from "../../src/server/state-store.js";
import { stopWorkerThreadWithin } from "../../src/server/worker-client-router.js";
import type { CodexThreadPatchView } from "../../src/server/types.js";

async function waitFor(predicate: () => boolean, timeoutMs = 500): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(predicate(), true);
}

test("updateThreadReasoningEffort issues a thread/settings/update JSON-RPC call", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "manor-codex-runtime-events-"));
  const store = new ButlerStateStore(path.join(dir, "state.json"));
  await store.load();

  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  const client = new CodexAppServerClient("ws://127.0.0.1:1", store, dir) as unknown as {
    updateThreadReasoningEffort: (threadId: string, effort: string) => Promise<void>;
  };
  (client as unknown as { codexProviderAdapter: { call: (method: string, params: Record<string, unknown>) => Promise<Record<string, unknown>> } }).codexProviderAdapter = {
    call: async (method, params) => {
      calls.push({ method, params });
      return {};
    }
  };

  await client.updateThreadReasoningEffort("thread-7", "high");

  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.method, "thread/settings/update");
  assert.deepEqual(calls[0]?.params, { threadId: "thread-7", effort: "high" });
});

test("thread/settings/updated notification refreshes the per-thread effort", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "manor-codex-runtime-events-"));
  const store = new ButlerStateStore(path.join(dir, "state.json"));
  await store.load();

  const client = new CodexAppServerClient("ws://127.0.0.1:1", store, dir) as unknown as {
    handleMessage: (message: unknown) => void;
    on: (event: "change" | "threadPatch", listener: (payload?: unknown) => void) => void;
  };

  client.handleMessage({
    method: "thread/settings/updated",
    params: {
      threadId: "thread-9",
      threadSettings: { effort: "xhigh", model: "gpt-5.4" }
    }
  });

  await waitFor(() => store.getThread("thread-9")?.requestedReasoningEffort === "xhigh");
  assert.equal(store.getThread("thread-9")?.requestedReasoningEffort, "xhigh");
  assert.equal((client as unknown as { getLastRuntimeActivityAt: (threadId: string) => number | null }).getLastRuntimeActivityAt("thread-9") !== null, true);
});

test("Codex Worker probe uses a lightweight thread read and preserves real activity time", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "manor-codex-probe-"));
  const store = new ButlerStateStore(path.join(dir, "state.json"));
  await store.load();
  const client = new CodexAppServerClient("ws://127.0.0.1:1", store, dir) as unknown as {
    transport: { getState: () => { connected: boolean; lastError: string | null } };
    codexProviderAdapter: { readThreadState: (threadId: string) => Promise<Record<string, unknown> | null> };
    activeTurnIds: Map<string, string>;
    lastRuntimeActivityAt: Map<string, number>;
    probeThread: (threadId: string) => Promise<Record<string, unknown>>;
  };
  const reads: string[] = [];
  client.transport.getState = () => ({ connected: true, lastError: null });
  client.codexProviderAdapter = {
    readThreadState: async (threadId) => {
      reads.push(threadId);
      return { id: threadId, status: { type: "active" } };
    }
  };
  client.lastRuntimeActivityAt.set("codex-live-probe", 4321);

  assert.deepEqual(await client.probeThread("codex-live-probe"), {
    state: "busy", busy: true, compacting: false, pendingMessageCount: 0,
    activityAt: 4321, acknowledgedWait: null, confirmedDead: false
  });
  assert.deepEqual(reads, ["codex-live-probe"]);
  assert.equal(client.lastRuntimeActivityAt.get("codex-live-probe"), 4321);
});

test("authoritative remote idle overrides stale Codex activity and makes intervention a no-op", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "manor-codex-idle-probe-"));
  const store = new ButlerStateStore(path.join(dir, "state.json"));
  await store.load();
  const threadId = "codex-remotely-idle";
  store.upsertThreadSummary({
    id: threadId,
    source: "appServer",
    status: "active",
    cwd: dir,
    turns: [{ id: "stale-turn", status: "in_progress", items: [] }]
  });
  let interruptCalls = 0;
  let remoteStatus = "futureStatus";
  const client = new CodexAppServerClient("ws://127.0.0.1:1", store, dir) as unknown as {
    transport: { getState: () => { connected: boolean; lastError: string | null } };
    codexProviderAdapter: {
      readThreadState: () => Promise<Record<string, unknown>>;
      interruptTurn: () => Promise<void>;
    };
    activeTurnIds: Map<string, string>;
    probeThread: (threadId: string) => Promise<Record<string, unknown>>;
    stopThread: (threadId: string) => Promise<boolean>;
  };
  client.transport.getState = () => ({ connected: true, lastError: null });
  client.codexProviderAdapter = {
    readThreadState: async () => ({ id: threadId, status: { type: remoteStatus } }),
    interruptTurn: async () => {
      interruptCalls += 1;
      throw new Error("completed remote turns cannot be interrupted");
    }
  };
  client.activeTurnIds.set(threadId, "stale-turn");

  assert.equal((await client.probeThread(threadId)).state, "busy");
  assert.equal(client.activeTurnIds.has(threadId), true);
  remoteStatus = "idle";
  assert.equal((await client.probeThread(threadId)).state, "idle");
  assert.equal(client.activeTurnIds.has(threadId), false);
  assert.equal(store.getThread(threadId)?.status, "idle");
  assert.equal(store.getThread(threadId)?.turns.at(-1)?.status, "completed");
  assert.deepEqual(
    await stopWorkerThreadWithin({ store, codexClient: client } as never, threadId, 50),
    { state: "idle", detail: null }
  );
  assert.equal(interruptCalls, 0);
});

test("transport close preserves active Codex turns until reconnect reports authoritative state", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "manor-codex-close-events-"));
  const store = new ButlerStateStore(path.join(dir, "state.json"));
  await store.load();
  store.upsertThreadSummary({
    id: "thread-close",
    status: "active",
    cwd: dir,
    turns: [{ id: "turn-close", status: "in_progress", items: [] }]
  });
  const client = new CodexAppServerClient("ws://127.0.0.1:1", store, dir) as unknown as {
    activeTurnIds: Map<string, string>;
    transport: { options: { onClosed?: (reason: string) => void }; getState: () => { connected: boolean; lastError: string | null } };
    codexProviderAdapter: { readThreadState: () => Promise<Record<string, unknown>> };
    probeThread: (threadId: string) => Promise<{ state: string }>;
    on: (event: "threadPatch", listener: (patch: CodexThreadPatchView) => void) => void;
  };
  client.activeTurnIds.set("thread-close", "turn-close");
  const patches: CodexThreadPatchView[] = [];
  client.on("threadPatch", (patch) => patches.push(patch));

  client.transport.options.onClosed?.("Socket closed Authorization: Bearer codex-close-secret-123456");
  await waitFor(() => store.getThread("thread-close")?.eventLog.some((entry) => entry.method === "runtime.transport.disconnected") === true);
  client.transport.getState = () => ({ connected: true, lastError: null });
  client.codexProviderAdapter = { readThreadState: async () => ({ id: "thread-close", status: { type: "futureStatus" } }) };
  assert.equal((await client.probeThread("thread-close")).state, "busy");
  client.codexProviderAdapter = { readThreadState: async () => ({ id: "thread-close" }) };
  assert.equal((await client.probeThread("thread-close")).state, "busy");
  client.codexProviderAdapter = { readThreadState: async () => ({ id: "thread-close", status: { type: "active" } }) };
  assert.equal((await client.probeThread("thread-close")).state, "busy");
  await store.flushSave();

  const turn = store.getThread("thread-close")?.turns[0];
  assert.equal(store.getThread("thread-close")?.status, "active");
  assert.equal(turn?.status, "in_progress");
  assert.equal(turn?.error, null);
  assert.equal(turn?.completedAt, null);
  assert.equal(store.getThread("thread-close")?.eventLog[0]?.summary, "Socket closed Authorization: Bearer [REDACTED]");
  assert.equal(patches.length, 0);
  assert.doesNotMatch(JSON.stringify(patches), /codex-close-secret/);

  const reloaded = new ButlerStateStore(path.join(dir, "state.json"));
  await reloaded.load();
  assert.equal(reloaded.getThread("thread-close")?.turns[0]?.status, "in_progress");
  assert.equal(reloaded.getThread("thread-close")?.status, "active");
});

test("thread read snapshots redact provider errors and item text before reload", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "manor-codex-thread-read-redaction-"));
  const store = new ButlerStateStore(path.join(dir, "state.json"));
  await store.load();
  store.upsertThreadSummary({
    id: "thread-redacted",
    status: "idle",
    cwd: dir,
    turns: [{
      id: "turn-redacted",
      status: "failed",
      error: "Previously redacted Authorization: Bearer [REDACTED]",
      items: []
    }]
  });
  const client = new CodexAppServerClient("ws://127.0.0.1:1", store, dir) as unknown as {
    codexProviderAdapter: {
      loadThread: (threadId: string) => Promise<{ threadId: string; thread: Record<string, unknown>; turns: [] }>;
      resumeThread: (threadId: string) => Promise<{ threadId: string }>;
    };
    loadThread: (threadId: string) => Promise<void>;
  };
  client.codexProviderAdapter = {
    loadThread: async (threadId) => ({
      threadId,
      thread: {
        id: threadId,
        source: "appServer",
        cwd: dir,
        status: "idle",
        turns: [{
          id: "turn-redacted",
          status: "failed",
          error: "Provider rejected Authorization: Bearer thread-read-secret-123456",
          startedAt: 100,
          completedAt: 200,
          items: [{
            id: "provider-message",
            type: "agentMessage",
            status: "failed",
            text: "Failure echoed api_key=sk-thread-read-abcdefghijklmnop"
          }]
        }]
      },
      turns: []
    }),
    resumeThread: async (threadId) => ({ threadId })
  };

  await client.loadThread("thread-redacted");
  const turn = store.getThread("thread-redacted")?.turns[0];
  assert.equal(turn?.error, "Provider rejected Authorization: Bearer [REDACTED]");
  assert.equal(turn?.items[0]?.text, "Failure echoed api_key=[REDACTED]");
  assert.doesNotMatch(JSON.stringify(store.getThreadDetail("thread-redacted")), /thread-read-secret|sk-thread-read/);
  await store.flushSave();

  const reloaded = new ButlerStateStore(path.join(dir, "state.json"));
  await reloaded.load();
  const reloadedTurn = reloaded.getThread("thread-redacted")?.turns[0];
  assert.equal(reloadedTurn?.error, "Provider rejected Authorization: Bearer [REDACTED]");
  assert.equal(reloadedTurn?.items[0]?.text, "Failure echoed api_key=[REDACTED]");
  assert.doesNotMatch(JSON.stringify(reloaded.getThreadDetail("thread-redacted")), /thread-read-secret|sk-thread-read/);
});
