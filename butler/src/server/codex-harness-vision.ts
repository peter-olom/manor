import { promises as fs } from "node:fs";
import path from "node:path";

import { normalizeString, normalizeStringArray } from "./codex-harness-helpers.js";
import { getActiveManorSettings } from "./manor-settings-runtime.js";
import type { FileReferenceStore, FileReferenceView } from "./file-store.js";
import type { ImageReferenceStore, ImageReferenceView } from "./image-store.js";
import { isPiImageMimeType } from "./pi-image-loader.js";
import type { PreviewProofRecordView, PreviewVerificationArtifactView } from "./types.js";
import type { ButlerStateStore } from "./state-store.js";
import { formatVisionInspection, type VisionInspectionService } from "./vision-inspection.js";

const MAX_PROOF_IMAGE_BYTES = 3 * 1024 * 1024;
const MAX_TOTAL_PROOF_IMAGE_BYTES = 12 * 1024 * 1024;
const MAX_VISION_IMAGES = 4;
// Inspectable artifact kinds. `video`, `trace`, and `html` are never vision-inspectable.
const PROOF_FORBIDDEN_KINDS = new Set(["video", "trace", "html"]);
const PROOF_ALLOWED_KINDS = new Set(["screenshot", "file", "other", "manifest"]);

export type HarnessVisionAccess = {
  imageStore: ImageReferenceStore;
  fileStore: FileReferenceStore;
};

type ImageSource =
  | { kind: "reference"; referenceId: string; view: ImageReferenceView }
  | { kind: "proof"; artifactId: string; name: string; mimeType: string; buffer: Buffer };

export async function handleHarnessVisionAction(input: {
  action: string;
  params: Record<string, unknown>;
  threadId: string;
  store: ButlerStateStore;
  visionInspection: VisionInspectionService;
  allowedImageReferenceIds: string[];
  access?: HarnessVisionAccess | null;
}): Promise<{ text: string; data: Record<string, unknown> } | null> {
  if (input.action !== "vision.inspect") return null;
  const imageReferenceIds = normalizeStringArray(input.params.imageReferenceIds);
  const proofRunId = normalizeString(input.params.proofRunId);
  const proofArtifactSelectors = normalizeStringArray(input.params.proofArtifacts);
  const question = normalizeString(input.params.question);
  if (imageReferenceIds.length === 0 && !proofRunId) {
    throw new Error("vision.inspect requires at least one image reference id or --proof-run <runId>");
  }
  if (proofArtifactSelectors.length > 0 && !proofRunId) {
    throw new Error("vision.inspect --proof-artifact requires --proof-run <runId>");
  }
  if (!question) throw new Error("vision.inspect requires a focused question");

  const sources: ImageSource[] = [];

  // Reference attachments (and job-derived images published through the existing output flow).
  if (imageReferenceIds.length > 0) {
    if (!input.access) throw new Error("vision.inspect image references are not available in this context");
    const allowed = new Set(input.allowedImageReferenceIds);
    for (const referenceId of imageReferenceIds) {
      const view = input.access.imageStore.get(referenceId);
      if (!view) throw new Error(`Image reference ${referenceId} was not found`);
      if (allowed.has(referenceId)) {
        sources.push({ kind: "reference", referenceId, view });
        continue;
      }
      // Allow references published from a job-granted source through the existing output flow.
      const rootId = lineageRootId(referenceId, input.access);
      if (rootId && rootId !== referenceId && allowed.has(rootId)) {
        sources.push({ kind: "reference", referenceId, view });
        continue;
      }
      throw new Error("vision.inspect can only access image attachments registered to this job or images published from them through the existing output flow");
    }
  }

  // Same-job proof artifacts (browser proof screenshots and preview-rendered images).
  if (proofRunId) {
    if (!input.access) throw new Error("vision.inspect proof artifacts are not available in this context");
    const proof = findProofForThread(input.store, input.threadId, proofRunId);
    if (!proof) throw new Error(`Proof run ${proofRunId} was not found for job ${input.threadId}`);
    const selectors = proofArtifactSelectors.length > 0 ? proofArtifactSelectors : null;
    const matchingArtifacts = selectProofArtifacts(proof, selectors);
    if (matchingArtifacts.length === 0) {
      throw new Error(selectors
        ? `No inspectable image artifacts in proof run ${proofRunId} matched the requested labels`
        : `Proof run ${proofRunId} has no inspectable image artifacts`);
    }
    let totalBytes = 0;
    for (const artifact of matchingArtifacts) {
      validateProofArtifact(artifact, proofRunId);
      const sizeBytes = artifact.sizeBytes ?? 0;
      totalBytes += sizeBytes;
      if (totalBytes > MAX_TOTAL_PROOF_IMAGE_BYTES) {
        throw new Error("Requested proof artifacts exceed the 12 MiB aggregate inspection limit");
      }
      const buffer = await readProofArtifactBuffer(artifact, proofRunId);
      sources.push({
        kind: "proof",
        artifactId: `${proofRunId}:${artifact.label}`,
        name: artifact.fileName || artifact.label,
        mimeType: artifact.contentType,
        buffer
      });
    }
  }

  if (sources.length > MAX_VISION_IMAGES) {
    throw new Error(`vision.inspect accepts at most ${MAX_VISION_IMAGES} images per request`);
  }

  // Reference-only requests use the existing store-backed path with no extra file reads.
  if (sources.every((source) => source.kind === "reference")) {
    const referenceIds = sources.map((source) => (source as { kind: "reference"; referenceId: string }).referenceId);
    return runInspection({
      threadId: input.threadId,
      store: input.store,
      visionInspection: input.visionInspection,
      question,
      payload: { mode: "references", referenceIds }
    });
  }

  // Mixed or proof-only: load every source as an in-memory image and inspect together.
  const images: Array<{ id: string; name: string; mimeType: string; buffer: Buffer }> = [];
  for (const source of sources) {
    if (source.kind === "proof") {
      images.push({ id: source.artifactId, name: source.name, mimeType: source.mimeType, buffer: source.buffer });
      continue;
    }
    const filePath = input.access!.imageStore.getFilePath(source.referenceId);
    if (!filePath) throw new Error(`Image reference ${source.referenceId} has no stored file`);
    const buffer = await fs.readFile(filePath);
    if (buffer.byteLength > MAX_PROOF_IMAGE_BYTES) {
      throw new Error(`Image reference ${source.referenceId} exceeds the 3 MiB inspection limit`);
    }
    images.push({ id: source.referenceId, name: source.view.name, mimeType: source.view.mimeType, buffer });
  }
  return runInspection({
    threadId: input.threadId,
    store: input.store,
    visionInspection: input.visionInspection,
    question,
    payload: { mode: "images", images }
  });
}

