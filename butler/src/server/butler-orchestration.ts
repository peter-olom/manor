import crypto from "node:crypto";

import type {
  ButlerRoutingDecisionView,
  ButlerRoutingQuestionView,
  ButlerRoutingRiskLevel,
  ButlerRoutingTaskClass,
  CodexTaskCategory,
  CodexThreadExecutionContractView,
  CodexThreadRecord,
  CodexWorkerReportView,
  WorkerClaimStatus,
  WorkerClaimsReportView,
  WorkerReviewResultRecordView,
  WorkerReviewSeverity
} from "./types.js";

const TASK_CLASSES = new Set<string>([
  "trivial",
  "ui",
  "api",
  "deploy",
  "docs",
  "data",
  "writing",
  "generic_code",
  "read_only",
  "research",
  "prototype",
  "plan",
  "recommendation",
  "unknown"
]);
const RISK_LEVELS = new Set<string>(["low", "medium", "high", "critical"]);
const CLAIM_STATUSES = new Set<string>(["completed", "partial", "blocked"]);
const REVIEW_SEVERITIES = new Set<string>(["info", "low", "medium", "high", "critical"]);

function text(value: unknown, maxLength: number): string | null {
  const normalized = typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
  if (!normalized) return null;
  return normalized.length > maxLength ? normalized.slice(0, maxLength - 1).trimEnd() : normalized;
}

function stringList(value: unknown, maxItems: number, maxLength: number): string[] {
  return (Array.isArray(value) ? value : [])
    .map((entry) => text(entry, maxLength))
    .filter((entry): entry is string => Boolean(entry))
    .slice(0, maxItems);
}

function readRecordString(record: Record<string, unknown>, ...keys: string[]): string | null {
  for (const key of keys) {
    const value = text(record[key], 1200);
    if (value) return value;
  }
  return null;
}

export function normalizeRoutingDecision(raw: unknown, fallbackTaskClass: CodexTaskCategory = "unknown"): ButlerRoutingDecisionView | null {
  if (!raw || typeof raw !== "object") return null;
  const record = raw as Record<string, unknown>;
  const rawTaskClass = text(record.taskClass ?? record.task_class, 80);
  if (!rawTaskClass || !TASK_CLASSES.has(rawTaskClass)) return null;
  const rawRisk = text(record.riskLevel ?? record.risk_level ?? record.risk, 40);
  if (!rawRisk || !RISK_LEVELS.has(rawRisk)) return null;
  if (typeof record.confidence !== "number" || !Number.isFinite(record.confidence)) return null;
  const rawQuestionSet = record.questionSet ?? record.question_set ?? record.questions;
  if (!Array.isArray(rawQuestionSet)) return null;
  const rawSubAgentRoles = record.subAgentRoles ?? record.sub_agent_roles;
  if (!Array.isArray(rawSubAgentRoles)) return null;
  const goal = record.goalRecommendation && typeof record.goalRecommendation === "object" && !Array.isArray(record.goalRecommendation)
    ? (record.goalRecommendation as Record<string, unknown>)
    : record.goal_recommendation && typeof record.goal_recommendation === "object" && !Array.isArray(record.goal_recommendation)
      ? (record.goal_recommendation as Record<string, unknown>)
      : null;
  const review = record.reviewRecommendation && typeof record.reviewRecommendation === "object" && !Array.isArray(record.reviewRecommendation)
    ? (record.reviewRecommendation as Record<string, unknown>)
    : record.review_recommendation && typeof record.review_recommendation === "object" && !Array.isArray(record.review_recommendation)
      ? (record.review_recommendation as Record<string, unknown>)
      : null;
  if (!goal || !review) return null;
  const rawGoalMode = text(goal.mode, 40);
  if (rawGoalMode !== "none" && rawGoalMode !== "native_goal" && rawGoalMode !== "contract_fallback") return null;
  const reviewRequired = review.required === true;
  const rawReviewTarget = text(review.target, 40);
  if (rawReviewTarget !== "none" && rawReviewTarget !== "codex_review" && rawReviewTarget !== "adversarial_review") return null;

  return {
    taskClass: rawTaskClass as ButlerRoutingTaskClass,
    confidence: Math.max(0, Math.min(1, record.confidence)),
    questionSet: normalizeRoutingQuestions(rawQuestionSet),
    goalRecommendation: {
      mode: rawGoalMode,
      goal: text(goal.goal, 500),
      fallbackReason: text(goal.fallbackReason ?? goal.fallback_reason, 500)
    },
    reviewRecommendation: {
      target: rawReviewTarget === "codex_review" ? "adversarial_review" : rawReviewTarget,
      required: reviewRequired || rawReviewTarget === "codex_review" || rawReviewTarget === "adversarial_review",
      reason: text(review.reason, 500)
    },
    subAgentRoles: stringList(rawSubAgentRoles, 8, 80),
    riskLevel: rawRisk as ButlerRoutingRiskLevel,
    fallbackReason: text(record.fallbackReason ?? record.fallback_reason, 500),
    createdAt: typeof record.createdAt === "number" && Number.isFinite(record.createdAt) ? record.createdAt : Date.now()
  };
}

