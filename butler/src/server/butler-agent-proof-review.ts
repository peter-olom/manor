import { promises as fs } from "node:fs";

import { complete, type Model } from "@earendil-works/pi-ai/compat";
import type { AgentSession, ModelRegistry } from "@earendil-works/pi-coding-agent";

import { contentToText, parseProofScreenshotReview, type ProofScreenshotReview, type ResolvedPreviewProof } from "./butler-agent-helpers.js";
import { modelToModelOption, parseProviderModelRef } from "./model-provider-config.js";
import { applyOpencodeGoNativeThinkingPayload } from "./pi-opencode-web-tools-extension.js";
import { piThinkingLevelForModelOption } from "./pi-thinking-levels.js";
import { inspectProofArtifacts } from "./proof-artifact-inspector.js";
import type { ButlerThinkingLevel } from "./types.js";
import { getActiveManorSettings } from "./manor-settings-runtime.js";

type ButlerProofReviewAccess = {
  modelRegistry: ModelRegistry | null;
  session: AgentSession | null;
  completeModel?: typeof complete;
};

type ButlerProofReviewOptions = {
  expectedOutcome?: string;
  signal?: AbortSignal;
  modelProvider?: string;
  modelId?: string;
  reasoningLevel?: ButlerThinkingLevel;
};

function matchesConfiguredModel(model: Model<any>, configured: string | null): boolean {
  const ref = parseProviderModelRef(configured);
  if (!ref.model || (ref.provider && ref.provider !== model.provider)) return false;
  const qualified = model.id.startsWith(`${model.provider}/`) ? model.id : `${model.provider}/${model.id}`;
  return ref.model === model.id || configured === qualified;
}

export function buildButlerProofReviewCompletionOptions(
  model: Model<any>,
  auth: { apiKey?: string; headers?: Record<string, string> },
  options?: ButlerProofReviewOptions
) {
  const reasoning = options?.reasoningLevel
    ? piThinkingLevelForModelOption(options.reasoningLevel, modelToModelOption(model))
    : null;
  return {
    apiKey: auth.apiKey,
    headers: auth.headers,
    signal: options?.signal,
    timeoutMs: 60_000,
    ...(reasoning ? { reasoning } : {}),
    onPayload: (payload: unknown) => applyOpencodeGoNativeThinkingPayload(payload)
  };
}

async function resolveButlerProofReviewModel(access: ButlerProofReviewAccess, needsVision: boolean, pinned?: { provider?: string; id?: string }): Promise<Model<any>> {
  if (!access.modelRegistry) {
    throw new Error("Butler model registry is not ready");
  }

  const availableModels = access.modelRegistry.getAvailable();
  if (pinned?.id) {
    const pinnedModel = availableModels.find((model) => model.id === pinned.id && (!pinned.provider || model.provider === pinned.provider));
    if (!pinnedModel) throw new Error("The Butler model pinned for proof review is no longer available. Reconnect it in Settings → Providers, then retry.");
    if (!needsVision || modelToModelOption(pinnedModel).inputCapabilities.image === "supported") return pinnedModel;
  }

  const currentModel = access.session?.model;
  if (currentModel && (!needsVision || modelToModelOption(currentModel).inputCapabilities.image === "supported")) {
    return currentModel;
  }

  const compatibleModels = availableModels.filter((model) => !needsVision || modelToModelOption(model).inputCapabilities.image === "supported");
  const currentProvider = currentModel?.provider ?? null;
  const companionModel = getActiveManorSettings().vision.companionModel;
  const preferredModel =
    (companionModel ? compatibleModels.find((model) => matchesConfiguredModel(model, companionModel)) : null) ??
    (currentProvider ? compatibleModels.find((model) => model.provider === currentProvider) : null) ??
    compatibleModels.find((model) => model.provider === "openai-codex" || model.provider === "openai") ??
    compatibleModels[0];

  if (!preferredModel) {
    throw new Error("No vision-capable Butler model is available.");
  }

  return preferredModel;
}

export async function reviewButlerProofScreenshot(
  access: ButlerProofReviewAccess,
  proof: ResolvedPreviewProof,
  options?: ButlerProofReviewOptions
): Promise<ProofScreenshotReview> {
  if (!access.modelRegistry) {
    throw new Error("Butler model registry is not ready");
  }

  options?.signal?.throwIfAborted();
  const inspection = await inspectProofArtifacts(proof.artifacts);
  const preferredScreenshots = inspection.imageArtifacts.filter((artifact) => /after script|final/i.test(artifact.label));
  const images = (preferredScreenshots.length > 0 ? preferredScreenshots : inspection.imageArtifacts).slice(-4);
  const imagePayloads = await Promise.all(
    images.map(async (artifact) => ({
      artifact,
      buffer: await fs.readFile(artifact.filePath)
    }))
  );
  options?.signal?.throwIfAborted();
  const model = await resolveButlerProofReviewModel(access, imagePayloads.length > 0, { provider: options?.modelProvider, id: options?.modelId });
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
    proof.video ? "A video recording is stored for operator playback. Review the accompanying screenshots as the visible checkpoints and do not claim unseen video moments." : "",
    inspection.textEvidence ? `Inspected artifact evidence:\n${inspection.textEvidence}` : "",
    `Verification mode: ${proof.verification.mode}`,
    `Verification status: ${proof.verification.status ?? "none"}`,
    `Verification failure kind: ${proof.verification.failureKind}`,
    `Readiness route ok: ${proof.verification.readiness.routeOk}`,
    `Readiness login redirect detected: ${proof.verification.readiness.loginRedirectDetected}`
  ]
    .filter(Boolean)
    .join("\n");

  const response = await (access.completeModel ?? complete)(
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
    buildButlerProofReviewCompletionOptions(model, auth, options)
  );
  options?.signal?.throwIfAborted();

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
