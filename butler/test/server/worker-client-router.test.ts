import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  getUnifiedWorkerCompose,
  deleteAllWorkerThreads,
  deleteWorkerThread,
  loadWorkerThread,
  startWorkerThread,
  updateUnifiedWorkerCompose
} from "../../src/server/worker-client-router.js";
import { ButlerStateStore } from "../../src/server/state-store.js";
import { StaleWorkerOperationError } from "../../src/server/stale-worker-operation-error.js";
import { buildThreadExecutionContract } from "../../src/server/thread-contract.js";
import { runWithCallbackReviewGuard } from "../../src/server/butler-job-mutation-guard.js";

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
  const affinityRecords: Array<{ provider: string; model: string; effort?: string | null }> = [];
  return {
    codexUpdates,
    piUpdates,
    started,
    piStarts,
    affinityRecords,
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
      getCodexAuthStatus: () => ({ loggedIn: true }),
      recordSuccessfulWorkerSelection(selection: { provider: string; model: string; effort?: string | null }) {
        affinityRecords.push(selection);
      },
      ...overrides
    } as never
  };
}

test("worker compose defaults to Pi RPC models when Pi runtime is forced", () => {
  const ctx = access();
  withEnv({ MANOR_WORKER_MODEL: undefined }, () => {
    const compose = getUnifiedWorkerCompose(ctx.access, null, null, "pi-rpc");
    assert.equal(compose.runtime, "pi-rpc");
    assert.equal(compose.model, "ollama-cloud/glm-5.2");
    assert.equal(compose.provider, "ollama-cloud");
  });
});

test("worker compose resolves auto runtime from the selected Pi RPC model", () => {
  const ctx = access();
  withEnv({ MANOR_WORKER_MODEL: "ollama-cloud/glm-5.2" }, () => {
    const compose = getUnifiedWorkerCompose(ctx.access);
    assert.equal(compose.runtime, "pi-rpc");
    assert.equal(compose.model, "ollama-cloud/glm-5.2");
  });
});

test("successful worker affinity wins over the configured first-run default", () => {
  const ctx = access({
    getWorkerAffinity: () => ({
      hasSuccessfulDelegation: true,
      lastProvider: "ollama-cloud",
      modelByProvider: { "ollama-cloud": "ollama-cloud/glm-5.2" },
      effortByProvider: { "ollama-cloud": "xhigh" },
      updatedAt: 1
    })
  });
  withEnv({ MANOR_WORKER_MODEL: "gpt-5-codex" }, () => {
    const compose = getUnifiedWorkerCompose(ctx.access);
    assert.equal(compose.runtime, "pi-rpc");
    assert.equal(compose.model, "ollama-cloud/glm-5.2");
    assert.equal(compose.effort, "xhigh");
  });
});

test("worker affinity falls back through remembered providers before inventory order", () => {
  const ctx = access({
    getCodexAuthStatus: () => ({ loggedIn: false }),
    getWorkerAffinity: () => ({
      hasSuccessfulDelegation: true,
      lastProvider: "disconnected-provider",
      modelByProvider: { "opencode-go": "opencode-go/deepseek-v4-pro" },
      effortByProvider: { "opencode-go": "high" },
      updatedAt: 1
    }),
    piRpcWorkerClient: {
      getConnectionState: () => ({
        compose: {
          provider: "ollama-local",
          model: "qwen-tiny",
          effort: null,
          availableModels: [
            { id: "qwen-tiny", label: "Qwen Tiny", provider: "ollama-local", supportsReasoning: false, supportedThinkingLevels: [], supportedReasoningEfforts: [], defaultReasoningEffort: null },
            { id: "deepseek-v4-pro", label: "DeepSeek V4 Pro", provider: "opencode-go", supportsReasoning: true, supportedThinkingLevels: ["high"], supportedReasoningEfforts: ["high"], defaultReasoningEffort: "high" },
            { id: "glm-5.2", label: "GLM 5.2", provider: "ollama-cloud", supportsReasoning: true, supportedThinkingLevels: ["high"], supportedReasoningEfforts: ["high"], defaultReasoningEffort: "high" }
          ]
        }
      })
    }
  });
  withEnv({ MANOR_WORKER_MODEL: undefined }, () => {
    const compose = getUnifiedWorkerCompose(ctx.access);
    assert.equal(compose.model, "opencode-go/deepseek-v4-pro");
    assert.equal(compose.provider, "opencode-go");
  });
});

