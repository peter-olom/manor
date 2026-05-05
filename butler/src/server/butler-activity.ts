import type { AgentSessionEvent } from "@mariozechner/pi-coding-agent";

import type { ButlerAgentSessionAccess } from "./butler-agent-tool-access.js";
import type { ButlerActivityItemView, ButlerActivityTurnView } from "./types.js";

const MAX_ACTIVITY_TURNS = 20;
const MAX_ACTIVITY_TEXT = 3000;

function clipText(text: string): string {
  const normalized = text.replace(/\\n/g, " ").replace(/\s+/g, " ").trim();
  if (normalized.length <= MAX_ACTIVITY_TEXT) {
    return normalized;
  }
  return `${normalized.slice(0, MAX_ACTIVITY_TEXT).trimEnd()} ...`;
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

function stringifyValue(value: unknown): string {
  if (value === null || value === undefined) {
    return "";
  }

  if (typeof value === "string") {
    return clipText(value);
  }

  try {
    return clipText(JSON.stringify(value, null, 2));
  } catch {
    return clipText(String(value));
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
      text: stringifyValue(block?.arguments),
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
      text: stringifyValue(event.args),
      status: "active",
      toolCallId: event.toolCallId,
      at
    });
    return;
  }

  if (event.type === "tool_execution_update") {
    upsertToolItem(ensureActivityTurn(access, at), {
      title: event.toolName,
      text: stringifyValue(event.partialResult),
      status: "active",
      toolCallId: event.toolCallId,
      at
    });
    return;
  }

  if (event.type === "tool_execution_end") {
    upsertToolItem(ensureActivityTurn(access, at), {
      title: event.toolName,
      text: stringifyValue(event.result),
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

export function getButlerActivityTurns(access: ButlerAgentSessionAccess): ButlerActivityTurnView[] {
  return access.activityTurns
    .filter((turn) => turn.status === "active" || turn.items.length > 0)
    .slice(-MAX_ACTIVITY_TURNS)
    .map((turn) => ({
      ...turn,
      items: turn.items.map((item) => ({ ...item }))
    }));
}
