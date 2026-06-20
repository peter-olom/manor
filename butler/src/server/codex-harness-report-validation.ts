import crypto from "node:crypto";

import { hasVisualProof, threadRequiresVisualProof } from "./proof-policy.js";
import type { CodexThreadRecord, CodexWorkerEvidenceView, PreviewProofRecordView, WorkerEvidenceKind } from "./types.js";

function normalizeWorkerEvidenceKind(value: unknown): WorkerEvidenceKind {
  return typeof value === "string" &&
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
    ].includes(value)
    ? (value as WorkerEvidenceKind)
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

function evidenceMatchesKind(entry: CodexWorkerEvidenceView, kind: WorkerEvidenceKind): boolean {
  if (entry.kind === kind) return true;
  if (kind === "visual_review") return entry.kind === "screenshot" || entry.kind === "video" || entry.kind === "proof";
  if (kind === "browser_flow") return entry.kind === "proof" || entry.kind === "screenshot" || entry.kind === "video" || entry.kind === "trace";
  if (kind === "log_review") return entry.kind === "log";
  if (kind === "build") return entry.kind === "command";
  return false;
}

function hasEvidenceKind(evidence: CodexWorkerEvidenceView[], kinds: WorkerEvidenceKind[]): boolean {
  return evidence.some((entry) => kinds.some((kind) => evidenceMatchesKind(entry, kind)));
}

function currentWorkerOwnedVerificationRows(thread: CodexThreadRecord) {
  const matrix = thread.executionContract?.verificationMatrix ?? [];
  const workerOwnedRows = matrix.filter((row) => row.owner !== "butler");
  const rejectedChecklistPointIds = new Set(
    (thread.supervisionChecklist?.items ?? [])
      .filter((item) => item.status === "rejected")
      .map((item) => item.id)
  );
  if (rejectedChecklistPointIds.size === 0) {
    return workerOwnedRows;
  }

  const rejectedRows = workerOwnedRows.filter((row) => row.acceptancePointId && rejectedChecklistPointIds.has(row.acceptancePointId));
  return rejectedRows.length > 0 ? rejectedRows : workerOwnedRows;
}

export function validateCompletedWorkerEvidence(input: {
  thread: CodexThreadRecord;
  evidence: CodexWorkerEvidenceView[];
  threadProofs: PreviewProofRecordView[];
}): void {
  const { thread, evidence, threadProofs } = input;
  if ((thread.executionContract?.inferredWorkDepth === "deep" || thread.executionContract?.inferredWorkDepth === "incident") && evidence.length === 0) {
    throw new Error("Deep delegated work requires point-specific evidence before reporting completed.");
  }
  const matrix = currentWorkerOwnedVerificationRows(thread);
  const missingRows = matrix.filter(
    (row) => !evidence.some((entry) => entry.matrixRowId === row.id || (row.acceptancePointId && entry.pointId === row.acceptancePointId))
  );
  if ((thread.executionContract?.inferredWorkDepth === "deep" || thread.executionContract?.inferredWorkDepth === "incident") && missingRows.length > 0) {
    throw new Error(`Deep delegated work is missing evidence for ${missingRows.slice(0, 4).map((row) => row.acceptancePointId ?? row.id).join(", ")}.`);
  }
  if (thread.executionContract?.proofExpectation === "requested" && threadProofs.length === 0) {
    throw new Error("This job asked for proof. Gather persisted proof before reporting completed.");
  }
  if (threadRequiresVisualProof(thread) && !hasVisualProof(threadProofs)) {
    throw new Error(
      "This job affects operator-visible UI. Capture persisted screenshot or video proof before reporting completed; text or file proof alone is insufficient."
    );
  }
  if (thread.executionContract?.taskCategory === "api" && !hasEvidenceKind(evidence, ["api_smoke"])) {
    throw new Error("API/backend work requires request-level smoke evidence before reporting completed.");
  }
  if (thread.executionContract?.taskCategory === "api" && !hasEvidenceKind(evidence, ["negative_case"])) {
    throw new Error("API/backend work requires failure-path evidence before reporting completed.");
  }
  if (thread.executionContract?.taskCategory === "api" && !hasEvidenceKind(evidence, ["log_review"])) {
    throw new Error("API/backend work requires log or runtime review evidence before reporting completed.");
  }
  if (thread.executionContract?.taskCategory === "ui" && !hasEvidenceKind(evidence, ["responsive_review"])) {
    throw new Error("UI work requires responsive review evidence before reporting completed.");
  }
  if (thread.executionContract?.taskCategory === "ui" && !hasEvidenceKind(evidence, ["accessibility_review"])) {
    throw new Error("UI work requires accessibility review evidence before reporting completed.");
  }
  if (thread.executionContract?.taskCategory === "ui" && !hasEvidenceKind(evidence, ["taste_review"])) {
    throw new Error("UI work requires taste review evidence before reporting completed.");
  }
}
