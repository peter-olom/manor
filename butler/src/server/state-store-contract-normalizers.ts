import crypto from "node:crypto";

import { normalizeRoutingDecision } from "./butler-orchestration.js";
import { buildMissionContract, buildVerificationMatrix, inferTaskCategory, inferWorkDepth } from "./thread-contract.js";
import { normalizeWorkerReviewPaths } from "./worker-review-attribution.js";
import type {
  CodexThreadExecutionContractView,
  CodexWorkerEvidenceView,
  SupervisionChecklistView,
  VerificationMatrixRowView,
  WorkerEvidenceKind,
  WorkerReviewSeverity
} from "./types.js";

export function normalizeSupervisionChecklist(raw: SupervisionChecklistView): SupervisionChecklistView {
  const now = Date.now();
  const items = raw.items
    .filter((item) => item && typeof item === "object" && typeof item.text === "string" && item.text.trim())
    .map((item, index) => {
      const status: SupervisionChecklistView["items"][number]["status"] =
        item.status === "accepted" || item.status === "rejected" || item.status === "waived" ? item.status : "pending";
      return {
        id: typeof item.id === "string" && item.id.trim() ? item.id.trim() : `point-${index + 1}`,
        text: item.text.trim(),
        status,
        butlerNote: typeof item.butlerNote === "string" && item.butlerNote.trim() ? item.butlerNote.trim() : null,
        queuedInstruction:
          typeof item.queuedInstruction === "string" && item.queuedInstruction.trim() ? item.queuedInstruction.trim() : null,
        decidedAt: typeof item.decidedAt === "number" && Number.isFinite(item.decidedAt) ? item.decidedAt : null,
        evidence: Array.isArray(item.evidence)
          ? item.evidence
              .filter((entry) => entry && typeof entry === "object" && typeof entry.summary === "string")
              .map((entry) => ({
                id: typeof entry.id === "string" && entry.id.trim() ? entry.id.trim() : crypto.randomUUID(),
                source: entry.source === "butler_review" ? ("butler_review" as const) : ("worker_report" as const),
                kind: normalizeWorkerEvidenceKind(entry.kind, entry.source === "butler_review" ? "butler_review" : "manual"),
                pointId: typeof entry.pointId === "string" && entry.pointId.trim() ? entry.pointId.trim() : null,
                matrixRowId: typeof entry.matrixRowId === "string" && entry.matrixRowId.trim() ? entry.matrixRowId.trim() : null,
                summary: entry.summary.trim(),
                details: typeof entry.details === "string" && entry.details.trim() ? entry.details.trim() : null,
                reportTurnId: typeof entry.reportTurnId === "string" && entry.reportTurnId.trim() ? entry.reportTurnId.trim() : null,
                proofRunId: typeof entry.proofRunId === "string" && entry.proofRunId.trim() ? entry.proofRunId.trim() : null,
                artifactId: typeof entry.artifactId === "string" && entry.artifactId.trim() ? entry.artifactId.trim() : null,
                command: typeof entry.command === "string" && entry.command.trim() ? entry.command.trim() : null,
                route: typeof entry.route === "string" && entry.route.trim() ? entry.route.trim() : null,
                createdAt: typeof entry.createdAt === "number" && Number.isFinite(entry.createdAt) ? entry.createdAt : now
              }))
              .slice(-20)
          : []
      };
    });
  return {
    threadId: typeof raw.threadId === "string" && raw.threadId.trim() ? raw.threadId.trim() : "unknown",
    projectId: typeof raw.projectId === "string" && raw.projectId.trim() ? raw.projectId.trim() : "unknown",
    projectLabel: typeof raw.projectLabel === "string" && raw.projectLabel.trim() ? raw.projectLabel.trim() : "Unknown",
    requestedTask:
      typeof raw.requestedTask === "string" && raw.requestedTask.trim() ? raw.requestedTask.trim() : "Carry out the delegated task.",
    items,
    heartbeat: {
      lastThreadEventAt:
        typeof raw.heartbeat?.lastThreadEventAt === "number" && Number.isFinite(raw.heartbeat.lastThreadEventAt)
          ? raw.heartbeat.lastThreadEventAt
          : null,
      lastWorkerReportAt:
        typeof raw.heartbeat?.lastWorkerReportAt === "number" && Number.isFinite(raw.heartbeat.lastWorkerReportAt)
          ? raw.heartbeat.lastWorkerReportAt
          : null,
      lastKnownThreadStatus:
        raw.heartbeat?.lastKnownThreadStatus === "active" ||
        raw.heartbeat?.lastKnownThreadStatus === "idle" ||
        raw.heartbeat?.lastKnownThreadStatus === "unknown"
          ? raw.heartbeat.lastKnownThreadStatus
          : "unknown",
      stale: Boolean(raw.heartbeat?.stale)
    },
    reviewState: raw.reviewState === "reviewed" ? "reviewed" : "needs_review",
    createdAt: typeof raw.createdAt === "number" && Number.isFinite(raw.createdAt) ? raw.createdAt : now,
    updatedAt: typeof raw.updatedAt === "number" && Number.isFinite(raw.updatedAt) ? raw.updatedAt : now
  };
}

