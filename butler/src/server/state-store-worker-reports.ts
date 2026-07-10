import crypto from "node:crypto";

import { normalizeWorkerClaimsReport } from "./butler-orchestration.js";
import { getSelfImprovementRequestState } from "./self-improvement-request-state.js";
import { recordChecklistWorkerEvidence } from "./supervision-checklist.js";
import { emitStateStoreChange, queueStateStoreSave, type StateStoreInternalAccess } from "./state-store-internals.js";
import type { CodexThreadExecutionContractView, CodexWorkerEvidenceView, CodexWorkerReportView, WorkerClaimsReportView, WorkerReviewResultRecordView } from "./types.js";

export type WorkerReviewBaselineState = {
  cwd: string | null;
  sha: string | null;
  treeSha: string | null;
  objectDir: string | null;
  peerContexts: NonNullable<CodexThreadExecutionContractView["reviewPeerContexts"]>;
  peerContextOverflow: boolean;
};

function normalizeWorkerReportEvidence(rawEvidence: unknown, fallbackCreatedAt: number): CodexWorkerEvidenceView[] {
  if (!Array.isArray(rawEvidence)) {
    return [];
  }
  return rawEvidence
    .map((entry) => {
      if (!entry || typeof entry !== "object") return null;
      const item = entry as Partial<CodexWorkerEvidenceView>;
      const summary = typeof item.summary === "string" && item.summary.trim() ? item.summary.trim() : "";
      if (!summary) return null;
      return {
        id: typeof item.id === "string" && item.id.trim() ? item.id.trim() : crypto.randomUUID(),
        pointId: typeof item.pointId === "string" && item.pointId.trim() ? item.pointId.trim() : null,
        matrixRowId: typeof item.matrixRowId === "string" && item.matrixRowId.trim() ? item.matrixRowId.trim() : null,
        kind: item.kind ?? "manual",
        summary,
        details: typeof item.details === "string" && item.details.trim() ? item.details.trim() : null,
        command: typeof item.command === "string" && item.command.trim() ? item.command.trim() : null,
        exitCode: typeof item.exitCode === "number" && Number.isFinite(item.exitCode) ? Math.trunc(item.exitCode) : null,
        proofRunId: typeof item.proofRunId === "string" && item.proofRunId.trim() ? item.proofRunId.trim() : null,
        artifactId: typeof item.artifactId === "string" && item.artifactId.trim() ? item.artifactId.trim() : null,
        route: typeof item.route === "string" && item.route.trim() ? item.route.trim() : null,
        logRef: typeof item.logRef === "string" && item.logRef.trim() ? item.logRef.trim() : null,
        dataRef: typeof item.dataRef === "string" && item.dataRef.trim() ? item.dataRef.trim() : null,
        createdAt: typeof item.createdAt === "number" && Number.isFinite(item.createdAt) ? item.createdAt : fallbackCreatedAt
      } satisfies CodexWorkerEvidenceView;
    })
    .filter((entry): entry is CodexWorkerEvidenceView => Boolean(entry));
}

function updateExecutionContractFromEvidence(
  access: StateStoreInternalAccess,
  threadId: string,
  evidence: CodexWorkerEvidenceView[],
  status: "completed" | "blocked"
): void {
  if (evidence.length === 0) return;
  const thread = access.getOrCreateThread(threadId);
  const contract = thread.executionContract;
  if (!contract) return;
  const now = Date.now();
  const evidenceByRow = new Map<string, CodexWorkerEvidenceView[]>();
  const evidenceByPoint = new Map<string, CodexWorkerEvidenceView[]>();
  for (const item of evidence) {
    if (item.matrixRowId) evidenceByRow.set(item.matrixRowId, [...(evidenceByRow.get(item.matrixRowId) ?? []), item]);
    if (item.pointId) evidenceByPoint.set(item.pointId, [...(evidenceByPoint.get(item.pointId) ?? []), item]);
  }
  contract.verificationMatrix = contract.verificationMatrix.map((row) => {
    const rowEvidence = [
      ...(row.id ? evidenceByRow.get(row.id) ?? [] : []),
      ...(row.acceptancePointId ? evidenceByPoint.get(row.acceptancePointId) ?? [] : [])
    ];
    if (rowEvidence.length === 0) return row;
    const artifactRefs = rowEvidence.flatMap((item) =>
      [item.artifactId, item.proofRunId].filter((value): value is string => Boolean(value))
    );
    const commandRefs = rowEvidence.flatMap((item) => [item.command].filter((value): value is string => Boolean(value)));
    return {
      ...row,
      status: status === "blocked" ? row.status : "evidence_submitted",
      evidenceIds: [...new Set([...row.evidenceIds, ...rowEvidence.map((item) => item.id)])],
      artifactRefs: [...new Set([...row.artifactRefs, ...artifactRefs])],
      commandRefs: [...new Set([...row.commandRefs, ...commandRefs])],
      updatedAt: now
    };
  });
  access.persistedExecutionContractsByThreadId.set(threadId, { ...contract });
}

