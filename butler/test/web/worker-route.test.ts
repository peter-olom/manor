import assert from "node:assert/strict";
import test from "node:test";

import { workerProviderForModelLabel, workerProviderLabel, workerRuntimeForModel, workerRuntimeLabel } from "../../src/web/worker-route";

import type { PairCodexModelOption } from "../../src/shared/pairing";

function model(provider: string | null): PairCodexModelOption {
  return {
    id: "model",
    label: "Model",
    provider,
    supportedReasoningEfforts: [],
    defaultReasoningEffort: null
  };
}

test("missing persisted worker identity stays visibly unknown", () => {
  assert.equal(workerProviderLabel(null), "Unknown provider");
  assert.equal(workerRuntimeLabel(null), "Unknown harness");
});

test("Codex maps explicitly while configured non-OpenAI worker provider ids use Pi", () => {
  assert.equal(workerProviderForModelLabel(model(null)), "OpenAI / Codex");
  assert.equal(workerRuntimeForModel(model(null)), "openai");
  assert.equal(workerRuntimeForModel(model("openai-codex")), "openai");
  assert.equal(workerRuntimeForModel(model("ollama-local")), "pi-rpc");
  assert.equal(workerRuntimeForModel(model("ollama-cloud")), "pi-rpc");
  assert.equal(workerRuntimeForModel(model("opencode-go")), "pi-rpc");
  assert.equal(workerRuntimeForModel(model("custom-ollama-cloud")), "pi-rpc");
});
