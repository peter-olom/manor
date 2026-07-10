import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { CodexAppServerClient } from "../../src/server/codex-client.js";
import { displayThinkingLevelForModelOption, displayThinkingLevelForPiLevel, piThinkingLevelForButlerLevel, piThinkingLevelForEffort, piThinkingLevelForModelOption } from "../../src/server/pi-thinking-levels.js";
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

test("Pi RPC unsupported efforts are mapped to closest pi thinking level", () => {
  assert.equal(piThinkingLevelForEffort("minimal"), "low");
  assert.equal(piThinkingLevelForEffort("none"), "low");
  assert.equal(piThinkingLevelForEffort("max"), "xhigh");
  assert.equal(piThinkingLevelForEffort("high"), "high");
});

test("Pi session thinking translation preserves provider-facing max display", () => {
  assert.equal(piThinkingLevelForButlerLevel("max"), "xhigh");
  assert.equal(piThinkingLevelForButlerLevel("none"), "off");
  assert.equal(displayThinkingLevelForPiLevel("xhigh", ["high", "max"]), "max");
  assert.equal(displayThinkingLevelForPiLevel("xhigh", ["high", "xhigh"]), "xhigh");
});

test("Pi session thinking translation preserves provider-native variants", () => {
  const model: ModelOption = {
    id: "minimax-m3",
    label: "MiniMax M3",
    provider: "opencode-go",
    supportsReasoning: true,
    supportedThinkingLevels: ["default", "none", "thinking"],
    supportedReasoningEfforts: [],
    defaultReasoningEffort: null,
    thinkingLevelTransports: { default: "off", none: "minimal", thinking: "xhigh" }
  };
  assert.equal(piThinkingLevelForModelOption("default", model), "off");
  assert.equal(piThinkingLevelForModelOption("none", model), "minimal");
  assert.equal(piThinkingLevelForModelOption("thinking", model), "xhigh");
  assert.equal(displayThinkingLevelForModelOption("off", model), "default");
  assert.equal(displayThinkingLevelForModelOption("minimal", model), "none");
  assert.equal(displayThinkingLevelForModelOption("xhigh", model), "thinking");
});

test("Codex model loading trusts selectable app-server models and accepts string efforts", async () => {
  const { store, dir } = await createStore("manor-codex-model-list-test-");
  const client = new CodexAppServerClient("ws://127.0.0.1:1", store, dir, {
    onThreadCapabilityReady: async () => undefined
  });
  const clientState = client as unknown as {
    availableModels: ModelOption[];
    selectedModel: string | null;
    selectedEffort: ReasoningEffort | null;
    loadModels: () => Promise<void>;
    codexProviderAdapter: {
      listModels: (params: Record<string, unknown>) => Promise<{ data: Record<string, unknown>[]; nextCursor: string | null }>;
    };
  };
  clientState.selectedModel = null;
  clientState.selectedEffort = "xhigh";
  clientState.codexProviderAdapter = {
    listModels: async () => ({
      data: [
        {
          id: "gpt-5.3-codex-spark",
          displayName: "GPT-5.3 Codex Spark",
          supportedReasoningEfforts: ["high", { reasoningEffort: "xhigh" }],
          defaultReasoningEffort: "high"
        },
        { id: "gpt-5.3-codex", displayName: "GPT-5.3 Codex", supportedReasoningEfforts: ["low", "medium", "high", "xhigh"] },
        { id: "gpt-5.3", displayName: "GPT-5.3", supportedReasoningEfforts: ["low", "medium", "high"] },
        { id: "gpt-5.2", displayName: "GPT-5.2", supportedReasoningEfforts: ["low", "medium", "high"] },
        { id: "gpt-5.3-disabled", displayName: "GPT-5.3 Disabled", disabled: true, supportedReasoningEfforts: ["low", "medium", "high"] }
      ],
      nextCursor: null
    })
  };

  await clientState.loadModels();

  assert.deepEqual(clientState.availableModels.map((model) => model.id), [
    "gpt-5.3-codex-spark",
    "gpt-5.3-codex",
    "gpt-5.3",
    "gpt-5.2"
  ]);
  assert.deepEqual(clientState.availableModels[0]?.supportedReasoningEfforts, ["high", "xhigh"]);
  assert.equal(clientState.selectedModel, "gpt-5.3-codex-spark");
  assert.equal(clientState.selectedEffort, "xhigh");
});

