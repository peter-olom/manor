import crypto from "node:crypto";

import type { ButlerStateStore } from "./state-store.js";

export type MemoryDebugTraceKind = "review" | "synthesis";
export type MemoryDebugTraceStatus = "completed" | "failed" | "skipped";

export type MemoryDebugTraceDecision = {
  stage: string;
  outcome: "submitted" | "dropped" | "deduped" | "normalized" | "saved" | "skipped";
  summary: string;
  reason?: string | null;
  sourceEntryId?: string | null;
  persistedId?: string | null;
  inputIndex?: number | null;
};

export type MemoryDebugTraceView = {
  id: string;
  kind: MemoryDebugTraceKind;
  status: MemoryDebugTraceStatus;
  projectId: string;
  projectLabel: string;
  threadId: string | null;
  sourceId: string;
  reason: string;
  promptVersion: string;
  model: string | null;
  createdAt: number;
  completedAt: number;
  durationMs: number | null;
  prompt: string | null;
  input: unknown;
  rawOutput: unknown;
  normalizedOutput: unknown;
  decisions: MemoryDebugTraceDecision[];
  persisted: {
    observationIds: string[];
    candidateIds: string[];
    entityIds: string[];
    relationshipIds: string[];
    jobEntryIds: string[];
  };
  error: string | null;
  warnings: string[];
};

export type MemoryDebugTraceFilters = {
  traceId?: string | null;
  kind?: MemoryDebugTraceKind | null;
  status?: MemoryDebugTraceStatus | null;
  projectId?: string | null;
  threadId?: string | null;
  from?: string | number | null;
  to?: string | number | null;
  limit?: number | null;
};

const TRACE_PAYLOAD_KIND = "memory_debug_trace";
const MAX_PROMPT_CHARS = 80_000;
const MAX_JSON_CHARS = 80_000;
const SECRET_PATTERN = /\b(sk-[A-Za-z0-9_-]{8,}|bearer\s+[A-Za-z0-9._-]+|api[_-]?key|password|secret|token)\b/gi;

function parseTime(value: string | number | null | undefined): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  const raw = typeof value === "string" ? value.trim() : "";
  if (!raw) return null;
  const parsed = /^\d+$/.test(raw) ? Number(raw) : Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

function inWindow(value: number, filters: MemoryDebugTraceFilters): boolean {
  const from = parseTime(filters.from);
  const to = parseTime(filters.to);
  if (from !== null && value < from) return false;
  return !(to !== null && value > to);
}

