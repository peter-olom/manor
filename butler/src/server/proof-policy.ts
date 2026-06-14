import type { CodexThreadExecutionContractView, CodexThreadRecord, PreviewProofRecordView } from "./types.js";

export const VISUAL_PROOF_REQUIREMENT =
  "UI-impacting work requires visual proof: capture and surface a screenshot or video of the relevant UI state; text logs or TXT/file proof alone are insufficient.";

const UI_SURFACE_PATTERN =
  /\b(ui|user interface|web app|browser|screen|page|view|component|layout|styling|style|css|responsive|mobile|desktop|modal|dialog|form|button|navigation|nav|dashboard|toast|panel|drawer|composer|surface|timeline|visual|screenshot|video)\b/i;

const MANOR_CHAT_PATTERN =
  /\b(operator-facing|butler chat|codex thread|chat responses?|callback closeouts?|final responses?|message rendering|reply footer|timing footer)\b/i;

export function taskHasUiImplication(text: string | null | undefined): boolean {
  const normalized = (text ?? "").replace(/\s+/g, " ").trim();
  if (!normalized) {
    return false;
  }
  return UI_SURFACE_PATTERN.test(normalized) || MANOR_CHAT_PATTERN.test(normalized);
}

export function acceptancePointsNeedVisualProof(points: string[]): boolean {
  return points.some((point) => /\b(visual proof|ui proof|screenshot|video|browser proof|desktop proof)\b/i.test(point));
}

export function contractRequiresVisualProof(contract: CodexThreadExecutionContractView | null | undefined): boolean {
  if (!contract) {
    return false;
  }
  if (contract.notes.some((note) => note === VISUAL_PROOF_REQUIREMENT)) {
    return true;
  }
  return taskHasUiImplication(
    [contract.requestedTask, contract.operatorGoal, ...contract.acceptancePoints, ...contract.notes].filter(Boolean).join("\n")
  );
}

export function threadRequiresVisualProof(thread: CodexThreadRecord | null | undefined): boolean {
  return contractRequiresVisualProof(thread?.executionContract);
}

export function proofHasVisualArtifact(proof: PreviewProofRecordView): boolean {
  return proof.verification.artifacts.some(
    (artifact) => (artifact.kind === "screenshot" || artifact.kind === "video") && artifact.availability === "available"
  );
}

export function hasVisualProof(proofs: PreviewProofRecordView[]): boolean {
  return proofs.some(proofHasVisualArtifact);
}
