import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { AuthStorage, ModelRegistry } from "@mariozechner/pi-coding-agent";

import {
  formatProviderModelRef,
  isCodexPreferredModelRef,
  modelToModelOption,
  parseProviderModelRef,
  shouldExposeManorModel,
  registerManorProviders,
  syncManorPiModelsJson
} from "../../src/server/model-provider-config.js";
import { clearOllamaCloudModelsCache } from "../../src/server/ollama-cloud-models.js";
import { clearOpencodeGoModelsCache, opencodeGoModelMetadata } from "../../src/server/opencode-go-models.js";
import { clearOpenRouterModelCapabilitiesCache } from "../../src/server/openrouter-model-capabilities.js";
import { isChatGptSubscriptionModelAvailable } from "../../src/server/chatgpt-entitlement.js";
import {
  getModelCapabilityMetadata,
  thinkingLevelMapFromSupportedEfforts
} from "../../src/server/model-capabilities.js";
import { setActiveManorSettings } from "../../src/server/manor-settings-runtime.js";

function withProcessEnv<T>(patch: Record<string, string | undefined>, fn: () => T): T {
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

test("parseProviderModelRef handles provider-qualified and plain model ids", () => {
  assert.deepEqual(parseProviderModelRef("ollama-cloud/glm-5.2"), { provider: "ollama-cloud", model: "glm-5.2" });
  assert.deepEqual(parseProviderModelRef("groq/groq%2Fcompound"), { provider: "groq", model: "groq/compound" });
  assert.deepEqual(parseProviderModelRef("ollama-local/qwen3%3A8b"), { provider: "ollama-local", model: "qwen3:8b" });
  assert.equal(formatProviderModelRef({ provider: "groq", model: "groq/compound" }), "groq/groq/compound");
  assert.deepEqual(parseProviderModelRef("gpt-5.4-mini"), { provider: null, model: "gpt-5.4-mini" });
  assert.deepEqual(parseProviderModelRef(""), { provider: null, model: null });
});

test("isCodexPreferredModelRef routes OpenAI and unqualified models to Codex", () => {
  assert.equal(isCodexPreferredModelRef("gpt-5.4-mini"), true);
  assert.equal(isCodexPreferredModelRef("openai-codex/gpt-5.4-mini"), true);
  assert.equal(isCodexPreferredModelRef("openai/gpt-5.4-mini"), true);
  assert.equal(isCodexPreferredModelRef("ollama-cloud/glm-5.2"), false);
});

test("ChatGPT subscription model gate excludes unsupported older GPT models", () => {
  assert.equal(isChatGptSubscriptionModelAvailable({ id: "gpt-5.2", provider: "openai-codex" }), false);
  assert.equal(isChatGptSubscriptionModelAvailable({ id: "gpt-5.3", provider: "openai-codex" }), false);
  assert.equal(isChatGptSubscriptionModelAvailable({ id: "gpt-5.3-codex", provider: "openai-codex" }), false);
  assert.equal(isChatGptSubscriptionModelAvailable({ id: "gpt-5.3-codex-spark", provider: "openai-codex" }), true);
  assert.equal(isChatGptSubscriptionModelAvailable({ id: "gpt-5.4", provider: "openai-codex" }), true);
  assert.equal(isChatGptSubscriptionModelAvailable({ id: "openai-codex/gpt-5.2" }), false);
  assert.equal(isChatGptSubscriptionModelAvailable({ id: "ollama-cloud/gpt-oss:120b" }), true);
});

test("thinkingLevelMapFromSupportedEfforts passes through raw effort names without mapping", () => {
  const map = thinkingLevelMapFromSupportedEfforts(["low", "medium", "high", "max"]);
  assert.deepEqual(
    map,
    { off: null, none: null, minimal: null, low: "low", medium: "medium", high: "high", xhigh: null, max: "max" }
  );
});

test("thinkingLevelMapFromSupportedEfforts passes through none as a distinct level", () => {
  const map = thinkingLevelMapFromSupportedEfforts(["none", "low", "medium", "high"]);
  assert.deepEqual(
    map,
    { off: null, none: "none", minimal: null, low: "low", medium: "medium", high: "high", xhigh: null, max: null }
  );
});

test("thinkingLevelMapFromSupportedEfforts passes through xhigh and max as distinct levels", () => {
  const map = thinkingLevelMapFromSupportedEfforts(["medium", "high", "xhigh", "max"]);
  assert.deepEqual(
    map,
    { off: null, none: null, minimal: null, low: null, medium: "medium", high: "high", xhigh: "xhigh", max: "max" }
  );
});

test("thinkingLevelMapFromSupportedEfforts returns undefined for empty or null efforts", () => {
  assert.equal(thinkingLevelMapFromSupportedEfforts([]), undefined);
  assert.equal(thinkingLevelMapFromSupportedEfforts(["bogus"]), undefined);
  assert.equal(thinkingLevelMapFromSupportedEfforts(null), undefined);
});

test("getModelCapabilityMetadata returns GLM-5.2 fallback with high and max transport mapping", () => {
  const metadata = getModelCapabilityMetadata("glm-5.2");
  assert.equal(metadata?.reasoning, true);
  assert.equal(metadata?.contextWindow, 1_000_000);
  assert.equal(metadata?.__source, "builtin-fallback");
  assert.deepEqual(
    metadata?.thinkingLevelMap,
    { off: null, none: null, minimal: null, low: null, medium: null, high: "high", xhigh: "max" }
  );
});

test("getModelCapabilityMetadata matches GLM-5.2 by alias", () => {
  assert.ok(getModelCapabilityMetadata("z-ai/glm-5.2"));
  assert.ok(getModelCapabilityMetadata("z-ai/glm-5.2-20260616"));
  assert.ok(getModelCapabilityMetadata("glm-5.2-20260616"));
  assert.equal(getModelCapabilityMetadata("glm-4.9"), null);
});

test("registerManorProviders registers Ollama Cloud models from env", async () => {
  clearOllamaCloudModelsCache();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    throw new Error("no live discovery in this test");
  }) as typeof fetch;
  const registry = ModelRegistry.inMemory(AuthStorage.inMemory());
  try {
    await registerManorProviders(registry, {
      MANOR_OLLAMA_LOCAL_ENABLED: "0",
      MANOR_OLLAMA_CLOUD_ENABLED: "1",
      MANOR_OLLAMA_CLOUD_PROVIDER_ID: "ollama-cloud",
      MANOR_OLLAMA_CLOUD_BASE_URL: "https://ollama.example/v1",
      MANOR_OLLAMA_CLOUD_MODELS: "glm-5.2,kimi-k2.6",
      OLLAMA_API_KEY: "test-key"
    } as NodeJS.ProcessEnv);
  } finally {
    globalThis.fetch = originalFetch;
    clearOllamaCloudModelsCache();
  }

  const models = registry.getAvailable().filter((model) => model.provider === "ollama-cloud");
  assert.deepEqual(models.map((model) => `${model.provider}/${model.id}`), [
    "ollama-cloud/glm-5.2",
    "ollama-cloud/kimi-k2.6"
  ]);
  assert.equal(models[0]?.baseUrl, "https://ollama.example/v1");
  assert.equal(models[0]?.compat?.maxTokensField, "max_tokens");
});