test("worker compose excludes unauthenticated Codex models and auto routes to Pi RPC", () => {
  const ctx = access({
    getCodexAuthStatus: () => ({ loggedIn: false })
  });
  withEnv({ MANOR_WORKER_MODEL: undefined }, () => {
    const compose = getUnifiedWorkerCompose(ctx.access);
    assert.equal(compose.runtime, "pi-rpc");
    assert.equal(compose.model, "ollama-cloud/glm-5.2");
    assert.equal(compose.provider, "ollama-cloud");
    assert.deepEqual(compose.availableModels.map((model) => model.id), ["ollama-cloud/glm-5.2"]);
  });
});

test("OPENAI_API_KEY enables the Codex Worker harness without a separate login file", () => {
  const ctx = access({ getCodexAuthStatus: () => ({ loggedIn: false }) });
  withEnv({ OPENAI_API_KEY: "test-key", MANOR_WORKER_MODEL: undefined }, () => {
    const compose = getUnifiedWorkerCompose(ctx.access);
    assert.equal(compose.runtime, "openai");
    assert.equal(compose.model, "gpt-5-codex");
  });
});

test("worker compose does not trust Codex when auth status is unavailable", () => {
  const ctx = access({ getCodexAuthStatus: undefined });
  withEnv({ MANOR_WORKER_MODEL: undefined }, () => {
    const compose = getUnifiedWorkerCompose(ctx.access);
    assert.equal(compose.runtime, "pi-rpc");
    assert.deepEqual(compose.availableModels.map((model) => model.id), ["ollama-cloud/glm-5.2"]);
  });
});

test("empty authenticated inventory stays readable and start errors include remediation", async () => {
  const ctx = access({
    getCodexAuthStatus: () => ({ loggedIn: false }),
    piRpcWorkerClient: {
      getConnectionState: () => ({ compose: { provider: null, model: null, effort: null, availableModels: [] } })
    }
  });
  await withEnvAsync({ MANOR_WORKER_MODEL: undefined }, async () => {
    const compose = getUnifiedWorkerCompose(ctx.access);
    assert.equal(compose.runtime, "auto");
    assert.deepEqual(compose.availableModels, []);
    await assert.rejects(
      () => startWorkerThread(ctx.access, { task: "Needs a worker", runtime: "auto" }),
      /Open Settings.*Providers/
    );
  });
});

test("forced Codex runtime rejects unauthenticated Worker use with remediation", async () => {
  const ctx = access({
    getCodexAuthStatus: () => ({ loggedIn: false })
  });
  await assert.rejects(
    () => startWorkerThread(ctx.access, { task: "Use Codex", runtime: "openai" }),
    /Open Settings.*OpenAI \/ Codex and sign in/
  );
  assert.deepEqual(ctx.started, []);
});

test("expired provider credentials surface a settings remediation message", async () => {
  const ctx = access({
    codexClient: {
      getConnectionState() {
        return { compose: { model: "gpt-5-codex", effort: "medium", availableModels: [{ id: "gpt-5-codex", label: "GPT-5 Codex", provider: null, supportsReasoning: true, supportedThinkingLevels: ["medium"], supportedReasoningEfforts: ["medium"], defaultReasoningEffort: "medium" }] } };
      },
      async updateComposeSettings() {},
      async startThread() { throw new Error("401 Unauthorized: token expired"); }
    }
  });
  await assert.rejects(
    () => startWorkerThread(ctx.access, { task: "Use Codex", runtime: "auto" }),
    /Open Settings.*Providers.*authentication/
  );
});

test("a stale initial Worker start rejects without recording provider affinity", async () => {
  const ctx = access({
    codexClient: {
      getConnectionState() {
        return { compose: { model: "gpt-5-codex", effort: "medium", availableModels: [{ id: "gpt-5-codex", label: "GPT-5 Codex", provider: null, supportsReasoning: true, supportedThinkingLevels: ["medium"], supportedReasoningEfforts: ["medium"], defaultReasoningEffort: "medium" }] } };
      },
      async updateComposeSettings() {},
      async startThread() { throw new StaleWorkerOperationError("phantom-thread"); }
    }
  });

  await assert.rejects(
    () => startWorkerThread(ctx.access, { task: "Never dispatched", runtime: "openai" }),
    StaleWorkerOperationError
  );
  assert.deepEqual(ctx.affinityRecords, []);
});

