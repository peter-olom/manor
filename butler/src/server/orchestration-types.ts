export type ButlerRoutingRiskLevel = "low" | "medium" | "high" | "critical";
export type ButlerRoutingTaskClass =
  | "trivial"
  | "ui"
  | "api"
  | "deploy"
  | "docs"
  | "data"
  | "writing"
  | "generic_code"
  | "read_only"
  | "research"
  | "prototype"
  | "plan"
  | "recommendation"
  | "unknown";
export type ButlerGoalRoutingMode = "none" | "native_goal" | "contract_fallback";
export type ButlerReviewRoutingTarget = "none" | "adversarial_review";
export type WorkerClaimStatus = "completed" | "partial" | "blocked";
export type WorkerReviewSeverity = "info" | "low" | "medium" | "high" | "critical";

export type ReviewRecordState = "queued" | "running" | "accepted" | "rejected";

export interface ReviewFinding {
  id: string;
  severity: WorkerReviewSeverity;
  summary: string;
  blocking: boolean;
  waived: boolean;
  waiverReason: string | null;
  source: "adversarial_review" | "butler_review";
  proofRunId: string | null;
  checklistItemId: string | null;
  createdAt: number;
}

export interface ReviewRecord {
  id: string;
  threadId: string;
  attemptId: string;
  scopeId: string;
  reportUpdatedAt: number;
  outputManifestHash: string | null;
  state: ReviewRecordState;
  findings: ReviewFinding[];
  workerInstruction: string | null;
  reviewedAt: number | null;
  createdAt: number;
  updatedAt: number;
}
export type ReviewPanelRole = "intent" | "qa" | "ui_taste" | "api" | "ops" | "product";
export type ReviewPanelVerdict = "pending" | "passed" | "concern" | "failed" | "blocked";
export type ReviewPanelSummaryStatus = "pending" | "passed" | "concerns" | "blocked";

export interface ReviewPanelRunView {
  id: string;
  role: ReviewPanelRole;
  label: string;
  scope: string;
  trigger: string;
  prompt: string;
  verdict: ReviewPanelVerdict;
  concerns: string[];
  evidenceRefs: string[];
  requiredFollowUp: string | null;
  reviewerNote: string | null;
  modelProvider: string | null;
  modelId: string | null;
  createdAt: number;
  reviewedAt: number | null;
  updatedAt: number;
}

export interface ReviewPanelSummaryView {
  status: ReviewPanelSummaryStatus;
  reviewers: number;
  passed: number;
  concerns: number;
  blocking: number;
  summary: string | null;
  updatedAt: number | null;
}

export interface ButlerRoutingQuestionView {
  id: string;
  prompt: string;
  context: string | null;
  options: Array<{ id: string | null; label: string; description: string | null }>;
  allowFreeform: boolean;
}

export interface ButlerRoutingDecisionView {
  taskClass: ButlerRoutingTaskClass;
  confidence: number;
  questionSet: ButlerRoutingQuestionView[];
  goalRecommendation: {
    mode: ButlerGoalRoutingMode;
    goal: string | null;
    fallbackReason: string | null;
  };
  reviewRecommendation: {
    target: ButlerReviewRoutingTarget;
    required: boolean;
    reason: string | null;
  };
  subAgentRoles: string[];
  riskLevel: ButlerRoutingRiskLevel;
  fallbackReason: string | null;
  createdAt: number;
}

export interface WorkerClaimView {
  claimId: string;
  status: WorkerClaimStatus;
  summary: string;
  evidencePointer: string;
  proofId: string | null;
  riskNote: string | null;
  reviewerTarget: string | null;
}

export interface WorkerSubAgentSummaryView {
  role: string;
  summary: string;
  evidencePointer: string | null;
}

export interface WorkerClaimsReportView {
  version: 1;
  changedWorkSummary: string;
  claims: WorkerClaimView[];
  risks: string[];
  unresolvedItems: string[];
  subAgentSummaries: WorkerSubAgentSummaryView[];
}

export interface WorkerReviewResultRecordView {
  id: string;
  reviewSource: "adversarial_review";
  turnId: string;
  reportUpdatedAt: number;
  severity: WorkerReviewSeverity;
  findingSummary: string;
  blocking: boolean;
  waived: boolean;
  waiverReason: string | null;
  automationFailure?: boolean;
  linkedClaimIds: string[];
  modelProvider: string | null;
  modelId: string | null;
  reasoningLevel: string | null;
  createdAt: number;
  updatedAt: number;
}
