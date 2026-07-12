import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { CodexAppServerClient } from "../../src/server/codex-client.js";
import { ButlerStateStore } from "../../src/server/state-store.js";
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
});

test("transport close durably interrupts every active Codex turn with its exact redacted reason", async () => {
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
    transport: { options: { onClosed?: (reason: string) => void } };
    providerRuntimeIngestion: { drain: () => Promise<void> };
    on: (event: "threadPatch", listener: (patch: CodexThreadPatchView) => void) => void;
  };
  client.activeTurnIds.set("thread-close", "turn-close");
  const patches: CodexThreadPatchView[] = [];
  client.on("threadPatch", (patch) => patches.push(patch));

  client.transport.options.onClosed?.("Socket closed Authorization: Bearer codex-close-secret-123456");
  await waitFor(() => store.getThread("thread-close")?.turns[0]?.status === "interrupted");
  await client.providerRuntimeIngestion.drain();

  const turn = store.getThread("thread-close")?.turns[0];
  assert.equal(store.getThread("thread-close")?.status, "idle");
  assert.equal(turn?.error, "Socket closed Authorization: Bearer [REDACTED]");
  assert.equal(turn?.completedAt === null, false);
  assert.equal(store.getThread("thread-close")?.eventLog[0]?.summary, "Socket closed Authorization: Bearer [REDACTED]");
  assert.equal(patches.some((patch) => patch.kind === "runtime-message" && patch.message.includes("[REDACTED]")), true);
  assert.equal(patches.some((patch) => patch.kind === "turn-lifecycle" && patch.status === "interrupted"), true);
  assert.doesNotMatch(JSON.stringify(patches), /codex-close-secret/);

  const reloaded = new ButlerStateStore(path.join(dir, "state.json"));
  await reloaded.load();
  assert.equal(reloaded.getThread("thread-close")?.turns[0]?.status, "interrupted");
  assert.equal(reloaded.getThread("thread-close")?.turns[0]?.error, "Socket closed Authorization: Bearer [REDACTED]");
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
