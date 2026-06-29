import crypto from "node:crypto";

import { emitStateStoreChange, queueStateStoreSave, type StateStoreInternalAccess } from "./state-store-internals.js";
import { normalizeButlerMemoryMetadata } from "./memory-metadata.js";
import type { ButlerMemoryEntryView } from "./types.js";

function normalizeTags(tags: unknown): string[] {
  return Array.isArray(tags)
    ? [...new Set(tags.filter((tag): tag is string => typeof tag === "string").map((tag) => tag.trim()).filter(Boolean))].slice(0, 12)
    : [];
}

export function recordStateStoreButlerMemory(
  access: StateStoreInternalAccess,
  input: {
    summary: string;
    details?: string | null;
    source?: ButlerMemoryEntryView["source"];
    sourceMessageId?: string | null;
    tags?: unknown;
    memoryType?: ButlerMemoryEntryView["memoryType"];
    scopeKind?: ButlerMemoryEntryView["scopeKind"];
    projectId?: string | null;
    threadId?: string | null;
    reviewState?: ButlerMemoryEntryView["reviewState"];
    confidence?: number | null;
    expiresAt?: number | null;
    supersedesId?: string | null;
    provenance?: Record<string, unknown>;
    contentVersion?: number;
  }
): ButlerMemoryEntryView {
  const now = Date.now();
  const tags = normalizeTags(input.tags);
  const entry: ButlerMemoryEntryView = {
    id: crypto.randomUUID(),
    summary: input.summary.trim(),
    details: typeof input.details === "string" && input.details.trim() ? input.details.trim() : null,
    source: input.source ?? "butler_tool",
    sourceMessageId: typeof input.sourceMessageId === "string" && input.sourceMessageId.trim() ? input.sourceMessageId.trim() : null,
    tags,
    createdAt: now,
    ...normalizeButlerMemoryMetadata(input, tags)
  };
  access.persistedButlerMemoryEntries.splice(0, access.persistedButlerMemoryEntries.length, ...[...access.persistedButlerMemoryEntries, entry].slice(-100));
  queueStateStoreSave(access);
  emitStateStoreChange(access);
  return entry;
}

export function deleteStateStoreButlerMemory(access: StateStoreInternalAccess, id: string): boolean {
  const entries = access.persistedButlerMemoryEntries;
  const index = entries.findIndex((entry) => entry.id === id);
  if (index < 0) {
    return false;
  }
  entries.splice(index, 1);
  queueStateStoreSave(access);
  emitStateStoreChange(access);
  return true;
}
