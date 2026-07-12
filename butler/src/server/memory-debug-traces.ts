import crypto from "node:crypto";

import { redactSensitiveText } from "./redact-sensitive-text.js";
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
const MAX_DECISIONS = 100;
const MAX_DECISION_TEXT_CHARS = 2_000;
const MAX_FORMAT_FIELD_CHARS = 8_000;
const MAX_FORMAT_DECISIONS_CHARS = 12_000;

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

function boundedText(value: string, limit: number): string {
  const redacted = redactSensitiveText(value);
  return redacted.length > limit ? `${redacted.slice(0, limit)}\n...[truncated]` : redacted;
}

function boundedValue(value: unknown): unknown {
  try {
    const serialized = JSON.stringify(value);
    if (typeof serialized !== "string") return null;
    const redacted = redactSensitiveText(serialized);
    if (redacted.length > MAX_JSON_CHARS) {
      return { truncated: true, preview: `${redacted.slice(0, MAX_JSON_CHARS)}\n...[truncated]` };
    }
    try {
      return JSON.parse(redacted) as unknown;
    } catch {
      return redacted;
    }
  } catch {
    return boundedText(String(value), MAX_JSON_CHARS);
  }
}

function normalizeDecision(value: unknown): MemoryDebugTraceDecision | null {
  if (!value || typeof value !== "object") return null;
  const decision = value as Partial<MemoryDebugTraceDecision>;
  const outcome = ["submitted", "dropped", "deduped", "normalized", "saved", "skipped"].includes(decision.outcome ?? "")
    ? decision.outcome as MemoryDebugTraceDecision["outcome"]
    : null;
  if (!outcome || typeof decision.summary !== "string") return null;
  return {
    stage: boundedText(normalizeText(decision.stage, "unknown"), MAX_DECISION_TEXT_CHARS),
    outcome,
    summary: boundedText(decision.summary, MAX_DECISION_TEXT_CHARS),
    reason: typeof decision.reason === "string" ? boundedText(decision.reason, MAX_DECISION_TEXT_CHARS) : null,
    sourceEntryId: typeof decision.sourceEntryId === "string" ? boundedText(decision.sourceEntryId, MAX_DECISION_TEXT_CHARS) : null,
    persistedId: typeof decision.persistedId === "string" ? boundedText(decision.persistedId, MAX_DECISION_TEXT_CHARS) : null,
    inputIndex: typeof decision.inputIndex === "number" && Number.isFinite(decision.inputIndex) ? decision.inputIndex : null
  };
}

function normalizeStringList(value: unknown, limit = 1_000): string[] {
  return Array.isArray(value)
    ? value.slice(0, limit).filter((entry): entry is string => typeof entry === "string").map((entry) => boundedText(entry, MAX_DECISION_TEXT_CHARS))
    : [];
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
    reason: boundedText(normalizeText(trace.reason, "memory debug trace"), MAX_DECISION_TEXT_CHARS),
    promptVersion: boundedText(normalizeText(trace.promptVersion, "unknown"), MAX_DECISION_TEXT_CHARS),
    model: normalizeText(trace.model, "") ? boundedText(normalizeText(trace.model), MAX_DECISION_TEXT_CHARS) : null,
    createdAt: typeof trace.createdAt === "number" ? trace.createdAt : Date.now(),
    completedAt: typeof trace.completedAt === "number" ? trace.completedAt : Date.now(),
    durationMs: typeof trace.durationMs === "number" ? trace.durationMs : null,
    prompt: typeof trace.prompt === "string" ? boundedText(trace.prompt, MAX_PROMPT_CHARS) : null,
    input: boundedValue(trace.input),
    rawOutput: boundedValue(trace.rawOutput),
    normalizedOutput: boundedValue(trace.normalizedOutput),
    decisions: Array.isArray(trace.decisions)
      ? trace.decisions.slice(0, MAX_DECISIONS).map(normalizeDecision).filter((entry): entry is MemoryDebugTraceDecision => Boolean(entry))
      : [],
    persisted: {
      observationIds: normalizeStringList(trace.persisted?.observationIds),
      candidateIds: normalizeStringList(trace.persisted?.candidateIds),
      entityIds: normalizeStringList(trace.persisted?.entityIds),
      relationshipIds: normalizeStringList(trace.persisted?.relationshipIds),
      jobEntryIds: normalizeStringList(trace.persisted?.jobEntryIds)
    },
    error: typeof trace.error === "string" && trace.error.trim() ? boundedText(trace.error.trim(), MAX_JSON_CHARS) : null,
    warnings: normalizeStringList(trace.warnings, 100)
  };
}

export function recordMemoryDebugTrace(store: ButlerStateStore, input: Omit<MemoryDebugTraceView, "id"> & { id?: string }): MemoryDebugTraceView {
  const trace = normalizeTrace({
    ...input,
    id: input.id || `memtrace-${crypto.randomUUID()}`
  });
  if (!trace) throw new Error("Invalid memory debug trace");
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
  const formatField = (value: unknown, limit = MAX_FORMAT_FIELD_CHARS): string => {
    const text = typeof value === "string" ? value : JSON.stringify(value, null, 2) ?? "null";
    return boundedText(text, limit);
  };
  return [
    `Memory debug trace ${trace.id}`,
    `Kind: ${trace.kind}`,
    `Status: ${trace.status}`,
    `Scope: project=${trace.projectId}, thread=${trace.threadId ?? "none"}`,
    `Reason: ${trace.reason}`,
    `Model: ${trace.model ?? "unknown"}`,
    `Prompt version: ${trace.promptVersion}`,
    `Decisions: ${outcomeText}`,
    `Prompt:\n${formatField(trace.prompt)}`,
    `Input:\n${formatField(trace.input)}`,
    `Raw output:\n${formatField(trace.rawOutput)}`,
    `Normalized output:\n${formatField(trace.normalizedOutput)}`,
    `Decision details:\n${formatField(trace.decisions, MAX_FORMAT_DECISIONS_CHARS)}`,
    `Persisted: observations=${trace.persisted.observationIds.length}, candidates=${trace.persisted.candidateIds.length}, entities=${trace.persisted.entityIds.length}, relationships=${trace.persisted.relationshipIds.length}, job_entries=${trace.persisted.jobEntryIds.length}`,
    trace.error ? `Error: ${trace.error}` : "Error: none",
    trace.warnings.length > 0 ? `Warnings: ${trace.warnings.join(" ")}` : "Warnings: none"
  ].join("\n");
}
