import assert from "node:assert/strict";
import test from "node:test";

import { buildOnboardingView, workerOpenAiOnboardingRequired } from "../../src/server/onboarding-status.js";

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

test("OpenAI onboarding copy keeps Worker as the execution role", async () => {
  const view = await buildOnboardingView({
    butlerAuth: disconnected,
    workerAuth: disconnected,
    workerConfigDir: "/missing-codex-config",
    workerOpenAiRequired: true
  });
  const copy = view.steps.flatMap((step) => [step.detail, ...step.commandSets.map((set) => set.detail)]).join("\n");

  assert.match(copy, /Worker Pi environment/);
  assert.match(copy, /Worker terminal to start headless GitHub sign-in/);
  assert.doesNotMatch(copy, /Codex runs|Codex can use GitHub|asking Codex to clone or push/);
});

test("non-OpenAI Worker onboarding does not require OpenAI or GitHub auth", async () => {
  const view = await buildOnboardingView({
    butlerAuth: connected,
    workerAuth: disconnected,
    workerConfigDir: "/missing-codex-config",
    workerOpenAiRequired: false
  });

  assert.equal(view.complete, true);
  assert.deepEqual(view.steps.map((step) => step.id), ["butlerAuth"]);
});

test("OpenAI Worker onboarding requires Worker OpenAI and GitHub auth", async () => {
  const view = await buildOnboardingView({
    butlerAuth: connected,
    workerAuth: disconnected,
    workerConfigDir: "/missing-codex-config",
    workerOpenAiRequired: true
  });

  assert.equal(view.complete, false);
  assert.deepEqual(view.steps.map((step) => step.id), ["butlerAuth", "workerAuth", "githubAuth"]);
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

test("non-OpenAI Worker models skip OpenAI onboarding", () => {
  assert.equal(workerOpenAiOnboardingRequired(null, {
    ...routeSettings,
    worker: { defaultHarness: null, defaultModel: "ollama-cloud/glm-5.2" }
  }), false);
  assert.equal(workerOpenAiOnboardingRequired({ model: "cloud-custom/glm-5.2" }, routeSettings), false);
});

test("raw and OpenAI Worker models require OpenAI onboarding", () => {
  assert.equal(workerOpenAiOnboardingRequired({ model: "gpt-5.4" }, routeSettings), true);
  assert.equal(workerOpenAiOnboardingRequired({ model: "openai-codex/gpt-5.4" }, routeSettings), true);
  assert.equal(workerOpenAiOnboardingRequired({ model: "unknown-provider/model" }, routeSettings), true);
});
