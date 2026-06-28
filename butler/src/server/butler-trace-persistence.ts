import type { ButlerTraceItemView, ButlerTraceMetaView } from "./types.js";

const TRACE_ITEM_TYPES: ReadonlyArray<ButlerTraceItemView["type"]> = [
  "reasoning",
  "command_execution",
  "file_change",
  "plan",
  "mcp_tool_call",
  "dynamic_tool_call",
  "web_search",
  "image_view",
  "context_compaction",
  "user_message",
  "assistant_message",
  "error",
  "unknown"
];

const TRACE_STATUSES: ReadonlyArray<ButlerTraceItemView["status"]> = ["in_progress", "completed", "failed", "declined"];

export function readPersistedTrace(raw: unknown): ButlerTraceItemView[] | null {
  if (!Array.isArray(raw)) return null;
  const items: ButlerTraceItemView[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const candidate = entry as Record<string, unknown>;
    const id = typeof candidate.id === "string" ? candidate.id : null;
    const type = typeof candidate.type === "string" && (TRACE_ITEM_TYPES as readonly string[]).includes(candidate.type)
      ? (candidate.type as ButlerTraceItemView["type"])
      : null;
    const status = typeof candidate.status === "string" && (TRACE_STATUSES as readonly string[]).includes(candidate.status)
      ? (candidate.status as ButlerTraceItemView["status"])
      : null;
    const text = typeof candidate.text === "string" ? candidate.text : null;
    const at = typeof candidate.at === "number" && Number.isFinite(candidate.at) ? candidate.at : null;
    if (!id || !type || !status || text === null || at === null) continue;
    const item: ButlerTraceItemView = { id, type, status, text, at };
    if (typeof candidate.title === "string" && candidate.title) item.title = candidate.title;
    if (typeof candidate.completedAt === "number" && Number.isFinite(candidate.completedAt)) item.completedAt = candidate.completedAt;
    items.push(item);
  }
  return items;
}

export function readPersistedTraceMeta(raw: unknown): ButlerTraceMetaView | null {
  if (!raw || typeof raw !== "object") return null;
  const candidate = raw as Record<string, unknown>;
  const turnId = typeof candidate.turnId === "string" ? candidate.turnId : null;
  const startedAt = typeof candidate.startedAt === "number" && Number.isFinite(candidate.startedAt) ? candidate.startedAt : null;
  const completedAt = typeof candidate.completedAt === "number" && Number.isFinite(candidate.completedAt) ? candidate.completedAt : null;
  const items = readPersistedTrace(candidate.items);
  if (!turnId || startedAt === null || completedAt === null || !items) return null;
  return { turnId, startedAt, completedAt, items };
}