test("worker compose uses Codex first when Codex is authenticated and no default is configured", () => {
  const ctx = access();
  withEnv({ MANOR_WORKER_MODEL: undefined }, () => {
    const compose = getUnifiedWorkerCompose(ctx.access);
    assert.equal(compose.runtime, "openai");
    assert.equal(compose.model, "gpt-5-codex");
    assert.deepEqual(compose.availableModels.map((model) => model.id), ["gpt-5-codex", "ollama-cloud/glm-5.2"]);
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
  withEnv({ MANOR_WORKER_MODEL: undefined }, () => {
    const compose = getUnifiedWorkerCompose(ctx.access);
    assert.deepEqual(compose.availableModels.map((model) => model.id), ["gpt-5-codex", "ollama-cloud/glm-5.2"]);
  });
});

test("Codex worker model updates use app-server model ids", async () => {
  const ctx = access();
  await withEnvAsync({ MANOR_WORKER_MODEL: undefined }, async () => {
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

  withEnv({ MANOR_WORKER_MODEL: "gpt-5.5", MANOR_WORKER_EFFORT: undefined }, () => {
    const compose = getUnifiedWorkerCompose(ctx.access);
    assert.equal(compose.model, "gpt-5.5");
    assert.deepEqual(compose.availableEfforts, ["minimal", "low", "medium", "high", "xhigh"]);
    assert.equal(compose.effort, "xhigh");
    assert.deepEqual(compose.availableModels.map((model) => model.id), ["gpt-5.5", "ollama-cloud/glm-5.2"]);
    assert.deepEqual(compose.availableModels.find((model) => model.id === "gpt-5.5")?.supportedReasoningEfforts, ["minimal", "low", "medium", "high", "xhigh"]);
  });
});

test("worker compose effort updates honor forced Pi RPC runtime without a selected model", async () => {
  const ctx = access();
  await withEnvAsync({ MANOR_WORKER_MODEL: undefined }, async () => {
    const updated = await updateUnifiedWorkerCompose(ctx.access, { effort: "high" as never, runtime: "pi-rpc" });
    assert.equal(updated.runtime, "pi-rpc");
    assert.deepEqual(ctx.piUpdates, [{ model: "ollama-cloud/glm-5.2", effort: "high" }]);
    assert.deepEqual(ctx.codexUpdates, []);
  });
});

test("worker compose ignores stale Codex model when Pi RPC runtime is forced", async () => {
  const ctx = access();
  await withEnvAsync({ MANOR_WORKER_MODEL: undefined }, async () => {
    const compose = getUnifiedWorkerCompose(ctx.access, "gpt-5-codex", null, "pi-rpc");
    assert.equal(compose.runtime, "pi-rpc");
    assert.equal(compose.model, "ollama-cloud/glm-5.2");
    assert.deepEqual(compose.availableModels.map((model) => model.id), ["ollama-cloud/glm-5.2"]);
  });
});

test("worker compose ignores stale Pi RPC model when OpenAI runtime is forced", async () => {
  const ctx = access();
  await withEnvAsync({ MANOR_WORKER_MODEL: undefined }, async () => {
    const compose = getUnifiedWorkerCompose(ctx.access, "ollama-cloud/glm-5.2", null, "openai");
    assert.equal(compose.runtime, "openai");
    assert.equal(compose.model, "gpt-5-codex");
    assert.deepEqual(compose.availableModels.map((model) => model.id), ["gpt-5-codex"]);
  });
});

test("worker compose model updates honor forced Pi RPC runtime with a stale Codex model", async () => {
  const ctx = access();
  await withEnvAsync({ MANOR_WORKER_MODEL: undefined }, async () => {
    const updated = await updateUnifiedWorkerCompose(ctx.access, { model: "gpt-5-codex", effort: "high" as never, runtime: "pi-rpc" });
    assert.equal(updated.runtime, "pi-rpc");
    assert.equal(updated.model, "ollama-cloud/glm-5.2");
    assert.deepEqual(ctx.piUpdates, [{ model: "ollama-cloud/glm-5.2", effort: "high" }]);
    assert.deepEqual(ctx.codexUpdates, []);
  });
});

test("startWorkerThread applies Ollama Cloud model before starting Pi RPC", async () => {
  const ctx = access();
  await withEnvAsync({ MANOR_WORKER_MODEL: "ollama-cloud/glm-5.2" }, async () => {
    const result = await startWorkerThread(ctx.access, { task: "Use Ollama", runtime: "auto" });
    assert.deepEqual(result, {
      threadId: "pi-thread",
      turnId: null,
      runtime: "pi-rpc",
      provider: "ollama-cloud",
      model: "ollama-cloud/glm-5.2",
      effort: "high"
    });
    assert.deepEqual(ctx.piUpdates, [{ model: "ollama-cloud/glm-5.2", effort: "high" }]);
    assert.deepEqual(ctx.piStarts, [{ effort: "high" }]);
    assert.deepEqual(ctx.started, ["pi-rpc"]);
    assert.deepEqual(ctx.affinityRecords, [{ provider: "ollama-cloud", model: "ollama-cloud/glm-5.2", effort: "high" }]);
  });
});

test("startWorkerThread auto routes around unauthenticated Codex and reports the actual selection", async () => {
  const ctx = access({
    getCodexAuthStatus: () => ({ loggedIn: false })
  });
  await withEnvAsync({ MANOR_WORKER_MODEL: undefined }, async () => {
    const result = await startWorkerThread(ctx.access, { task: "Use an authenticated worker", runtime: "auto" });
    assert.deepEqual(result, {
      threadId: "pi-thread",
      turnId: null,
      runtime: "pi-rpc",
      provider: "ollama-cloud",
      model: "ollama-cloud/glm-5.2",
      effort: "high"
    });
    assert.deepEqual(ctx.codexUpdates, []);
    assert.deepEqual(ctx.piUpdates, [{ model: "ollama-cloud/glm-5.2", effort: "high" }]);
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

  await withEnvAsync({ MANOR_WORKER_MODEL: "gpt-5.5", MANOR_WORKER_EFFORT: "xhigh" }, async () => {
    const result = await startWorkerThread(ctx.access, { task: "Use OpenAI", runtime: "openai" });
    assert.deepEqual(result, {
      threadId: "codex-thread",
      turnId: "turn-1",
      runtime: "openai",
      provider: "openai-codex",
      model: "gpt-5.5",
      effort: "xhigh"
    });
    assert.deepEqual(ctx.codexUpdates, [{ model: "gpt-5.5", effort: "xhigh" }]);
    assert.deepEqual(ctx.piStarts, [{ effort: "xhigh" }]);
    assert.deepEqual(ctx.started, ["codex"]);
  });
});

test("startWorkerThread applies forced Pi RPC default model and effort before starting", async () => {
  const ctx = access();
  await withEnvAsync({ MANOR_WORKER_MODEL: undefined }, async () => {
    const result = await startWorkerThread(ctx.access, { task: "Use forced Pi", runtime: "pi-rpc" });
    assert.equal(result.runtime, "pi-rpc");
    assert.deepEqual(ctx.piUpdates, [{ model: "ollama-cloud/glm-5.2", effort: "high" }]);
    assert.deepEqual(ctx.piStarts, [{ effort: "high" }]);
    assert.deepEqual(ctx.codexUpdates, []);
    assert.deepEqual(ctx.started, ["pi-rpc"]);
  });
});

test("startWorkerThread uses the provider default on first forced Pi RPC use", async () => {
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
  await withEnvAsync({ MANOR_WORKER_MODEL: undefined }, async () => {
    const result = await startWorkerThread(ctx.access, { task: "Use selected Pi", runtime: "pi-rpc" });
    assert.equal(result.runtime, "pi-rpc");
    assert.deepEqual(ctx.piUpdates, [{ model: "ollama-cloud/glm-5.2", effort: "high" }]);
    assert.deepEqual(ctx.piStarts, [{ effort: "high" }]);
    assert.deepEqual(ctx.codexUpdates, []);
    assert.deepEqual(ctx.started, ["pi-rpc"]);
  });
});

test("startWorkerThread resolves stale configured model against forced runtime before starting", async () => {
  const ctx = access();
  await withEnvAsync({ MANOR_WORKER_MODEL: "gpt-5-codex" }, async () => {
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

test("a superseded Codex load invalidates the late concrete operation", async () => {
  let current = true;
  let invalidations = 0;
  const loading = runWithCallbackReviewGuard({ threadId: "codex-load", isCurrent: () => current }, () => loadWorkerThread({
    store: { getThread: () => ({ id: "codex-load", source: "appServer" }) },
    codexClient: {
      loadThread: async () => new Promise<void>(() => undefined),
      invalidateThreadOperations: () => { invalidations += 1; }
    }
  } as never, "codex-load"));
  current = false;
  await assert.rejects(loading, /superseded/);
  assert.equal(invalidations, 1);
});

test("deleted Worker attribution is retained only for overlapping shared-checkout work", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "manor-worker-delete-attribution-"));
  const store = new ButlerStateStore(path.join(dir, "state.json"));
  const addThread = (threadId: string, createdAt: number, updatedAt: number, changedPath: string) => {
    store.upsertThreadSummary({ id: threadId, source: "appServer", status: { type: "idle" }, cwd: "/workspace", turns: [{ id: `turn-${threadId}`, status: "completed", items: [{ id: `change-${threadId}`, type: "fileChange", text: `changed ${changedPath}` }] }] });
    store.setThreadExecutionContract(threadId, { ...buildThreadExecutionContract({ threadId, workspaceCwd: "/workspace", projectId: "project", projectLabel: "Project", branch: null, taskText: "Change a file.", taskCategory: "generic_code", inferredWorkDepth: "standard", notes: [] }), reviewBaselineCwd: "/workspace" });
    Object.assign(store.getThread(threadId)!, { createdAt, updatedAt });
    Object.assign(store.getThread(threadId)!.turns[0]!, { startedAt: createdAt, completedAt: updatedAt });
  };
  addThread("overlap-a", 1_000, 3_000, "a.ts");
  addThread("overlap-b", 2_000, 4_000, "b.ts");
  addThread("historic", 100, 500, "historic.ts");
  store.getThread("overlap-a")!.turns[0]!.items.push(
    { id: "large-change", type: "fileChange", status: "completed", text: `diff --git a/huge.ts b/huge.ts\n${"x".repeat(20_000)}`, at: 2_000, raw: {} },
    { id: "last-change", type: "fileChange", status: "completed", text: "updated nested/last.ts", at: 2_500, raw: {} }
  );

  const access = {
    store,
    codexClient: {
      async deleteThread(threadId: string) { store.removeThread(threadId); return { deletedArtifacts: 0 }; }
    }
  } as never;
  await deleteWorkerThread(access, "overlap-a");
  const peerPaths = store.getThread("overlap-b")?.executionContract?.reviewPeerContexts?.flatMap((entry) => entry.paths) ?? [];
  assert.ok(peerPaths.includes("a.ts"));
  assert.ok(peerPaths.includes("huge.ts"));
  assert.ok(peerPaths.includes("nested/last.ts"));
  for (let index = 0; index < 100; index += 1) store.addEvent("overlap-b", "runtime.noise", `Noise ${index}`);
  assert.equal(store.getThread("overlap-b")?.eventLog.some((event) => event.method === "butler.review.deleted_peer_context"), false);
  assert.ok(store.getThread("overlap-b")?.executionContract?.reviewPeerContexts?.[0]?.paths.includes("nested/last.ts"));

  addThread("later", 2_000, 3_000, "later.ts");
  await deleteWorkerThread(access, "historic");
  assert.equal(store.getThread("later")?.eventLog.some((event) => event.method === "butler.review.deleted_peer_context"), false);
});

test("deleting an overlapping Worker with unknown paths preserves a blocking tombstone", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "manor-worker-delete-unknown-attribution-"));
  const store = new ButlerStateStore(path.join(dir, "state.json"));
  for (const threadId of ["unknown-peer", "survivor"]) {
    store.upsertThreadSummary({ id: threadId, source: "appServer", status: "idle", cwd: "/workspace", turns: [{ id: `turn-${threadId}`, status: "completed", items: [] }] });
    store.setThreadExecutionContract(threadId, { ...buildThreadExecutionContract({ threadId, workspaceCwd: "/workspace", projectId: "project", projectLabel: "Project", branch: null, taskText: "Change shared files.", taskCategory: "generic_code", inferredWorkDepth: "standard", notes: [] }), reviewBaselineCwd: "/workspace", reviewBaselineTreeSha: "a".repeat(40) });
    Object.assign(store.getThread(threadId)!, { createdAt: 1_000, updatedAt: 3_000 });
    Object.assign(store.getThread(threadId)!.turns[0]!, { startedAt: 1_000, completedAt: 3_000 });
  }
  const access = {
    store,
    codexClient: { async deleteThread(threadId: string) { store.removeThread(threadId); return { deletedArtifacts: 0 }; } }
  } as never;

  await deleteWorkerThread(access, "unknown-peer");

  const tombstone = store.getThread("survivor")?.executionContract?.reviewPeerContexts?.find((entry) => entry.sourceThreadId === "unknown-peer");
  assert.deepEqual(tombstone?.paths, []);
  assert.equal(tombstone?.attributionUnknown, true);
});

test("peer attribution is durable before provider deletion removes the Worker", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "manor-worker-delete-attribution-order-"));
  const statePath = path.join(dir, "state.json");
  const store = new ButlerStateStore(statePath);
  for (const threadId of ["deleting-peer", "reviewing-survivor"]) {
    store.upsertThreadSummary({ id: threadId, source: "appServer", status: "idle", cwd: "/workspace", turns: [{ id: `turn-${threadId}`, status: "completed", items: threadId === "deleting-peer" ? [{ id: "change", type: "fileChange", text: "changed peer.ts" }] : [] }] });
    store.setThreadExecutionContract(threadId, { ...buildThreadExecutionContract({ threadId, workspaceCwd: "/workspace", projectId: "project", projectLabel: "Project", branch: null, taskText: "Change shared files.", taskCategory: "generic_code", inferredWorkDepth: "standard", notes: [] }), reviewBaselineCwd: "/workspace", reviewBaselineTreeSha: "b".repeat(40) });
    Object.assign(store.getThread(threadId)!, { createdAt: 1_000, updatedAt: 3_000 });
    Object.assign(store.getThread(threadId)!.turns[0]!, { startedAt: 1_000, completedAt: 3_000 });
  }
  let releaseProvider!: () => void;
  let providerStarted!: () => void;
  const started = new Promise<void>((resolve) => { providerStarted = resolve; });
  const release = new Promise<void>((resolve) => { releaseProvider = resolve; });
  const deleting = deleteWorkerThread({
    store,
    codexClient: {
      async deleteThread(threadId: string) {
        providerStarted();
        await release;
        store.removeThread(threadId);
        return { deletedArtifacts: 0 };
      }
    }
  } as never, "deleting-peer");

  await started;
  try {
    assert.ok(store.getThread("reviewing-survivor")?.executionContract?.reviewPeerContexts?.some((entry) => entry.sourceThreadId === "deleting-peer" && entry.paths.includes("peer.ts")));
    const restored = new ButlerStateStore(statePath);
    await restored.load();
    assert.ok(restored.getThread("reviewing-survivor")?.executionContract?.reviewPeerContexts?.some((entry) => entry.sourceThreadId === "deleting-peer" && entry.paths.includes("peer.ts")));
  } finally {
    releaseProvider();
  }
  await deleting;
});

test("baseline-less deleted Workers leave unknown ownership in their execution workspace", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "manor-worker-delete-baseline-less-"));
  const store = new ButlerStateStore(path.join(dir, "state.json"));
  for (const threadId of ["baseline-less", "baseline-survivor"]) {
    store.upsertThreadSummary({ id: threadId, source: "appServer", status: "idle", cwd: "/workspace", turns: [{ id: `turn-${threadId}`, status: "completed", items: [] }] });
    store.setThreadExecutionContract(threadId, { ...buildThreadExecutionContract({ threadId, workspaceCwd: "/workspace", projectId: "project", projectLabel: "Project", branch: null, taskText: "Change shared files.", taskCategory: "generic_code", inferredWorkDepth: "standard", notes: [] }), ...(threadId === "baseline-survivor" ? { reviewBaselineCwd: "/workspace", reviewBaselineTreeSha: "c".repeat(40) } : { reviewBaselineCaptureFailed: true }) });
    Object.assign(store.getThread(threadId)!, { createdAt: 1_000, updatedAt: 3_000 });
    Object.assign(store.getThread(threadId)!.turns[0]!, { startedAt: 1_000, completedAt: 3_000 });
  }

  await deleteWorkerThread({ store, codexClient: { async deleteThread(threadId: string) { store.removeThread(threadId); return { deletedArtifacts: 0 }; } } } as never, "baseline-less");

  const tombstone = store.getThread("baseline-survivor")?.executionContract?.reviewPeerContexts?.find((entry) => entry.sourceThreadId === "baseline-less");
  assert.equal(tombstone?.attributionUnknown, true);
});

