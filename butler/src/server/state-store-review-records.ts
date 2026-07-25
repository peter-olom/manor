import crypto from "node:crypto";

import { emitStateStoreChange, queueStateStoreSave, type StateStoreInternalAccess } from "./state-store-internals.js";
import type { ReviewRecord } from "./types.js";

export function upsertStateStoreReviewRecord(access: StateStoreInternalAccess, threadId: string, record: ReviewRecord): ReviewRecord {
  const thread = access.threads.get(threadId) ?? access.getOrCreateThread(threadId);
  const existingIdx = thread.reviewRecords.findIndex((r) =>
    r.attemptId === record.attemptId &&
    r.scopeId === record.scopeId &&
    r.reportUpdatedAt === record.reportUpdatedAt &&
    (r.outputManifestHash ?? null) === (record.outputManifestHash ?? null)
  );
  const now = Date.now();
  if (existingIdx !== -1) {
    const existing = thread.reviewRecords[existingIdx]!;
    const byId = new Map(existing.findings.map((f) => [f.id, f]));
    for (const f of record.findings) byId.set(f.id, f);
    const mergedFindings = [...byId.values()].sort((a, b) => a.createdAt - b.createdAt);
    const hasBlocking = mergedFindings.some((f) => f.blocking && !f.waived);
    const next: ReviewRecord = {
      ...existing,
      findings: mergedFindings,
      state: hasBlocking ? "rejected" : record.state === "accepted" && !hasBlocking ? "accepted" : existing.state,
      workerInstruction: record.workerInstruction ?? existing.workerInstruction,
      reviewedAt: record.reviewedAt ?? existing.reviewedAt,
      updatedAt: now
    };
    thread.reviewRecords = [...thread.reviewRecords.slice(0, existingIdx), next, ...thread.reviewRecords.slice(existingIdx + 1)];
    syncPersistedReviewRecords(access, threadId);
    thread.updatedAt = now;
    queueStateStoreSave(access);
    emitStateStoreChange(access);
    return next;
  }
  const next: ReviewRecord = { ...record, createdAt: record.createdAt || now, updatedAt: now };
  thread.reviewRecords = [...thread.reviewRecords, next];
  syncPersistedReviewRecords(access, threadId);
  thread.updatedAt = now;
  queueStateStoreSave(access);
  emitStateStoreChange(access);
  return next;
}

export function getLatestStateStoreReviewRecord(access: StateStoreInternalAccess, threadId: string): ReviewRecord | null {
  const thread = access.threads.get(threadId) ?? access.getOrCreateThread(threadId);
  return thread.reviewRecords.length > 0
    ? [...thread.reviewRecords].sort((left, right) => right.reportUpdatedAt - left.reportUpdatedAt)[0]
    : null;
}

export function rejectStaleStateStoreReviewRecords(access: StateStoreInternalAccess, threadId: string, currentReportUpdatedAt: number): void {
  const thread = access.threads.get(threadId) ?? access.getOrCreateThread(threadId);
  const now = Date.now();
  let changed = false;
  for (const record of thread.reviewRecords) {
    if (record.reportUpdatedAt < currentReportUpdatedAt && (record.state === "queued" || record.state === "running")) {
      const alreadySuperseded = record.findings.some((f) => f.id.startsWith("superseded-"));
      if (alreadySuperseded) continue;
      record.state = "rejected";
      record.reviewedAt = now;
      record.updatedAt = now;
      record.findings = [...record.findings, { id: `superseded-${crypto.randomUUID().slice(0, 8)}`, severity: "info", summary: "Review superseded by a newer Worker report.", blocking: false, waived: true, waiverReason: "Newer report arrived before review completed.", source: "butler_review", proofRunId: null, checklistItemId: null, createdAt: now }];
      changed = true;
    }
  }
  if (changed) {
    syncPersistedReviewRecords(access, threadId);
    thread.updatedAt = now;
    queueStateStoreSave(access);
    emitStateStoreChange(access);
  }
}

