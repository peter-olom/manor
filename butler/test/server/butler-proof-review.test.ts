import assert from "node:assert/strict";
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
