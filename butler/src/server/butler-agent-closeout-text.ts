import type { ButlerStateStore } from "./state-store.js";

export function buildOperatorCloseoutText(input: {
  store: ButlerStateStore;
  thread: NonNullable<ReturnType<ButlerStateStore["getThread"]>>;
  workerReport: ReturnType<ButlerStateStore["getWorkerReport"]>;
  text: string;
  operatorRequestText?: string | null;
}): string {
  const trimmed = input.text.trim();
  const focusedOperatorRequest = input.operatorRequestText?.trim() || null;
  if (focusedOperatorRequest) return trimmed;
  if (!input.workerReport || input.workerReport.status !== "completed" || trimmed.toLowerCase().includes("proof dossier")) {
    return trimmed;
  }
  const checklist = input.thread.supervisionChecklist;
  if (!checklist || checklist.items.length === 0 || checklist.reviewState !== "reviewed") {
    return trimmed;
  }
  const proofs = input.store.listPreviewProofs().filter((proof) => proof.threadId === input.thread.id);
  const latestProofReview =
    proofs
      .flatMap((proof) => proof.proofReviews)
      .sort((left, right) => right.reviewedAt - left.reviewedAt)[0] ?? null;
  const reviewedItems = checklist.items.filter((item) => item.status === "accepted" || item.status === "waived");
  const acceptedLines = reviewedItems.slice(0, 5).map((item) => {
    const latestEvidence = item.evidence.at(-1);
    return `- ${item.text}${latestEvidence ? ` (${latestEvidence.summary})` : ""}`;
  });
  const waived = checklist.items.filter((item) => item.status === "waived");
  const proofLine = latestProofReview
    ? `Proof reviewed: ${latestProofReview.verdict}; visible state: ${latestProofReview.visibleState}`
    : proofs.length > 0
      ? `Proof recorded: ${proofs.length} bundle${proofs.length === 1 ? "" : "s"}`
      : "Proof recorded: none";
  const waiverLine =
    waived.length > 0
      ? `Risks or waivers: ${waived.map((item) => item.butlerNote || item.text).join("; ")}`
      : "Risks or waivers: none called out.";
  const reviewPanel = input.thread.executionContract?.reviewPanel ?? [];
  const challenged = reviewPanel
    .filter((entry) => entry.concerns.length > 0 || entry.requiredFollowUp)
    .map((entry) => `${entry.label}: ${entry.requiredFollowUp ?? entry.concerns[0]}`)
    .slice(0, 3);
  const reviewerLine =
    reviewPanel.length > 0
      ? challenged.length > 0
        ? `Reviewers challenged: ${challenged.join("; ")}`
        : `Reviewers challenged: none; ${reviewPanel.filter((entry) => entry.verdict === "passed").length}/${reviewPanel.length} passed.`
      : "Reviewers challenged: none.";
  return [
    trimmed,
    "Proof dossier",
    `Accepted evidence: ${reviewedItems.length}/${checklist.items.length}`,
    ...acceptedLines,
    proofLine,
    reviewerLine,
    waiverLine
  ].join("\n\n");
}
