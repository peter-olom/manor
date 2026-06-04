import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { CodexAppServerClient } from "../../src/server/codex-client.js";
import { ButlerStateStore } from "../../src/server/state-store.js";
import type { ModelOption, ReasoningEffort } from "../../src/server/types.js";

async function createStore(prefix = "manor-reasoning-effort-test-"): Promise<{ store: ButlerStateStore; statePath: string; dir: string }> {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  const statePath = path.join(dir, "state.json");
  return { store: new ButlerStateStore(statePath), statePath, dir };
}

test("requested xhigh reasoning effort is persisted and restored on thread summary/detail/turns", async () => {
  const { store, statePath } = await createStore();
  const threadId = "thread-xhigh-persist";
  const turnId = "turn-xhigh-persist";

  store.upsertThreadSummary({
    id: threadId,
    status: "active",
    source: "appServer",
    cwd: "/workspace",
    turns: [{ id: turnId, status: "in_progress", items: [] }]
  });
  store.setThreadRequestedReasoningEffort(threadId, "xhigh", turnId);
  store.upsertThreadSummary({
    id: threadId,
    status: "idle",
    source: "appServer",
    cwd: "/workspace",
    turns: [{ id: turnId, status: "completed", items: [] }]
  });

  assert.equal(store.listThreads()[0]?.requestedReasoningEffort, "xhigh");
  assert.equal(store.getThreadDetail(threadId)?.requestedReasoningEffort, "xhigh");
  assert.equal(store.getThreadDetail(threadId)?.turns[0]?.requestedReasoningEffort, "xhigh");

  await store.flushSave();
  const restored = new ButlerStateStore(statePath);
  await restored.load();

  assert.equal(restored.listThreads()[0]?.requestedReasoningEffort, "xhigh");
  assert.equal(restored.getThreadDetail(threadId)?.requestedReasoningEffort, "xhigh");
  assert.equal(restored.getThreadDetail(threadId)?.turns[0]?.requestedReasoningEffort, "xhigh");
});

test("Codex startThread stores delegated xhigh effort locally and sends it in turn/start params", async () => {
  const { store, dir } = await createStore();
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  const client = new CodexAppServerClient("ws://127.0.0.1:1", store, dir, {
    onThreadCapabilityReady: async () => undefined
  }) as unknown as CodexAppServerClient & {
    call: (method: string, params: Record<string, unknown>) => Promise<Record<string, unknown>>;
  };
  const clientState = client as unknown as {
    availableModels: ModelOption[];
    selectedModel: string | null;
    selectedEffort: ReasoningEffort | null;
  };
  clientState.availableModels = [{
    id: "gpt-test",
    label: "GPT Test",
    provider: null,
    supportsReasoning: true,
    supportedReasoningEfforts: ["low", "medium", "high", "xhigh"],
    defaultReasoningEffort: "medium"
  }];
  clientState.selectedModel = "gpt-test";
  clientState.selectedEffort = "medium";

  client.call = async (method: string, params: Record<string, unknown>) => {
    calls.push({ method, params });
    if (method === "thread/start") {
      return {
        thread: {
          id: "thread-xhigh-start",
          status: "active",
          source: "appServer",
          cwd: dir,
          preview: "Delegated xhigh job"
        }
      };
    }
    if (method === "turn/start") {
      return { turn: { id: "turn-xhigh-start", status: "in_progress", items: [] } };
    }
    throw new Error(`unexpected call ${method}`);
  };

  const result = await client.startThread({
    task: "Run the delegated xhigh job.",
    cwd: dir,
    effort: "xhigh",
    openWindow: false
  });

  assert.equal(result.threadId, "thread-xhigh-start");
  const turnStart = calls.find((call) => call.method === "turn/start");
  assert.equal(turnStart?.params.effort, "xhigh");
  assert.equal(client.getConnectionState().compose.effort, "xhigh");
  assert.equal(store.getThreadDetail(result.threadId)?.requestedReasoningEffort, "xhigh");
  assert.equal(store.getThreadDetail(result.threadId)?.turns[0]?.requestedReasoningEffort, "xhigh");
});
