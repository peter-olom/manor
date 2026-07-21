import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { ButlerStateStore } from "../../src/server/state-store.js";
import {
  deleteWorkerThread,
  getUnifiedWorkerCompose,
  loadWorkerThread,
  resolveNewWorkerRuntime,
  resolveThreadWorkerRuntime,
  sendWorkerMessage,
  startWorkerThread,
  updateUnifiedWorkerCompose
} from "../../src/server/worker-client-router.js";
import type { ModelOption } from "../../src/server/types.js";

const openAiModel: ModelOption = {
  id: "gpt-5.6-codex",
  label: "GPT-5.6 Codex",
  provider: "openai-codex",
  supportsReasoning: true,
  supportedThinkingLevels: ["low", "medium", "high", "xhigh"],
  supportedReasoningEfforts: ["low", "medium", "high", "xhigh"],
  defaultReasoningEffort: "medium",
  inputCapabilities: { image: "supported", source: "provider" }
};

async function context() {
  const dir = await mkdtemp(path.join(tmpdir(), "manor-pi-only-router-"));
  const store = new ButlerStateStore(path.join(dir, "state.json"));
  const calls = { starts: 0, sends: 0, loads: 0, updates: 0, workspacePreparations: 0 };
  const piRpcWorkerClient = {
    getConnectionState: () => ({
      connected: true,
      lastError: null,
      compose: { provider: "openai-codex", model: openAiModel.id, effort: "medium", availableModels: [openAiModel] }
    }),
    updateComposeSettings: async () => { calls.updates += 1; },
    startThread: async (options: { cwd?: string | null; provider?: string | null; model?: string | null; effort?: string | null }) => {
      calls.starts += 1;
      store.upsertThreadSummary({ id: "pi-new", source: "pi-rpc", status: "active", cwd: options.cwd ?? "/workspace", modelId: options.model ?? null, turns: [] });
      return { threadId: "pi-new", turnId: "turn-new" };
    },
    loadThread: async () => { calls.loads += 1; },
    sendMessage: async (threadId: string) => { calls.sends += 1; return { threadId, turnId: "turn-followup" }; },
    getThreadModelOption: () => openAiModel,
    deleteThread: async (threadId: string) => store.removeThreadDurably(threadId),
    getLastRuntimeActivityAt: () => null
  };
  return { store, calls, access: { store, piRpcWorkerClient, prepareWorkerWorkspace: async () => { calls.workspacePreparations += 1; } } as never };
}

test("OpenAI subscription models are exposed through the single Pi Worker route", async () => {
  const { access } = await context();
  const compose = getUnifiedWorkerCompose(access);
  assert.equal(compose.runtime, "pi-rpc");
  assert.equal(compose.harness, "pi");
  assert.equal(compose.model, "openai-codex/gpt-5.6-codex");
  assert.equal(compose.availableModels.length, 1);
  assert.equal(compose.availableModels[0]?.provider, "openai-codex");
});

test("Worker runtime and harness are fixed to Pi", async () => {
  const { access } = await context();
  assert.equal(resolveNewWorkerRuntime(access, { runtime: "pi-rpc", harness: "pi" }), "pi-rpc");
  const updated = await updateUnifiedWorkerCompose(access, { runtime: "pi-rpc", harness: "pi", model: "openai-codex/gpt-5.6-codex", effort: "high" });
  assert.equal(updated.runtime, "pi-rpc");
  assert.equal(updated.harness, "pi");
});

test("new Worker jobs start and continue through Pi", async () => {
  const { access, calls } = await context();
  const started = await startWorkerThread(access, { task: "Inspect the project", cwd: "/workspace", model: "openai-codex/gpt-5.6-codex" });
  assert.equal(started.runtime, "pi-rpc");
  assert.equal(started.harness, "pi");
  assert.equal(calls.starts, 1);
  assert.equal(calls.workspacePreparations, 0);
  await loadWorkerThread(access, started.threadId);
  await sendWorkerMessage(access, started.threadId, "Continue");
  assert.equal(calls.loads, 1);
  assert.equal(calls.sends, 1);
});
