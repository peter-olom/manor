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
  const piStarts: Array<{ effort?: string | null }> = [];
  return {
    codexUpdates,
    piUpdates,
    started,
    piStarts,
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
                { id: "gpt-5-codex", label: "GPT-5 Codex", provider: null, supportsReasoning: true, supportedThinkingLevels: ["low", "medium", "high"], supportedReasoningEfforts: ["low", "medium", "high"], defaultReasoningEffort: "medium" }
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
                { id: "glm-5.2", label: "GLM 5.2", provider: "ollama-cloud", supportsReasoning: true, supportedThinkingLevels: ["high", "xhigh"], supportedReasoningEfforts: ["high", "xhigh"], defaultReasoningEffort: "high" }
              ]
            }
          };
        },
        async updateComposeSettings(model: string, effort: string | null) {
          piUpdates.push({ model, effort });
        },
        async startThread(options: { effort?: string | null }) {
          piStarts.push({ effort: options.effort ?? null });
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

test("worker compose resolves auto runtime from the selected Pi RPC model", () => {
  const ctx = access();
  withEnv({ MANOR_WORKER_RUNTIME: undefined, MANOR_WORKER_MODEL: "ollama-cloud/glm-5.2" }, () => {
    const compose = getUnifiedWorkerCompose(ctx.access);
    assert.equal(compose.runtime, "pi-rpc");
    assert.equal(compose.model, "ollama-cloud/glm-5.2");
  });
});

test("worker compose excludes OpenAI Codex models reported by Pi", () => {
  const ctx = access();
  (ctx.access as { piRpcWorkerClient: unknown }).piRpcWorkerClient = {
    getConnectionState() {
      return {
        compose: {
          provider: "openai-codex",
          model: "gpt-5.5",
          effort: null,
          availableModels: [
            { id: "gpt-5.5", label: "GPT-5.5", provider: "openai-codex", supportsReasoning: true, supportedThinkingLevels: ["low", "medium", "high"], supportedReasoningEfforts: ["low", "medium", "high"], defaultReasoningEffort: "medium" },
            { id: "glm-5.2", label: "GLM 5.2", provider: "ollama-cloud", supportsReasoning: true, supportedThinkingLevels: ["high", "xhigh"], supportedReasoningEfforts: ["high", "xhigh"], defaultReasoningEffort: "high" }
          ]
        }
      };
    },
    async updateComposeSettings(model: string, effort: string | null) {
      ctx.piUpdates.push({ model, effort });
    },
    async startThread(options: { effort?: string | null }) {
      ctx.piStarts.push({ effort: options.effort ?? null });
      ctx.started.push("pi-rpc");
      return { threadId: "pi-thread", turnId: null };
    },
    async loadThread() {}
  };
  withEnv({ MANOR_WORKER_RUNTIME: undefined, MANOR_WORKER_MODEL: undefined }, () => {
    const compose = getUnifiedWorkerCompose(ctx.access);
    assert.deepEqual(compose.availableModels.map((model) => model.id), ["gpt-5-codex", "ollama-cloud/glm-5.2"]);
  });
});

test("Codex worker model updates use app-server model ids", async () => {
  const ctx = access();
  await withEnvAsync({ MANOR_WORKER_RUNTIME: undefined, MANOR_WORKER_MODEL: undefined }, async () => {
    const updated = await updateUnifiedWorkerCompose(ctx.access, { model: "gpt-5-codex", effort: "high" as never });
    assert.equal(updated.runtime, "openai");
    assert.deepEqual(ctx.codexUpdates, [{ model: "gpt-5-codex", effort: "high" }]);
  });
});

test("worker compose trusts provider manifest for regular OpenAI GPT efforts", () => {
  const ctx = access({
    codexClient: {
      getConnectionState() {
        return {
          compose: {
            model: "gpt-5.5",
            effort: "xhigh",
            availableModels: [
              { id: "gpt-5.5", label: "GPT-5.5", provider: null, supportsReasoning: true, supportedThinkingLevels: ["minimal", "low", "medium", "high", "xhigh"], supportedReasoningEfforts: ["minimal", "low", "medium", "high", "xhigh"], defaultReasoningEffort: "xhigh" }
            ]
          }
        };
      },
      async updateComposeSettings(model: string, effort: string | null) {
        ctx.codexUpdates.push({ model, effort });
      },
      async startThread() {
        ctx.started.push("codex");
        return { threadId: "codex-thread", turnId: "turn-1" };
      },
      async loadThread() {}
    }
  });

  withEnv({ MANOR_WORKER_RUNTIME: "openai", MANOR_WORKER_MODEL: "gpt-5.5", MANOR_WORKER_EFFORT: undefined }, () => {
    const compose = getUnifiedWorkerCompose(ctx.access);
    assert.equal(compose.model, "gpt-5.5");
    assert.deepEqual(compose.availableEfforts, ["minimal", "low", "medium", "high", "xhigh"]);
    assert.equal(compose.effort, "xhigh");
    assert.deepEqual(compose.availableModels.map((model) => model.id), ["gpt-5.5"]);
    assert.deepEqual(compose.availableModels[0]?.supportedReasoningEfforts, ["minimal", "low", "medium", "high", "xhigh"]);
  });
});

test("worker compose effort updates honor forced Pi RPC runtime without a selected model", async () => {
  const ctx = access();
  await withEnvAsync({ MANOR_WORKER_RUNTIME: undefined, MANOR_WORKER_MODEL: undefined }, async () => {
    const updated = await updateUnifiedWorkerCompose(ctx.access, { effort: "high" as never, runtime: "pi-rpc" });
    assert.equal(updated.runtime, "pi-rpc");
    assert.deepEqual(ctx.piUpdates, [{ model: "ollama-cloud/glm-5.2", effort: "high" }]);
    assert.deepEqual(ctx.codexUpdates, []);
  });
});

test("worker compose ignores stale Codex model when Pi RPC runtime is forced", async () => {
  const ctx = access();
  await withEnvAsync({ MANOR_WORKER_RUNTIME: undefined, MANOR_WORKER_MODEL: undefined }, async () => {
    const compose = getUnifiedWorkerCompose(ctx.access, "gpt-5-codex", null, "pi-rpc");
    assert.equal(compose.runtime, "pi-rpc");
    assert.equal(compose.model, "ollama-cloud/glm-5.2");
    assert.deepEqual(compose.availableModels.map((model) => model.id), ["ollama-cloud/glm-5.2"]);
  });
});

test("worker compose ignores stale Pi RPC model when OpenAI runtime is forced", async () => {
  const ctx = access();
  await withEnvAsync({ MANOR_WORKER_RUNTIME: undefined, MANOR_WORKER_MODEL: undefined }, async () => {
    const compose = getUnifiedWorkerCompose(ctx.access, "ollama-cloud/glm-5.2", null, "openai");
    assert.equal(compose.runtime, "openai");
    assert.equal(compose.model, "gpt-5-codex");
    assert.deepEqual(compose.availableModels.map((model) => model.id), ["gpt-5-codex"]);
  });
});

test("worker compose model updates honor forced Pi RPC runtime with a stale Codex model", async () => {
  const ctx = access();
  await withEnvAsync({ MANOR_WORKER_RUNTIME: undefined, MANOR_WORKER_MODEL: undefined }, async () => {
    const updated = await updateUnifiedWorkerCompose(ctx.access, { model: "gpt-5-codex", effort: "high" as never, runtime: "pi-rpc" });
    assert.equal(updated.runtime, "pi-rpc");
    assert.equal(updated.model, "ollama-cloud/glm-5.2");
    assert.deepEqual(ctx.piUpdates, [{ model: "ollama-cloud/glm-5.2", effort: "high" }]);
    assert.deepEqual(ctx.codexUpdates, []);
  });
});

test("startWorkerThread applies Ollama Cloud model before starting Pi RPC", async () => {
  const ctx = access();
  await withEnvAsync({ MANOR_WORKER_RUNTIME: undefined, MANOR_WORKER_MODEL: "ollama-cloud/glm-5.2" }, async () => {
    const result = await startWorkerThread(ctx.access, { task: "Use Ollama", runtime: "auto" });
    assert.equal(result.runtime, "pi-rpc");
    assert.deepEqual(ctx.piUpdates, [{ model: "ollama-cloud/glm-5.2", effort: "high" }]);
    assert.deepEqual(ctx.piStarts, [{ effort: "high" }]);
    assert.deepEqual(ctx.started, ["pi-rpc"]);
  });
});

test("startWorkerThread sends manifest-supported xhigh for regular OpenAI GPT when requested", async () => {
  const ctx = access({
    codexClient: {
      getConnectionState() {
        return {
          compose: {
            model: "gpt-5.5",
            effort: "xhigh",
            availableModels: [
              { id: "gpt-5.5", label: "GPT-5.5", provider: null, supportsReasoning: true, supportedThinkingLevels: ["minimal", "low", "medium", "high", "xhigh"], supportedReasoningEfforts: ["minimal", "low", "medium", "high", "xhigh"], defaultReasoningEffort: "xhigh" }
            ]
          }
        };
      },
      async updateComposeSettings(model: string, effort: string | null) {
        ctx.codexUpdates.push({ model, effort });
      },
      async startThread(options: { effort?: string | null }) {
        ctx.piStarts.push({ effort: options.effort ?? null });
        ctx.started.push("codex");
        return { threadId: "codex-thread", turnId: "turn-1" };
      },
      async loadThread() {}
    }
  });

  await withEnvAsync({ MANOR_WORKER_RUNTIME: "openai", MANOR_WORKER_MODEL: "gpt-5.5", MANOR_WORKER_EFFORT: "xhigh" }, async () => {
    const result = await startWorkerThread(ctx.access, { task: "Use OpenAI", runtime: "openai" });
    assert.equal(result.runtime, "openai");
    assert.deepEqual(ctx.codexUpdates, [{ model: "gpt-5.5", effort: "xhigh" }]);
    assert.deepEqual(ctx.piStarts, [{ effort: "xhigh" }]);
    assert.deepEqual(ctx.started, ["codex"]);
  });
});

test("startWorkerThread applies forced Pi RPC default model and effort before starting", async () => {
  const ctx = access();
  await withEnvAsync({ MANOR_WORKER_RUNTIME: undefined, MANOR_WORKER_MODEL: undefined }, async () => {
    const result = await startWorkerThread(ctx.access, { task: "Use forced Pi", runtime: "pi-rpc" });
    assert.equal(result.runtime, "pi-rpc");
    assert.deepEqual(ctx.piUpdates, [{ model: "ollama-cloud/glm-5.2", effort: "high" }]);
    assert.deepEqual(ctx.piStarts, [{ effort: "high" }]);
    assert.deepEqual(ctx.codexUpdates, []);
    assert.deepEqual(ctx.started, ["pi-rpc"]);
  });
});

test("startWorkerThread preserves selected Pi RPC model when runtime is forced without explicit model", async () => {
  const ctx = access();
  (ctx.access as { piRpcWorkerClient: unknown }).piRpcWorkerClient = {
    getConnectionState() {
      return {
        compose: {
          provider: "ollama-cloud",
          model: "kimi-k2.6",
          effort: null,
          availableModels: [
            { id: "glm-5.2", label: "GLM 5.2", provider: "ollama-cloud", supportsReasoning: true, supportedThinkingLevels: ["high", "xhigh"], supportedReasoningEfforts: ["high", "xhigh"], defaultReasoningEffort: "high" },
            { id: "kimi-k2.6", label: "Kimi K2.6", provider: "ollama-cloud", supportsReasoning: true, supportedThinkingLevels: ["high", "xhigh"], supportedReasoningEfforts: ["high", "xhigh"], defaultReasoningEffort: "high" }
          ]
        }
      };
    },
    async updateComposeSettings(model: string, effort: string | null) {
      ctx.piUpdates.push({ model, effort });
    },
    async startThread(options: { effort?: string | null }) {
      ctx.piStarts.push({ effort: options.effort ?? null });
      ctx.started.push("pi-rpc");
      return { threadId: "pi-thread", turnId: null };
    },
    async loadThread() {}
  };
  await withEnvAsync({ MANOR_WORKER_RUNTIME: undefined, MANOR_WORKER_MODEL: undefined }, async () => {
    const result = await startWorkerThread(ctx.access, { task: "Use selected Pi", runtime: "pi-rpc" });
    assert.equal(result.runtime, "pi-rpc");
    assert.deepEqual(ctx.piUpdates, [{ model: "ollama-cloud/kimi-k2.6", effort: "high" }]);
    assert.deepEqual(ctx.piStarts, [{ effort: "high" }]);
    assert.deepEqual(ctx.codexUpdates, []);
    assert.deepEqual(ctx.started, ["pi-rpc"]);
  });
});

test("startWorkerThread resolves stale configured model against forced runtime before starting", async () => {
  const ctx = access();
  await withEnvAsync({ MANOR_WORKER_RUNTIME: "pi-rpc", MANOR_WORKER_MODEL: "gpt-5-codex" }, async () => {
    const result = await startWorkerThread(ctx.access, { task: "Use forced Pi runtime", runtime: "pi-rpc" });
    assert.equal(result.runtime, "pi-rpc");
    assert.deepEqual(ctx.piUpdates, [{ model: "ollama-cloud/glm-5.2", effort: "high" }]);
    assert.deepEqual(ctx.piStarts, [{ effort: "high" }]);
    assert.deepEqual(ctx.codexUpdates, []);
    assert.deepEqual(ctx.started, ["pi-rpc"]);
  });
});

test("Pi RPC thread load fails clearly when Pi runtime is unavailable", async () => {
  const ctx = access({ piRpcWorkerClient: null });
  await assert.rejects(() => loadWorkerThread(ctx.access, "pi-thread"), /Pi RPC worker runtime is not available/);
});
