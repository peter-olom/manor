import assert from "node:assert/strict";
import test from "node:test";

import {
  memoryCodexModelArgs,
  normalizeMemoryCodexModel,
  normalizeMemoryCodexModelEnv
} from "../../src/server/memory-codex-model.js";
import { resolveMemoryServiceModel, resolveMemorySynthesisModel } from "../../src/server/memory-synthesis-config.js";

test("memory Codex model normalization maps GPT display labels to Codex slugs", () => {
  assert.equal(normalizeMemoryCodexModel("5.4 mini"), "gpt-5.4-mini");
  assert.equal(normalizeMemoryCodexModel("GPT-5.4 mini"), "gpt-5.4-mini");
  assert.deepEqual(memoryCodexModelArgs("5.4 mini"), ["--model", "gpt-5.4-mini"]);
});

test("memory Codex model normalization allows valid slugs and omits invalid labels", () => {
  assert.equal(normalizeMemoryCodexModel("gpt-5.4-mini"), "gpt-5.4-mini");
  assert.equal(normalizeMemoryCodexModel("not a codex model label"), null);
  assert.deepEqual(memoryCodexModelArgs("not a codex model label"), []);
});

test("memory Codex model env normalization protects active Codex model config keys", () => {
  const env: NodeJS.ProcessEnv = {
    MANOR_MEMORY_SYNTHESIS_MODEL: "GPT-5.4 mini",
    MANOR_MEMORY_PROMOTION_MODEL: "5.4 mini",
    MANOR_WORKER_REVIEW_MODEL: "not a codex model label",
    MANOR_ROUTING_CLASSIFIER_MODEL: "gpt-5.5",
    MANOR_SESSION_TITLE_MODEL: "openai-codex/gpt-5.5"
  };

  normalizeMemoryCodexModelEnv(env);

  assert.equal(env.MANOR_MEMORY_SYNTHESIS_MODEL, "gpt-5.4-mini");
  assert.equal(env.MANOR_MEMORY_PROMOTION_MODEL, "gpt-5.4-mini");
  assert.equal(env.MANOR_WORKER_REVIEW_MODEL, undefined);
  assert.equal(env.MANOR_ROUTING_CLASSIFIER_MODEL, "gpt-5.5");
  assert.equal(env.MANOR_SESSION_TITLE_MODEL, "openai-codex/gpt-5.5");
});

test("memory synthesis model config resolves only the current synthesis model key", () => {
  assert.equal(resolveMemorySynthesisModel({ MANOR_MEMORY_SYNTHESIS_MODEL: "5.4 mini" }), "gpt-5.4-mini");
  assert.equal(resolveMemorySynthesisModel({}), null);
});

test("service-specific memory model config overrides the global synthesis default", () => {
  assert.equal(resolveMemoryServiceModel("gpt-5.5", "5.4 mini"), "gpt-5.5");
  assert.equal(resolveMemoryServiceModel("", "5.4 mini"), "gpt-5.4-mini");
  assert.equal(resolveMemoryServiceModel("invalid model", "5.4 mini"), "gpt-5.4-mini");
});
