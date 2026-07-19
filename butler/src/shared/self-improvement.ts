export type SelfImprovementRequestStatus =
  | "pending"
  | "dismissed"
  | "approved"
  | "running"
  | "changes_ready"
  | "discarded"
  | "committed"
  | "pr_opened";

export const SELF_IMPROVEMENT_OPERATOR_CONTEXT_MAX_LENGTH = 8_000;

export interface SelfImprovementRequestView {
  id: string;
  status: SelfImprovementRequestStatus;
  trigger: string;
  symptoms: string;
  logs: string;
  observations: string;
  suspectedCause: string;
  proposedChange: string;
  risk: string;
  desiredOutcome: string | null;
  operatorContext: string | null;
  sourceThreadId: string | null;
  sourceProjectLabel: string | null;
  createdBy: "butler" | "operator";
  requestedAt: number;
  updatedAt: number;
  dismissedAt: number | null;
  dismissedReason: string | null;
  approvedAt: number | null;
  startedAt: number | null;
  completedAt: number | null;
  threadId: string | null;
  workerThreadIds: string[];
  pairId: string | null;
  workspaceCwd: string | null;
  branchName: string | null;
  commitSha: string | null;
  pullRequestUrl: string | null;
}

export interface SelfImprovementEligibilityView {
  enabled: boolean;
  sourceCwd: string;
  reasons: string[];
}

export interface SelfImprovementQueueResponse {
  requests: SelfImprovementRequestView[];
  eligibility: SelfImprovementEligibilityView;
}