function normalizeWorkerEvidenceKind(
  value: unknown,
  fallback: WorkerEvidenceKind | "butler_review" = "manual"
): WorkerEvidenceKind | "butler_review" {
  return typeof value === "string" &&
    [
      "unit_test",
      "integration_test",
      "api_smoke",
      "browser_flow",
      "visual_review",
      "responsive_review",
      "accessibility_review",
      "log_review",
      "data_check",
      "negative_case",
      "build",
      "deploy_health",
      "taste_review",
      "intent_review",
      "manual_waiver",
      "proof",
      "screenshot",
      "video",
      "trace",
      "log",
      "command",
      "file",
      "manual",
      "butler_review"
    ].includes(value)
    ? (value as WorkerEvidenceKind | "butler_review")
    : fallback;
}

export function normalizeWorkerEvidence(
  raw: unknown,
  fallback: { pointId?: string | null; matrixRowId?: string | null; createdAt?: number } = {}
): CodexWorkerEvidenceView | null {
  if (!raw || typeof raw !== "object") return null;
  const record = raw as Partial<CodexWorkerEvidenceView>;
  const summary = typeof record.summary === "string" && record.summary.trim() ? record.summary.trim() : null;
  if (!summary) return null;
  return {
    id: typeof record.id === "string" && record.id.trim() ? record.id.trim() : crypto.randomUUID(),
    pointId: typeof record.pointId === "string" && record.pointId.trim() ? record.pointId.trim() : fallback.pointId ?? null,
    matrixRowId:
      typeof record.matrixRowId === "string" && record.matrixRowId.trim() ? record.matrixRowId.trim() : fallback.matrixRowId ?? null,
    kind: normalizeWorkerEvidenceKind(record.kind) as WorkerEvidenceKind,
    summary,
    details: typeof record.details === "string" && record.details.trim() ? record.details.trim() : null,
    command: typeof record.command === "string" && record.command.trim() ? record.command.trim() : null,
    exitCode: typeof record.exitCode === "number" && Number.isFinite(record.exitCode) ? Math.trunc(record.exitCode) : null,
    proofRunId: typeof record.proofRunId === "string" && record.proofRunId.trim() ? record.proofRunId.trim() : null,
    artifactId: typeof record.artifactId === "string" && record.artifactId.trim() ? record.artifactId.trim() : null,
    route: typeof record.route === "string" && record.route.trim() ? record.route.trim() : null,
    logRef: typeof record.logRef === "string" && record.logRef.trim() ? record.logRef.trim() : null,
    dataRef: typeof record.dataRef === "string" && record.dataRef.trim() ? record.dataRef.trim() : null,
    createdAt: typeof record.createdAt === "number" && Number.isFinite(record.createdAt) ? record.createdAt : fallback.createdAt ?? Date.now()
  };
}