test("registerManorProviders does not wait for live Ollama Cloud discovery when fallback models exist", async (t) => {
  clearOllamaCloudModelsCache();
  const originalFetch = globalThis.fetch;
  let called = false;
  globalThis.fetch = (async () => {
    called = true;
    await new Promise((resolve) => setTimeout(resolve, 25));
    throw new Error("slow discovery");
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
    clearOllamaCloudModelsCache();
  });

  const registry = ModelRegistry.inMemory(AuthStorage.inMemory());
  const startedAt = Date.now();
  await registerManorProviders(registry, {
    MANOR_OLLAMA_LOCAL_ENABLED: "0",
    MANOR_OLLAMA_CLOUD_ENABLED: "1",
    MANOR_OLLAMA_CLOUD_PROVIDER_ID: "ollama-cloud",
    MANOR_OLLAMA_CLOUD_BASE_URL: "https://ollama.example/v1",
    MANOR_OLLAMA_CLOUD_MODELS: "glm-5.2",
    OLLAMA_API_KEY: "test-key"
  } as NodeJS.ProcessEnv);
  await new Promise((resolve) => setImmediate(resolve));

  assert.ok(Date.now() - startedAt < 1_000);
  assert.equal(called, true);
  assert.deepEqual(registry.getAvailable().filter((model) => model.provider === "ollama-cloud").map((model) => model.id), ["glm-5.2"]);
});

