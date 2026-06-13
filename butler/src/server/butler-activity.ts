import type { AgentSessionEvent } from "@mariozechner/pi-coding-agent";

import type { ButlerAgentSessionAccess } from "./butler-agent-tool-access.js";
import type { ButlerActivityItemView, ButlerActivityTurnView } from "./types.js";

const MAX_ACTIVITY_TURNS = 20;
const MAX_ACTIVITY_TEXT = 3000;
const REDACTED_THINKING_SUMMARY = "Thinking update recorded.";
const TOOL_MAIN_DATA_KEYS = [
  "message",
  "text",
  "content",
  "prompt",
  "query",
  "q",
  "command",
  "cmd",
  "summary",
  "description",
  "path",
  "url",
  "status"
];

function stripMarkdownFormatting(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, (match) => match.replace(/```[a-zA-Z0-9_-]*\n?/g, "").replace(/```/g, ""))
    .replace(/`([^`]+)`/g, "$1")
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^>\s?/gm, "")
    .replace(/^\s*[-*+]\s+/gm, "")
    .replace(/^\s*\d+\.\s+/gm, "")
    .replace(/(\*\*|__)(.*?)\1/g, "$2")
    .replace(/(?<!\w)(\*|_)(?!\s)(.*?)(?<!\s)\1(?!\w)/g, "$2")
    .replace(/~~(.*?)~~/g, "$1");
}

function clipText(text: string): string {
  const normalized = stripMarkdownFormatting(text).replace(/\\n/g, " ").replace(/\s+/g, " ").trim();
  if (normalized.length <= MAX_ACTIVITY_TEXT) {
    return normalized;
  }
  return `${normalized.slice(0, MAX_ACTIVITY_TEXT).trimEnd()} ...`;
}

function clipActivityText(text: string, maxLength: number | null): string {
  if (maxLength === null || text.length <= maxLength) {
    return text;
  }

  return `${text.slice(0, maxLength).trimEnd()} ...`;
}

function readThinkingText(content: unknown): string {
  if (!Array.isArray(content)) {
    return "";
  }

  return clipText(
    content
      .map((entry) => {
        if (entry && typeof entry === "object" && "type" in entry && entry.type === "text" && "text" in entry) {
          return "";
        }
        if (entry && typeof entry === "object" && "type" in entry && entry.type === "thinking" && "thinking" in entry) {
          return typeof entry.thinking === "string" ? entry.thinking : "";
        }
        return "";
      })
      .filter(Boolean)
      .join(" ")
  );
}

function collectToolMainData(value: unknown, depth = 0): string[] {
  if (value === null || value === undefined) {
    return [];
  }

  if (typeof value === "string") {
    return [value];
  }

  if (typeof value === "number" || typeof value === "boolean") {
    return [String(value)];
  }

  if (Array.isArray(value)) {
    return value.flatMap((entry) => collectToolMainData(entry, depth + 1));
  }

  if (typeof value !== "object" || depth > 3) {
    return [];
  }

  const record = value as Record<string, unknown>;
  const content = record.content;
  if (Array.isArray(content)) {
    const contentText = content
      .flatMap((entry) => {
        if (entry && typeof entry === "object" && "text" in entry && typeof entry.text === "string") {
          return [entry.text];
        }
        return collectToolMainData(entry, depth + 1);
      })
      .filter(Boolean);
    if (contentText.length > 0) {
      return contentText;
    }
  }

  for (const key of TOOL_MAIN_DATA_KEYS) {
    const entry = record[key];
    if (typeof entry === "string" && entry.trim()) {
      return [`${key}: ${entry}`];
    }
    if (entry && typeof entry === "object") {
      const nested = collectToolMainData(entry, depth + 1);
      if (nested.length > 0) {
        return nested.map((part) => (part.includes(":") ? part : `${key}: ${part}`));
      }
    }
  }

  const primitivePairs = Object.entries(record)
    .filter(([, entry]) => typeof entry === "string" || typeof entry === "number" || typeof entry === "boolean")
    .filter(([key]) => !["id", "type", "source", "createdAt"].includes(key))
    .slice(0, 3)
    .map(([key, entry]) => `${key}: ${String(entry)}`);
  if (primitivePairs.length > 0) {
    return primitivePairs;
  }

  try {
    return [JSON.stringify(value)];
  } catch {
    return [String(value)];
  }
}

function formatToolData(value: unknown): string {
  const [mainData] = collectToolMainData(value).map((entry) => clipText(entry)).filter(Boolean);
  return mainData ?? "";
}

function summarizeActivityTurn(turn: ButlerActivityTurnView): ButlerActivityTurnView {
  return {
    ...turn,
    status: "completed",
    completedAt: turn.completedAt ?? Date.now(),
    items: turn.items.map((item) => ({
      ...item,
      status: item.status === "active" ? "completed" : item.status,
      text: item.kind === "thinking" ? REDACTED_THINKING_SUMMARY : formatPersistedActivityText(item)
    }))
  };
}

function formatPersistedActivityText(item: ButlerActivityItemView): string {
  if (!item.text) {
    return "";
  }

  if (item.kind === "thinking") {
    return item.status === "completed" ? REDACTED_THINKING_SUMMARY : clipText(item.text);
  }

  try {
    return formatToolData(JSON.parse(item.text)) || clipText(item.text);
  } catch {
    return clipText(item.text);
  }
}

function ensureActivityTurn(access: ButlerAgentSessionAccess, at = Date.now()): ButlerActivityTurnView {
  const existing = access.activityTurns.find((turn) => turn.id === access.activeActivityTurnId);
  if (existing && existing.status === "active") {
    return existing;
  }

  access.activitySequence += 1;
  const turn: ButlerActivityTurnView = {
    id: `butler-activity-${at}-${access.activitySequence}`,
    status: "active",
    startedAt: at,
    completedAt: null,
    items: []
  };
  access.activityTurns.push(turn);
  access.activeActivityTurnId = turn.id;

  if (access.activityTurns.length > MAX_ACTIVITY_TURNS) {
    access.activityTurns.splice(0, access.activityTurns.length - MAX_ACTIVITY_TURNS);
  }

  return turn;
}

function completeActivityTurn(access: ButlerAgentSessionAccess, at = Date.now()): void {
  const turn = access.activityTurns.find((entry) => entry.id === access.activeActivityTurnId);
  if (!turn) {
    access.activeActivityTurnId = null;
    return;
  }

  turn.status = "completed";
  turn.completedAt = at;
  for (const item of turn.items) {
    if (item.status === "active") {
      item.status = "completed";
      item.updatedAt = at;
    }
  }
  if (typeof access.persistActivitySummaryTurn === "function") {
    access.persistActivitySummaryTurn(summarizeActivityTurn(turn));
  }
  access.activeActivityTurnId = null;
}

function latestThinkingItem(turn: ButlerActivityTurnView): ButlerActivityItemView | null {
  for (let index = turn.items.length - 1; index >= 0; index -= 1) {
    const item = turn.items[index];
    if (item?.kind === "thinking") {
      return item;
    }
  }
  return null;
}

function upsertThinkingItem(turn: ButlerActivityTurnView, text: string, at = Date.now()): ButlerActivityItemView {
  const existing = latestThinkingItem(turn);
  if (existing && existing.status === "active") {
    existing.text = clipText(text || existing.text);
    existing.updatedAt = at;
    return existing;
  }

  const item: ButlerActivityItemView = {
    id: `${turn.id}:thinking:${turn.items.length}`,
    kind: "thinking",
    status: "active",
    title: "Thinking",
    text: clipText(text),
    at,
    updatedAt: at,
    contentIndex: null,
    toolCallId: null
  };
  turn.items.push(item);
  return item;
}

function findToolItem(turn: ButlerActivityTurnView, contentIndex: number | null, toolCallId: string | null): ButlerActivityItemView | null {
  return (
    turn.items.find(
      (item) =>
        item.kind === "tool" &&
        ((toolCallId && item.toolCallId === toolCallId) || (contentIndex !== null && item.contentIndex === contentIndex))
    ) ?? null
  );
}

function readToolCallFromPartial(partial: unknown, contentIndex: number | null): Record<string, unknown> | null {
  if (contentIndex === null || !partial || typeof partial !== "object" || !("content" in partial) || !Array.isArray(partial.content)) {
    return null;
  }

  const block = partial.content[contentIndex];
  return block && typeof block === "object" ? (block as Record<string, unknown>) : null;
}

function upsertToolItem(
  turn: ButlerActivityTurnView,
  input: {
    title: string;
    text: string;
    status?: ButlerActivityItemView["status"];
    contentIndex?: number | null;
    toolCallId?: string | null;
    at?: number;
  }
): ButlerActivityItemView {
  const at = input.at ?? Date.now();
  const contentIndex = input.contentIndex ?? null;
  const toolCallId = input.toolCallId ?? null;
  const existing = findToolItem(turn, contentIndex, toolCallId);
  if (existing) {
    existing.title = input.title || existing.title;
    existing.text = clipText(input.text || existing.text);
    existing.status = input.status ?? existing.status;
    existing.updatedAt = at;
    existing.contentIndex = existing.contentIndex ?? contentIndex;
    existing.toolCallId = existing.toolCallId ?? toolCallId;
    return existing;
  }

  const item: ButlerActivityItemView = {
    id: `${turn.id}:tool:${turn.items.length}`,
    kind: "tool",
    status: input.status ?? "active",
    title: input.title || "Tool call",
    text: clipText(input.text),
    at,
    updatedAt: at,
    contentIndex,
    toolCallId
  };
  turn.items.push(item);
  return item;
}

function recordAssistantUpdate(access: ButlerAgentSessionAccess, event: Extract<AgentSessionEvent, { type: "message_update" }>): void {
  const turn = ensureActivityTurn(access);
  if (!event.message || typeof event.message !== "object" || event.message.role !== "assistant") {
    return;
  }

  const streamEvent = event.assistantMessageEvent;
  if (streamEvent.type === "thinking_start" || streamEvent.type === "thinking_delta" || streamEvent.type === "thinking_end") {
    upsertThinkingItem(turn, readThinkingText(event.message.content));
    return;
  }

  if (streamEvent.type === "toolcall_start" || streamEvent.type === "toolcall_delta" || streamEvent.type === "toolcall_end") {
    const block =
      streamEvent.type === "toolcall_end"
        ? streamEvent.toolCall
        : readToolCallFromPartial(streamEvent.partial, streamEvent.contentIndex);
    const name = typeof block?.name === "string" ? block.name : "Tool call";
    const id = typeof block?.id === "string" ? block.id : null;
    upsertToolItem(turn, {
      title: name,
      text: formatToolData(block?.arguments),
      status: streamEvent.type === "toolcall_end" ? "completed" : "active",
      contentIndex: streamEvent.contentIndex,
      toolCallId: id
    });
  }
}

export function recordButlerActivityEvent(access: ButlerAgentSessionAccess, event: AgentSessionEvent): void {
  const at = Date.now();

  if (event.type === "agent_start" || event.type === "turn_start") {
    ensureActivityTurn(access, at);
    return;
  }

  if (event.type === "message_update") {
    recordAssistantUpdate(access, event);
    return;
  }

  if (event.type === "message_end" && event.message.role === "assistant") {
    const item = latestThinkingItem(ensureActivityTurn(access, at));
    if (item) {
      item.text = readThinkingText(event.message.content) || item.text;
      item.status = "completed";
      item.updatedAt = at;
    }
    return;
  }

  if (event.type === "tool_execution_start") {
    upsertToolItem(ensureActivityTurn(access, at), {
      title: event.toolName,
      text: formatToolData(event.args),
      status: "active",
      toolCallId: event.toolCallId,
      at
    });
    return;
  }

  if (event.type === "tool_execution_update") {
    upsertToolItem(ensureActivityTurn(access, at), {
      title: event.toolName,
      text: formatToolData(event.partialResult),
      status: "active",
      toolCallId: event.toolCallId,
      at
    });
    return;
  }

  if (event.type === "tool_execution_end") {
    upsertToolItem(ensureActivityTurn(access, at), {
      title: event.toolName,
      text: formatToolData(event.result),
      status: event.isError ? "error" : "completed",
      toolCallId: event.toolCallId,
      at
    });
    return;
  }

  if (event.type === "agent_end") {
    completeActivityTurn(access, at);
  }
}

export function getButlerActivityTurns(
  access: ButlerAgentSessionAccess,
  options: {
    maxCompletedTurns?: number;
    maxItemsPerTurn?: number;
    maxItemText?: number;
  } = {}
): ButlerActivityTurnView[] {
  const turnsById = new Map<string, ButlerActivityTurnView>();
  const activitySummaryTurns = Array.isArray(access.activitySummaryTurns) ? access.activitySummaryTurns : [];
  for (const turn of activitySummaryTurns) {
    turnsById.set(turn.id, turn);
  }
  for (const turn of access.activityTurns) {
    turnsById.set(turn.id, turn);
  }

  const turns = [...turnsById.values()]
    .filter((turn) => turn.status === "active" || turn.items.length > 0)
    .sort((left, right) => left.startedAt - right.startedAt);
  const maxCompletedTurns = options.maxCompletedTurns ?? MAX_ACTIVITY_TURNS;
  const selectedTurns = maxCompletedTurns >= MAX_ACTIVITY_TURNS
    ? turns.slice(-MAX_ACTIVITY_TURNS)
    : [
        ...turns.filter((turn) => turn.status !== "active").slice(-maxCompletedTurns),
        ...turns.filter((turn) => turn.status === "active")
      ].sort((left, right) => left.startedAt - right.startedAt);
  const maxItemsPerTurn = options.maxItemsPerTurn ?? null;
  const maxItemText = options.maxItemText ?? null;

  return selectedTurns
    .map((turn) => ({
      ...turn,
      items: (maxItemsPerTurn === null ? turn.items : turn.items.slice(-maxItemsPerTurn)).map((item) => ({
        ...item,
        text: clipActivityText(formatPersistedActivityText(item), maxItemText)
      }))
    }));
}

function shouldKeepActivityTurnBefore(turn: ButlerActivityTurnView, timestamp: number): boolean {
  const activityAt = turn.completedAt ?? turn.startedAt;
  return activityAt < timestamp;
}

export function keepButlerActivityBefore(access: ButlerAgentSessionAccess, timestamp: number | null): boolean {
  if (timestamp === null) {
    return false;
  }

  const nextActivityTurns = access.activityTurns.filter((turn) => shouldKeepActivityTurnBefore(turn, timestamp));
  const nextSummaryTurns = access.activitySummaryTurns.filter((turn) => shouldKeepActivityTurnBefore(turn, timestamp));
  const removed = nextActivityTurns.length !== access.activityTurns.length || nextSummaryTurns.length !== access.activitySummaryTurns.length;

  if (!removed) {
    return false;
  }

  access.activityTurns.splice(0, access.activityTurns.length, ...nextActivityTurns);
  access.activitySummaryTurns.splice(0, access.activitySummaryTurns.length, ...nextSummaryTurns);

  if (access.activeActivityTurnId && !access.activityTurns.some((turn) => turn.id === access.activeActivityTurnId)) {
    access.activeActivityTurnId = null;
  }

  return true;
}

export function normalizeButlerActivitySummaryTurns(turns: unknown): ButlerActivityTurnView[] {
  if (!Array.isArray(turns)) {
    return [];
  }

  return turns
    .flatMap((turn): ButlerActivityTurnView[] => {
      if (!turn || typeof turn !== "object") {
        return [];
      }
      const entry = turn as Record<string, unknown>;
      const id = typeof entry.id === "string" && entry.id.trim() ? entry.id : null;
      const startedAt = typeof entry.startedAt === "number" && Number.isFinite(entry.startedAt) ? entry.startedAt : null;
      if (!id || startedAt === null || !Array.isArray(entry.items)) {
        return [];
      }
      const completedAt = typeof entry.completedAt === "number" && Number.isFinite(entry.completedAt) ? entry.completedAt : startedAt;
      const items = entry.items.flatMap((item): ButlerActivityItemView[] => {
        if (!item || typeof item !== "object") {
          return [];
        }
        const record = item as Record<string, unknown>;
        const kind = record.kind === "thinking" || record.kind === "tool" ? record.kind : null;
        const itemId = typeof record.id === "string" && record.id.trim() ? record.id : null;
        const title = typeof record.title === "string" && record.title.trim() ? record.title : kind === "thinking" ? "Thinking" : "Tool call";
        if (!kind || !itemId) {
          return [];
        }
        return [
          {
            id: itemId,
            kind,
            status: record.status === "error" ? "error" : "completed",
            title,
            text: kind === "thinking" ? REDACTED_THINKING_SUMMARY : clipText(typeof record.text === "string" ? record.text : ""),
            at: typeof record.at === "number" && Number.isFinite(record.at) ? record.at : startedAt,
            updatedAt: typeof record.updatedAt === "number" && Number.isFinite(record.updatedAt) ? record.updatedAt : completedAt,
            contentIndex: typeof record.contentIndex === "number" && Number.isFinite(record.contentIndex) ? record.contentIndex : null,
            toolCallId: typeof record.toolCallId === "string" && record.toolCallId.trim() ? record.toolCallId : null
          }
        ];
      });
      return items.length > 0 ? [{ id, status: "completed", startedAt, completedAt, items }] : [];
    })
    .sort((left, right) => left.startedAt - right.startedAt)
    .slice(-MAX_ACTIVITY_TURNS);
}
