import test from "node:test";
import assert from "node:assert/strict";

import { buildCodexAdversarialReviewArgs, shouldUseNativeCodexReview } from "../../src/server/butler-adversarial-review.js";
import { isolatedModelResourceOptions } from "../../src/server/isolated-model-resources.js";

test("Codex adversarial review uses the selected model and reasoning and reads Butler's prompt from stdin", () => {
  const args = buildCodexAdversarialReviewArgs({
    schemaPath: "/tmp/schema.json",
    outputPath: "/tmp/output.json",
    modelId: "gpt-5.5",
    thinkingLevel: "high"
  });

  assert.deepEqual(args, [
    "exec",
    "--sandbox",
    "read-only",
    "--ephemeral",
    "--ignore-user-config",
    "--skip-git-repo-check",
    "--ignore-rules",
    "--output-schema",
    "/tmp/schema.json",
    "--output-last-message",
    "/tmp/output.json",
    "--model",
    "gpt-5.5",
    "--config",
    'model_reasoning_effort="high"',
    "review",
    "-"
  ]);
  assert.equal(args.at(-1), "-");
  assert.equal(args.includes("--uncommitted"), false);
  assert.equal(args.includes("Review this closeout."), false);
});

test("native Codex review is limited to the Codex provider credential", () => {
  assert.equal(shouldUseNativeCodexReview("openai-codex", true), true);
  assert.equal(shouldUseNativeCodexReview("codex", true), true);
  assert.equal(shouldUseNativeCodexReview("openai", true), false);
  assert.equal(shouldUseNativeCodexReview("openai-codex", false), false);
});

test("isolated review sessions disable ambient Pi resources", () => {
  const options = isolatedModelResourceOptions();
  assert.equal(options.noExtensions, true);
  assert.equal(options.noSkills, true);
  assert.equal(options.noPromptTemplates, true);
  assert.equal(options.noThemes, true);
  assert.equal(options.noContextFiles, true);
  assert.deepEqual(options.appendSystemPromptOverride(), []);
});