test("registerManorProviders bounds Ollama Cloud discovery even without fallback models", async (t) => {
  clearOllamaCloudModelsCache();
  const originalFetch = globalThis.fetch;
  let called = false;
  globalThis.fetch = (async () => {
    called = true;
    await new Promise((resolve) => setTimeout(resolve, 1_750));
    return Response.json({ models: [] });
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
    clearOllamaCloudModelsCache();
  });

  const registry = ModelRegistry.inMemory(AuthStorage.inMemory());
  const startedAt = Date.now();
  await registerManorProviders(registry, {
    MANOR_OLLAMA_LOCAL_ENABLED: "0",
    MANOR_OLLAMA_CLOUD_ENABLED: "1",
    MANOR_OLLAMA_CLOUD_PROVIDER_ID: "ollama-cloud",
    MANOR_OLLAMA_CLOUD_BASE_URL: "https://ollama.example/v1",
    MANOR_OLLAMA_CLOUD_MODELS: "",
    OLLAMA_API_KEY: "test-key"
  } as NodeJS.ProcessEnv);

  assert.ok(Date.now() - startedAt < 2_500);
  assert.equal(called, true);
  assert.deepEqual(registry.getAvailable().filter((model) => model.provider === "ollama-cloud"), []);
});

test("registerManorProviders registers Ollama Local models without a real API key", async () => {
  const registry = ModelRegistry.inMemory(AuthStorage.inMemory());
  await registerManorProviders(registry, {
    MANOR_OLLAMA_LOCAL_ENABLED: "1",
    MANOR_OLLAMA_LOCAL_PROVIDER_ID: "ollama-local",
    MANOR_OLLAMA_LOCAL_BASE_URL: "http://ollama:11434/v1",
    MANOR_OLLAMA_LOCAL_MODELS: "qwen3:8b"
  } as NodeJS.ProcessEnv);

  const models = registry.getAvailable().filter((model) => model.provider === "ollama-local");
  assert.deepEqual(models.map((model) => `${model.provider}/${model.id}`), ["ollama-local/qwen3:8b"]);
  assert.equal(models[0]?.baseUrl, "http://ollama:11434/v1");
  assert.equal(models[0]?.compat?.maxTokensField, "max_tokens");
  const auth = await registry.getApiKeyAndHeaders(models[0]!);
  assert.equal(auth.ok, true);
  if (auth.ok) {
    assert.equal(auth.apiKey, "ollama");
    assert.equal(auth.headers, undefined);
  }
});

test("registerManorProviders preserves discovered Ollama Local context windows", async (t) => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    if (url.endsWith("/api/tags")) {
      return Response.json({ models: [{ name: "qwen3:8b" }] });
    }
    if (url.endsWith("/api/show")) {
      assert.equal(JSON.parse(String(init?.body ?? "{}")).model, "qwen3:8b");
      return Response.json({ capabilities: ["completion"], model_info: { "qwen.context_length": 32_768 } });
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const registry = ModelRegistry.inMemory(AuthStorage.inMemory());
  await registerManorProviders(registry, {
    MANOR_OLLAMA_LOCAL_ENABLED: "1",
    MANOR_OLLAMA_LOCAL_PROVIDER_ID: "ollama-local",
    MANOR_OLLAMA_LOCAL_BASE_URL: "http://ollama:11434/v1",
    MANOR_OLLAMA_LOCAL_NATIVE_BASE_URL: "http://ollama:11434",
    MANOR_OLLAMA_LOCAL_MODELS: ""
  } as NodeJS.ProcessEnv);

  const model = registry.getAvailable().find((entry) => entry.provider === "ollama-local" && entry.id === "qwen3:8b");
  assert.ok(model);
  assert.equal(model.contextWindow, 32_768);
});

test("registerManorProviders skips Ollama Local public URLs", async () => {
  const registry = ModelRegistry.inMemory(AuthStorage.inMemory());
  await registerManorProviders(registry, {
    MANOR_OLLAMA_LOCAL_ENABLED: "1",
    MANOR_OLLAMA_LOCAL_PROVIDER_ID: "ollama-local",
    MANOR_OLLAMA_LOCAL_BASE_URL: "https://api.example.com/v1",
    MANOR_OLLAMA_LOCAL_NATIVE_BASE_URL: "http://ollama:11434",
    MANOR_OLLAMA_LOCAL_MODELS: "qwen3:8b"
  } as NodeJS.ProcessEnv);

  assert.deepEqual(registry.getAvailable().filter((model) => model.provider === "ollama-local"), []);
});