test("deleted repo-bootstrap Workers block attribution in descendant cloned repositories", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "manor-worker-delete-bootstrap-"));
  const store = new ButlerStateStore(path.join(dir, "state.json"));
  store.upsertThreadSummary({ id: "bootstrap-worker", source: "appServer", status: "idle", cwd: "/repos", turns: [{ id: "turn-bootstrap", status: "completed", items: [] }] });
  store.setThreadExecutionContract("bootstrap-worker", buildThreadExecutionContract({ threadId: "bootstrap-worker", workspaceCwd: "/repos", projectId: "repos", projectLabel: "Repos", branch: null, taskText: "Clone and change foo.", taskCategory: "generic_code", inferredWorkDepth: "standard", notes: [] }));
  store.upsertThreadSummary({ id: "cloned-repo-survivor", source: "appServer", status: "idle", cwd: "/repos/foo", turns: [{ id: "turn-survivor", status: "completed", items: [] }] });
  store.setThreadExecutionContract("cloned-repo-survivor", { ...buildThreadExecutionContract({ threadId: "cloned-repo-survivor", workspaceCwd: "/repos/foo", projectId: "foo", projectLabel: "Foo", branch: null, taskText: "Change foo.", taskCategory: "generic_code", inferredWorkDepth: "standard", notes: [] }), reviewBaselineCwd: "/repos/foo", reviewBaselineTreeSha: "d".repeat(40) });
  for (const threadId of ["bootstrap-worker", "cloned-repo-survivor"]) {
    Object.assign(store.getThread(threadId)!, { createdAt: 1_000, updatedAt: 3_000 });
    Object.assign(store.getThread(threadId)!.turns[0]!, { startedAt: 1_000, completedAt: 3_000 });
  }

  await deleteWorkerThread({ store, codexClient: { async deleteThread(threadId: string) { store.removeThread(threadId); return { deletedArtifacts: 0 }; } } } as never, "bootstrap-worker");

  const tombstone = store.getThread("cloned-repo-survivor")?.executionContract?.reviewPeerContexts?.find((entry) => entry.sourceThreadId === "bootstrap-worker");
  assert.equal(tombstone?.attributionUnknown, true);
});

