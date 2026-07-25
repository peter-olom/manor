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
  const latestReviewRecord = input.store.getLatestReviewRecord(input.thread.id);
  if (!checklist || checklist.items.length === 0 || (latestReviewRecord?.state !== "accepted" && latestReviewRecord?.state !== "rejected")) {
    return trimmed;
  }
  const proofs = input.store.listPreviewProofs().filter((proof) => proof.threadId === input.thread.id);
  const reviewedItems = checklist.items.filter((item) => item.status === "accepted" || item.status === "waived");
  const acceptedLines = reviewedItems.slice(0, 5).map((item) => {
    const latestEvidence = item.evidence.at(-1);
    return `- ${item.text}${latestEvidence ? ` (${latestEvidence.summary})` : ""}`;
  });
  const waived = checklist.items.filter((item) => item.status === "waived");
  const proofFindings = latestReviewRecord?.findings.filter((f) => f.proofRunId) ?? [];
  const proofLine = proofFindings.length > 0
    ? `Proof reviewed: ${proofFindings.length} finding${proofFindings.length === 1 ? "" : "s"}. ${proofFindings.slice(0, 3).map((f) => f.summary).join(" ")}`
    : proofs.length > 0
      ? `Proof recorded: ${proofs.length} bundle${proofs.length === 1 ? "" : "s"}`
      : "Proof recorded: none";
  const waiverLine =
    waived.length > 0
      ? `Risks or waivers: ${waived.map((item) => item.butlerNote || item.text).join("; ")}`
      : "Risks or waivers: none called out.";
  const reviewFindings = latestReviewRecord?.findings.filter((f) => f.source === "adversarial_review") ?? [];
  const reviewerLine = reviewFindings.length > 0
    ? `Review findings: ${reviewFindings.filter((f) => f.blocking && !f.waived).length} blocking, ${reviewFindings.length} total.`
    : "Review findings: none.";
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