test("Codex model loading falls back to ChatGPT model cache when app-server misses ChatGPT-only models", async () => {
  const { store, dir } = await createStore("manor-codex-model-cache-test-");
  await writeFile(path.join(dir, "models_cache.json"), JSON.stringify({
    client_version: "test",
    models: [
      {
        slug: "gpt-5.5",
        display_name: "GPT-5.5",
        visibility: "list",
        supported_in_api: true,
        default_reasoning_level: "medium",
        supported_reasoning_levels: [{ effort: "low", description: "Low" }, { effort: "medium", description: "Medium" }, { effort: "high", description: "High" }, { effort: "xhigh", description: "Extra High" }]
      },
      {
        slug: "gpt-5.4",
        display_name: "GPT-5.4",
        visibility: "list",
        supported_in_api: true,
        default_reasoning_level: "medium",
        supported_reasoning_levels: [{ effort: "low", description: "Low" }, { effort: "medium", description: "Medium" }, { effort: "high", description: "High" }, { effort: "xhigh", description: "Extra High" }]
      },
      {
        slug: "gpt-5.4-mini",
        display_name: "GPT-5.4-Mini",
        visibility: "list",
        supported_in_api: true,
        default_reasoning_level: "medium",
        supported_reasoning_levels: [{ effort: "low", description: "Low" }, { effort: "medium", description: "Medium" }, { effort: "high", description: "High" }, { effort: "xhigh", description: "Extra High" }]
      },
      {
        slug: "gpt-5.3-codex-spark",
        display_name: "GPT-5.3-Codex-Spark",
        visibility: "list",
        supported_in_api: false,
        default_reasoning_level: "medium",
        supported_reasoning_levels: [{ effort: "low", description: "Low" }, { effort: "medium", description: "Medium" }, { effort: "high", description: "High" }, { effort: "xhigh", description: "Extra High" }]
      },
      {
        slug: "codex-auto-review",
        display_name: "Codex Auto Review",
        visibility: "hide",
        supported_in_api: true,
        default_reasoning_level: "medium",
        supported_reasoning_levels: [{ effort: "medium", description: "Medium" }]
      }
    ]
  }), "utf8");

  const client = new CodexAppServerClient("ws://127.0.0.1:1", store, dir, {
    onThreadCapabilityReady: async () => undefined
  });
  const clientState = client as unknown as {
    availableModels: ModelOption[];
    selectedModel: string | null;
    selectedEffort: ReasoningEffort | null;
    loadModels: () => Promise<void>;
    codexProviderAdapter: {
      listModels: (params: Record<string, unknown>) => Promise<{ data: Record<string, unknown>[]; nextCursor: string | null }>;
    };
  };
  clientState.selectedModel = null;
  clientState.selectedEffort = null;
  clientState.codexProviderAdapter = {
    listModels: async () => ({
      data: [
        { id: "gpt-5.5", displayName: "GPT-5.5", supportedReasoningEfforts: ["low", "medium", "high", "xhigh"] },
        { id: "gpt-5.4", displayName: "GPT-5.4", supportedReasoningEfforts: ["low", "medium", "high", "xhigh"] },
        { id: "gpt-5.4-mini", displayName: "GPT-5.4 Mini", supportedReasoningEfforts: ["low", "medium", "high", "xhigh"] },
        { id: "gpt-5.3-codex", displayName: "GPT-5.3 Codex", upgrade: "gpt-5.4", supportedReasoningEfforts: ["low", "medium", "high", "xhigh"] },
        { id: "gpt-5.2", displayName: "GPT-5.2", upgrade: "gpt-5.4", supportedReasoningEfforts: ["low", "medium", "high", "xhigh"] }
      ],
      nextCursor: null
    })
  };

  await clientState.loadModels();

  assert.deepEqual(clientState.availableModels.map((model) => model.id), [
    "gpt-5.5",
    "gpt-5.4",
    "gpt-5.4-mini",
    "gpt-5.3-codex-spark"
  ]);
  assert.deepEqual(clientState.availableModels.at(-1)?.supportedReasoningEfforts, ["low", "medium", "high", "xhigh"]);
  assert.equal(clientState.selectedModel, "gpt-5.5");
  assert.equal(clientState.selectedEffort, "medium");
});