test("failed Pi Worker deletion keeps both the thread and Butler attribution unchanged", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "manor-worker-delete-failure-"));
  const store = new ButlerStateStore(path.join(dir, "state.json"));
  store.upsertThreadSummary({ id: "pi-failed", source: "pi-rpc", status: { type: "idle" }, cwd: "/workspace", turns: [] });
  store.setThreadExecutionContract("pi-failed", { ...buildThreadExecutionContract({ threadId: "pi-failed", workspaceCwd: "/workspace", projectId: "project", projectLabel: "Project", branch: null, taskText: "Work", taskCategory: "generic_code", inferredWorkDepth: "standard", notes: [] }), reviewBaselineCwd: "/workspace" });
  await assert.rejects(() => deleteWorkerThread({
    store,
    codexClient: {},
    piRpcWorkerClient: { deleteThread: async () => false }
  } as never, "pi-failed"), /could not be deleted/);
  assert.ok(store.getThread("pi-failed"));
});

test("peer attribution overflow is explicit instead of silently producing a clean review", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "manor-worker-peer-overflow-"));
  const store = new ButlerStateStore(path.join(dir, "state.json"));
  const threadId = "survivor";
  store.upsertThreadSummary({ id: threadId, source: "appServer", status: "idle", cwd: "/workspace", turns: [] });
  store.setThreadExecutionContract(threadId, buildThreadExecutionContract({ threadId, workspaceCwd: "/workspace", projectId: "project", projectLabel: "Project", branch: null, taskText: "Work", taskCategory: "generic_code", inferredWorkDepth: "standard", notes: [] }));
  for (let index = 0; index < 33; index += 1) {
    store.recordWorkerReviewPeerContext(threadId, { sourceThreadId: `deleted-${index}`, baselineTreeSha: "f".repeat(40), paths: [`file-${index}.ts`], recordedAt: index });
  }
  assert.equal(store.getThread(threadId)?.executionContract?.reviewPeerContexts?.length, 32);
  assert.equal(store.getThread(threadId)?.executionContract?.reviewPeerContextOverflow, true);
});

