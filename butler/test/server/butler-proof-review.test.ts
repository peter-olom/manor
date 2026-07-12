import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { buildButlerProofReviewCompletionOptions, reviewButlerProofScreenshot } from "../../src/server/butler-agent-proof-review.js";

test("proof review sends an explicit off reasoning level", () => {
  const options = buildButlerProofReviewCompletionOptions(
    { id: "gpt-pinned", name: "Pinned", provider: "openai-codex", reasoning: true } as never,
    { apiKey: "test" },
    { reasoningLevel: "off" }
  );
  assert.equal(options.reasoning, "off");
});

test("proof review honors cancellation before model work", async () => {
  await assert.rejects(() => reviewButlerProofScreenshot(
    { modelRegistry: {} as never, session: null },
    { artifacts: [] } as never,
    { signal: AbortSignal.abort() }
  ), /abort/i);
});

test("proof review never substitutes a different model for a pinned review", async () => {
  await assert.rejects(() => reviewButlerProofScreenshot(
    { modelRegistry: { getAvailable: () => [] } as never, session: null },
    { artifacts: [] } as never,
    { modelProvider: "openai-codex", modelId: "gpt-pinned", reasoningLevel: "high" }
  ), /pinned.*no longer available/i);
});

test("proof review falls back to a vision model when the callback model is text-only", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "manor-proof-review-"));
  const imagePath = path.join(dir, "final.png");
  await writeFile(imagePath, Buffer.from("image"));
  const pinned = { id: "glm-5.2", name: "GLM", provider: "ollama-cloud", reasoning: true, input: ["text"] };
  const vision = { id: "gpt-5.5", name: "GPT", provider: "openai-codex", reasoning: true, input: ["text", "image"] };
  let selectedModel = "";

  const review = await reviewButlerProofScreenshot(
    {
      modelRegistry: {
        getAvailable: () => [pinned, vision],
        getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "test", headers: {} })
      } as never,
      session: null,
      completeModel: (async (model: { id: string }) => {
        selectedModel = model.id;
        return {
          stopReason: "stop",
          content: [{ type: "text", text: JSON.stringify({ verdict: "credible", visibleState: "Final state", evidence: "Visible", concern: "" }) }]
        };
      }) as never
    },
    {
      artifacts: [{ kind: "screenshot", label: "Final screenshot", fileName: "final.png", filePath: imagePath, contentType: "image/png", availability: "available", sizeBytes: 5 }],
      screenshots: [],
      video: null,
      preview: { title: "Proof" },
      verification: { mode: "manual", status: null, failureKind: "none", readiness: { routeOk: true, loginRedirectDetected: false } }
    } as never,
    { modelProvider: pinned.provider, modelId: pinned.id, reasoningLevel: "high" }
  );

  assert.equal(selectedModel, vision.id);
  assert.equal(review.modelId, vision.id);
});

test("proof review rejects a provider result that arrives after cancellation", async () => {
  const controller = new AbortController();
  const model = { id: "gpt-pinned", name: "Pinned", provider: "openai-codex", reasoning: true, input: ["text"] };
  await assert.rejects(() => reviewButlerProofScreenshot(
    {
      modelRegistry: {
        getAvailable: () => [model],
        getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "test", headers: {} })
      } as never,
      session: null,
      completeModel: (async () => {
        controller.abort();
        return { stopReason: "stop", content: [{ type: "text", text: "{}" }] };
      }) as never
    },
    {
      artifacts: [],
      preview: { title: "Proof" },
      verification: { mode: "manual", status: null, failureKind: "none", readiness: { routeOk: true, loginRedirectDetected: false } }
    } as never,
    { signal: controller.signal, modelProvider: model.provider, modelId: model.id, reasoningLevel: "off" }
  ), /abort/i);
});
