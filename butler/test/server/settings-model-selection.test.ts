import assert from "node:assert/strict";
import test from "node:test";

import type { ModelOption } from "../../src/server/types.js";
import { resolveProviderSettingsParam, resolveSettingsModelValue, resolveWorkerSettingsSelection, timezoneInputIsValid } from "../../src/web/SettingsDashboard.js";
import { authActionLabel, authUsageHint, formatAuthSummary, type AuthStatusView } from "../../src/web/openai-auth-settings.js";
import { workerModelPickerOption } from "../../src/web/worker-route.js";

function model(id: string, provider: string, harness: "pi" | "pi" | null = null): ModelOption {
  return {
    id,
    label: id,
    provider,
    harness,
    supportsReasoning: false,
    supportedThinkingLevels: [],
    supportedReasoningEfforts: [],
    defaultReasoningEffort: null
  };
}

function auth(loggedIn: boolean): AuthStatusView {
  return { mode: loggedIn ? "chatgpt" : "none", loggedIn, validationError: null, lastValidatedAt: null };
}

test("OpenAI settings leave refresh to Pi and make real usage the confirmation", () => {
  assert.equal(formatAuthSummary(auth(true)), "Signed in with ChatGPT");
  assert.match(authUsageHint("butler", auth(true)), /Pi refreshes this sign-in automatically/);
  assert.match(authUsageHint("butler", auth(true)), /Use Check auth/);
  assert.match(authUsageHint("butler", auth(true)), /background reply/);
  assert.match(authUsageHint("worker", auth(true)), /Use Check auth/);
});

test("OpenAI settings always offer a clear connection or reconnection action", () => {
  assert.equal(authActionLabel("butler", auth(true)), "Sign in again");
  assert.equal(authActionLabel("worker", auth(true)), "Sign in again");
  assert.equal(authActionLabel("butler", auth(false)), "Connect Butler");
  assert.equal(authActionLabel("worker", auth(false)), "Connect Worker");
});

test("OpenAI settings do not describe API keys as auto-refreshing ChatGPT sign-ins", () => {
  const apiAuth: AuthStatusView = { ...auth(true), mode: "api" };
  assert.equal(formatAuthSummary(apiAuth), "Signed in with API key");
  assert.doesNotMatch(authUsageHint("butler", apiAuth), /refresh/i);
  assert.equal(authActionLabel("butler", apiAuth), "Switch to ChatGPT");
});

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

test("settings accepts supported operator timezones and rejects typos", () => {
  assert.equal(timezoneInputIsValid("Africa/Lagos"), true);
  assert.equal(timezoneInputIsValid(""), true);
  assert.equal(timezoneInputIsValid(undefined), true);
  assert.equal(timezoneInputIsValid("Africa/Lago"), false);
});

test("Worker defaults preserve the selected Pi model", () => {
  const pi = model("openai-codex/shared-model", "openai-codex", "pi");
  const piOption = workerModelPickerOption(pi);

  assert.deepEqual(resolveWorkerSettingsSelection(piOption.selectionId, [pi]), {
    defaultModel: "openai-codex/shared-model"
  });
  assert.deepEqual(resolveWorkerSettingsSelection(null, [pi]), {
    defaultModel: null
  });
});
