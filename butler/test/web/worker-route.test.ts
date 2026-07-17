import assert from "node:assert/strict";
import test from "node:test";

import { modelOptionSelectionValue, modelOptionValue } from "../../src/web/ModelPicker";
import {
  isSameWorkerRoute,
  providerModelRef,
  workerHarnessForModel,
  workerModelForRoute,
  workerModelForSelection,
  workerModelLabel,
  workerModelPickerOption,
  workerModelSelectionId,
  workerProviderForModelLabel,
  workerProviderLabel
} from "../../src/web/worker-route";

import type { PairModelOption, PairWorkerHarness } from "../../src/shared/pairing";

function model(provider: string | null, harness: PairWorkerHarness | null, label = "Model"): PairModelOption {
  return {
    id: "model",
    label,
    provider,
    harness,
    supportedReasoningEfforts: [],
    defaultReasoningEffort: null
  };
}

test("missing provider identity stays visibly unknown", () => {
  assert.equal(workerProviderLabel(null), "Unknown provider");
});

test("provider-qualified model references never repeat their provider", () => {
  assert.equal(providerModelRef("ollama-cloud", "glm-5.2"), "ollama-cloud/glm-5.2");
  assert.equal(providerModelRef("ollama-cloud", "ollama-cloud/glm-5.2"), "ollama-cloud/glm-5.2");
  assert.equal(providerModelRef(null, "gpt-5.5"), "gpt-5.5");
});

test("worker model selection is provider-facing and transport-independent", () => {
  const pi = model("openai-codex", "pi", "Model");
  const models = [pi];
  const piOption = workerModelPickerOption(pi);

  assert.equal(modelOptionSelectionValue(piOption), piOption.selectionId);
  assert.equal(workerModelForSelection(models, modelOptionValue(piOption)), pi);
  assert.equal(workerModelForRoute(models, "model", "codex"), pi);
  assert.equal(workerModelLabel(models, "model", "pi"), "Model");
  assert.equal(isSameWorkerRoute(pi, "model", "codex"), true);
  assert.equal(piOption.hint, "OpenAI");
});

test("picker selection ids do not change legacy option values", () => {
  const option = { id: "model", label: "Model", provider: "openai-codex" };
  assert.equal(modelOptionValue(option), "openai-codex/model");
  assert.equal(modelOptionSelectionValue(option), "model");
});

test("worker harness identity is explicit and independent from provider", () => {
  assert.equal(workerProviderForModelLabel(model(null, "codex")), "Unknown provider");
  assert.equal(workerHarnessForModel(model("openai-codex", "codex")), "codex");
  assert.equal(workerHarnessForModel(model("openai-codex", "pi")), "pi");
  assert.equal(workerHarnessForModel(model("ollama-cloud", "pi")), "pi");
  assert.equal(workerHarnessForModel(model("custom-provider", "custom-harness")), "custom-harness");
  assert.equal(workerHarnessForModel(model("ollama-cloud", null)), null);
});
