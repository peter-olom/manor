import crypto from "node:crypto";

import type {
  CodexThreadExecutionContractView,
  CodexThreadRecord,
  CodexWorkerReportView,
  SupervisionChecklistItemStatus,
  SupervisionChecklistView
} from "./types.js";

export function buildSupervisionChecklist(
  thread: CodexThreadRecord,
  contract: CodexThreadExecutionContractView
): SupervisionChecklistView {
  const now = Date.now();
  const existingByText = new Map((thread.supervisionChecklist?.items ?? []).map((item) => [item.text.toLowerCase(), item]));
  const items = contract.acceptancePoints.map((point, index) => {
    const existing = existingByText.get(point.toLowerCase());
    return {
      id: existing?.id ?? `point-${index + 1}`,
      text: point,
        status: existing?.status ?? "pending",
        butlerNote: existing?.butlerNote ?? null,
        queuedInstruction: existing?.queuedInstruction ?? null,
        decidedAt: existing?.decidedAt ?? null,
        evidence: existing?.evidence ?? []
    };
  });

  return {
    threadId: thread.id,
    projectId: contract.projectId,
    projectLabel: contract.projectLabel,
    requestedTask: contract.requestedTask,
    items,
    heartbeat: thread.supervisionChecklist?.heartbeat ?? {
      lastThreadEventAt: null,
      lastWorkerReportAt: null,
      lastKnownThreadStatus: thread.status,
      stale: false
    },
    reviewState: thread.supervisionChecklist?.reviewState ?? "needs_review",
    createdAt: thread.supervisionChecklist?.createdAt ?? now,
    updatedAt: now
  };
}

export function reviewChecklistAcceptancePoint(
  checklist: SupervisionChecklistView,
  input: {
    pointId: string;
    status: SupervisionChecklistItemStatus;
    note?: string | null;
    nextInstruction?: string | null;
  }
): SupervisionChecklistView {
  if (input.status === "pending") {
    throw new Error("Butler review must accept, reject, or waive an acceptance point.");
  }
  if (input.status === "rejected" && !input.nextInstruction?.trim()) {
    throw new Error("Rejected acceptance points require nextInstruction so Butler can batch one worker follow-up.");
  }

  const now = Date.now();
  const item = checklist.items.find((entry) => entry.id === input.pointId);
  if (!item) {
    throw new Error(`Unknown acceptance point ${input.pointId}.`);
  }
  item.status = input.status;
  item.butlerNote = typeof input.note === "string" && input.note.trim() ? input.note.trim() : null;
  item.queuedInstruction =
    input.status === "rejected" && typeof input.nextInstruction === "string" && input.nextInstruction.trim()
      ? input.nextInstruction.trim()
      : input.status === "rejected"
        ? item.queuedInstruction
        : null;
  item.decidedAt = now;
  item.evidence = [
    ...item.evidence,
    {
      id: crypto.randomUUID(),
      source: "butler_review" as const,
      summary: `${input.status}: ${item.text}`,
      details: item.butlerNote,
      reportTurnId: null,
      createdAt: now
    }
  ].slice(-20);
  checklist.reviewState = checklist.items.every((entry) => entry.status === "accepted" || entry.status === "waived")
    ? "reviewed"
    : "needs_review";
  checklist.updatedAt = now;
  return checklist;
}

export function buildQueuedRejectionInstruction(checklist: SupervisionChecklistView): string | null {
  const rejected = checklist.items.filter((item) => item.status === "rejected" && item.queuedInstruction);
  if (rejected.length === 0) {
    return null;
  }

  return [
    "BUTLER CHECKLIST REJECTION FOLLOW-UP",
    "Fix the rejected acceptance points below, then submit one supervisor report with evidence for each point.",
    ...rejected.map((item, index) => `${index + 1}. ${item.text}\nRequired next step: ${item.queuedInstruction}`)
  ].join("\n\n");
}

export function clearQueuedRejectionInstructions(checklist: SupervisionChecklistView): SupervisionChecklistView {
  for (const item of checklist.items) {
    if (item.status === "rejected") {
      item.queuedInstruction = null;
    }
  }
  checklist.updatedAt = Date.now();
  return checklist;
}

export function recordChecklistWorkerEvidence(
  checklist: SupervisionChecklistView | null,
  thread: CodexThreadRecord,
  report: CodexWorkerReportView,
  now: number
): SupervisionChecklistView | null {
  if (!checklist) {
    return null;
  }

  checklist.heartbeat.lastWorkerReportAt = now;
  checklist.heartbeat.lastThreadEventAt = now;
  checklist.heartbeat.lastKnownThreadStatus = thread.status;
  checklist.heartbeat.stale = false;
  checklist.reviewState = "needs_review";
  checklist.updatedAt = now;

  for (const item of checklist.items) {
    if (item.status === "accepted" || item.status === "waived") {
      continue;
    }
    item.evidence = [
      ...item.evidence,
      {
        id: crypto.randomUUID(),
        source: "worker_report" as const,
        summary: report.summary,
        details: report.details,
        reportTurnId: report.turnId,
        createdAt: now
      }
    ].slice(-20);
  }

  return checklist;
}

export function updateChecklistHeartbeat(
  checklist: SupervisionChecklistView | null,
  thread: CodexThreadRecord,
  activityAt: number
): SupervisionChecklistView | null {
  if (!checklist) {
    return null;
  }
  const lastWorkerSignal = checklist.heartbeat.lastWorkerReportAt ?? checklist.heartbeat.lastThreadEventAt;
  checklist.heartbeat.lastThreadEventAt = activityAt;
  checklist.heartbeat.lastKnownThreadStatus = thread.status;
  checklist.heartbeat.stale = thread.status === "active" && lastWorkerSignal !== null && Date.now() - lastWorkerSignal > 10 * 60 * 1000;
  checklist.updatedAt = activityAt;
  return checklist;
}
