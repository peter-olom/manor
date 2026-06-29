export type ButlerMemoryType = "operator_preference" | "project_fact" | "thread_fact" | "task_instruction" | "artifact_reference" | "implementation_decision" | "blocker" | "final_report_summary" | "transient_observation" | "correction" | "stale_note" | "legacy_global";
export type ButlerMemoryScopeKind = "global" | "project" | "thread";
export type ButlerMemoryReviewState = "accepted" | "pending" | "rejected" | "legacy";

export interface ButlerMemoryEntryView {
  id: string;
  summary: string;
  details: string | null;
  source: "butler_tool" | "manual_chat_save";
  sourceMessageId: string | null;
  tags: string[];
  createdAt: number;
  memoryType?: ButlerMemoryType;
  scopeKind?: ButlerMemoryScopeKind;
  projectId?: string | null;
  threadId?: string | null;
  reviewState?: ButlerMemoryReviewState;
  confidence?: number | null;
  expiresAt?: number | null;
  supersedesId?: string | null;
  provenance?: Record<string, unknown>;
  contentVersion?: number;
}

export interface MemoryEmbeddingView {
  id: string;
  sourceKind: "butler_memory" | "project_memory" | "job_memory" | "promotion_candidate" | "memory_observation";
  sourceId: string;
  sourceTextHash: string;
  model: string;
  modelTag: string;
  dimension: number;
  vectorBase64: string;
  memoryType: ButlerMemoryType;
  projectId: string | null;
  threadId: string | null;
  provenance: Record<string, unknown>;
  contentVersion: number;
  createdAt: number;
  embeddedAt: number;
}

export interface MemoryRetrievalCandidateView {
  id: string;
  sourceKind: MemoryEmbeddingView["sourceKind"] | "legacy_project_rollup" | "legacy_job_memory" | "legacy_butler_memory";
  sourceId: string;
  text: string;
  memoryType: ButlerMemoryType;
  scopeKind: ButlerMemoryScopeKind;
  projectId: string | null;
  threadId: string | null;
  eligibleForInjection: boolean;
  reason: string;
  score: {
    lexical: number;
    vector: number | null;
    freshness: number;
    total: number;
  };
}
