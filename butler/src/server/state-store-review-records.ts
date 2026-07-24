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
    const next: ReviewRecord = { ...record, createdAt: record.createdAt || now, updatedAt: now };
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
  latest.findings = [...latest.findings, {
    id: `proof-${runId}-${now}`, severity: verdict === "failed" ? "high" : "info",
    summary: `Proof review for ${runId}: ${verdict}. ${concern}`, blocking: verdict === "failed",
    waived: false, waiverReason: null, source: "butler_review", proofRunId: runId, checklistItemId: null, createdAt: now
  }];
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