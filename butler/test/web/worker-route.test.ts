import assert from "node:assert/strict";
import test from "node:test";

import { modelOptionSelectionValue, modelOptionValue } from "../../src/web/ModelPicker";
import {
  isSameWorkerRoute,
  workerHarnessForModel,
  workerHarnessLabel,
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

test("missing persisted worker identity stays visibly unknown", () => {
  assert.equal(workerProviderLabel(null), "Unknown provider");
  assert.equal(workerHarnessLabel(null), "Unknown harness");
});

test("duplicate provider and model ids remain distinct across Worker harnesses", () => {
  const codex = model("openai-codex", "codex", "Model through Codex");
  const pi = model("openai-codex", "pi", "Model through Pi");
  const models = [codex, pi];
  const codexOption = workerModelPickerOption(codex);
  const piOption = workerModelPickerOption(pi);

  assert.notEqual(workerModelSelectionId(codex), workerModelSelectionId(pi));
  assert.notEqual(modelOptionValue(codexOption), modelOptionValue(piOption));
  assert.equal(modelOptionSelectionValue(piOption), piOption.selectionId);
  assert.equal(workerModelForSelection(models, modelOptionValue(piOption)), pi);
  assert.equal(workerModelForRoute(models, "model", "codex"), codex);
  assert.equal(workerModelForRoute([pi], "model", "codex"), null);
  assert.equal(workerModelLabel(models, "model", "pi"), "Model through Pi");
  assert.equal(isSameWorkerRoute(pi, "model", "codex"), false);
  assert.equal(codexOption.hint, "Codex harness");
  assert.equal(piOption.hint, "Pi harness");
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
  assert.equal(workerHarnessLabel("codex"), "Codex");
  assert.equal(workerHarnessLabel("pi"), "Pi");
});
