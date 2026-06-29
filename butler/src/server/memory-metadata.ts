import type {
  ButlerMemoryEntryView,
  ButlerMemoryReviewState,
  ButlerMemoryScopeKind,
  ButlerMemoryType
} from "./types.js";

export type ButlerMemoryMetadataInput = {
  memoryType?: unknown;
  scopeKind?: unknown;
  projectId?: unknown;
  threadId?: unknown;
  reviewState?: unknown;
  confidence?: unknown;
  expiresAt?: unknown;
  supersedesId?: unknown;
  provenance?: unknown;
  contentVersion?: unknown;
};

const MEMORY_TYPES = new Set<ButlerMemoryType>([
  "operator_preference",
  "project_fact",
  "thread_fact",
  "task_instruction",
  "artifact_reference",
  "implementation_decision",
  "blocker",
  "final_report_summary",
  "transient_observation",
  "correction",
  "stale_note",
  "legacy_global"
]);
const SCOPE_KINDS = new Set<ButlerMemoryScopeKind>(["global", "project", "thread"]);
const REVIEW_STATES = new Set<ButlerMemoryReviewState>(["accepted", "pending", "rejected", "legacy"]);

function clean(value: unknown): string | null {
  const normalized = typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
  return normalized || null;
}

function optionalNumber(value: unknown): number | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function optionalRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? { ...(value as Record<string, unknown>) } : undefined;
}

export function normalizeButlerMemoryType(value: unknown, fallback: ButlerMemoryType = "legacy_global"): ButlerMemoryType {
  return typeof value === "string" && MEMORY_TYPES.has(value as ButlerMemoryType) ? value as ButlerMemoryType : fallback;
}

export function normalizeButlerMemoryScopeKind(value: unknown, fallback: ButlerMemoryScopeKind = "global"): ButlerMemoryScopeKind {
  return typeof value === "string" && SCOPE_KINDS.has(value as ButlerMemoryScopeKind) ? value as ButlerMemoryScopeKind : fallback;
}

export function normalizeButlerMemoryReviewState(value: unknown, fallback: ButlerMemoryReviewState = "legacy"): ButlerMemoryReviewState {
  return typeof value === "string" && REVIEW_STATES.has(value as ButlerMemoryReviewState) ? value as ButlerMemoryReviewState : fallback;
}

export function inferButlerMemoryTypeFromTags(tags: string[]): ButlerMemoryType {
  if (tags.includes("operator-taste") || tags.includes("operator-preference")) return "operator_preference";
  if (tags.some((tag) => tag.startsWith("project:"))) return "project_fact";
  return "legacy_global";
}

export function normalizeButlerMemoryMetadata(input: ButlerMemoryMetadataInput, tags: string[] = []): Required<Pick<
  ButlerMemoryEntryView,
  "memoryType" | "scopeKind" | "reviewState" | "projectId" | "threadId" | "confidence" | "expiresAt" | "supersedesId" | "contentVersion"
>> & { provenance?: Record<string, unknown> } {
  const inferredType = inferButlerMemoryTypeFromTags(tags);
  const memoryType = normalizeButlerMemoryType(input.memoryType, inferredType);
  const scopeKind = normalizeButlerMemoryScopeKind(
    input.scopeKind,
    memoryType === "project_fact" ? "project" : memoryType === "thread_fact" ? "thread" : "global"
  );
  const reviewState = normalizeButlerMemoryReviewState(
    input.reviewState,
    memoryType === "legacy_global" ? "legacy" : "pending"
  );
  const confidence = optionalNumber(input.confidence);
  const expiresAt = optionalNumber(input.expiresAt);
  const contentVersion = typeof input.contentVersion === "number" && Number.isFinite(input.contentVersion)
    ? Math.max(1, Math.trunc(input.contentVersion))
    : 1;
  return {
    memoryType,
    scopeKind,
    projectId: clean(input.projectId),
    threadId: clean(input.threadId),
    reviewState,
    confidence: confidence === undefined ? null : confidence,
    expiresAt: expiresAt === undefined ? null : expiresAt,
    supersedesId: clean(input.supersedesId),
    contentVersion,
    ...(optionalRecord(input.provenance) ? { provenance: optionalRecord(input.provenance) } : {})
  };
}

export function isAcceptedOperatorPreferenceMemory(entry: ButlerMemoryEntryView, now = Date.now()): boolean {
  if (entry.memoryType !== "operator_preference") return false;
  if (entry.reviewState !== "accepted") return false;
  if (entry.expiresAt !== null && entry.expiresAt !== undefined && entry.expiresAt <= now) return false;
  return true;
}

export function formatOperatorPreferenceMemory(entry: ButlerMemoryEntryView): string {
  return `${entry.summary}${entry.details ? ` - ${entry.details}` : ""}`;
}
