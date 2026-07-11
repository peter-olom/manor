import assert from "node:assert/strict";
import test from "node:test";

import { buildOnboardingView, codexHarnessOnboardingRequired } from "../../src/server/onboarding-status.js";

const disconnected = {
  mode: "none" as const,
  loggedIn: false,
  validationError: null,
  lastValidatedAt: null
};

const connected = {
  mode: "chatgpt" as const,
  loggedIn: true,
  validationError: null,
  lastValidatedAt: Date.now()
};

test("Codex onboarding copy keeps Worker as the execution role", async () => {
  const view = await buildOnboardingView({
    butlerAuth: disconnected,
    codexAuth: disconnected,
    codexConfigDir: "/missing-codex-config",
    codexHarnessRequired: true
  });
  const copy = view.steps.flatMap((step) => [step.detail, ...step.commandSets.map((set) => set.detail)]).join("\n");

  assert.match(copy, /Worker jobs through the Codex harness/);
  assert.match(copy, /Worker through it to clone or push repositories/);
  assert.doesNotMatch(copy, /Codex runs|Codex can use GitHub|asking Codex to clone or push/);
});

test("Pi-only Worker onboarding does not require Codex or GitHub auth", async () => {
  const view = await buildOnboardingView({
    butlerAuth: connected,
    codexAuth: disconnected,
    codexConfigDir: "/missing-codex-config",
    codexHarnessRequired: false
  });

  assert.equal(view.complete, true);
  assert.deepEqual(view.steps.map((step) => step.id), ["butlerAuth"]);
});

test("Codex Worker onboarding still requires Codex and GitHub auth", async () => {
  const view = await buildOnboardingView({
    butlerAuth: connected,
    codexAuth: disconnected,
    codexConfigDir: "/missing-codex-config",
    codexHarnessRequired: true
  });

  assert.equal(view.complete, false);
  assert.deepEqual(view.steps.map((step) => step.id), ["butlerAuth", "codexAuth", "githubAuth"]);
  assert.deepEqual(view.steps.map((step) => step.status), ["complete", "pending", "pending"]);
});

const routeSettings = {
  overview: { workerProvider: "openai-codex" },
  worker: { defaultHarness: null, defaultModel: null },
  providers: {
    ollamaLocal: { providerId: "local-custom" },
    ollamaCloud: { providerId: "cloud-custom" },
    opencodeGo: { providerId: "go-custom" }
  }
};

test("provider-qualified Pi Worker models skip Codex onboarding without a saved harness", () => {
  assert.equal(codexHarnessOnboardingRequired(null, {
    ...routeSettings,
    worker: { defaultHarness: null, defaultModel: "ollama-cloud/glm-5.2" }
  }), false);
  assert.equal(codexHarnessOnboardingRequired({ model: "cloud-custom/glm-5.2" }, routeSettings), false);
});

test("raw and OpenAI Worker models still require Codex onboarding", () => {
  assert.equal(codexHarnessOnboardingRequired({ model: "gpt-5.4" }, routeSettings), true);
  assert.equal(codexHarnessOnboardingRequired({ model: "openai-codex/gpt-5.4" }, routeSettings), true);
  assert.equal(codexHarnessOnboardingRequired({ model: "unknown-provider/model" }, routeSettings), true);
});
