import crypto from "node:crypto";

import { normalizeWorkerClaimsReport } from "./butler-orchestration.js";
import type { CodexThreadRecord, CodexWorkerEvidenceView, PreviewProofRecordView, WorkerClaimsReportView, WorkerEvidenceKind } from "./types.js";

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

export { normalizeWorkerClaimsReport };

export function validateCompletedWorkerEvidence(input: {
  thread: CodexThreadRecord;
  evidence: CodexWorkerEvidenceView[];
  threadProofs: PreviewProofRecordView[];
  claims?: WorkerClaimsReportView | null;
}): void {
  void input;
}