export function recordStateStoreWorkerReport(
  access: StateStoreInternalAccess,
  threadId: string,
  report: {
    status: "completed" | "blocked";
    summary: string;
    details?: string | null;
    turnId?: string | null;
    evidence?: CodexWorkerEvidenceView[];
    claims?: WorkerClaimsReportView | null;
  }
): CodexWorkerReportView {
  const thread = access.getOrCreateThread(threadId);
  const latestTurn = thread.turns.at(-1);
  const explicitTurnId = typeof report.turnId === "string" && report.turnId.trim() ? report.turnId.trim() : null;
  const turnId = explicitTurnId ?? latestTurn?.id ?? null;
  if (!turnId) {
    throw new Error("Cannot record a worker report before the thread has an active or completed turn");
  }

  const existing = thread.workerReport;
  const timestamp = Date.now();
  const now = existing?.turnId === turnId && timestamp <= existing.updatedAt ? existing.updatedAt + 1 : timestamp;
  const evidence = normalizeWorkerReportEvidence(report.evidence, now);
  const claims = normalizeWorkerClaimsReport(report.claims);
  const nextReport: CodexWorkerReportView = {
    threadId,
    turnId,
    status: report.status,
    summary: report.summary.trim(),
    details: typeof report.details === "string" && report.details.trim() ? report.details.trim() : null,
    evidence,
    claims,
    createdAt: existing?.turnId === turnId && existing?.status === report.status ? existing.createdAt : now,
    updatedAt: now
  };

  thread.workerReport = nextReport;
  thread.updatedAt = now;
  updateExecutionContractFromEvidence(access, threadId, evidence, report.status);
  const checklist = recordChecklistWorkerEvidence(thread.supervisionChecklist, thread, nextReport, now);
  if (checklist) {
    access.persistedSupervisionChecklistsByThreadId.set(thread.id, { ...checklist });
  }
  const history = access.persistedWorkerReportsByThreadId.get(threadId) ?? [];
  const nextHistory = [...history.filter((entry) => entry.turnId !== turnId), nextReport]
    .sort((left, right) => left.createdAt - right.createdAt)
    .slice(-20);
  access.persistedWorkerReportsByThreadId.set(threadId, nextHistory);
  if (report.status === "completed") {
    try {
      for (const request of getSelfImprovementRequestState().list().filter((entry) => entry.threadId === threadId && entry.status === "running")) {
        getSelfImprovementRequestState().update(request.id, { status: "changes_ready", completedAt: now });
      }
    } catch {}
  }
  queueStateStoreSave(access);
  emitStateStoreChange(access);
  return nextReport;
}

export function listStateStoreWorkerReports(access: StateStoreInternalAccess, threadId: string): CodexWorkerReportView[] {
  const reports = access.persistedWorkerReportsByThreadId.get(threadId) ?? [];
  const liveReport = access.threads.get(threadId)?.workerReport ?? null;
  const byTurnId = new Map<string, CodexWorkerReportView>();
  for (const report of reports) byTurnId.set(report.turnId, report);
  if (liveReport) byTurnId.set(liveReport.turnId, liveReport);
  return [...byTurnId.values()].sort((left, right) => left.createdAt - right.createdAt);
}

export function recordStateStoreWorkerReviewResults(
  access: StateStoreInternalAccess,
  threadId: string,
  results: WorkerReviewResultRecordView[]
): CodexThreadExecutionContractView | null {
  const thread = access.getOrCreateThread(threadId);
  if (!thread.executionContract) return null;
  const byId = new Map<string, WorkerReviewResultRecordView>();
  for (const result of thread.executionContract.reviewResults ?? []) byId.set(result.id, result);
  for (const result of results) byId.set(result.id, result);
  thread.executionContract.reviewResults = [...byId.values()].sort((left, right) => left.createdAt - right.createdAt).slice(-80);
  thread.updatedAt = Date.now();
  access.persistedExecutionContractsByThreadId.set(threadId, { ...thread.executionContract });
  queueStateStoreSave(access);
  emitStateStoreChange(access);
  return thread.executionContract;
}

export function recordStateStoreWorkerReviewPeerContext(access: StateStoreInternalAccess, threadId: string, context: NonNullable<CodexThreadExecutionContractView["reviewPeerContexts"]>[number]): void {
  const thread = access.threads.get(threadId);
  if (!thread?.executionContract || (context.paths.length === 0 && context.attributionUnknown !== true)) return;
  const retained = (thread.executionContract.reviewPeerContexts ?? []).filter((entry) => entry.sourceThreadId !== context.sourceThreadId);
  if (retained.length >= 32) thread.executionContract.reviewPeerContextOverflow = true;
  thread.executionContract.reviewPeerContexts = [
    ...retained,
    context
  ].slice(-32);
  access.persistedExecutionContractsByThreadId.set(threadId, { ...thread.executionContract });
  queueStateStoreSave(access);
  emitStateStoreChange(access);
}

export function replaceStateStoreWorkerReviewBaseline(access: StateStoreInternalAccess, threadId: string, baseline: WorkerReviewBaselineState): void {
  const thread = access.threads.get(threadId);
  if (!thread?.executionContract) return;
  thread.executionContract = { ...thread.executionContract, reviewBaselineCwd: baseline.cwd, reviewBaselineSha: baseline.sha, reviewBaselineTreeSha: baseline.treeSha, reviewBaselineObjectDir: baseline.objectDir, reviewPeerContexts: baseline.peerContexts, reviewPeerContextOverflow: baseline.peerContextOverflow };
  access.persistedExecutionContractsByThreadId.set(threadId, { ...thread.executionContract });
  queueStateStoreSave(access);
  emitStateStoreChange(access);
}
