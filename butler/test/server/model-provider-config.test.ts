import assert from "node:assert/strict";
import test from "node:test";

import { AuthStorage, ModelRegistry } from "@mariozechner/pi-coding-agent";

import {
  isCodexPreferredModelRef,
  modelToModelOption,
  parseProviderModelRef,
  registerManorProviders
} from "../../src/server/model-provider-config.js";

test("parseProviderModelRef handles provider-qualified and plain model ids", () => {
  assert.deepEqual(parseProviderModelRef("ollama-cloud/glm-5.2"), { provider: "ollama-cloud", model: "glm-5.2" });
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
    MANOR_OLLAMA_CLOUD_ENABLED: "1",
    MANOR_OLLAMA_CLOUD_PROVIDER_ID: "ollama-cloud",
    MANOR_OLLAMA_CLOUD_BASE_URL: "https://ollama.example/v1",
    MANOR_OLLAMA_CLOUD_MODELS: "glm-5.2,kimi-k2.6",
    OLLAMA_API_KEY: "test-key"
  } as NodeJS.ProcessEnv);

  const models = registry.getAvailable();
  assert.deepEqual(models.map((model) => `${model.provider}/${model.id}`), [
    "ollama-cloud/glm-5.2",
    "ollama-cloud/kimi-k2.6"
  ]);
  assert.equal(models[0]?.baseUrl, "https://ollama.example/v1");
});

test("modelToModelOption preserves provider labels for UI selectors", async () => {
  const registry = ModelRegistry.inMemory(AuthStorage.inMemory());
  await registerManorProviders(registry, {
    MANOR_OLLAMA_CLOUD_ENABLED: "1",
    MANOR_OLLAMA_CLOUD_PROVIDER_ID: "ollama-cloud",
    MANOR_OLLAMA_CLOUD_MODELS: "glm-5.2",
    OLLAMA_API_KEY: "test-key"
  } as NodeJS.ProcessEnv);
  const option = modelToModelOption(registry.getAvailable()[0]!);
  assert.equal(option.id, "glm-5.2");
  assert.equal(option.provider, "ollama-cloud");
  assert.equal(option.supportsReasoning, true);
  assert.ok(option.supportedReasoningEfforts.includes("medium"));
});