function normalizeRoutingQuestions(raw: unknown): ButlerRoutingQuestionView[] {
  return (Array.isArray(raw) ? raw : [])
    .map((entry, index) => {
      if (!entry || typeof entry !== "object") return null;
      const record = entry as Record<string, unknown>;
      const prompt = text(record.prompt ?? record.question, 500);
      if (!prompt) return null;
      const options = (Array.isArray(record.options) ? record.options : [])
        .map((option) => {
          if (!option || typeof option !== "object") return null;
          const optionRecord = option as Record<string, unknown>;
          const label = text(optionRecord.label, 120);
          if (!label) return null;
          return {
            id: text(optionRecord.id, 80),
            label,
            description: text(optionRecord.description, 300)
          };
        })
        .filter((option): option is { id: string | null; label: string; description: string | null } => Boolean(option))
        .slice(0, 4);
      return {
        id: text(record.id, 80) ?? `question-${index + 1}`,
        prompt,
        context: text(record.context, 500),
        options,
        allowFreeform: record.allowFreeform !== false && record.allow_freeform !== false
      };
    })
    .filter((entry): entry is ButlerRoutingQuestionView => Boolean(entry))
    .slice(0, 5);
}

export function normalizeWorkerClaimsReport(raw: unknown): WorkerClaimsReportView | null {
  if (!raw || typeof raw !== "object") return null;
  const record = raw as Record<string, unknown>;
  const changedWorkSummary = readRecordString(record, "changedWorkSummary", "changed_work_summary", "summary");
  if (!Array.isArray(record.claims) || record.claims.length === 0 || record.claims.length > 20) return null;
  const claims: WorkerClaimsReportView["claims"] = [];
  for (const [index, entry] of record.claims.entries()) {
    if (!entry || typeof entry !== "object") return null;
    const item = entry as Record<string, unknown>;
    const status = text(item.status, 40);
    const summary = readRecordString(item, "summary", "claim", "completed_claim");
    const evidencePointer = readRecordString(item, "evidencePointer", "evidence_pointer");
    if (!status || !CLAIM_STATUSES.has(status) || !summary || !evidencePointer) return null;
    claims.push({
      claimId: readRecordString(item, "claimId", "claim_id", "id") ?? `claim-${index + 1}`,
      status: status as WorkerClaimStatus,
      summary,
      evidencePointer,
      proofId: readRecordString(item, "proofId", "proof_id"),
      riskNote: readRecordString(item, "riskNote", "risk_note"),
      reviewerTarget: readRecordString(item, "reviewerTarget", "reviewer_target")
    });
  }
  if (!changedWorkSummary || claims.length === 0) return null;
  const rawSubAgentSummaries = record.subAgentSummaries ?? record.sub_agent_summaries;
  const subAgentSummaries = (Array.isArray(rawSubAgentSummaries) ? rawSubAgentSummaries : [])
    .map((entry: unknown) => {
      if (!entry || typeof entry !== "object") return null;
      const item = entry as Record<string, unknown>;
      const role = readRecordString(item, "role");
      const summary = readRecordString(item, "summary");
      if (!role || !summary) return null;
      return {
        role,
        summary,
        evidencePointer: readRecordString(item, "evidencePointer", "evidence_pointer")
      };
    })
    .filter((entry: WorkerClaimsReportView["subAgentSummaries"][number] | null): entry is WorkerClaimsReportView["subAgentSummaries"][number] => Boolean(entry))
    .slice(0, 12);
  return {
    version: 1,
    changedWorkSummary,
    claims,
    risks: stringList(record.risks, 12, 500),
    unresolvedItems: stringList(record.unresolvedItems ?? record.unresolved_items, 12, 500),
    subAgentSummaries
  };
}

