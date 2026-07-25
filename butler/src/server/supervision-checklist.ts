import crypto from "node:crypto";

import type {
  CodexThreadExecutionContractView,
  CodexThreadRecord,
  CodexWorkerReportView,
  SupervisionChecklistItemStatus,
  SupervisionChecklistView
} from "./types.js";
import { buildThreadExecutionContract } from "./thread-contract.js";

export type OperatorCloseoutGate =
  | { ok: true }
  | {
      ok: false;
      reason: string;
      openItems: Array<{ id: string; status: SupervisionChecklistItemStatus; text: string }>;
    };

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
      kind: "butler_review" as const,
      pointId: item.id,
      matrixRowId: null,
      summary: `${input.status}: ${item.text}`,
      details: item.butlerNote,
      reportTurnId: null,
      proofRunId: null,
      artifactId: null,
      command: null,
      route: null,
      createdAt: now
    }
  ].slice(-20);
  checklist.reviewState = checklist.items.every((entry) => entry.status === "accepted" || entry.status === "waived")
    ? "reviewed"
    : "needs_review";
  checklist.updatedAt = now;
  return checklist;
}

export function reviewChecklistAcceptancePoints(
  checklist: SupervisionChecklistView,
  decisions: Array<{
    pointId: string;
    status: SupervisionChecklistItemStatus;
    note?: string | null;
    nextInstruction?: string | null;
  }>
): SupervisionChecklistView {
  if (decisions.length === 0) throw new Error("Batch review requires at least one acceptance-point decision.");
  const pointIds = decisions.map((decision) => decision.pointId);
  if (new Set(pointIds).size !== pointIds.length) throw new Error("Batch review cannot decide the same acceptance point twice.");
  const next = structuredClone(checklist);
  for (const decision of decisions) reviewChecklistAcceptancePoint(next, decision);
  return next;
}

export function buildQueuedRejectionInstruction(checklist: SupervisionChecklistView): string | null {
  const rejected = checklist.items.filter((item) => item.status === "rejected" && item.queuedInstruction);
  if (rejected.length === 0) {
    return null;
  }

  return [
    "Rejected acceptance points",
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

export function evaluateOperatorCloseoutGate(
  checklist: SupervisionChecklistView | null | undefined,
  workerReport: CodexWorkerReportView | null | undefined
): OperatorCloseoutGate {
  if (workerReport?.status === "blocked") {
    return { ok: true };
  }

  if (!checklist || checklist.items.length === 0) {
    return { ok: true };
  }

  const openItems = checklist.items
    .filter((item) => item.status !== "accepted" && item.status !== "waived")
    .map((item) => ({ id: item.id, status: item.status, text: item.text }));

  if (openItems.length === 0) {
    return { ok: true };
  }

  const openSummary = openItems.map((item) => `${item.id}:${item.status}:${item.text}`).join(" | ");
  return {
    ok: false,
    reason: `Completed worker reports are evidence only. Butler must accept or waive every checklist point before posting a completed closeout. Open items: ${openSummary}`,
    openItems
  };
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
    const matchingEvidence = report.evidence.filter(
      (entry) => entry.pointId === item.id || entry.matrixRowId === `row-${item.id.replace(/^point-/, "")}`
    );
    const evidenceEntries =
      matchingEvidence.length > 0
        ? matchingEvidence.map((entry) => ({
            id: entry.id,
            source: "worker_report" as const,
            kind: entry.kind,
            pointId: entry.pointId ?? item.id,
            matrixRowId: entry.matrixRowId,
            summary: entry.summary,
            details: entry.details,
            reportTurnId: report.turnId,
            proofRunId: entry.proofRunId,
            artifactId: entry.artifactId,
            command: entry.command,
            route: entry.route,
            createdAt: entry.createdAt
          }))
        : report.evidence.length > 0
          ? []
        : [
            {
              id: crypto.randomUUID(),
              source: "worker_report" as const,
              kind: "manual" as const,
              pointId: item.id,
              matrixRowId: null,
              summary: report.summary,
              details: report.details,
              reportTurnId: report.turnId,
              proofRunId: null,
              artifactId: null,
              command: null,
              route: null,
              createdAt: now
            }
          ];
    item.evidence = [
      ...item.evidence,
      ...evidenceEntries
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

export function refreshCompletedChecklistForFollowup(
  thread: CodexThreadRecord,
  taskText: string,
  options: { force?: boolean } = {}
): { contract: CodexThreadExecutionContractView; checklist: SupervisionChecklistView } | null {
  const existingChecklist = thread.supervisionChecklist;
  const trimmedTask = taskText.trim();
  if (
    !trimmedTask ||
    (!options.force && (
      !existingChecklist ||
      existingChecklist.items.length === 0 ||
      !existingChecklist.items.every((item) => item.status === "accepted" || item.status === "waived")
    ))
  ) {
    return null;
  }

  const existingContract = thread.executionContract;
  const contract = buildThreadExecutionContract({
    threadId: thread.id,
    workspaceCwd: existingContract?.workspaceCwd ?? thread.cwd ?? "/repos",
    projectId: existingContract?.projectId ?? thread.supervisor.projectId ?? "unknown",
    projectLabel: existingContract?.projectLabel ?? thread.supervisor.projectLabel ?? "Unknown",
    branch: existingContract?.branch ?? null,
    taskText: trimmedTask,
    requestedTask: trimmedTask,
    operatorGoal: null,
    notes: [options.force
      ? "Explicitly refreshed for a new follow-up task so earlier review state cannot leak into the new scope."
      : "Refreshed after new follow-up work arrived with the previous checklist already complete."]
  });
  const checklist = buildSupervisionChecklist({ ...thread, supervisionChecklist: null }, contract);
  checklist.reviewState = "needs_review";
  return { contract, checklist };
}