test("syncManorPiModelsJson writes Ollama Local provider config for spawned Pi workers", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "manor-pi-models-"));
  t.after(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });
  const authPath = path.join(dir, "auth.json");
  const modelsPath = path.join(dir, "models.json");
  await fs.writeFile(modelsPath, JSON.stringify({ providers: { existing: { baseUrl: "http://example.test" } } }), "utf8");

  const changed = await syncManorPiModelsJson(authPath, {
    MANOR_OLLAMA_LOCAL_ENABLED: "1",
    MANOR_OLLAMA_LOCAL_PROVIDER_ID: "ollama-local",
    MANOR_OLLAMA_LOCAL_PROVIDER_NAME: "Ollama Local",
    MANOR_OLLAMA_LOCAL_BASE_URL: "http://ollama:11434/v1",
    MANOR_OLLAMA_LOCAL_NATIVE_BASE_URL: "http://ollama:11434",
    MANOR_OLLAMA_LOCAL_MODELS: "qwen3:8b"
  } as NodeJS.ProcessEnv);

  assert.equal(changed, true);
  const payload = JSON.parse(await fs.readFile(modelsPath, "utf8"));
  assert.equal(payload.providers.existing.baseUrl, "http://example.test");
  const provider = payload.providers["ollama-local"];
  assert.equal(provider.name, "Ollama Local");
  assert.equal(provider.baseUrl, "http://ollama:11434/v1");
  assert.equal(provider.apiKey, "ollama");
  assert.equal(provider.authHeader, false);
  assert.equal(provider.compat.maxTokensField, "max_tokens");
  assert.deepEqual(provider.models.map((model: { id: string }) => model.id), ["qwen3:8b"]);
  assert.equal(provider.models[0].compat.maxTokensField, "max_tokens");
});

test("syncManorPiModelsJson backs up invalid existing Pi models config before writing", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "manor-pi-models-invalid-"));
  t.after(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });
  const authPath = path.join(dir, "auth.json");
  const modelsPath = path.join(dir, "models.json");
  await fs.writeFile(modelsPath, "{ invalid", "utf8");

  const changed = await syncManorPiModelsJson(authPath, {
    MANOR_OLLAMA_LOCAL_ENABLED: "1",
    MANOR_OLLAMA_LOCAL_PROVIDER_ID: "ollama-local",
    MANOR_OLLAMA_LOCAL_BASE_URL: "http://ollama:11434/v1",
    MANOR_OLLAMA_LOCAL_NATIVE_BASE_URL: "http://ollama:11434",
    MANOR_OLLAMA_LOCAL_MODELS: "qwen3:8b"
  } as NodeJS.ProcessEnv);

  assert.equal(changed, true);
  const payload = JSON.parse(await fs.readFile(modelsPath, "utf8"));
  assert.equal(payload.providers["ollama-local"].models[0].id, "qwen3:8b");
  const backup = (await fs.readdir(dir)).find((entry) => entry.startsWith("models.json.invalid-"));
  assert.ok(backup);
  assert.equal(await fs.readFile(path.join(dir, backup), "utf8"), "{ invalid");
});

test("syncManorPiModelsJson removes stale managed OpenCode Go provider config", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "manor-pi-opencode-cleanup-"));
  t.after(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });
  const authPath = path.join(dir, "auth.json");
  const modelsPath = path.join(dir, "models.json");
  await fs.writeFile(modelsPath, JSON.stringify({
    manorManagedProviderIds: ["opencode-go"],
    providers: {
      existing: { baseUrl: "https://existing.example" },
      "opencode-go": { baseUrl: "https://old-opencode.example", models: [{ id: "stale-model" }] }
    }
  }), "utf8");

  const changed = await syncManorPiModelsJson(authPath, {
    MANOR_OLLAMA_LOCAL_ENABLED: "0",
    MANOR_OLLAMA_CLOUD_ENABLED: "0",
    MANOR_OPENCODE_GO_ENABLED: "1"
  } as NodeJS.ProcessEnv);

  assert.equal(changed, true);
  const payload = JSON.parse(await fs.readFile(modelsPath, "utf8"));
  assert.deepEqual(Object.keys(payload.providers), ["existing"]);
  assert.equal("manorManagedProviderIds" in payload, false);
});

