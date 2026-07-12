import type {
  WorkerChecklistItem,
  WorkerItem,
  WorkerJobPayload,
  WorkerTimeline,
  WorkerTurnGroup
} from "./WorkerPane";

type WorkerThreadReport = {
  turnId: string;
  status: string;
  summary: string;
  details: string | null;
  evidence?: Array<{ proofRunId?: string | null; artifactId?: string | null }>;
  claims?: { claims?: Array<{ proofId?: string | null }> } | null;
  createdAt?: number;
  updatedAt: number;
};

export type WorkerThread = {
  id: string;
  status: string;
  preview?: string;
  eventLog?: Array<{ at: number; method: string; summary: string }>;
  supervisor?: { latestAgentReply?: string | null; summary?: string | null };
  turns?: Array<{
    id: string;
    status: string;
    error?: string | null;
    startedAt?: number;
    completedAt?: number | null;
    items: WorkerItem[];
  }>;
  workerReport?: WorkerThreadReport | null;
  workerReports?: WorkerThreadReport[];
  jobPayload?: WorkerJobPayload | null;
  supervisionChecklist?: {
    items?: Array<{ id: string; text: string; status: string; butlerNote?: string | null; queuedInstruction?: string | null }>;
  } | null;
};

function workerReportFromWire(report: WorkerThreadReport): WorkerTimeline["reports"][number] {
  return {
    turnId: report.turnId,
    status: report.status,
    summary: report.summary,
    details: report.details,
    evidence: report.evidence,
    claims: report.claims,
    updatedAt: report.updatedAt
  };
}

function boundedWorkerError(value: string): string {
  const trimmed = value.trim();
  return trimmed.length <= 3000 ? trimmed : `${trimmed.slice(0, 2999)}…`;
}

function isFailedWorkerTurn(status: string): boolean {
  return status === "failed" || status === "interrupted" || status === "cancelled";
}

export function shapeWorkerTimeline(thread: WorkerThread | null): WorkerTimeline {
  if (!thread) return { turns: [], report: null, reports: [], payload: null, checklist: null, fallback: [] };
  const checklist: WorkerChecklistItem[] | null = thread.supervisionChecklist?.items?.length
    ? thread.supervisionChecklist.items.map((item) => ({
        id: item.id,
        text: item.text,
        status: item.status,
        note: item.butlerNote ?? item.queuedInstruction ?? null
      }))
    : null;
  const reportsByTurnId = new Map<string, WorkerTimeline["reports"][number]>();
  for (const rawReport of thread.workerReports ?? []) {
    const report = workerReportFromWire(rawReport);
    if (report.turnId) reportsByTurnId.set(report.turnId, report);
  }
  if (thread.workerReport) {
    const report = workerReportFromWire(thread.workerReport);
    if (report.turnId) reportsByTurnId.set(report.turnId, report);
  }
  const reports = [...reportsByTurnId.values()].sort((left, right) => left.updatedAt - right.updatedAt);
  const report = reports.at(-1) ?? null;
  const rawTurns = thread.turns ?? [];
  const runtimeErrors = (thread.eventLog ?? []).filter((entry) => /(?:^|[./])runtime[./]error$/i.test(entry.method) && entry.summary.trim());
  const turns: WorkerTurnGroup[] = rawTurns
    .map((turn, turnIndex) => {
      const items = (turn.items ?? [])
        .map((item) => ({ ...item, id: `${turn.id}:${item.id}`, status: item.status || turn.status }))
        .filter((item) => item.text?.trim());
      const nextTurnStartedAt = rawTurns[turnIndex + 1]?.startedAt ?? null;
      const diagnosticWindowEnd = nextTurnStartedAt ?? (turn.completedAt ? turn.completedAt + 10_000 : Number.POSITIVE_INFINITY);
      const diagnostics = [
        ...(turn.error?.trim() ? [{ at: turn.completedAt ?? turn.startedAt ?? 0, text: boundedWorkerError(turn.error) }] : []),
        ...runtimeErrors
          .filter((entry) => entry.at >= (turn.startedAt ?? 0) && entry.at <= diagnosticWindowEnd)
          .map((entry) => ({ at: entry.at, text: boundedWorkerError(entry.summary) }))
      ].filter((entry, index, entries) => entries.findIndex((candidate) => candidate.text === entry.text) === index);
      for (const [diagnosticIndex, diagnostic] of diagnostics.entries()) {
        items.push({ id: `${turn.id}:runtime-error:${diagnosticIndex}`, type: "error", status: "failed", text: diagnostic.text, at: diagnostic.at });
      }
      const turnReport = reportsByTurnId.get(turn.id) ?? null;
      if (turnReport) {
        items.push({
          id: `${turn.id}:worker-report:${turnReport.updatedAt}`,
          type: "assistant_message",
          status: "completed",
          text: `${turnReport.summary}${turnReport.details ? `\n\n${turnReport.details}` : ""}`,
          at: turnReport.updatedAt
        });
      }
      items.sort((left, right) => left.at - right.at);
      const completedAt = turn.completedAt ?? null;
      let finalIndex: number | null = null;
      if (completedAt !== null) {
        for (let index = items.length - 1; index >= 0; index -= 1) {
          if (items[index]?.type === "agentMessage" || items[index]?.type === "assistant_message") {
            finalIndex = index;
            break;
          }
        }
      }
      return { id: turn.id, status: turn.status, startedAt: turn.startedAt ?? items[0]?.at ?? 0, completedAt, items, finalIndex };
    })
    .filter((turn) => turn.items.length > 0 || turn.completedAt === null || isFailedWorkerTurn(turn.status));
  return {
    turns,
    report: report && !turns.some((turn) => turn.id === report.turnId) ? report : null,
    reports,
    payload: thread.jobPayload ?? null,
    checklist,
    fallback: []
  };
}
