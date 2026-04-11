import { promises as fs } from "node:fs";

import { complete, type Model } from "@mariozechner/pi-ai";
import type { AgentSession, ModelRegistry } from "@mariozechner/pi-coding-agent";

import { contentToText, parseProofScreenshotReview, type ProofScreenshotReview, type ResolvedPreviewProof } from "./butler-agent-helpers.js";

type ButlerProofReviewAccess = {
  modelRegistry: ModelRegistry | null;
  session: AgentSession | null;
};

async function resolveButlerProofReviewModel(access: ButlerProofReviewAccess): Promise<Model<any>> {
  if (!access.modelRegistry) {
    throw new Error("Butler model registry is not ready");
  }

  const currentModel = access.session?.model;
  if (currentModel?.input.includes("image")) {
    return currentModel;
  }

  const availableModels = access.modelRegistry.getAvailable().filter((model) => model.input.includes("image"));
  const currentProvider = currentModel?.provider ?? null;
  const preferredModel =
    (currentProvider ? availableModels.find((model) => model.provider === currentProvider) : null) ??
    availableModels.find((model) => model.provider === "openai-codex" || model.provider === "openai") ??
    availableModels[0];

  if (!preferredModel) {
    throw new Error("No vision-capable Butler model is available.");
  }

  return preferredModel;
}

export async function reviewButlerProofScreenshot(
  access: ButlerProofReviewAccess,
  proof: ResolvedPreviewProof,
  options?: {
    expectedOutcome?: string;
  }
): Promise<ProofScreenshotReview> {
  if (!access.modelRegistry) {
    throw new Error("Butler model registry is not ready");
  }

  const model = await resolveButlerProofReviewModel(access);
  const auth = await access.modelRegistry.getApiKeyAndHeaders(model);
  if (!auth.ok) {
    throw new Error(auth.error);
  }

  const screenshotBuffer = await fs.readFile(proof.screenshot.filePath);
  const reviewPrompt = [
    "Review this Playwright screenshot as proof of frontend execution.",
    "Be strict and describe only what is visibly present in the screenshot.",
    "Return JSON only with keys verdict, visibleState, evidence, concern.",
    "Set verdict to one of: credible, unclear, failed.",
    options?.expectedOutcome?.trim() ? `Expected outcome: ${options.expectedOutcome.trim()}` : "",
    `Preview title: ${proof.preview.title}`,
    `Verification mode: ${proof.verification.mode}`,
    `Verification status: ${proof.verification.status ?? "none"}`,
    `Verification failure kind: ${proof.verification.failureKind}`,
    `Readiness route ok: ${proof.verification.readiness.routeOk}`,
    `Readiness login redirect detected: ${proof.verification.readiness.loginRedirectDetected}`
  ]
    .filter(Boolean)
    .join("\n");

  const response = await complete(
    model,
    {
      systemPrompt:
        "You are a strict UI proof reviewer. Judge only what is clearly visible. Do not assume success when the page looks blank, loading, or error-like.",
      messages: [
        {
          role: "user",
          timestamp: Date.now(),
          content: [
            { type: "text", text: reviewPrompt },
            {
              type: "image",
              data: screenshotBuffer.toString("base64"),
              mimeType: proof.screenshot.contentType || "image/png"
            }
          ]
        }
      ]
    },
    {
      apiKey: auth.apiKey,
      headers: auth.headers
    }
  );

  if (response.stopReason === "error" || response.stopReason === "aborted") {
    throw new Error(response.errorMessage || "Butler screenshot review failed.");
  }

  const rawText = contentToText(response.content).trim();
  if (!rawText) {
    throw new Error("Butler screenshot review returned no text.");
  }

  const parsed = parseProofScreenshotReview(rawText) ?? {
    verdict: "unclear",
    visibleState: "The screenshot review model returned unstructured output.",
    evidence: rawText,
    concern: "Review output needs manual interpretation.",
    rawText,
    reviewedAt: Date.now(),
    modelId: "",
    modelProvider: ""
  };

  return {
    ...parsed,
    rawText,
    reviewedAt: Date.now(),
    modelId: model.id,
    modelProvider: model.provider
  };
}
