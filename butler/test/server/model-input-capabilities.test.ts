import assert from "node:assert/strict";
import test from "node:test";

import { AuthStorage, ModelRegistry } from "@earendil-works/pi-coding-agent";
import { getModels } from "@earendil-works/pi-ai/compat";
import manifest from "../../src/server/model-input-capabilities.json" with { type: "json" };

import {
  modelInputCapabilityCatalogVersion,
  resolveModelInputCapabilities
} from "../../src/server/model-input-capabilities.js";
import { modelToModelOption, registerManorProviders } from "../../src/server/model-provider-config.js";
import { clearOllamaCloudModelsCache } from "../../src/server/ollama-cloud-models.js";

test("the bundled manifest resolves provider-qualified aliases", () => {
  assert.equal(modelInputCapabilityCatalogVersion(), "202607130154");
  assert.deepEqual(resolveModelInputCapabilities({
    modelId: "ollama-cloud/google/gemma-4",
    provider: "ollama-cloud"
  }), { image: "supported", source: "manifest" });
  assert.deepEqual(resolveModelInputCapabilities({
    modelId: "ollama-cloud/gemma4:31b",
    provider: "ollama-cloud"
  }), { image: "supported", source: "manifest" });

  assert.deepEqual(resolveModelInputCapabilities({
    modelId: "opencode-go/z-ai/glm-5.2",
    provider: "opencode-go"
  }), { image: "unsupported", source: "manifest" });
});

test("every snapshotted provider model has a manifest capability", () => {
  const missing = Object.entries(manifest.providerCatalogs).flatMap(([provider, modelIds]) =>
    modelIds.filter((modelId) => resolveModelInputCapabilities({ modelId, provider }).source !== "manifest")
      .map((modelId) => `${provider}/${modelId}`)
  );
  assert.deepEqual(missing, []);
});

test("the manifest covers and matches Manor's pinned provider catalogs", () => {
  const mismatches = ["openai-codex", "opencode-go"].flatMap((provider) =>
    getModels(provider).flatMap((model) => {
      const capability = resolveModelInputCapabilities({ modelId: model.id, provider });
      const expected = model.input.includes("image") ? "supported" : "unsupported";
      return capability.source === "manifest" && capability.image === expected
        ? []
        : [`${provider}/${model.id}: expected ${expected}, received ${capability.source}/${capability.image}`];
    })
  );
  assert.deepEqual(mismatches, []);
});

test("provider metadata takes precedence over the bundled manifest", () => {
  assert.deepEqual(resolveModelInputCapabilities({
    modelId: "gemma4",
    providerInputModalities: ["text"]
  }), { image: "unsupported", source: "provider" });
});

test("an explicit override takes precedence over provider metadata", () => {
  assert.deepEqual(resolveModelInputCapabilities({
    modelId: "glm-5.2",
    providerInputModalities: ["text"],
    override: "supported"
  }), { image: "supported", source: "override" });
});

test("unknown models remain distinct from models declared text-only", () => {
  assert.deepEqual(resolveModelInputCapabilities({
    modelId: "new-model-without-metadata"
  }), { image: "unknown", source: "unknown" });

  assert.deepEqual(resolveModelInputCapabilities({
    modelId: "new-provider-model",
    providerInputModalities: []
  }), { image: "unsupported", source: "provider" });
});

test("Pi model options preserve live input capability metadata", () => {
  const option = modelToModelOption({
    id: "live-vision-model",
    name: "Live Vision Model",
    provider: "test-provider",
    baseUrl: "https://example.test",
    api: "openai-responses",
    input: ["text", "image"],
    contextWindow: 128_000,
    maxTokens: 16_384,
    reasoning: false,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
  } as never);

  assert.deepEqual(option.inputCapabilities, { image: "supported", source: "provider" });
});

test("registered custom models retain manifest and unknown capability sources", async (t) => {
  clearOllamaCloudModelsCache();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => { throw new Error("no live discovery in this test"); }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
    clearOllamaCloudModelsCache();
  });

  const registry = ModelRegistry.inMemory(AuthStorage.inMemory());
  await registerManorProviders(registry, {
    MANOR_OLLAMA_LOCAL_ENABLED: "0",
    MANOR_OLLAMA_CLOUD_ENABLED: "1",
    MANOR_OLLAMA_CLOUD_PROVIDER_ID: "ollama-cloud",
    MANOR_OLLAMA_CLOUD_MODELS: "gemma4,new-unlisted-model",
    OLLAMA_API_KEY: "test-key"
  } as NodeJS.ProcessEnv);

  const options = registry.getAvailable()
    .filter((model) => model.provider === "ollama-cloud")
    .map(modelToModelOption);
  assert.deepEqual(options.find((model) => model.id === "gemma4")?.inputCapabilities, {
    image: "supported",
    source: "manifest"
  });
  assert.deepEqual(options.find((model) => model.id === "new-unlisted-model")?.inputCapabilities, {
    image: "unknown",
    source: "unknown"
  });
});
