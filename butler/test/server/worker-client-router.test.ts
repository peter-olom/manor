import assert from "node:assert/strict";
import test from "node:test";

import {
  getUnifiedWorkerCompose,
  loadWorkerThread,
  startWorkerThread,
  updateUnifiedWorkerCompose
} from "../../src/server/worker-client-router.js";

function withEnv<T>(patch: Record<string, string | undefined>, fn: () => T): T {
  const previous = new Map<string, string | undefined>();
  for (const key of Object.keys(patch)) {
    previous.set(key, process.env[key]);
    if (patch[key] === undefined) delete process.env[key];
    else process.env[key] = patch[key];
  }
  try {
    return fn();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

async function withEnvAsync<T>(patch: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> {
  const previous = new Map<string, string | undefined>();
  for (const key of Object.keys(patch)) {
    previous.set(key, process.env[key]);
    if (patch[key] === undefined) delete process.env[key];
    else process.env[key] = patch[key];
  }
  try {
    return await fn();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function access(overrides: Record<string, unknown> = {}) {
  const codexUpdates: Array<{ model: string; effort: string | null }> = [];
  const piUpdates: Array<{ model: string; effort: string | null }> = [];
  const started: string[] = [];
  return {
    codexUpdates,
    piUpdates,
    started,
    access: {
      store: {
        getThread(threadId: string) {
          return threadId.startsWith("pi-") ? { id: threadId, source: "pi-rpc" } : { id: threadId, source: "codex" };
        },
        listThreads() {
          return [];
        }
      },
      codexClient: {
        getConnectionState() {
          return {
            compose: {
              model: "gpt-5-codex",
              effort: "medium",
              availableModels: [
                { id: "gpt-5-codex", label: "GPT-5 Codex", provider: null, supportedReasoningEfforts: ["low", "medium", "high"], defaultReasoningEffort: "medium" }
              ]
            }
          };
        },
        async updateComposeSettings(model: string, effort: string | null) {
          codexUpdates.push({ model, effort });
        },
        async startThread() {
          started.push("codex");
          return { threadId: "codex-thread", turnId: "turn-1" };
        },
        async loadThread() {}
      },
      piRpcWorkerClient: {
        getConnectionState() {
          return {
            compose: {
              provider: "ollama-cloud",
              model: "glm-5.2",
              effort: null,
              availableModels: [
                { id: "glm-5.2", label: "GLM 5.2", provider: "ollama-cloud", supportedReasoningEfforts: ["low", "medium", "high"], defaultReasoningEffort: "medium" }
              ]
            }
          };
        },
        async updateComposeSettings(model: string, effort: string | null) {
          piUpdates.push({ model, effort });
        },
        async startThread() {
          started.push("pi-rpc");
          return { threadId: "pi-thread", turnId: null };
        },
        async loadThread() {}
      },
      ...overrides
    } as never
  };
}

test("worker compose defaults to Pi RPC models when Pi runtime is forced", () => {
  const ctx = access();
  withEnv({ MANOR_WORKER_RUNTIME: "pi-rpc", MANOR_WORKER_MODEL: undefined }, () => {
    const compose = getUnifiedWorkerCompose(ctx.access);
    assert.equal(compose.runtime, "pi-rpc");
    assert.equal(compose.model, "ollama-cloud/glm-5.2");
    assert.equal(compose.provider, "ollama-cloud");
  });
});

test("provider-qualified Codex worker model selects unqualified Codex model", async () => {
  const ctx = access();
  await withEnvAsync({ MANOR_WORKER_RUNTIME: undefined, MANOR_WORKER_MODEL: undefined }, async () => {
    const updated = await updateUnifiedWorkerCompose(ctx.access, { model: "openai-codex/gpt-5-codex", effort: "high" as never });
    assert.equal(updated.runtime, "codex");
    assert.deepEqual(ctx.codexUpdates, [{ model: "gpt-5-codex", effort: "high" }]);
  });
});

test("startWorkerThread applies Ollama Cloud model before starting Pi RPC", async () => {
  const ctx = access();
  await withEnvAsync({ MANOR_WORKER_RUNTIME: undefined, MANOR_WORKER_MODEL: "ollama-cloud/glm-5.2" }, async () => {
    const result = await startWorkerThread(ctx.access, { task: "Use Ollama", runtime: "auto" });
    assert.equal(result.runtime, "pi-rpc");
    assert.deepEqual(ctx.piUpdates, [{ model: "ollama-cloud/glm-5.2", effort: "medium" }]);
    assert.deepEqual(ctx.started, ["pi-rpc"]);
  });
});

test("Pi RPC thread load fails clearly when Pi runtime is unavailable", async () => {
  const ctx = access({ piRpcWorkerClient: null });
  await assert.rejects(() => loadWorkerThread(ctx.access, "pi-thread"), /Pi RPC worker runtime is not available/);
});