async function runInspection(input: {
  threadId: string;
  store: ButlerStateStore;
  visionInspection: VisionInspectionService;
  question: string;
  payload: { mode: "references"; referenceIds: string[] } | { mode: "images"; images: Array<{ id: string; name: string; mimeType: string; buffer: Buffer }> };
}): Promise<{ text: string; data: Record<string, unknown> }> {
  let inspection;
  try {
    inspection = input.payload.mode === "references"
      ? await input.visionInspection.inspect({ imageReferenceIds: input.payload.referenceIds, question: input.question })
      : await input.visionInspection.inspectImages({ images: input.payload.images, question: input.question });
  } catch (error) {
    if (getActiveManorSettings().vision.unavailableBehavior === "block") throw error;
    const reason = error instanceof Error ? error.message : String(error);
    input.store.addEvent(input.threadId, "harness.vision.unavailable", reason);
    return { text: `Vision inspection was unavailable: ${reason}\n\nContinue without image-dependent claims.`, data: { inspection: null, unavailable: true } };
  }
  input.store.addEvent(input.threadId, "harness.vision.inspected", `${inspection.model.provider}/${inspection.model.id} inspected ${inspection.images.length} image attachment${inspection.images.length === 1 ? "" : "s"}.`);
  return { text: formatVisionInspection(inspection), data: { inspection } };
}

function lineageRootId(referenceId: string, access: HarnessVisionAccess): string | null {
  const start = access.imageStore.get(referenceId);
  if (!start) return null;
  const seen = new Set<string>();
  let current: ImageReferenceView | FileReferenceView = start;
  while (current.sourceReferenceId && !seen.has(current.id)) {
    seen.add(current.id);
    const parent: ImageReferenceView | FileReferenceView | null = access.imageStore.get(current.sourceReferenceId) ?? access.fileStore.get(current.sourceReferenceId);
    if (!parent) break;
    current = parent;
  }
  return current.id;
}

function findProofForThread(store: ButlerStateStore, threadId: string, runId: string): PreviewProofRecordView | null {
  return store.listPreviewProofs().find((proof) => proof.threadId === threadId && proof.verification.runId === runId) ?? null;
}

function selectProofArtifacts(proof: PreviewProofRecordView, selectors: string[] | null): PreviewVerificationArtifactView[] {
  const imageArtifacts = proof.verification.artifacts.filter((artifact) => isInspectableProofArtifact(artifact));
  if (!selectors) return imageArtifacts;
  const normalized = new Set(selectors.map((selector) => selector.trim().toLowerCase()));
  return imageArtifacts.filter((artifact) => {
    const label = artifact.label.trim().toLowerCase();
    const fileName = artifact.fileName.trim().toLowerCase();
    return normalized.has(label) || normalized.has(fileName);
  });
}

function isInspectableProofArtifact(artifact: PreviewVerificationArtifactView): boolean {
  if (PROOF_FORBIDDEN_KINDS.has(artifact.kind)) return false;
  if (!PROOF_ALLOWED_KINDS.has(artifact.kind)) return false;
  return isPiImageMimeType(artifact.contentType);
}

function validateProofArtifact(artifact: PreviewVerificationArtifactView, runId: string): void {
  if (artifact.availability !== "available") {
    throw new Error(`Proof artifact ${artifact.label} in run ${runId} is ${artifact.availability} and cannot be inspected`);
  }
  if (!isPiImageMimeType(artifact.contentType)) {
    throw new Error(`Proof artifact ${artifact.label} in run ${runId} has an unsupported image type (${artifact.contentType}); allowed: image/jpeg, image/png, image/gif, image/webp`);
  }
  const sizeBytes = artifact.sizeBytes ?? 0;
  if (sizeBytes > MAX_PROOF_IMAGE_BYTES) {
    throw new Error(`Proof artifact ${artifact.label} in run ${runId} exceeds the 3 MiB inspection limit`);
  }
  if (!artifact.filePath) {
    throw new Error(`Proof artifact ${artifact.label} in run ${runId} has no stored file`);
  }
}

async function readProofArtifactBuffer(artifact: PreviewVerificationArtifactView, runId: string): Promise<Buffer> {
  // Reject arbitrary file paths: only read the recorded artifact path, and only after ownership and type checks.
  const resolved = path.resolve(artifact.filePath as string);
  const stats = await fs.stat(resolved).catch(() => null);
  if (!stats?.isFile()) {
    throw new Error(`Proof artifact ${artifact.label} in run ${runId} is not a regular file`);
  }
  if ((artifact.sizeBytes ?? 0) > 0 && stats.size !== artifact.sizeBytes) {
    throw new Error(`Proof artifact ${artifact.label} in run ${runId} no longer matches its recorded size`);
  }
  return fs.readFile(resolved);
}