import crypto from "node:crypto";

import { normalizeWorkerClaimsReport } from "./butler-orchestration.js";
import { proofHasVisualArtifact, threadRequiresVisualProof } from "./proof-policy.js";
import type { CodexThreadRecord, CodexWorkerEvidenceView, PreviewProofRecordView, WorkerClaimsReportView, WorkerEvidenceKind } from "./types.js";

function normalizeWorkerEvidenceKind(value: unknown): WorkerEvidenceKind {
  const normalizedValue = value === "browser" ? "browser_flow" : value;
  return typeof normalizedValue === "string" &&
    [
      "unit_test",
      "integration_test",
      "api_smoke",
      "browser_flow",
      "visual_review",
      "responsive_review",
      "accessibility_review",
      "log_review",
      "data_check",
      "negative_case",
      "build",
      "deploy_health",
      "taste_review",
      "intent_review",
      "manual_waiver",
      "proof",
      "screenshot",
      "video",
      "trace",
      "log",
      "command",
      "file",
      "manual"
    ].includes(normalizedValue)
    ? (normalizedValue as WorkerEvidenceKind)
    : "manual";
}

export function normalizeReportEvidence(raw: unknown): CodexWorkerEvidenceView[] {
  const entries = Array.isArray(raw) ? raw : raw && typeof raw === "object" ? [raw] : [];
  return entries
    .map((entry) => {
      if (!entry || typeof entry !== "object") return null;
      const item = entry as Partial<CodexWorkerEvidenceView>;
      const summary = typeof item.summary === "string" && item.summary.trim() ? item.summary.trim() : "";
      if (!summary) return null;
      return {
        id: typeof item.id === "string" && item.id.trim() ? item.id.trim() : crypto.randomUUID(),
        pointId: typeof item.pointId === "string" && item.pointId.trim() ? item.pointId.trim() : null,
        matrixRowId: typeof item.matrixRowId === "string" && item.matrixRowId.trim() ? item.matrixRowId.trim() : null,
        kind: normalizeWorkerEvidenceKind(item.kind),
        summary,
        details: typeof item.details === "string" && item.details.trim() ? item.details.trim() : null,
        command: typeof item.command === "string" && item.command.trim() ? item.command.trim() : null,
        exitCode: typeof item.exitCode === "number" && Number.isFinite(item.exitCode) ? Math.trunc(item.exitCode) : null,
        proofRunId: typeof item.proofRunId === "string" && item.proofRunId.trim() ? item.proofRunId.trim() : null,
        artifactId: typeof item.artifactId === "string" && item.artifactId.trim() ? item.artifactId.trim() : null,
        route: typeof item.route === "string" && item.route.trim() ? item.route.trim() : null,
        logRef: typeof item.logRef === "string" && item.logRef.trim() ? item.logRef.trim() : null,
        dataRef: typeof item.dataRef === "string" && item.dataRef.trim() ? item.dataRef.trim() : null,
        createdAt: Date.now()
      };
    })
    .filter((entry): entry is CodexWorkerEvidenceView => Boolean(entry));
}

export { normalizeWorkerClaimsReport };

const VISUAL_EVIDENCE_KINDS = new Set<WorkerEvidenceKind>([
  "browser_flow",
  "visual_review",
  "responsive_review",
  "screenshot",
  "video",
  "proof",
  "taste_review"
]);
const PROOF_BOUND_EVIDENCE_KINDS = new Set<WorkerEvidenceKind>([
  "browser_flow",
  "visual_review",
  "screenshot",
  "video",
  "proof"
]);
const DURABLE_REFERENCE_EVIDENCE_KINDS = new Set<WorkerEvidenceKind>([
  "proof",
  "screenshot",
  "video",
  "trace",
  "file"
]);
const LOCAL_FILESYSTEM_REFERENCE_PATTERN = /(?:^file:\/\/?|^(?:~\/|[A-Za-z]:[\\/]|\\\\)|\/var\/folders\/|\/private\/var\/folders\/|TemporaryItems|screencaptureui|NSIRD_|\/(?:private\/)?tmp\/)/i;

function assertDurableReferenceId(value: string | null | undefined, label: string): void {
  if (value && (/\s/.test(value) || /[\\/]/.test(value) || /^file:/i.test(value))) {
    throw new Error(`${label} must be a Manor reference ID, not a local path.`);
  }
}

function assertNoLocalFilesystemReference(value: string | null | undefined, label: string): void {
  if (value && LOCAL_FILESYSTEM_REFERENCE_PATTERN.test(value)) {
    throw new Error(`${label} must reference Manor proof runs or durable artifacts, not local filesystem paths.`);
  }
}

function normalizedRoutePath(raw: string): string | null {
  try {
    const pathname = new URL(raw, "http://manor.invalid").pathname.replace(/^\/preview\/[^/]+/, "");
    return pathname.replace(/\/$/, "") || "/";
  } catch {
    return null;
  }
}

function proofFailure(proof: PreviewProofRecordView, requireVisualArtifact: boolean): string | null {
  const verification = proof.verification;
  if (!verification.ok || verification.failureKind !== "none") {
    return verification.error ?? `proof run failed with signal ${verification.failureKind}`;
  }
  if (!verification.readiness.routeOk) {
    return "the captured route did not pass readiness checks";
  }
  if (verification.phases.some((phase) => phase.status === "failed")) {
    return "the proof contains a failed phase";
  }
  if (verification.actions?.some((action) => action.status === "failed")) {
    return "the proof contains a failed browser action";
  }
  if (requireVisualArtifact && !proofHasVisualArtifact(proof)) {
    return "the proof has no available screenshot or video";
  }
  return null;
}