test("syncManorPiModelsJson writes live OpenCode Go models with OpenCode transform metadata", async (t) => {
  clearOpencodeGoModelsCache();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL): Promise<Response> => {
    const url = String(input);
    if (url === "https://opencode.example/zen/go/v1/models") {
      return Response.json({
        data: [
          { id: "glm-5.2" },
          { id: "qwen3.7-max" },
          { id: "qwen3.7-plus" },
          { id: "general-reasoning-model" }
        ]
      });
    }
    throw new Error(`unexpected fetch: ${url}`);
  }) as typeof fetch;
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "manor-pi-opencode-live-"));
  t.after(async () => {
    globalThis.fetch = originalFetch;
    clearOpencodeGoModelsCache();
    await fs.rm(dir, { recursive: true, force: true });
  });
  const authPath = path.join(dir, "auth.json");
  const modelsPath = path.join(dir, "models.json");

  const changed = await syncManorPiModelsJson(authPath, {
    MANOR_OLLAMA_LOCAL_ENABLED: "0",
    MANOR_OLLAMA_CLOUD_ENABLED: "0",
    MANOR_OPENCODE_GO_ENABLED: "1",
    MANOR_OPENCODE_GO_BASE_URL: "https://opencode.example/zen/go/v1",
    OPENCODE_API_KEY: "test-key"
  } as NodeJS.ProcessEnv);

  assert.equal(changed, true);
  const payload = JSON.parse(await fs.readFile(modelsPath, "utf8"));
  const provider = payload.providers["opencode-go"];
  assert.equal(provider.baseUrl, "https://opencode.example/zen/go/v1");
  assert.deepEqual(provider.models.map((model: { id: string }) => model.id), ["general-reasoning-model", "glm-5.2", "qwen3.7-plus", "qwen3.7-max"]);
  const glmModel = provider.models.find((model: { id: string }) => model.id === "glm-5.2");
  assert.equal(glmModel.reasoning, true);
  assert.equal(glmModel.thinkingLevelMap.high, "high");
  assert.equal(glmModel.thinkingLevelMap.xhigh, "max");
  assert.equal(glmModel.thinkingLevelMap.max, undefined);
  const qwenModel = provider.models.find((model: { id: string }) => model.id === "qwen3.7-max");
  assert.equal(qwenModel.reasoning, true);
  assert.deepEqual(qwenModel.thinkingLevelMap, {
    off: null,
    minimal: null,
    low: null,
    medium: null,
    high: null,
    xhigh: null
  });
  const standardModel = provider.models.find((model: { id: string }) => model.id === "general-reasoning-model");
  assert.equal(standardModel.reasoning, true);
  assert.deepEqual(standardModel.thinkingLevelMap, {
    off: null,
    minimal: null,
    low: "low",
    medium: "medium",
    high: "high",
    xhigh: null
  });
});

test("syncManorPiModelsJson removes disabled managed providers from spawned Pi config", async (t) => {
  clearOllamaCloudModelsCache();
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "manor-pi-disabled-providers-"));
  t.after(async () => {
    clearOllamaCloudModelsCache();
    await fs.rm(dir, { recursive: true, force: true });
  });
  const authPath = path.join(dir, "auth.json");
  const modelsPath = path.join(dir, "models.json");
  await fs.writeFile(modelsPath, JSON.stringify({
    manorManagedProviderIds: ["custom-ollama-cloud", "custom-opencode-go"],
    providers: {
      existing: { baseUrl: "https://existing.example" },
      "ollama-cloud": { baseUrl: "https://old-ollama.example" },
      "opencode-go": { baseUrl: "https://old-opencode.example" },
      "custom-ollama-cloud": { baseUrl: "https://old-custom-ollama.example" },
      "custom-opencode-go": { baseUrl: "https://old-custom-opencode.example" }
    }
  }), "utf8");

  const changed = await syncManorPiModelsJson(authPath, {
    MANOR_OLLAMA_LOCAL_ENABLED: "0",
    MANOR_OLLAMA_CLOUD_ENABLED: "0",
    MANOR_OPENCODE_GO_ENABLED: "0"
  } as NodeJS.ProcessEnv);

  assert.equal(changed, true);
  const payload = JSON.parse(await fs.readFile(modelsPath, "utf8"));
  assert.deepEqual(Object.keys(payload.providers), ["existing"]);
  assert.equal(payload.providers.existing.baseUrl, "https://existing.example");
  assert.equal("manorManagedProviderIds" in payload, false);
});

