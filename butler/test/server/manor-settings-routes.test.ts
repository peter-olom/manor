import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import express from "express";

import { registerManorSettingsRoutes } from "../../src/server/manor-settings-routes.js";
import { clearOllamaCloudModelsCache } from "../../src/server/ollama-cloud-models.js";
import { clearOpencodeGoModelsCache } from "../../src/server/opencode-go-models.js";
import { getActiveManorSettings, setActiveManorSettings } from "../../src/server/manor-settings-runtime.js";
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
    codexClient: { getConnectionState: () => ({ connected: false, lastError: null, compose: { availableModels: [] } }) },
    piRpcWorkerClient: { getConnectionState: () => ({ lastError: null, compose: { availableModels: [] } }) },
    butlerAgent: {
      getShellSnapshot: () => ({ compose: { availableModels: [] } }),
      getButlerAuthStatus: () => ({ loggedIn: false }),
      getCodexAuthStatus: () => ({ loggedIn: false })
    },
    onSettingsChanged: async () => undefined
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
    codexClient: { getConnectionState: () => ({ connected: true, lastError: null, compose: { model: null, effort: null, availableModels: [] } }) },
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
      getCodexAuthStatus: () => ({ loggedIn: false })
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