function normalizeText(value: unknown, fallback = ""): string {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function redactText(value: string): string {
  return value.replace(SECRET_PATTERN, "[redacted]");
}

function boundedValue(value: unknown): unknown {
  if (typeof value === "string") return redactText(value).slice(0, MAX_JSON_CHARS);
  try {
    const serialized = JSON.stringify(value);
    if (serialized.length <= MAX_JSON_CHARS) return value;
    return { truncated: true, preview: redactText(serialized.slice(0, MAX_JSON_CHARS)) };
  } catch {
    return String(value).slice(0, MAX_JSON_CHARS);
  }
}

function normalizeTrace(value: unknown): MemoryDebugTraceView | null {
  if (!value || typeof value !== "object") return null;
  const trace = value as Partial<MemoryDebugTraceView>;
  const kind = trace.kind === "review" || trace.kind === "synthesis" ? trace.kind : null;
  const status = trace.status === "completed" || trace.status === "failed" || trace.status === "skipped" ? trace.status : null;
  if (!trace.id || !kind || !status) return null;
  return {
    id: trace.id,
    kind,
    status,
    projectId: normalizeText(trace.projectId, "unknown"),
    projectLabel: normalizeText(trace.projectLabel, normalizeText(trace.projectId, "unknown")),
    threadId: normalizeText(trace.threadId, "") || null,
    sourceId: normalizeText(trace.sourceId, trace.id),
    reason: normalizeText(trace.reason, "memory debug trace"),
    promptVersion: normalizeText(trace.promptVersion, "unknown"),
    model: normalizeText(trace.model, "") || null,
    createdAt: typeof trace.createdAt === "number" ? trace.createdAt : Date.now(),
    completedAt: typeof trace.completedAt === "number" ? trace.completedAt : Date.now(),
    durationMs: typeof trace.durationMs === "number" ? trace.durationMs : null,
    prompt: typeof trace.prompt === "string" ? trace.prompt : null,
    input: trace.input ?? null,
    rawOutput: trace.rawOutput ?? null,
    normalizedOutput: trace.normalizedOutput ?? null,
    decisions: Array.isArray(trace.decisions) ? trace.decisions.filter((entry): entry is MemoryDebugTraceDecision => Boolean(entry && typeof entry === "object" && typeof entry.summary === "string")) : [],
    persisted: {
      observationIds: Array.isArray(trace.persisted?.observationIds) ? trace.persisted.observationIds.filter((entry): entry is string => typeof entry === "string") : [],
      candidateIds: Array.isArray(trace.persisted?.candidateIds) ? trace.persisted.candidateIds.filter((entry): entry is string => typeof entry === "string") : [],
      entityIds: Array.isArray(trace.persisted?.entityIds) ? trace.persisted.entityIds.filter((entry): entry is string => typeof entry === "string") : [],
      relationshipIds: Array.isArray(trace.persisted?.relationshipIds) ? trace.persisted.relationshipIds.filter((entry): entry is string => typeof entry === "string") : [],
      jobEntryIds: Array.isArray(trace.persisted?.jobEntryIds) ? trace.persisted.jobEntryIds.filter((entry): entry is string => typeof entry === "string") : []
    },
    error: typeof trace.error === "string" && trace.error.trim() ? trace.error.trim() : null,
    warnings: Array.isArray(trace.warnings) ? trace.warnings.filter((entry): entry is string => typeof entry === "string") : []
  };
}

export function recordMemoryDebugTrace(store: ButlerStateStore, input: Omit<MemoryDebugTraceView, "id"> & { id?: string }): MemoryDebugTraceView {
  const trace: MemoryDebugTraceView = {
    ...input,
    id: input.id || `memtrace-${crypto.randomUUID()}`,
    prompt: input.prompt ? redactText(input.prompt).slice(0, MAX_PROMPT_CHARS) : null,
    input: boundedValue(input.input),
    rawOutput: boundedValue(input.rawOutput),
    normalizedOutput: boundedValue(input.normalizedOutput)
  };
  store.recordMemoryObservation({
    idempotencyKey: `memory-debug-trace:${trace.id}`,
    projectId: trace.projectId,
    projectLabel: trace.projectLabel,
    threadId: trace.threadId,
    sourceKind: "system",
    sourceId: trace.id,
    summary: `${trace.kind} memory trace ${trace.status}: ${trace.reason}`,
    details: trace.error,
    payload: { kind: TRACE_PAYLOAD_KIND, trace },
    observedAt: trace.completedAt,
    durable: false
  });
  return trace;
}

export function listMemoryDebugTraces(store: ButlerStateStore, filters: MemoryDebugTraceFilters = {}): MemoryDebugTraceView[] {
  const limit = typeof filters.limit === "number" && Number.isFinite(filters.limit) ? Math.max(1, Math.min(100, Math.trunc(filters.limit))) : 20;
  return store
    .listMemoryGraph()
    .observations.map((entry) => normalizeTrace((entry.payload as { trace?: unknown; kind?: unknown }).kind === TRACE_PAYLOAD_KIND ? (entry.payload as { trace?: unknown }).trace : null))
    .filter((trace): trace is MemoryDebugTraceView => Boolean(trace))
    .filter((trace) => !filters.traceId || trace.id === filters.traceId)
    .filter((trace) => !filters.kind || trace.kind === filters.kind)
    .filter((trace) => !filters.status || trace.status === filters.status)
    .filter((trace) => !filters.projectId || trace.projectId === filters.projectId)
    .filter((trace) => !filters.threadId || trace.threadId === filters.threadId)
    .filter((trace) => inWindow(trace.completedAt, filters))
    .sort((left, right) => right.completedAt - left.completedAt)
    .slice(0, limit);
}

export function getMemoryDebugTrace(store: ButlerStateStore, traceId: string): MemoryDebugTraceView | null {
  return listMemoryDebugTraces(store, { traceId, limit: 1 })[0] ?? null;
}

export function formatMemoryDebugTraceList(traces: MemoryDebugTraceView[]): string {
  if (traces.length === 0) return "No memory debug traces matched.";
  return traces
    .map((trace, index) => `${index + 1}. ${trace.id} | ${trace.kind} | ${trace.status} | project=${trace.projectId} | thread=${trace.threadId ?? "none"} | ${trace.reason}`)
    .join("\n");
}

export function formatMemoryDebugTrace(trace: MemoryDebugTraceView): string {
  const outcomes = trace.decisions.reduce<Record<string, number>>((counts, decision) => {
    counts[decision.outcome] = (counts[decision.outcome] ?? 0) + 1;
    return counts;
  }, {});
  const outcomeText = Object.entries(outcomes).map(([key, value]) => `${key}=${value}`).join(", ") || "none";
  return [
    `Memory debug trace ${trace.id}`,
    `Kind: ${trace.kind}`,
    `Status: ${trace.status}`,
    `Scope: project=${trace.projectId}, thread=${trace.threadId ?? "none"}`,
    `Reason: ${trace.reason}`,
    `Model: ${trace.model ?? "unknown"}`,
    `Prompt version: ${trace.promptVersion}`,
    `Decisions: ${outcomeText}`,
    `Persisted: observations=${trace.persisted.observationIds.length}, candidates=${trace.persisted.candidateIds.length}, entities=${trace.persisted.entityIds.length}, relationships=${trace.persisted.relationshipIds.length}, job_entries=${trace.persisted.jobEntryIds.length}`,
    trace.error ? `Error: ${trace.error}` : "Error: none",
    trace.warnings.length > 0 ? `Warnings: ${trace.warnings.join(" ")}` : "Warnings: none"
  ].join("\n");
}