test("Codex model loading trusts provider manifest for regular GPT thinking levels", async () => {
  const { store, dir } = await createStore("manor-codex-model-levels-test-");
  const client = new CodexAppServerClient("ws://127.0.0.1:1", store, dir, {
    onThreadCapabilityReady: async () => undefined
  });
  const clientState = client as unknown as {
    availableModels: ModelOption[];
    selectedModel: string | null;
    selectedEffort: ReasoningEffort | null;
    loadModels: () => Promise<void>;
    codexProviderAdapter: {
      listModels: (params: Record<string, unknown>) => Promise<{ data: Record<string, unknown>[]; nextCursor: string | null }>;
    };
  };
  clientState.selectedModel = "gpt-5.5";
  clientState.selectedEffort = "xhigh";
  clientState.codexProviderAdapter = {
    listModels: async () => ({
      data: [
        {
          id: "gpt-5.5",
          displayName: "GPT-5.5",
          supportedReasoningEfforts: ["minimal", "low", "medium", "high", "xhigh"],
          defaultReasoningEffort: "xhigh"
        },
        {
          id: "gpt-5.3-codex-spark",
          displayName: "GPT-5.3 Codex Spark",
          supportedReasoningEfforts: ["low", "medium", "high", "xhigh"],
          defaultReasoningEffort: "high"
        }
      ],
      nextCursor: null
    })
  };

  await clientState.loadModels();

  const gpt = clientState.availableModels.find((model) => model.id === "gpt-5.5");
  const codex = clientState.availableModels.find((model) => model.id === "gpt-5.3-codex-spark");
  assert.deepEqual(gpt?.supportedReasoningEfforts, ["minimal", "low", "medium", "high", "xhigh"]);
  assert.deepEqual(gpt?.supportedThinkingLevels, ["minimal", "low", "medium", "high", "xhigh"]);
  assert.equal(gpt?.defaultReasoningEffort, "xhigh");
  assert.deepEqual(codex?.supportedReasoningEfforts, ["low", "medium", "high", "xhigh"]);
  assert.equal(clientState.selectedModel, "gpt-5.5");
  assert.equal(clientState.selectedEffort, "xhigh");
});

test("Codex model loading preserves app-server model order", async () => {
  const { store, dir } = await createStore("manor-codex-model-sort-test-");
  const client = new CodexAppServerClient("ws://127.0.0.1:1", store, dir, {
    onThreadCapabilityReady: async () => undefined
  });
  const clientState = client as unknown as {
    availableModels: ModelOption[];
    selectedModel: string | null;
    selectedEffort: ReasoningEffort | null;
    loadModels: () => Promise<void>;
    codexProviderAdapter: {
      listModels: (params: Record<string, unknown>) => Promise<{ data: Record<string, unknown>[]; nextCursor: string | null }>;
    };
  };
  clientState.selectedModel = null;
  clientState.selectedEffort = null;
  clientState.codexProviderAdapter = {
    listModels: async () => ({
      data: [
        { id: "gpt-5.5", displayName: "GPT-5.5", supportedReasoningEfforts: ["low", "medium", "high"] },
        { id: "gpt-5.4", displayName: "GPT-5.4", supportedReasoningEfforts: ["low", "medium", "high"] },
        { id: "gpt-5.4-mini", displayName: "GPT-5.4 Mini", supportedReasoningEfforts: ["low", "medium", "high"] }
      ],
      nextCursor: null
    })
  };

  await clientState.loadModels();

  assert.deepEqual(clientState.availableModels.map((model) => model.id), [
    "gpt-5.5",
    "gpt-5.4",
    "gpt-5.4-mini"
  ]);
  assert.equal(clientState.selectedModel, "gpt-5.5");
});