function routeMatchesProof(route: string, proof: PreviewProofRecordView): boolean {
  const expectedPath = normalizedRoutePath(route);
  if (!expectedPath) return false;
  const candidates = [
    proof.verification.readiness.finalUrl,
    proof.verification.url,
    ...proof.verification.artifacts
      .filter((artifact) => artifact.kind === "screenshot")
      .map((artifact) => artifact.captureUrl)
      .filter((value): value is string => Boolean(value))
  ];
  return candidates.some((candidate) => {
    const actualPath = normalizedRoutePath(candidate);
    if (!actualPath) return false;
    return actualPath === expectedPath || (expectedPath !== "/" && actualPath.endsWith(expectedPath));
  });
}

function rejectDuplicateNamedCaptures(proofs: PreviewProofRecordView[]): void {
  const byChecksum = new Map<string, Array<{ label: string; route: string | null }>>();
  for (const proof of proofs) {
    for (const artifact of proof.verification.artifacts) {
      if (artifact.kind !== "screenshot" || !artifact.checksumSha256 || /\b(ready|final)\b/i.test(artifact.label)) continue;
      const entries = byChecksum.get(artifact.checksumSha256) ?? [];
      entries.push({ label: artifact.label, route: artifact.captureUrl ? normalizedRoutePath(artifact.captureUrl) : null });
      byChecksum.set(artifact.checksumSha256, entries);
    }
  }
  for (const entries of byChecksum.values()) {
    const claims = new Set(entries.map((entry) => `${entry.label}\u0000${entry.route ?? ""}`));
    if (claims.size > 1) {
      throw new Error("Completed report references differently named or routed screenshots with identical image content. Recapture each claimed UI state.");
    }
  }
}

export function validateCompletedWorkerEvidence(input: {
  thread: CodexThreadRecord;
  evidence: CodexWorkerEvidenceView[];
  threadProofs: PreviewProofRecordView[];
  claims?: WorkerClaimsReportView | null;
}): void {
  const contract = input.thread.executionContract;
  const pointIds = new Set(contract?.verificationMatrix.map((row) => row.acceptancePointId).filter((id): id is string => Boolean(id)) ?? []);
  const matrixRowIds = new Set(contract?.verificationMatrix.map((row) => row.id) ?? []);
  for (const entry of input.evidence) {
    assertDurableReferenceId(entry.proofRunId, "Evidence proof run");
    assertDurableReferenceId(entry.artifactId, "Evidence artifact");
    assertNoLocalFilesystemReference(entry.route, "Evidence route");
    assertNoLocalFilesystemReference(entry.logRef, "Evidence log reference");
    assertNoLocalFilesystemReference(entry.dataRef, "Evidence data reference");
    if (DURABLE_REFERENCE_EVIDENCE_KINDS.has(entry.kind) && !entry.proofRunId && !entry.artifactId) {
      throw new Error(`Evidence kind ${entry.kind} must reference a Manor proof run or durable project artifact.`);
    }
    if (entry.pointId && !pointIds.has(entry.pointId)) {
      throw new Error(`Completed report evidence references unknown acceptance point ${entry.pointId}.`);
    }
    if (entry.matrixRowId && !matrixRowIds.has(entry.matrixRowId)) {
      throw new Error(`Completed report evidence references unknown verification row ${entry.matrixRowId}.`);
    }
  }

  const proofByRunId = new Map(input.threadProofs.map((proof) => [proof.verification.runId, proof]));
  const referencedEvidence = input.evidence.filter((entry) => entry.proofRunId);

  const visualProofRequired = threadRequiresVisualProof(input.thread);
  for (const entry of referencedEvidence) {
    const proof = proofByRunId.get(entry.proofRunId!);
    if (!proof) {
      throw new Error(`Completed report references missing proof run ${entry.proofRunId}. Capture the proof again and report its returned run ID.`);
    }
    const entryRequiresVisualArtifact = entry.kind === "browser_flow" ||
      entry.kind === "visual_review" ||
      entry.kind === "screenshot" ||
      entry.kind === "video" ||
      (visualProofRequired && PROOF_BOUND_EVIDENCE_KINDS.has(entry.kind));
    const failure = proofFailure(proof, entryRequiresVisualArtifact);
    if (failure) {
      throw new Error(`Completed report references unusable proof run ${entry.proofRunId}: ${failure}.`);
    }
    if (entry.route && !routeMatchesProof(entry.route, proof)) {
      throw new Error(`Completed report claims route ${entry.route}, but proof run ${entry.proofRunId} did not capture that route.`);
    }
  }
  rejectDuplicateNamedCaptures([...new Set(referencedEvidence.map((entry) => proofByRunId.get(entry.proofRunId!)).filter((proof): proof is PreviewProofRecordView => Boolean(proof)))]);

  if (!visualProofRequired) return;

  const visualEvidence = input.evidence.filter((entry) => VISUAL_EVIDENCE_KINDS.has(entry.kind));
  if (visualEvidence.length === 0) {
    throw new Error("UI work cannot be reported completed without structured visual evidence.");
  }
  const proofBoundEvidence = visualEvidence.filter((entry) => PROOF_BOUND_EVIDENCE_KINDS.has(entry.kind));
  if (proofBoundEvidence.length === 0) {
    throw new Error("UI work cannot be reported completed without browser or screenshot evidence tied to a proof run.");
  }
  if (proofBoundEvidence.some((entry) => !entry.proofRunId)) {
    throw new Error("Browser and screenshot evidence for completed UI work must reference the proof run that produced it.");
  }
}