function normalizeVerificationMatrixRow(raw: unknown, index: number, fallbackPoint: string | null): VerificationMatrixRowView | null {
  if (!raw || typeof raw !== "object") return null;
  const row = raw as Partial<VerificationMatrixRowView>;
  const text = typeof row.text === "string" && row.text.trim() ? row.text.trim() : fallbackPoint;
  if (!text) return null;
  const checkKinds = Array.isArray(row.checkKinds)
    ? row.checkKinds
        .map((kind) => (typeof kind === "string" ? normalizeWorkerEvidenceKind(kind, "manual") : null))
        .filter(
          (kind): kind is VerificationMatrixRowView["checkKinds"][number] =>
            kind !== null &&
            kind !== "butler_review" &&
            kind !== "proof" &&
            kind !== "screenshot" &&
            kind !== "video" &&
            kind !== "trace" &&
            kind !== "log" &&
            kind !== "command" &&
            kind !== "file" &&
            kind !== "manual"
        )
    : [];
  return {
    id: typeof row.id === "string" && row.id.trim() ? row.id.trim() : `row-${index + 1}`,
    acceptancePointId:
      typeof row.acceptancePointId === "string" && row.acceptancePointId.trim() ? row.acceptancePointId.trim() : `point-${index + 1}`,
    text,
    requiredChecks: Array.isArray(row.requiredChecks)
      ? row.requiredChecks.filter((entry): entry is string => typeof entry === "string" && Boolean(entry.trim())).map((entry) => entry.trim())
      : checkKinds.map((kind) => kind.replace(/_/g, " ")),
    checkKinds,
    expectedEvidence: Array.isArray(row.expectedEvidence)
      ? row.expectedEvidence.filter((entry): entry is string => typeof entry === "string" && Boolean(entry.trim())).map((entry) => entry.trim())
      : [],
    owner: row.owner === "butler" || row.owner === "both" ? row.owner : "worker",
    status:
      row.status === "evidence_submitted" || row.status === "accepted" || row.status === "rejected" || row.status === "waived"
        ? row.status
        : "pending",
    evidenceIds: Array.isArray(row.evidenceIds) ? row.evidenceIds.filter((entry): entry is string => typeof entry === "string") : [],
    artifactRefs: Array.isArray(row.artifactRefs) ? row.artifactRefs.filter((entry): entry is string => typeof entry === "string") : [],
    commandRefs: Array.isArray(row.commandRefs) ? row.commandRefs.filter((entry): entry is string => typeof entry === "string") : [],
    reviewerNote: typeof row.reviewerNote === "string" && row.reviewerNote.trim() ? row.reviewerNote.trim() : null,
    updatedAt: typeof row.updatedAt === "number" && Number.isFinite(row.updatedAt) ? row.updatedAt : null
  };
}