test("Codex model loading clears stale models when live listing fails", async () => {
  const { store, dir } = await createStore("manor-codex-model-list-fail-test-");
  const client = new CodexAppServerClient("ws://127.0.0.1:1", store, dir, {
    onThreadCapabilityReady: async () => undefined
  });
  const clientState = client as unknown as {
    availableModels: ModelOption[];
    selectedModel: string | null;
    selectedEffort: ReasoningEffort | null;
    loadModels: () => Promise<void>;
    codexProviderAdapter: {
      listModels: () => Promise<{ data: Record<string, unknown>[]; nextCursor: string | null }>;
    };
  };
  clientState.availableModels = [{
    id: "gpt-5.2",
    label: "GPT-5.2",
    provider: null,
    supportsReasoning: true,
    supportedThinkingLevels: ["low", "medium", "high"],
    supportedReasoningEfforts: ["low", "medium", "high"],
    defaultReasoningEffort: "medium"
  }];
  clientState.selectedModel = "gpt-5.2";
  clientState.selectedEffort = "medium";
  clientState.codexProviderAdapter = {
    listModels: async () => {
      throw new Error("model list unavailable");
    }
  };

  await assert.rejects(() => clientState.loadModels(), /model list unavailable/);

  assert.deepEqual(clientState.availableModels, []);
  assert.equal(clientState.selectedModel, null);
  assert.equal(clientState.selectedEffort, null);
});