test("modelToModelOption preserves provider labels for UI selectors", async () => {
  clearOllamaCloudModelsCache();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    throw new Error("no live discovery in this test");
  }) as typeof fetch;
  const registry = ModelRegistry.inMemory(AuthStorage.inMemory());
  try {
    await registerManorProviders(registry, {
      MANOR_OLLAMA_LOCAL_ENABLED: "0",
      MANOR_OLLAMA_CLOUD_ENABLED: "1",
      MANOR_OLLAMA_CLOUD_PROVIDER_ID: "ollama-cloud",
      MANOR_OLLAMA_CLOUD_MODELS: "glm-5.2",
      OLLAMA_API_KEY: "test-key"
    } as NodeJS.ProcessEnv);
  } finally {
    globalThis.fetch = originalFetch;
    clearOllamaCloudModelsCache();
  }
  const option = modelToModelOption(registry.getAvailable().find((model) => model.provider === "ollama-cloud")!);
  assert.equal(option.id, "glm-5.2");
  assert.equal(option.provider, "ollama-cloud");
  assert.equal(option.supportsReasoning, true);
  assert.deepEqual(option.supportedThinkingLevels, ["high", "max"]);
  assert.deepEqual(option.supportedReasoningEfforts, ["high", "max"]);
  assert.equal(option.defaultReasoningEffort, "high");
});

test("modelToModelOption exposes only supported thinking levels", () => {
  const option = modelToModelOption({
    id: "limited-thinking",
    name: "Limited Thinking",
    provider: "test-provider",
    baseUrl: "https://example.test",
    api: "openai-responses",
    input: ["text"],
    contextWindow: 128_000,
    maxTokens: 16_384,
    reasoning: true,
    thinkingLevelMap: {
      off: null,
      minimal: null,
      low: null,
      medium: null,
      high: "high",
      xhigh: "xhigh"
    },
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
  } as never);

  assert.deepEqual(option.supportedThinkingLevels, ["high", "xhigh"]);
  assert.deepEqual(option.supportedReasoningEfforts, ["high", "xhigh"]);
  assert.equal(option.defaultReasoningEffort, "high");
});

test("modelToModelOption reflects declared thinking level map without stripping", () => {
  const option = modelToModelOption({
    id: "gpt-5.5",
    name: "GPT-5.5",
    provider: "openai",
    baseUrl: "https://example.test",
    api: "openai-responses",
    input: ["text"],
    contextWindow: 128_000,
    maxTokens: 16_384,
    reasoning: true,
    thinkingLevelMap: { off: null, minimal: null, low: null, medium: null, high: null, xhigh: "xhigh" },
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
  } as never);

  assert.deepEqual(option.supportedThinkingLevels, ["xhigh"]);
  assert.deepEqual(option.supportedReasoningEfforts, ["xhigh"]);
  assert.equal(option.defaultReasoningEffort, "xhigh");
});

test("modelToModelOption only exposes explicit xhigh when the map narrows defaults", () => {
  const option = modelToModelOption({
    id: "gpt-5.3-codex-spark",
    name: "GPT-5.3 Codex Spark",
    provider: "openai-codex",
    baseUrl: "https://example.test",
    api: "openai-responses",
    input: ["text"],
    contextWindow: 128_000,
    maxTokens: 16_384,
    reasoning: true,
    thinkingLevelMap: {
      off: null,
      none: null,
      minimal: null,
      low: null,
      medium: null,
      high: null,
      xhigh: "xhigh"
    },
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
  } as never);

  assert.deepEqual(option.supportedThinkingLevels, ["xhigh"]);
  assert.deepEqual(option.supportedReasoningEfforts, ["xhigh"]);
});

