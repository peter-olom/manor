import assert from "node:assert/strict";
import test from "node:test";

import {
  memoryCodexModelArgs,
  normalizeMemoryCodexModel,
  normalizeMemoryCodexModelEnv
} from "../../src/server/memory-codex-model.js";
import { resolveMemorySynthesisModel } from "../../src/server/memory-synthesis-config.js";

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

test("memory Codex model env normalization protects review and synthesis config keys", () => {
  const env: NodeJS.ProcessEnv = {
    MANOR_MEMORY_REVIEW_MODEL: "5.4 mini",
    MANOR_MEMORY_SYNTHESIS_MODEL: "GPT-5.4 mini",
    MANOR_MEMORY_EXEC_MODEL: "not a codex model label"
  };

  normalizeMemoryCodexModelEnv(env);

  assert.equal(env.MANOR_MEMORY_REVIEW_MODEL, "gpt-5.4-mini");
  assert.equal(env.MANOR_MEMORY_SYNTHESIS_MODEL, "gpt-5.4-mini");
  assert.equal(env.MANOR_MEMORY_EXEC_MODEL, undefined);
});

test("memory synthesis model config resolves display labels to slugs and leaves absent config unforced", () => {
  assert.equal(resolveMemorySynthesisModel({ MANOR_MEMORY_SYNTHESIS_MODEL: "5.4 mini" }), "gpt-5.4-mini");
  assert.equal(resolveMemorySynthesisModel({ MANOR_MEMORY_EXEC_MODEL: "gpt-5.4-mini" }), "gpt-5.4-mini");
  assert.equal(resolveMemorySynthesisModel({}), null);
});
