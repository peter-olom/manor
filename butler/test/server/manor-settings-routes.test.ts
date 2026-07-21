import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import express from "express";

import { registerManorSettingsRoutes } from "../../src/server/manor-settings-routes.js";
import { clearOllamaCloudModelsCache } from "../../src/server/ollama-cloud-models.js";
import { clearOpencodeGoModelsCache } from "../../src/server/opencode-go-models.js";
import { getActiveManorSettings, setActiveManorSettings } from "../../src/server/manor-settings-runtime.js";
import type { ModelOption } from "../../src/server/types.js";
import type { SettingsValidationKey, SettingsValidationResult } from "../../src/shared/settings.js";

async function listen(app: express.Express): Promise<{ url: string; close: () => Promise<void> }> {
  const server = app.listen(0);
  const address = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      })
  };
}

function model(id: string, provider: string): ModelOption {
  return {
    id,
    label: id,
    provider,
    supportsReasoning: false,
    supportedThinkingLevels: [],
    supportedReasoningEfforts: [],
    defaultReasoningEffort: null
  };
}

test("settings exposes only authenticated provider models for background tasks, including custom provider ids", async (t) => {
  const settings = getActiveManorSettings({
    MANOR_OPENCODE_GO_ENABLED: "1",
    MANOR_OPENCODE_GO_PROVIDER_ID: "custom-go",
    OPENCODE_API_KEY: "test-key"
  } as NodeJS.ProcessEnv);
  setActiveManorSettings(settings);
  const previousOpenCodeKey = process.env.OPENCODE_API_KEY;
  const previousOpenAiKey = process.env.OPENAI_API_KEY;
  process.env.OPENCODE_API_KEY = "test-key";
  delete process.env.OPENAI_API_KEY;
  t.after(() => {
    if (previousOpenCodeKey === undefined) delete process.env.OPENCODE_API_KEY;
    else process.env.OPENCODE_API_KEY = previousOpenCodeKey;
    if (previousOpenAiKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previousOpenAiKey;
    setActiveManorSettings(null);
  });

  const codexModel = model("gpt-5.4", "openai-codex");
  const openCodeModel = model("glm-5.2", "custom-go");
  const app = express();
  app.use(express.json());
  registerManorSettingsRoutes({
    app,
    settingsService: {
      getSettings: () => settings,
      getProvenance: () => ({}),
      getValidation: () => ({})
    },
    store: { getThread: () => null, listThreads: () => [] },
    piRpcWorkerClient: {
      getConnectionState: () => ({ lastError: null, compose: { provider: "custom-go", model: null, effort: null, availableModels: [openCodeModel] } })
    },
    butlerAgent: {
      getShellSnapshot: () => ({ compose: { availableModels: [codexModel, openCodeModel] } }),
      getButlerAuthStatus: () => ({ loggedIn: true }),
      getWorkerAuthStatus: () => ({ loggedIn: false })
    },
    onSettingsChanged: async () => undefined
  } as never);

  const server = await listen(app);
  try {
    const response = await fetch(`${server.url}/api/settings`);
    const payload = await response.json() as {
      availableModels: { modelTasks: ModelOption[] };
      providerAvailability: Record<string, { secretAvailable: boolean }>;
      modelTaskProviderAvailability: Record<string, { secretAvailable: boolean }>;
    };
    assert.equal(response.status, 200);
    assert.deepEqual(payload.availableModels.modelTasks.map((entry) => entry.id), ["openai-codex/gpt-5.4", "custom-go/glm-5.2"]);
    assert.equal(payload.providerAvailability["openai-codex"]?.secretAvailable, true);
    assert.equal(payload.modelTaskProviderAvailability["openai-codex"]?.secretAvailable, true);
  } finally {
    await server.close();
  }
});

test("Butler auth check sends hi through the explicit OpenAI Pi model without using chat history", async () => {
  const settings = getActiveManorSettings();
  const openAiModel = model("openai-codex/gpt-5.4", "openai-codex");
  const otherModel = model("ollama-cloud/glm-5.2", "ollama-cloud");
  const calls: Array<Record<string, unknown>> = [];
  let fail = false;
  const app = express();
  app.use(express.json());
  registerManorSettingsRoutes({
    app,
    settingsService: {
      getSettings: () => settings,
      getProvenance: () => ({}),
      getValidation: () => ({})
    },
    store: {},
    piRpcWorkerClient: { getConnectionState: () => ({ lastError: null, compose: { availableModels: [] } }) },
    butlerAgent: {
      getButlerAuthStatus: () => ({ loggedIn: true }),
      getShellSnapshot: () => ({
        compose: {
          provider: "ollama-cloud",
          model: otherModel.id,
          availableModels: [otherModel, openAiModel]
        }
      })
    },
    modelTasks: {
      runText: async (input: Record<string, unknown>) => {
        calls.push(input);
        if (fail) throw new Error("401 unauthorized Bearer supersecretcredential");
        return "Hello";
      }
    },
    onSettingsChanged: async () => undefined
  } as never);

  const server = await listen(app);
  try {
    const successResponse = await fetch(`${server.url}/api/settings/auth/butler/check`, { method: "POST" });
    const success = await successResponse.json() as { ok: boolean; message: string; checkedAt: number };
    assert.equal(success.ok, true);
    assert.equal(success.message, "Authentication is working.");
    assert.equal(typeof success.checkedAt, "number");
    assert.deepEqual(calls[0], {
      purpose: "Butler authentication check",
      prompt: "hi",
      systemPrompt: "Reply briefly. This is an authentication check.",
      timeoutMs: 30_000,
      model: openAiModel.id,
      allowWebTools: false
    });

    fail = true;
    const failureResponse = await fetch(`${server.url}/api/settings/auth/butler/check`, { method: "POST" });
    const failure = await failureResponse.json() as { ok: boolean; message: string };
    assert.equal(failure.ok, false);
    assert.match(failure.message, /unauthorized/i);
    assert.doesNotMatch(failure.message, /supersecretcredential/);
  } finally {
    await server.close();
  }
});

test("Butler auth check trusts a working API-key OpenAI transport over stale sign-in status", async () => {
  const settings = getActiveManorSettings();
  const openAiModel = model("openai/gpt-5.4", "openai");
  const calls: Array<Record<string, unknown>> = [];
  const app = express();
  app.use(express.json());
  registerManorSettingsRoutes({
    app,
    settingsService: { getSettings: () => settings, getProvenance: () => ({}), getValidation: () => ({}) },
    store: {},
    piRpcWorkerClient: { getConnectionState: () => ({ lastError: null, compose: { availableModels: [] } }) },
    butlerAgent: {
      getButlerAuthStatus: () => ({ loggedIn: false }),
      getShellSnapshot: () => ({ compose: { provider: "openai", model: openAiModel.id, availableModels: [openAiModel] } })
    },
    modelTasks: { runText: async (input: Record<string, unknown>) => { calls.push(input); return "Hello"; } },
    onSettingsChanged: async () => undefined
  } as never);

  const server = await listen(app);
  try {
    const response = await fetch(`${server.url}/api/settings/auth/butler/check`, { method: "POST" });
    const result = await response.json() as { ok: boolean };
    assert.equal(result.ok, true);
    assert.equal(calls[0]?.model, openAiModel.id);
  } finally {
    await server.close();
  }
});

test("Worker auth check sends an isolated probe and redacts failures", async () => {
  const settings = getActiveManorSettings();
  const app = express();
  app.use(express.json());
  let calls = 0;
  let fail = false;
  registerManorSettingsRoutes({
    app,
    settingsService: { getSettings: () => settings, getProvenance: () => ({}), getValidation: () => ({}) },
    store: {},
    piRpcWorkerClient: {
      getConnectionState: () => ({ lastError: null, compose: { availableModels: [] } }),
      checkOpenAiAuth: async (timeoutMs: number) => {
        calls += 1;
        assert.equal(timeoutMs, 30_000);
        if (fail) throw new Error("401 unauthorized Bearer supersecretcredential");
        return "Hello";
      }
    },
    butlerAgent: {
      getButlerAuthStatus: () => ({ loggedIn: true }),
      getShellSnapshot: () => ({ compose: { availableModels: [] } })
    },
    modelTasks: {},
    onSettingsChanged: async () => undefined
  } as never);

  const server = await listen(app);
  try {
    const successResponse = await fetch(`${server.url}/api/settings/auth/worker/check`, { method: "POST" });
    const success = await successResponse.json() as { ok: boolean; message: string; checkedAt: number };
    assert.equal(success.ok, true);
    assert.equal(success.message, "Authentication is working.");
    assert.equal(typeof success.checkedAt, "number");
    assert.equal(calls, 1);

    fail = true;
    const failureResponse = await fetch(`${server.url}/api/settings/auth/worker/check`, { method: "POST" });
    const failure = await failureResponse.json() as { ok: boolean; message: string };
    assert.equal(failure.ok, false);
    assert.match(failure.message, /unauthorized/i);
    assert.doesNotMatch(failure.message, /supersecretcredential/);
    assert.equal(calls, 2);
  } finally {
    await server.close();
  }
});

test("settings diagnostics validates Ollama Cloud using discovered models", async (t) => {
  clearOllamaCloudModelsCache();
  const settings = getActiveManorSettings({
    MANOR_OLLAMA_CLOUD_ENABLED: "1",
    MANOR_OLLAMA_CLOUD_BASE_URL: "https://ollama.example/v1",
    MANOR_OLLAMA_WEB_TOOLS_BASE_URL: "https://ollama.example/api",
    OLLAMA_API_KEY: "test-key"
  } as NodeJS.ProcessEnv);
  settings.providers.ollamaCloud.models = [];
  setActiveManorSettings(settings);

  const previousKey = process.env.OLLAMA_API_KEY;
  const originalFetch = globalThis.fetch;
  process.env.OLLAMA_API_KEY = "test-key";
  globalThis.fetch = (async (input, init) => {
    const url = String(input);
    if (url === "https://ollama.example/api/tags") {
      return Response.json({ models: [{ name: "glm-5.2" }] });
    }
    if (url === "https://ollama.example/api/show") {
      assert.equal(init?.method, "POST");
      return Response.json({ model_info: { "glm.context_length": 131_072 } });
    }
    if (url === "https://ollama.example/v1/chat/completions") {
      assert.equal(init?.method, "POST");
      return Response.json({ choices: [{ message: { content: "OK" } }] });
    }
    if (url.startsWith("http://127.0.0.1:")) {
      return originalFetch(input, init);
    }
    throw new Error(`Unexpected fetch: ${url}`);
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
    if (previousKey === undefined) delete process.env.OLLAMA_API_KEY;
    else process.env.OLLAMA_API_KEY = previousKey;
    setActiveManorSettings(null);
    clearOllamaCloudModelsCache();
  });

  const validation = new Map<SettingsValidationKey, SettingsValidationResult>();
  let refreshRequests = 0;
  const app = express();
  app.use(express.json());
  registerManorSettingsRoutes({
    app,
    settingsService: {
      getSettings: () => settings,
      getProvenance: () => ({}),
      getValidation: () => Object.fromEntries(validation),
      setValidation: async (key: SettingsValidationKey, result: SettingsValidationResult) => {
        validation.set(key, result);
      }
    },
    store: {},
    piRpcWorkerClient: { getConnectionState: () => ({ lastError: null, compose: { availableModels: [] } }) },
    butlerAgent: {
      getShellSnapshot: () => ({ compose: { availableModels: [] } }),
      getButlerAuthStatus: () => ({ loggedIn: false }),
      getWorkerAuthStatus: () => ({ loggedIn: false })
    },
    onSettingsChanged: async () => undefined,
    refreshModelInventories: () => { refreshRequests += 1; }
  } as never);

  const server = await listen(app);
  try {
    const response = await fetch(`${server.url}/api/settings/validate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ target: "ollamaCloud" })
    });
    const payload = await response.json() as {
      validation: Record<string, SettingsValidationResult>;
    };

    assert.equal(response.status, 200);
    assert.equal(payload.validation.ollamaCloud?.status, "ok");
    assert.match(payload.validation.ollamaCloud?.message ?? "", /glm-5\.2/);
    assert.equal(refreshRequests, 1);
  } finally {
    await server.close();
  }
});

test("settings exposes OpenCode Go models from the live OpenCode Go endpoint", async (t) => {
  clearOpencodeGoModelsCache();
  const settings = getActiveManorSettings({
    MANOR_OPENCODE_GO_ENABLED: "1",
    MANOR_OPENCODE_GO_BASE_URL: "https://opencode.example/zen/go/v1",
    OPENCODE_API_KEY: "test-key"
  } as NodeJS.ProcessEnv);
  setActiveManorSettings(settings);
  const previousKey = process.env.OPENCODE_API_KEY;
  process.env.OPENCODE_API_KEY = "test-key";
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    if (url === "https://opencode.example/zen/go/v1/models") {
      return Response.json({
        data: [
          { id: "glm-5.2" },
          { id: "qwen3.7-max" },
          { id: "qwen3.7-plus" }
        ]
      });
    }
    if (url.startsWith("http://127.0.0.1:")) {
      return originalFetch(input, init);
    }
    throw new Error(`Unexpected fetch: ${url}`);
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
    if (previousKey === undefined) delete process.env.OPENCODE_API_KEY;
    else process.env.OPENCODE_API_KEY = previousKey;
    setActiveManorSettings(null);
    clearOpencodeGoModelsCache();
  });

  const validation = new Map<SettingsValidationKey, SettingsValidationResult>();
  const app = express();
  app.use(express.json());
  registerManorSettingsRoutes({
    app,
    settingsService: {
      getSettings: () => settings,
      getProvenance: () => ({}),
      getValidation: () => Object.fromEntries(validation),
      setValidation: async (key: SettingsValidationKey, result: SettingsValidationResult) => {
        validation.set(key, result);
      }
    },
    store: { getThread: () => null, listThreads: () => [] },
    piRpcWorkerClient: {
      getConnectionState: () => ({
        lastError: null,
        compose: {
          provider: "opencode-go",
          model: null,
          effort: null,
          availableModels: []
        }
      })
    },
    butlerAgent: {
      getShellSnapshot: () => ({ compose: { availableModels: [] } }),
      getButlerAuthStatus: () => ({ loggedIn: false }),
      getWorkerAuthStatus: () => ({ loggedIn: false })
    },
    onSettingsChanged: async () => undefined
  } as never);

  const server = await listen(app);
  try {
    const modelsResponse = await fetch(`${server.url}/api/settings/providers/opencode-go/models`);
    const modelsPayload = await modelsResponse.json() as { models: Array<{ id: string; provider: string }> };
    assert.equal(modelsResponse.status, 200);
    assert.deepEqual(modelsPayload.models.map((model) => model.id), ["glm-5.2", "qwen3.7-plus", "qwen3.7-max"]);

    const validationResponse = await fetch(`${server.url}/api/settings/validate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ target: "opencodeGo" })
    });
    const validationPayload = await validationResponse.json() as {
      validation: Record<string, SettingsValidationResult>;
    };
    assert.equal(validationResponse.status, 200);
    assert.equal(validationPayload.validation.opencodeGo?.status, "ok");
    assert.match(validationPayload.validation.opencodeGo?.message ?? "", /3 OpenCode Go models/);
  } finally {
    await server.close();
  }
});
