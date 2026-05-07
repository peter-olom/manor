import { promises as fs } from "node:fs";

import { complete, type Model } from "@mariozechner/pi-ai";
import type { AgentSession, ModelRegistry } from "@mariozechner/pi-coding-agent";

import { contentToText, parseProofScreenshotReview, type ProofScreenshotReview, type ResolvedPreviewProof } from "./butler-agent-helpers.js";
import { inspectProofArtifacts } from "./proof-artifact-inspector.js";

type ButlerProofReviewAccess = {
  modelRegistry: ModelRegistry | null;
  session: AgentSession | null;
};

async function resolveButlerProofReviewModel(access: ButlerProofReviewAccess, needsVision: boolean): Promise<Model<any>> {
  if (!access.modelRegistry) {
    throw new Error("Butler model registry is not ready");
  }

  const currentModel = access.session?.model;
  if (currentModel && (!needsVision || currentModel.input.includes("image"))) {
    return currentModel;
  }

  const availableModels = access.modelRegistry.getAvailable().filter((model) => !needsVision || model.input.includes("image"));
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

  const inspection = await inspectProofArtifacts(proof.artifacts);
  const preferredScreenshots = inspection.imageArtifacts.filter((artifact) => /after script|final/i.test(artifact.label));
  const images = (preferredScreenshots.length > 0 ? preferredScreenshots : inspection.imageArtifacts).slice(-4);
  const imagePayloads = await Promise.all(
    images.map(async (artifact) => ({
      artifact,
      buffer: await fs.readFile(artifact.filePath)
    }))
  );
  const model = await resolveButlerProofReviewModel(access, imagePayloads.length > 0);
  const auth = await access.modelRegistry.getApiKeyAndHeaders(model);
  if (!auth.ok) {
    throw new Error(auth.error);
  }

  const reviewPrompt = [
    "Review these proof artifacts. They may be browser screenshots/video, desktop screenshots/logs, or standalone files.",
    "Be strict and describe only what the artifacts directly support.",
    "Return JSON only with keys verdict, visibleState, evidence, concern.",
    "Set verdict to one of: credible, unclear, failed.",
    options?.expectedOutcome?.trim() ? `Expected outcome: ${options.expectedOutcome.trim()}` : "",
    `Proof title: ${proof.preview.title}`,
    `Artifacts:\n${inspection.artifactSummary}`,
    imagePayloads.length > 0 ? `Image sequence: ${images.map((artifact) => artifact.label).join(", ")}` : "",
    inspection.textEvidence ? `Inspected artifact evidence:\n${inspection.textEvidence}` : "",
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
        "You are a strict proof reviewer. Judge only what is directly visible or readable in the supplied artifacts. Do not assume success from filenames alone.",
      messages: [
        {
          role: "user",
          timestamp: Date.now(),
          content: [
            { type: "text", text: reviewPrompt },
            ...imagePayloads.map(({ artifact, buffer }) => ({
              type: "image" as const,
              data: buffer.toString("base64"),
              mimeType: artifact.contentType || "image/png"
            }))
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
    throw new Error(response.errorMessage || "Butler proof review failed.");
  }

  const rawText = contentToText(response.content).trim();
  if (!rawText) {
    throw new Error("Butler proof review returned no text.");
  }

  const parsed = parseProofScreenshotReview(rawText) ?? {
    verdict: "unclear",
    visibleState: "The proof review model returned unstructured output.",
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
