export type MemoryEntryKind = "checkpoint" | "decision" | "note";

export type ProjectMemoryEntry = {
  id: string;
  sourceThreadId: string;
  kind: MemoryEntryKind;
  summary: string;
  details: string | null;
  acceptedAt: number;
};

export type ProjectMemory = {
  projectId: string;
  projectLabel: string;
  summary: string | null;
  entries: ProjectMemoryEntry[];
  updatedAt: number;
};

export type JobMemoryEntry = {
  id: string;
  kind: MemoryEntryKind;
  summary: string;
  details: string | null;
  nextAction: string | null;
  blockers: string[];
  plan: string[];
  assumptions: string[];
  proofRequirements: string[];
  promote: boolean;
  promotionCandidateId: string | null;
  at: number;
};

export type JobMemoryDecision = {
  id: string;
  summary: string;
  details: string | null;
  at: number;
};

export type JobMemoryPromotionCandidate = {
  id: string;
  threadId: string;
  projectId: string;
  projectLabel: string;
  kind: MemoryEntryKind;
  sourceEntryId: string;
  summary: string;
  details: string | null;
  status: "pending" | "accepted" | "rejected";
  createdAt: number;
  updatedAt: number;
  resolvedAt: number | null;
};

export type JobMemory = {
  threadId: string;
  projectId: string;
  projectLabel: string;
  source: string | null;
  createdAt: number;
  updatedAt: number;
  operatorGoal: string | null;
  requestedTask: string | null;
  currentPlan: string[];
  latestCheckpoint: string | null;
  nextAction: string | null;
  blockers: string[];
  assumptions: string[];
  proofRequirements: string[];
  notes: string[];
  decisions: JobMemoryDecision[];
  entries: JobMemoryEntry[];
  promotionCandidates: JobMemoryPromotionCandidate[];
};

export type ButlerMemoryEntry = {
  id: string;
  summary: string;
  details: string | null;
  source: "butler_tool" | "manual_chat_save";
  sourceMessageId: string | null;
  tags: string[];
  createdAt: number;
  memoryType?: string;
  scopeKind?: "global" | "project" | "thread";
  projectId?: string | null;
  threadId?: string | null;
  reviewState?: "accepted" | "pending" | "rejected" | "legacy";
  confidence?: number | null;
  expiresAt?: number | null;
  supersedesId?: string | null;
  contentVersion?: number;
};

export type MemorySection = "projects" | "jobs" | "butler";

export type ProjectsResponse = { projects: ProjectMemory[] };
export type JobsResponse = { jobs: JobMemory[] };
export type ButlerMemoryResponse = { entries: ButlerMemoryEntry[] };

export type MemoryRetrieval = {
  query: string | null;
  projectId: string | null;
  threadId: string | null;
  includeProvenance: boolean;
  projectRollups: ProjectMemory[];
  jobMemories: JobMemory[];
  butlerMemories: ButlerMemoryEntry[];
  pendingPromotionCandidates: JobMemoryPromotionCandidate[];
  warnings: string[];
  retrievedAt: number;
};

export type MemoryRetrievalResponse = {
  retrieval: MemoryRetrieval;
  formatted: string;
};
