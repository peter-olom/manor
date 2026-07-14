import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { buildButlerProofReviewCompletionOptions, reviewButlerProofScreenshot } from "../../src/server/butler-agent-proof-review.js";
import { getActiveManorSettings, setActiveManorSettings } from "../../src/server/manor-settings-runtime.js";

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

test("proof review sends images to the configured companion instead of a manifest text-only callback model", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "manor-proof-review-"));
  const imagePath = path.join(dir, "final.png");
  await writeFile(imagePath, Buffer.from("image"));
  const settings = getActiveManorSettings({} as NodeJS.ProcessEnv);
  settings.vision.companionModel = "ollama-cloud/gemma4:31b";
  setActiveManorSettings(settings);
  t.after(() => setActiveManorSettings(null));
  // Provider metadata can overstate image support. Manor's capability manifest
  // is the transport contract and declares GLM 5.2 text-only.
  const pinned = {
    id: "glm-5.2",
    name: "GLM",
    provider: "ollama-cloud",
    reasoning: true,
    input: ["text", "image"],
    compat: { manorInputCapabilities: { image: "unsupported", source: "manifest" } }
  };
  const otherVision = { id: "devstral-small-2:24b", name: "Devstral", provider: "ollama-cloud", reasoning: true, input: ["text", "image"] };
  const vision = { id: "gemma4:31b", name: "Gemma", provider: "ollama-cloud", reasoning: true, input: ["text", "image"] };
  let selectedModel = "";
  let selectedContent: Array<{ type: string }> = [];

  const review = await reviewButlerProofScreenshot(
    {
      modelRegistry: {
        getAvailable: () => [pinned, otherVision, vision],
        getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "test", headers: {} })
      } as never,
      session: null,
      completeModel: (async (model: { id: string }, context: { messages: Array<{ content: Array<{ type: string }> }> }) => {
        selectedModel = model.id;
        selectedContent = context.messages[0]?.content ?? [];
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
  assert.equal(selectedContent.some((item) => item.type === "image"), true);
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