export function requiresStrictWorkerClaims(thread: CodexThreadRecord): boolean {
  return Boolean(thread.executionContract?.orchestration);
}

export function getOrchestrationCloseoutBlocker(input: {
  thread: CodexThreadRecord | null | undefined;
  workerReport: CodexWorkerReportView | null | undefined;
}): string | null {
  const contract = input.thread?.executionContract;
  const orchestration = contract?.orchestration;
  if (!contract) return null;
  const report = input.workerReport;
  if (report?.status !== "completed") return null;
  if (orchestration && (!report.claims || report.claims.claims.length === 0)) {
    return "Completed worker reports must include strict JSON claims with proof pointers before Butler can close the job.";
  }
  if (orchestration && report.claims?.claims.some((claim) => claim.status !== "completed")) {
    return "Completed worker reports cannot close while any strict claim is partial or blocked.";
  }
  if (orchestration && report.claims?.unresolvedItems.length) {
    return "Completed worker report still lists unresolved items. Butler must resolve, rework, or waive them before closeout.";
  }
  const currentResults = (contract.reviewResults ?? []).filter((result) => result.turnId === report.turnId && result.reportUpdatedAt === report.updatedAt);
  const completedResults = currentResults.filter((result) => result.automationFailure !== true);
  if (completedResults.length === 0) {
    return "Adversarial review must finish before Butler can close the job.";
  }
  const blocker = completedResults.find((result) => result.blocking && !result.waived);
  return blocker ? `Adversarial review blocked closeout: ${blocker.findingSummary}` : null;
}

export function shouldRunCodexWorkerReview(contract: CodexThreadExecutionContractView | null | undefined, report: CodexWorkerReportView): boolean {
  if (report.status !== "completed") return false;
  if (!contract) return false;
  const existing = (contract.reviewResults ?? []).some((result) => result.turnId === report.turnId && result.reportUpdatedAt === report.updatedAt && result.automationFailure !== true);
  return !existing;
}

export function normalizeWorkerReviewResults(input: {
  raw: unknown;
  threadId: string;
  turnId: string;
  reportUpdatedAt: number;
  defaultBlocking?: boolean;
  modelProvider?: string | null;
  modelId?: string | null;
  reasoningLevel?: string | null;
}): WorkerReviewResultRecordView[] {
  const record = input.raw && typeof input.raw === "object" ? (input.raw as Record<string, unknown>) : {};
  const rawFindings = Array.isArray(record.findings) ? record.findings : [];
  return rawFindings
    .map((entry, index): WorkerReviewResultRecordView | null => {
      if (!entry || typeof entry !== "object") return null;
      const item = entry as Record<string, unknown>;
      const summary = readRecordString(item, "findingSummary", "finding_summary", "summary");
      if (!summary) return null;
      const rawSeverity = text(item.severity, 40) ?? "medium";
      const severity = REVIEW_SEVERITIES.has(rawSeverity) ? (rawSeverity as WorkerReviewSeverity) : "medium";
      const blocking = typeof item.blocking === "boolean" ? item.blocking : severity === "high" || severity === "critical" || input.defaultBlocking === true;
      return {
        id: readRecordString(item, "id") ?? `review-${input.turnId}-${index + 1}-${crypto.randomUUID().slice(0, 8)}`,
        reviewSource: "adversarial_review" as const,
        turnId: input.turnId,
        reportUpdatedAt: input.reportUpdatedAt,
        severity,
        findingSummary: summary,
        blocking,
        waived: item.waived === true || item.waiverStatus === "waived" || item.waiver_status === "waived",
        waiverReason: readRecordString(item, "waiverReason", "waiver_reason"),
        automationFailure: false,
        linkedClaimIds: stringList(item.linkedClaimIds ?? item.linked_claim_ids, 20, 100),
        modelProvider: input.modelProvider?.trim() || null,
        modelId: input.modelId?.trim() || null,
        reasoningLevel: input.reasoningLevel?.trim() || null,
        createdAt: Date.now(),
        updatedAt: Date.now()
      };
    })
    .filter((entry): entry is WorkerReviewResultRecordView => Boolean(entry))
    .slice(0, 20);
}