export function normalizeExecutionContract(contract: CodexThreadExecutionContractView): CodexThreadExecutionContractView {
  const requestedTask =
    typeof contract.requestedTask === "string" && contract.requestedTask.trim()
      ? contract.requestedTask.trim()
      : "Carry out the delegated task.";
  const operatorGoal = typeof contract.operatorGoal === "string" && contract.operatorGoal.trim() ? contract.operatorGoal.trim() : null;
  const acceptancePoints = Array.isArray(contract.acceptancePoints)
    ? contract.acceptancePoints.filter((point): point is string => typeof point === "string" && Boolean(point.trim())).map((point) => point.trim())
    : [];
  const contractText = [requestedTask, operatorGoal, ...acceptancePoints].filter(Boolean).join("\n");
  const taskCategory =
    contract.taskCategory === "ui" ||
    contract.taskCategory === "api" ||
    contract.taskCategory === "deploy" ||
    contract.taskCategory === "docs" ||
    contract.taskCategory === "data" ||
    contract.taskCategory === "writing" ||
    contract.taskCategory === "generic_code" ||
    contract.taskCategory === "read_only" ||
    contract.taskCategory === "research" ||
    contract.taskCategory === "prototype" ||
    contract.taskCategory === "plan" ||
    contract.taskCategory === "recommendation" ||
    contract.taskCategory === "unknown"
      ? contract.taskCategory
      : inferTaskCategory(contractText);
  const inferredWorkDepth =
    contract.inferredWorkDepth === "quick" ||
    contract.inferredWorkDepth === "standard" ||
    contract.inferredWorkDepth === "deep" ||
    contract.inferredWorkDepth === "incident"
      ? contract.inferredWorkDepth
      : inferWorkDepth(contractText, taskCategory);
  const verificationMatrix = Array.isArray(contract.verificationMatrix)
    ? contract.verificationMatrix
        .map((row, index) => normalizeVerificationMatrixRow(row, index, acceptancePoints[index] ?? null))
        .filter((row): row is VerificationMatrixRowView => Boolean(row))
    : [];
  const orchestration = normalizeRoutingDecision(contract.orchestration, taskCategory);
  const reviewPeerContexts = Array.isArray(contract.reviewPeerContexts)
    ? contract.reviewPeerContexts.flatMap((entry) => {
        if (!entry || typeof entry !== "object" || typeof entry.sourceThreadId !== "string") return [];
        const paths = normalizeWorkerReviewPaths(entry.paths);
        const attributionUnknown = entry.attributionUnknown === true;
        return paths.length > 0 || attributionUnknown ? [{ sourceThreadId: entry.sourceThreadId, baselineTreeSha: typeof entry.baselineTreeSha === "string" ? entry.baselineTreeSha : null, paths, attributionUnknown, recordedAt: typeof entry.recordedAt === "number" && Number.isFinite(entry.recordedAt) ? entry.recordedAt : Date.now() }] : [];
      }).slice(-32)
    : [];
  const rawMission = contract.mission && typeof contract.mission === "object" ? contract.mission : null;
  const mission = rawMission
    ? {
        ...buildMissionContract({
          taskText: contractText,
          requestedTask,
          operatorGoal,
          taskCategory,
          tasteNotes: Array.isArray(rawMission.tasteNotes)
            ? rawMission.tasteNotes
                .filter((note): note is string => typeof note === "string" && Boolean(note.trim()))
                .map((note) => note.trim())
            : [],
          plannerSteps: Array.isArray(rawMission.plannerSteps)
            ? rawMission.plannerSteps
                .filter((step): step is string => typeof step === "string" && Boolean(step.trim()))
                .map((step) => step.trim())
            : [],
          criticChecks: Array.isArray(rawMission.criticChecks)
            ? rawMission.criticChecks
                .filter((check): check is string => typeof check === "string" && Boolean(check.trim()))
                .map((check) => check.trim())
            : [],
          operatorQuestionPolicy:
            typeof rawMission.operatorQuestionPolicy === "string" && rawMission.operatorQuestionPolicy.trim()
              ? rawMission.operatorQuestionPolicy.trim()
              : null,
          blockedConditions: Array.isArray(rawMission.blockedConditions)
            ? rawMission.blockedConditions
                .filter((condition): condition is string => typeof condition === "string" && Boolean(condition.trim()))
                .map((condition) => condition.trim())
            : []
        }),
        intent:
          typeof rawMission.intent === "string" && rawMission.intent.trim()
            ? rawMission.intent.trim()
            : operatorGoal ?? requestedTask
      }
    : undefined;
  return {
    ...contract,
    requestedTask,
    operatorGoal,
    acceptancePoints,
    proofExpectation: contract.proofExpectation === "requested" ? "requested" : "none",
    proofExpectationLabel: contract.proofExpectation === "requested" ? "proof requested" : "no explicit proof request",
    inferredWorkDepth,
    taskCategory,
    verificationMatrix:
      verificationMatrix.length > 0
        ? verificationMatrix
        : buildVerificationMatrix({ acceptancePoints, taskCategory, inferredWorkDepth }),
    ...(orchestration ? { orchestration } : {}),
    reviewPeerContexts,
    reviewPeerContextOverflow: contract.reviewPeerContextOverflow === true,
    reviewBaselineCaptureFailed: contract.reviewBaselineCaptureFailed === true,
    ...(mission ? { mission } : {}),
    notes: Array.isArray(contract.notes) ? contract.notes.filter((note): note is string => typeof note === "string") : []
  };
}