export function addProofReviewFindingToLatestRecord(access: StateStoreInternalAccess, threadId: string, runId: string, verdict: string, concern: string): void {
  const thread = access.threads.get(threadId);
  if (!thread || thread.reviewRecords.length === 0) return;
  const latest = [...thread.reviewRecords].sort((left, right) => right.reportUpdatedAt - left.reportUpdatedAt)[0];
  if (!latest) return;
  const now = Date.now();
  const withoutStale = latest.findings.filter((f) => f.proofRunId !== runId);
  const newFinding = {
    id: `proof-${runId}-${now}`, severity: verdict === "failed" ? "high" as const : "info" as const,
    summary: `Proof review for ${runId}: ${verdict}. ${concern}`, blocking: verdict === "failed",
    waived: false, waiverReason: null, source: "butler_review" as const, proofRunId: runId, checklistItemId: null, createdAt: now
  };
  latest.findings = [...withoutStale, newFinding];
  const hasBlocking = latest.findings.some((f) => f.blocking && !f.waived);
  if (!hasBlocking && latest.state === "rejected") latest.state = "accepted";
  if (verdict === "failed") latest.state = "rejected";
  latest.updatedAt = now;
  syncPersistedReviewRecords(access, threadId);
  thread.updatedAt = now;
  queueStateStoreSave(access);
  emitStateStoreChange(access);
}

function syncPersistedReviewRecords(access: StateStoreInternalAccess, threadId: string): void {
  const thread = access.threads.get(threadId);
  if (!thread) return;
  access.persistedReviewRecordsByThreadId.set(threadId, thread.reviewRecords.map((r) => ({ ...r, findings: r.findings.map((f) => ({ ...f })) })));
}

export function normalizeReviewRecord(raw: unknown): ReviewRecord | null {
  const r = raw && typeof raw === "object" ? raw as Record<string, unknown> : null;
  if (!r || typeof r.id !== "string" || typeof r.threadId !== "string" || typeof r.attemptId !== "string" || typeof r.scopeId !== "string" || typeof r.reportUpdatedAt !== "number") return null;
  const validState = r.state === "queued" || r.state === "running" || r.state === "accepted" || r.state === "rejected";
  if (!validState) return null;
  const validSeverities = new Set(["info", "low", "medium", "high", "critical"]);
  const findings: ReviewRecord["findings"] = Array.isArray(r.findings)
    ? r.findings.filter((f): f is ReviewRecord["findings"][number] =>
        f && typeof f === "object" && typeof f.id === "string" && typeof f.summary === "string" &&
        validSeverities.has(f.severity as string)
      )
    : [];
  return {
    id: r.id, threadId: r.threadId, attemptId: r.attemptId, scopeId: r.scopeId,
    reportUpdatedAt: r.reportUpdatedAt,
    outputManifestHash: typeof r.outputManifestHash === "string" ? r.outputManifestHash : null,
    state: r.state as ReviewRecord["state"],
    findings: findings.map((f) => ({
      id: f.id, severity: f.severity as ReviewRecord["findings"][number]["severity"], summary: f.summary ?? "",
      blocking: Boolean(f.blocking), waived: Boolean(f.waived),
      waiverReason: typeof f.waiverReason === "string" ? f.waiverReason : null,
      source: f.source === "adversarial_review" ? "adversarial_review" : "butler_review",
      proofRunId: typeof f.proofRunId === "string" ? f.proofRunId : null,
      checklistItemId: typeof f.checklistItemId === "string" ? f.checklistItemId : null,
      createdAt: typeof f.createdAt === "number" ? f.createdAt : (r.reportUpdatedAt as number)
    })),
    workerInstruction: typeof r.workerInstruction === "string" ? r.workerInstruction : null,
    reviewedAt: typeof r.reviewedAt === "number" ? r.reviewedAt : null,
    createdAt: typeof r.createdAt === "number" ? r.createdAt : (r.reportUpdatedAt as number),
    updatedAt: typeof r.updatedAt === "number" ? r.updatedAt : (r.reportUpdatedAt as number)
  };
}

export function clearReviewRecordsForThread(access: StateStoreInternalAccess, threadId: string): void {
  access.persistedReviewRecordsByThreadId.delete(threadId);
}
