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
  registerManorProviders,
  syncManorPiModelsJson
} from "../../src/server/model-provider-config.js";

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

test("registerManorProviders registers Ollama Cloud models from env", async () => {
  const registry = ModelRegistry.inMemory(AuthStorage.inMemory());
  await registerManorProviders(registry, {
    MANOR_OLLAMA_LOCAL_ENABLED: "0",
    MANOR_OLLAMA_CLOUD_ENABLED: "1",
    MANOR_OLLAMA_CLOUD_PROVIDER_ID: "ollama-cloud",
    MANOR_OLLAMA_CLOUD_BASE_URL: "https://ollama.example/v1",
    MANOR_OLLAMA_CLOUD_MODELS: "glm-5.2,kimi-k2.6",
    OLLAMA_API_KEY: "test-key"
  } as NodeJS.ProcessEnv);

  const models = registry.getAvailable().filter((model) => model.provider === "ollama-cloud");
  assert.deepEqual(models.map((model) => `${model.provider}/${model.id}`), [
    "ollama-cloud/glm-5.2",
    "ollama-cloud/kimi-k2.6"
  ]);
  assert.equal(models[0]?.baseUrl, "https://ollama.example/v1");
  assert.equal(models[0]?.compat?.maxTokensField, "max_tokens");
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

test("modelToModelOption preserves provider labels for UI selectors", async () => {
  const registry = ModelRegistry.inMemory(AuthStorage.inMemory());
  await registerManorProviders(registry, {
    MANOR_OLLAMA_LOCAL_ENABLED: "0",
    MANOR_OLLAMA_CLOUD_ENABLED: "1",
    MANOR_OLLAMA_CLOUD_PROVIDER_ID: "ollama-cloud",
    MANOR_OLLAMA_CLOUD_MODELS: "glm-5.2",
    OLLAMA_API_KEY: "test-key"
  } as NodeJS.ProcessEnv);
  const option = modelToModelOption(registry.getAvailable().find((model) => model.provider === "ollama-cloud")!);
  assert.equal(option.id, "glm-5.2");
  assert.equal(option.provider, "ollama-cloud");
  assert.equal(option.supportsReasoning, true);
  assert.ok(option.supportedReasoningEfforts.includes("medium"));
});
