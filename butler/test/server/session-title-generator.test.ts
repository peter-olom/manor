import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  fallbackSessionTitle,
  normalizeSessionTitleModel,
  PiSessionTitleGenerator,
  readSessionTitleConfig,
  sanitizeSessionTitle
} from "../../src/server/session-title-generator.js";

test("sanitizeSessionTitle trims quotes, punctuation, and caps at four words", () => {
  assert.equal(sanitizeSessionTitle("\"Fix checkout retry flow now.\""), "Fix checkout retry flow");
  assert.equal(sanitizeSessionTitle("  Plan   API billing migration!!! "), "Plan API billing migration");
});

test("sanitizeSessionTitle falls back for blank output", () => {
  assert.equal(sanitizeSessionTitle("   ", "Feature: Auto add session title"), "Feature Auto add session");
});

test("fallbackSessionTitle creates a deterministic short title", () => {
  assert.equal(fallbackSessionTitle("Can you investigate the deployment failure today?"), "Can you investigate the");
});

test("readSessionTitleConfig supports a title-specific model and timeout", () => {
  const config = readSessionTitleConfig({
    MANOR_SESSION_TITLE_MODEL: "5.4 mini",
    MANOR_MEMORY_SYNTHESIS_MODEL: "gpt-5.5",
    MANOR_SESSION_TITLE_TIMEOUT_MS: "2500"
  } as NodeJS.ProcessEnv);
  assert.equal(config.model, "gpt-5.4-mini");
  assert.equal(config.timeoutMs, 2500);
});

test("readSessionTitleConfig supports provider-qualified title models", () => {
  const config = readSessionTitleConfig({
    MANOR_SESSION_TITLE_MODEL: "openai-codex/gpt-5.5",
    MANOR_MEMORY_SYNTHESIS_MODEL: "gpt-5.4-mini"
  } as NodeJS.ProcessEnv);
  assert.equal(config.model, "openai-codex/gpt-5.5");
});

test("normalizeSessionTitleModel rejects invalid model references", () => {
  assert.equal(normalizeSessionTitleModel("openai-codex/gpt-5.4-mini"), "openai-codex/gpt-5.4-mini");
  assert.equal(normalizeSessionTitleModel("ollama-local/qwen3%3A8b"), "ollama-local/qwen3:8b");
  assert.equal(normalizeSessionTitleModel("openrouter/anthropic/claude-sonnet-4"), "openrouter/anthropic/claude-sonnet-4");
  assert.equal(normalizeSessionTitleModel("not a model"), null);
});

test("PiSessionTitleGenerator returns sanitized runner output", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "manor-title-test-"));
  const generator = new PiSessionTitleGenerator({
    piAuthPath: path.join(dir, "auth.json"),
    runner: async () => ({ title: "\"Review checkout retries today\"" })
  });

  assert.equal(await generator.generateTitle({ firstUserPrompt: "Please review checkout retries." }), "Review checkout retries today");
});

test("PiSessionTitleGenerator falls back for malformed runner output", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "manor-title-test-"));
  const generator = new PiSessionTitleGenerator({
    piAuthPath: path.join(dir, "auth.json"),
    runner: async () => "not json"
  });

  assert.equal(await generator.generateTitle({ firstUserPrompt: "Feature: Auto add session title" }), "Feature Auto add session");
});

test("PiSessionTitleGenerator falls back when runner fails", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "manor-title-test-"));
  const generator = new PiSessionTitleGenerator({
    piAuthPath: path.join(dir, "auth.json"),
    runner: async () => {
      throw new Error("pi completion failed");
    }
  });

  assert.equal(await generator.generateTitle({ firstUserPrompt: "Feature: Auto add session title" }), "Feature Auto add session");
});
