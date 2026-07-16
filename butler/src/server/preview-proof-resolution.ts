import type { CodexWorkerReportView, PreviewProofRecordView } from "./types.js";

export function buildCurrentReportProofCoverageLines(
  report: CodexWorkerReportView | null,
  proofs: PreviewProofRecordView[],
  threadId: string
): string[] {
  const runIds = [...new Set((report?.evidence ?? []).map((entry) => entry.proofRunId).filter((runId): runId is string => Boolean(runId)))];
  const byRunId = new Map(proofs.filter((proof) => proof.threadId === threadId).map((proof) => [proof.verification.runId, proof]));
  return runIds.map((runId) => {
    const proof = byRunId.get(runId);
    const review = proof?.proofReviews.at(-1);
    return proof
      ? `${runId}: verification=${proof.verification.ok && proof.verification.failureKind === "none" ? "passed" : `failed:${proof.verification.failureKind}`} | review=${review?.verdict ?? "unreviewed"} | title=${proof.previewTitle}`
      : `${runId}: missing from Manor proof storage`;
  });
}

export function requireExactPreviewProof(
  proofs: PreviewProofRecordView[],
  runId: string,
  scope: { threadId?: string; previewId?: string }
): PreviewProofRecordView {
  const proof = proofs.find((entry) =>
    entry.verification.runId === runId &&
    (!scope.threadId || entry.threadId === scope.threadId) &&
    (!scope.previewId || entry.previewId === scope.previewId)
  );
  if (!proof) throw new Error(`Verification run ${runId} is not available for the selected proof scope.`);
  return proof;
}

export function previewProofSubject(proof: PreviewProofRecordView) {
  return {
    id: proof.previewId,
    threadId: proof.threadId,
    projectId: proof.projectId,
    projectLabel: proof.projectLabel,
    title: proof.previewTitle,
    stackId: proof.stackId
  };
}