test("modelToModelOption exposes max when xhigh transports native max", () => {
  const option = modelToModelOption({
    id: "glm-5.2",
    name: "GLM-5.2",
    provider: "opencode-go",
    baseUrl: "https://example.test",
    api: "openai-completions",
    input: ["text"],
    contextWindow: 1_000_000,
    maxTokens: 32_768,
    reasoning: true,
    thinkingLevelMap: {
      off: null,
      none: null,
      minimal: null,
      low: null,
      medium: null,
      high: "high",
      xhigh: "max"
    },
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
  } as never);

  assert.deepEqual(option.supportedThinkingLevels, ["high", "max"]);
  assert.deepEqual(option.supportedReasoningEfforts, ["high", "max"]);
  assert.equal(option.defaultReasoningEffort, "high");
});

test("registerManorProviders narrows provider thinking levels from OpenRouter capability metadata", async (t) => {
  clearOllamaCloudModelsCache();
  clearOpenRouterModelCapabilitiesCache();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL): Promise<Response> => {
    const url = String(input);
    if (url === "https://openrouter.ai/api/v1/models") {
      return Response.json({
        data: [{
          id: "vendor/exact-thinking-model",
          top_provider: { context_length: 256_000 },
          supported_parameters: ["reasoning"],
          reasoning: {
            supported_efforts: ["high"],
            default_effort: "high"
          }
        }]
      });
    }
    throw new Error(`unexpected fetch: ${url}`);
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
    clearOllamaCloudModelsCache();
    clearOpenRouterModelCapabilitiesCache();
  });

  const registry = ModelRegistry.inMemory(AuthStorage.inMemory());
  await registerManorProviders(registry, {
    MANOR_OLLAMA_LOCAL_ENABLED: "0",
    MANOR_OLLAMA_CLOUD_ENABLED: "1",
    MANOR_OLLAMA_CLOUD_PROVIDER_ID: "ollama-cloud",
    MANOR_OLLAMA_CLOUD_BASE_URL: "https://ollama.example/v1",
    MANOR_OLLAMA_CLOUD_MODELS: "exact-thinking-model",
    OLLAMA_API_KEY: "test-key"
  } as NodeJS.ProcessEnv);

  const option = modelToModelOption(registry.getAvailable().find((model) => model.id === "exact-thinking-model")!);
  assert.deepEqual(option.supportedThinkingLevels, ["high"]);
  assert.deepEqual(option.supportedReasoningEfforts, ["high"]);
  const model = registry.getAvailable().find((entry) => entry.id === "exact-thinking-model")!;
  assert.equal(model.compat?.supportsReasoningEffort, true);
});

test("OpenCode Go metadata mirrors OpenCode OpenAI-compatible transform variants", () => {
  const minimaxM3 = opencodeGoModelMetadata("minimax-m3");
  assert.equal(minimaxM3.reasoning, true);
  assert.deepEqual(minimaxM3.thinkingLevelMap, {
    off: "default",
    minimal: "none",
    low: null,
    medium: null,
    high: null,
    xhigh: "thinking"
  });
  assert.equal(minimaxM3.compat?.supportsReasoningEffort, true);
  assert.equal(minimaxM3.compat?.nativeThinkingFormat, "minimax-m3");

  const glm = opencodeGoModelMetadata("glm-5.2");
  assert.equal(glm.reasoning, true);
  assert.deepEqual(glm.thinkingLevelMap, {
    off: null,
    none: null,
    minimal: null,
    low: null,
    medium: null,
    high: "high",
    xhigh: "max"
  });
  assert.equal(glm.compat?.supportsReasoningEffort, true);

  const qwen = opencodeGoModelMetadata("qwen3.7-max");
  assert.equal(qwen.reasoning, true);
  assert.deepEqual(qwen.thinkingLevelMap, {
    off: null,
    minimal: null,
    low: null,
    medium: null,
    high: null,
    xhigh: null
  });
  assert.equal(qwen.compat?.supportsReasoningEffort, false);

  const standard = opencodeGoModelMetadata("general-reasoning-model");
  assert.equal(standard.reasoning, true);
  assert.deepEqual(standard.thinkingLevelMap, {
    off: null,
    minimal: null,
    low: "low",
    medium: "medium",
    high: "high",
    xhigh: null
  });
  assert.equal(standard.compat?.supportsReasoningEffort, true);

  const deepseekV4 = opencodeGoModelMetadata("deepseek-v4.1");
  assert.deepEqual(deepseekV4.thinkingLevelMap, {
    off: null,
    minimal: null,
    low: "low",
    medium: "medium",
    high: "high",
    xhigh: "max"
  });
});

