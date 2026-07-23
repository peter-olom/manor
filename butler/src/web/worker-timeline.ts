import type {
  WorkerChecklistItem,
  WorkerItem,
  WorkerJobPayload,
  WorkerJobOutputManifest,
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
  jobOutputManifest?: WorkerJobOutputManifest | null;
  supervisionChecklist?: {
    items?: Array<{ id: string; text: string; status: string; butlerNote?: string | null; queuedInstruction?: string | null }>;
  } | null;
  loadedStart?: number;
  hasMore?: boolean;
  turnCount?: number;
};

export function mergeWorkerThreadPages(current: WorkerThread | null, incoming: WorkerThread | null): WorkerThread | null {
  if (!incoming) return current;
  if (!current || current.id !== incoming.id) return incoming;
  const currentStart = current.loadedStart ?? 0;
  const incomingStart = incoming.loadedStart ?? 0;
  const incomingIsOlderPage = incomingStart < currentStart;
  const currentEnd = currentStart + (current.turns?.length ?? 0);
  const currentTurnIds = new Set((current.turns ?? []).map((turn) => turn.id));
  const overlapsCurrent = (incoming.turns ?? []).some((turn) => currentTurnIds.has(turn.id));
  if (!incomingIsOlderPage && incomingStart > currentEnd && !overlapsCurrent) return incoming;
  const older = incomingIsOlderPage ? incoming : current;
  const newer = incomingIsOlderPage ? current : incoming;
  const turns = new Map((older.turns ?? []).map((turn) => [turn.id, turn]));
  for (const turn of newer.turns ?? []) turns.set(turn.id, turn);
  const snapshots = new Map((older.jobPayload?.snapshots ?? []).map((snapshot) => [`${snapshot.nodeId}:${snapshot.revision}`, snapshot]));
  for (const snapshot of newer.jobPayload?.snapshots ?? []) snapshots.set(`${snapshot.nodeId}:${snapshot.revision}`, snapshot);
  const reports = new Map((older.workerReports ?? []).map((report) => [`${report.turnId}:${report.updatedAt}`, report]));
  for (const report of newer.workerReports ?? []) reports.set(`${report.turnId}:${report.updatedAt}`, report);
  const events = new Map((older.eventLog ?? []).map((entry) => [`${entry.at}:${entry.method}:${entry.summary}`, entry]));
  for (const entry of newer.eventLog ?? []) events.set(`${entry.at}:${entry.method}:${entry.summary}`, entry);
  const loadedStart = Math.min(current.loadedStart ?? Number.POSITIVE_INFINITY, incoming.loadedStart ?? Number.POSITIVE_INFINITY);
  const newestPayload = newer.jobPayload ?? older.jobPayload;
  return {
    ...older,
    ...newer,
    turns: [...turns.values()].sort((left, right) => (left.startedAt ?? 0) - (right.startedAt ?? 0)),
    eventLog: [...events.values()].sort((left, right) => left.at - right.at),
    workerReport: newer.workerReport ?? older.workerReport,
    workerReports: [...reports.values()].sort((left, right) => left.updatedAt - right.updatedAt),
    jobPayload: newestPayload
      ? { ...newestPayload, snapshots: [...snapshots.values()].sort((left, right) => left.updatedAt - right.updatedAt) }
      : null,
    loadedStart: Number.isFinite(loadedStart) ? loadedStart : 0,
    hasMore: Number.isFinite(loadedStart) ? loadedStart > 0 : Boolean(incoming.hasMore ?? current.hasMore),
    turnCount: Math.max(current.turnCount ?? 0, incoming.turnCount ?? 0)
  };
}

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
  if (!thread) return { turns: [], report: null, reports: [], payload: null, outputManifest: null, checklist: null, fallback: [] };
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
      return {
        id: turn.id,
        ordinal: Math.max(0, thread.loadedStart ?? 0) + turnIndex + 1,
        status: turn.status,
        startedAt: turn.startedAt ?? items[0]?.at ?? 0,
        completedAt,
        items,
        finalIndex
      };
    })
    .filter((turn) => turn.items.length > 0 || turn.completedAt === null || isFailedWorkerTurn(turn.status));
  return {
    turns,
    report: report && !turns.some((turn) => turn.id === report.turnId) ? report : null,
    reports,
    payload: thread.jobPayload ?? null,
    outputManifest: thread.jobOutputManifest ?? null,
    checklist,
    fallback: []
  };
}
