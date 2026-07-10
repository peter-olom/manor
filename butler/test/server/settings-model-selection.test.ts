import assert from "node:assert/strict";
import test from "node:test";

import type { ModelOption } from "../../src/server/types.js";
import { resolveProviderSettingsParam, resolveSettingsModelValue } from "../../src/web/SettingsDashboard.js";

function model(id: string, provider: string): ModelOption {
  return {
    id,
    label: id,
    provider,
    supportsReasoning: false,
    supportedThinkingLevels: [],
    supportedReasoningEfforts: [],
    defaultReasoningEffort: null
  };
}

test("settings resolves a legacy unqualified model when only one provider serves it", () => {
  assert.equal(
    resolveSettingsModelValue("gpt-5.4-mini", [model("openai-codex/gpt-5.4-mini", "openai-codex")]),
    "openai-codex/gpt-5.4-mini"
  );
});

test("settings keeps an ambiguous unqualified model unresolved", () => {
  assert.equal(
    resolveSettingsModelValue("glm-5.2", [
      model("opencode-go/glm-5.2", "opencode-go"),
      model("ollama-cloud/glm-5.2", "ollama-cloud")
    ]),
    null
  );
});

test("settings preserves an exact provider-qualified model", () => {
  assert.equal(
    resolveSettingsModelValue("ollama-cloud/glm-5.2", [model("ollama-cloud/glm-5.2", "ollama-cloud")]),
    "ollama-cloud/glm-5.2"
  );
});

test("settings maps custom provider ids to their provider remediation tab", () => {
  assert.equal(resolveProviderSettingsParam("custom-go", { "custom-go": "opencode" }), "opencode");
  assert.equal(resolveProviderSettingsParam("unknown", {}), null);
});