test("Codex startThread stores delegated xhigh effort locally and sends it in turn/start params", async () => {
  const { store, dir } = await createStore();
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  const client = new CodexAppServerClient("ws://127.0.0.1:1", store, dir, {
    onThreadCapabilityReady: async () => undefined
  });
  const clientState = client as unknown as {
    availableModels: ModelOption[];
    selectedModel: string | null;
    selectedEffort: ReasoningEffort | null;
    codexProviderAdapter: {
      startThread: (params: Record<string, unknown>) => Promise<{ threadId: string; thread: Record<string, unknown> }>;
      sendTurn: (threadId: string, params: Record<string, unknown>) => Promise<{ threadId: string; turnId: string; turn: Record<string, unknown> }>;
    };
  };
  clientState.availableModels = [{
    id: "gpt-test",
    label: "GPT Test",
    provider: null,
    supportsReasoning: true,
    supportedThinkingLevels: ["low", "medium", "high", "xhigh"],
    supportedReasoningEfforts: ["low", "medium", "high", "xhigh"],
    defaultReasoningEffort: "medium"
  }];
  clientState.selectedModel = "gpt-test";
  clientState.selectedEffort = "medium";

  clientState.codexProviderAdapter = {
    startThread: async (params: Record<string, unknown>) => {
      calls.push({ method: "thread/start", params });
      return {
        threadId: "thread-xhigh-start",
        thread: {
          id: "thread-xhigh-start",
          status: "active",
          source: "appServer",
          cwd: dir,
          preview: "Delegated xhigh job"
        }
      };
    },
    sendTurn: async (threadId: string, params: Record<string, unknown>) => {
      calls.push({ method: "turn/start", params });
      return { threadId, turnId: "turn-xhigh-start", turn: { id: "turn-xhigh-start", status: "in_progress", items: [] } };
    }
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

test("an exact Codex worker start preserves an explicit null effort", async () => {
  const { store, dir } = await createStore("manor-codex-null-effort-");
  let turnParams: Record<string, unknown> | null = null;
  const client = new CodexAppServerClient("ws://127.0.0.1:1", store, dir, {
    onThreadCapabilityReady: async () => undefined
  });
  const clientState = client as unknown as {
    availableModels: ModelOption[];
    selectedModel: string | null;
    selectedEffort: ReasoningEffort | null;
    codexProviderAdapter: {
      startThread: (params: Record<string, unknown>) => Promise<{ threadId: string; thread: Record<string, unknown> }>;
      sendTurn: (threadId: string, params: Record<string, unknown>) => Promise<{ threadId: string; turnId: string; turn: Record<string, unknown> }>;
    };
  };
  clientState.availableModels = [{
    id: "gpt-test",
    label: "GPT Test",
    provider: null,
    supportsReasoning: true,
    supportedThinkingLevels: ["low", "medium", "high"],
    supportedReasoningEfforts: ["low", "medium", "high"],
    defaultReasoningEffort: "medium"
  }];
  clientState.selectedModel = "gpt-test";
  clientState.selectedEffort = "high";
  clientState.codexProviderAdapter = {
    startThread: async () => ({
      threadId: "thread-null-effort",
      thread: { id: "thread-null-effort", cwd: dir, status: "active", turns: [] }
    }),
    sendTurn: async (threadId, params) => {
      turnParams = params;
      return { threadId, turnId: "turn-null-effort", turn: { id: "turn-null-effort", status: "in_progress", items: [] } };
    }
  };

  const result = await client.startThread({
    task: "Use provider defaults",
    cwd: dir,
    model: "gpt-test",
    effort: null,
    openWindow: false
  });

  assert.equal(turnParams && "effort" in turnParams, false);
  assert.equal(client.getConnectionState().compose.effort, "high");
  assert.equal(store.getThreadDetail(result.threadId)?.requestedReasoningEffort, null);
});

test("Codex thread settings update sends selected model and compatible effort", async () => {
  const { store, dir } = await createStore("manor-codex-model-test-");
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  const client = new CodexAppServerClient("ws://127.0.0.1:1", store, dir, {
    onThreadCapabilityReady: async () => undefined
  });
  const clientState = client as unknown as {
    availableModels: ModelOption[];
    codexProviderAdapter: {
      call: (method: string, params: Record<string, unknown>) => Promise<unknown>;
    };
  };
  clientState.availableModels = [{
    id: "gpt-5-codex-high",
    label: "GPT-5 Codex High",
    provider: "openai",
    supportsReasoning: true,
    supportedThinkingLevels: ["low", "medium", "high"],
    supportedReasoningEfforts: ["low", "medium", "high"],
    defaultReasoningEffort: "medium"
  }];
  clientState.codexProviderAdapter = {
    call: async (method: string, params: Record<string, unknown>) => {
      calls.push({ method, params });
      return { ok: true };
    }
  };

  await client.updateThreadSettings("thread-model-settings", { model: "gpt-5-codex-high", effort: "xhigh" });

  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.method, "thread/settings/update");
  assert.deepEqual(calls[0]?.params, {
    threadId: "thread-model-settings",
    model: "gpt-5-codex-high",
    effort: "medium"
  });
});

test("Codex thread settings update does not clamp effort-only updates against global compose model", async () => {
  const { store, dir } = await createStore("manor-codex-effort-only-test-");
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  const client = new CodexAppServerClient("ws://127.0.0.1:1", store, dir, {
    onThreadCapabilityReady: async () => undefined
  });
  const clientState = client as unknown as {
    availableModels: ModelOption[];
    selectedModel: string | null;
    codexProviderAdapter: {
      call: (method: string, params: Record<string, unknown>) => Promise<unknown>;
    };
  };
  clientState.availableModels = [{
    id: "gpt-5-codex-high",
    label: "GPT-5 Codex High",
    provider: "openai",
    supportsReasoning: true,
    supportedThinkingLevels: ["low", "medium", "high"],
    supportedReasoningEfforts: ["low", "medium", "high"],
    defaultReasoningEffort: "medium"
  }];
  clientState.selectedModel = "gpt-5-codex-high";
  clientState.codexProviderAdapter = {
    call: async (method: string, params: Record<string, unknown>) => {
      calls.push({ method, params });
      return { ok: true };
    }
  };

  await client.updateThreadSettings("thread-effort-only", { effort: "xhigh" });

  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.method, "thread/settings/update");
  assert.deepEqual(calls[0]?.params, {
    threadId: "thread-effort-only",
    effort: "xhigh"
  });
});

test("Codex thread settings rejects unavailable models before provider call", async () => {
  const { store, dir } = await createStore("manor-codex-model-reject-test-");
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  const client = new CodexAppServerClient("ws://127.0.0.1:1", store, dir, {
    onThreadCapabilityReady: async () => undefined
  });
  const clientState = client as unknown as {
    availableModels: ModelOption[];
    codexProviderAdapter: {
      call: (method: string, params: Record<string, unknown>) => Promise<unknown>;
    };
  };
  clientState.availableModels = [];
  clientState.codexProviderAdapter = {
    call: async (method: string, params: Record<string, unknown>) => {
      calls.push({ method, params });
      return { ok: true };
    }
  };

  await assert.rejects(
    () => client.updateThreadSettings("thread-model-settings", { model: "missing-model" }),
    /Selected Codex model is not available/
  );
  assert.equal(calls.length, 0);
});