test("registerManorProviders uses live OpenCode Go models with OpenCode transform metadata", async (t) => {
  clearOpencodeGoModelsCache();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL): Promise<Response> => {
    const url = String(input);
    if (url === "https://opencode.example/zen/go/v1/models") {
      return Response.json({
        data: [
          { id: "glm-5.2" },
          { id: "minimax-m3" },
          { id: "qwen3.7-max" },
          { id: "qwen3.7-plus" },
          { id: "general-reasoning-model" },
          { id: "deepseek-v4.1" }
        ]
      });
    }
    throw new Error(`unexpected fetch: ${url}`);
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
    clearOpencodeGoModelsCache();
  });

  const registry = ModelRegistry.inMemory(AuthStorage.inMemory());
  await registerManorProviders(registry, {
    MANOR_OLLAMA_LOCAL_ENABLED: "0",
    MANOR_OLLAMA_CLOUD_ENABLED: "0",
    MANOR_OPENCODE_GO_ENABLED: "1",
    MANOR_OPENCODE_GO_BASE_URL: "https://opencode.example/zen/go/v1",
    OPENCODE_API_KEY: "test-key"
  } as NodeJS.ProcessEnv);

  const models = registry.getAvailable().filter((model) => model.provider === "opencode-go");
  assert.deepEqual(models.map((model) => model.id), ["deepseek-v4.1", "general-reasoning-model", "glm-5.2", "minimax-m3", "qwen3.7-plus", "qwen3.7-max"]);

  const glmOption = modelToModelOption(models.find((model) => model.id === "glm-5.2")!);
  assert.deepEqual(glmOption.supportedThinkingLevels, ["high", "max"]);
  assert.deepEqual(glmOption.supportedReasoningEfforts, ["high", "max"]);
  assert.equal(glmOption.defaultReasoningEffort, "high");

  const minimaxOption = modelToModelOption(models.find((model) => model.id === "minimax-m3")!);
  assert.deepEqual(minimaxOption.supportedThinkingLevels, ["default", "none", "thinking"]);
  assert.deepEqual(minimaxOption.supportedReasoningEfforts, []);
  assert.equal(minimaxOption.defaultReasoningEffort, null);
  assert.deepEqual(minimaxOption.thinkingLevelTransports, { default: "off", none: "minimal", thinking: "xhigh" });

  const qwenOption = modelToModelOption(models.find((model) => model.id === "qwen3.7-max")!);
  assert.equal(qwenOption.supportsReasoning, true);
  assert.deepEqual(qwenOption.supportedThinkingLevels, []);
  assert.deepEqual(qwenOption.supportedReasoningEfforts, []);
  assert.equal(qwenOption.defaultReasoningEffort, null);

  const standardOption = modelToModelOption(models.find((model) => model.id === "general-reasoning-model")!);
  assert.deepEqual(standardOption.supportedThinkingLevels, ["low", "medium", "high"]);
  assert.deepEqual(standardOption.supportedReasoningEfforts, ["low", "medium", "high"]);
  assert.equal(standardOption.defaultReasoningEffort, "medium");

  const maxOption = modelToModelOption(models.find((model) => model.id === "deepseek-v4.1")!);
  assert.deepEqual(maxOption.supportedThinkingLevels, ["low", "medium", "high", "max"]);
  assert.deepEqual(maxOption.supportedReasoningEfforts, ["low", "medium", "high", "max"]);
  assert.equal(maxOption.defaultReasoningEffort, "medium");
});

test("shouldExposeManorModel hides OpenCode Go when the provider is disabled", () => {
  const registry = ModelRegistry.inMemory(AuthStorage.inMemory());
  withProcessEnv({ OPENCODE_API_KEY: "test-key" }, () => {
    setActiveManorSettings(null);
    try {
      const model = registry.getAvailable().find((entry) => entry.provider === "opencode-go");
      assert.ok(model);
      assert.equal(shouldExposeManorModel(model, { MANOR_OPENCODE_GO_ENABLED: "0" } as NodeJS.ProcessEnv), false);
    } finally {
      setActiveManorSettings(null);
    }
  });
});
