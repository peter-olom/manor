import type { JobPayloadView } from "./job-payload-types.js";
import type { CodexThreadDetailView, CodexWorkerReportView, PreviewProofRecordView } from "./types.js";

export type WorkerThreadPageView = Pick<
  CodexThreadDetailView,
  "id" | "status" | "turnCount" | "turns" | "workerReport" | "workerReports" | "jobPayload"
> & {
  eventLog: CodexThreadDetailView["eventLog"];
  supervisionChecklist: {
    items: Array<{
      id: string;
      text: string;
      status: string;
      butlerNote: string | null;
      queuedInstruction: string | null;
    }>;
  } | null;
  reviewRecords: CodexThreadDetailView["reviewRecords"];
  loadedStart: number;
  hasMore: boolean;
};

function pagePayload(payload: JobPayloadView | null | undefined, turnIds: Set<string>): JobPayloadView | null | undefined {
  if (!payload) return payload;
  const snapshots = payload.snapshots.filter((snapshot) => Boolean(snapshot.delivery.turnId && turnIds.has(snapshot.delivery.turnId)));
  const nodeIds = new Set(snapshots.map((snapshot) => snapshot.nodeId));
  return {
    ...payload,
    outputManifest: { version: 1, entries: [] },
    snapshots,
    nodes: payload.nodes.filter((node) => Boolean((node.turnId && turnIds.has(node.turnId)) || nodeIds.has(node.id))),
    executionContract: null
  };
}

function pageEventLog(thread: CodexThreadDetailView, start: number, end: number): CodexThreadDetailView["eventLog"] {
  const firstTurnAt = thread.turns[start]?.startedAt ?? Number.NEGATIVE_INFINITY;
  const nextTurnAt = thread.turns[end]?.startedAt ?? Number.POSITIVE_INFINITY;
  return thread.eventLog
    .filter((entry) => /(?:^|[./])runtime[./]error$/i.test(entry.method))
    .filter((entry) => entry.at >= firstTurnAt && entry.at < nextTurnAt)
    .sort((left, right) => right.at - left.at)
    .slice(0, 20)
    .sort((left, right) => left.at - right.at);
}

function pageChecklist(thread: CodexThreadDetailView): WorkerThreadPageView["supervisionChecklist"] {
  if (!thread.supervisionChecklist) return null;
  return {
    items: thread.supervisionChecklist.items.map((item) => ({
      id: item.id,
      text: item.text,
      status: item.status,
      butlerNote: item.butlerNote,
      queuedInstruction: item.queuedInstruction
    }))
  };
}

export function pageWorkerThread(thread: CodexThreadDetailView, before: number | null, requestedLimit: number): WorkerThreadPageView {
  const total = thread.turns.length;
  const end = before === null ? total : Math.max(0, Math.min(total, Math.floor(before)));
  const limit = Number.isFinite(requestedLimit) ? Math.max(1, Math.min(50, Math.floor(requestedLimit))) : 10;
  const start = Math.max(0, end - limit);
  const turns = thread.turns.slice(start, end);
  const turnIds = new Set(turns.map((turn) => turn.id));
  return {
    id: thread.id,
    status: thread.status,
    turnCount: thread.turnCount,
    turns,
    eventLog: pageEventLog(thread, start, end),
    jobPayload: pagePayload(thread.jobPayload, turnIds),
    supervisionChecklist: pageChecklist(thread),
    reviewRecords: thread.reviewRecords,
    workerReport: thread.workerReport && turnIds.has(thread.workerReport.turnId) ? thread.workerReport : null,
    workerReports: thread.workerReports?.filter((report) => turnIds.has(report.turnId)),
    loadedStart: start,
    hasMore: start > 0
  };
}

function reportProofReferences(reports: Array<CodexWorkerReportView | null | undefined>): Set<string> {
  const references = new Set<string>();
  for (const report of reports) {
    if (!report) continue;
    for (const evidence of report.evidence) {
      if (evidence.proofRunId) references.add(evidence.proofRunId);
      if (evidence.artifactId) references.add(evidence.artifactId);
    }
    for (const claim of report.claims?.claims ?? []) {
      if (claim.proofId) references.add(claim.proofId);
    }
  }
  return references;
}

function proofTimestamp(proof: PreviewProofRecordView): number {
  return proof.verification.checkedAt || proof.updatedAt || proof.createdAt;
}

export function pageWorkerProofRecords(
  proofs: PreviewProofRecordView[],
  page: WorkerThreadPageView
): PreviewProofRecordView[] {
  if (!page.hasMore || page.turns.length === 0) return proofs;
  const firstTurnAt = Math.min(...page.turns.map((turn) => turn.startedAt));
  const references = reportProofReferences([page.workerReport, ...(page.workerReports ?? [])]);
  return proofs.filter((proof) =>
    proofTimestamp(proof) >= firstTurnAt || references.has(proof.id) || references.has(proof.verification.runId)
  );
}
