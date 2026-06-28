import type { ButlerTraceItemView, ButlerTraceMetaView } from "./types.js";

export type ButlerTraceBufferHooks = {
  onTracePersisted?: (input: { messageId: string; trace: ButlerTraceItemView[]; meta: ButlerTraceMetaView }) => void;
};

const TRACE_ITEM_LIMIT = 80;
const TRACE_TEXT_LIMIT = 4000;

function clampText(value: string): string {
  if (value.length <= TRACE_TEXT_LIMIT) return value;
  return `${value.slice(0, TRACE_TEXT_LIMIT)}…`;
}

function asTraceItem(input: {
  id: string;
  type: string;
  status: string;
  text: string;
  title?: string;
  at: number;
  completedAt?: number | null;
}): ButlerTraceItemView {
  const item: ButlerTraceItemView = {
    id: input.id,
    type: (input.type as ButlerTraceItemView["type"]) || "unknown",
    status: (input.status as ButlerTraceItemView["status"]) || "in_progress",
    text: clampText(input.text),
    at: input.at
  };
  if (input.title) item.title = input.title;
  if (input.completedAt !== undefined) item.completedAt = input.completedAt;
  return item;
}

export class ButlerTraceBuffer {
  private readonly byTurn = new Map<string, Map<string, ButlerTraceItemView>>();
  private readonly meta = new Map<string, ButlerTraceMetaView>();
  private readonly pendingByAssistantItem = new Map<string, { turnId: string; at: number }>();
  private readonly itemToTurn = new Map<string, string>();

  constructor(private readonly hooks: ButlerTraceBufferHooks = {}) {}

  startTurn(turnId: string, at: number): void {
    if (!this.byTurn.has(turnId)) {
      this.byTurn.set(turnId, new Map());
    }
    const existing = this.meta.get(turnId);
    if (!existing) {
      this.meta.set(turnId, { turnId, startedAt: at, completedAt: 0, items: [] });
    } else if (existing.startedAt === 0) {
      existing.startedAt = at;
    }
  }

  setAssistantItem(turnId: string, itemId: string, at: number): void {
    this.pendingByAssistantItem.set(itemId, { turnId, at });
  }

  upsertItem(input: {
    turnId: string;
    itemId: string;
    type: string;
    status: string;
    text: string;
    title?: string;
    at: number;
    completedAt?: number | null;
  }): void {
    if (input.type === "assistant_message" || input.type === "user_message") {
      return;
    }
    this.startTurn(input.turnId, input.at);
    this.itemToTurn.set(input.itemId, input.turnId);
    let items = this.byTurn.get(input.turnId);
    if (!items) {
      items = new Map();
      this.byTurn.set(input.turnId, items);
    }
    const existing = items.get(input.itemId);
    const isCompletion = input.status === "completed" && existing && existing.status !== "completed";
    const nextText = isCompletion || !existing ? clampText(input.text) : existing.text + input.text;
    const next = asTraceItem({
      id: input.itemId,
      type: input.type,
      status: input.status,
      text: nextText,
      title: input.title ?? existing?.title,
      at: existing?.at ?? input.at,
      completedAt: input.completedAt ?? existing?.completedAt ?? null
    });
    items.set(input.itemId, next);
    if (items.size > TRACE_ITEM_LIMIT) {
      const overflow = items.size - TRACE_ITEM_LIMIT;
      const oldestKeys = [...items.keys()].slice(0, overflow);
      for (const key of oldestKeys) items.delete(key);
    }
  }

  completeTurn(turnId: string, at: number): ButlerTraceMetaView | null {
    const items = this.byTurn.get(turnId);
    const meta = this.meta.get(turnId);
    if (!meta) return null;
    meta.completedAt = at;
    meta.items = items ? [...items.values()].sort((a, b) => a.at - b.at) : [];
    if (items) this.byTurn.delete(turnId);
    this.itemToTurn.forEach((turn, key) => {
      if (turn === turnId) this.itemToTurn.delete(key);
    });
    return meta;
  }

  consumeForAssistantItem(itemId: string): ButlerTraceMetaView | null {
    const link = this.pendingByAssistantItem.get(itemId);
    if (!link) return null;
    this.pendingByAssistantItem.delete(itemId);
    const meta = this.completeTurn(link.turnId, link.at);
    return meta;
  }

  reset(): void {
    this.byTurn.clear();
    this.meta.clear();
    this.pendingByAssistantItem.clear();
    this.itemToTurn.clear();
  }
}