test("Codex deletion persistence failures surface even after local thread removal", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "manor-worker-delete-persist-failure-"));
  try {
    const store = new ButlerStateStore(path.join(dir, "state.json"));
    const threadId = "codex-persist-failure";
    store.upsertThreadSummary({ id: threadId, source: "appServer", status: "idle", cwd: "/workspace", turns: [] });

    await assert.rejects(() => deleteWorkerThread({
      store,
      codexClient: {
        deleteThread: async () => {
          store.removeThread(threadId);
          return { deletedArtifacts: 0, cleanupFailed: true, cleanupError: "tombstone save failed" };
        }
      }
    } as never, threadId, { waitForCleanup: true }), /tombstone save failed/);
    assert.equal(store.getThread(threadId), undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("partial bulk deletion cleans only baselines for Workers actually removed", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "manor-worker-delete-all-partial-"));
  try {
    const store = new ButlerStateStore(path.join(dir, "state.json"));
    const objectDirs = new Map<string, string>();
    for (const threadId of ["pi-a", "pi-b"]) {
      const objectDir = path.join(dir, `baseline-${threadId}`, "objects");
      await mkdir(objectDir, { recursive: true });
      objectDirs.set(threadId, objectDir);
      store.upsertThreadSummary({ id: threadId, source: "pi-rpc", status: "idle", cwd: "/workspace", turns: [{ id: `turn-${threadId}`, status: "completed", items: [{ id: `change-${threadId}`, type: "fileChange", text: `changed ${threadId}.ts` }] }] });
      store.setThreadExecutionContract(threadId, {
        ...buildThreadExecutionContract({ threadId, workspaceCwd: "/workspace", projectId: "project", projectLabel: "Project", branch: null, taskText: "Work", taskCategory: "generic_code", inferredWorkDepth: "standard", notes: [] }),
        reviewBaselineCwd: "/workspace",
        reviewBaselineObjectDir: objectDir
      });
      Object.assign(store.getThread(threadId)!, { createdAt: 1_000, updatedAt: 3_000 });
      Object.assign(store.getThread(threadId)!.turns[0]!, { startedAt: 1_000, completedAt: 3_000 });
    }

    const deleteCalls: string[] = [];
    await assert.rejects(() => deleteAllWorkerThreads({
      store,
      codexClient: { deleteAllThreads: async () => { throw new Error("Codex deletion should not run"); } },
      piRpcWorkerClient: {
        deleteThread: async (threadId: string) => {
          deleteCalls.push(threadId);
          if (deleteCalls.length === 1) {
            store.removeThread(threadId);
            return true;
          }
          return false;
        }
      }
    } as never), /could not be deleted/);

    const [deletedId, failedId] = deleteCalls;
    assert.ok(deletedId && failedId);
    assert.equal(store.getThread(deletedId), undefined);
    assert.ok(store.getThread(failedId));
    const retainedPeer = store.getThread(failedId)?.executionContract?.reviewPeerContexts?.find((entry) => entry.sourceThreadId === deletedId);
    assert.ok(retainedPeer?.paths.includes(`${deletedId}.ts`));
    await assert.rejects(() => stat(objectDirs.get(deletedId)!), /ENOENT/);
    assert.ok(await stat(objectDirs.get(failedId)!));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
