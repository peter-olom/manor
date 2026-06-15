import { promises as fs } from "node:fs";
import path from "node:path";

import { extractOperatorCallbackThreadId, normalizeOperatorMessages, upsertOperatorMessage } from "./butler-operator-messages.js";
import type { ButlerStateStore } from "./state-store.js";
import type { ButlerMessageView, ButlerNextWorkerReportAction } from "./types.js";

export type DirectCodexMessagePingInput = {
  text: string;
  imageReferenceIds?: string[];
  fileReferenceIds?: string[];
  inputItems?: unknown[];
};

export type DirectCodexMessageAccess = {
  store: ButlerStateStore;
  registerPendingChatCallback(
    threadId: string,
    options?: { privateSteerText?: string | null; nextWorkerReportAction?: ButlerNextWorkerReportAction; requestedAt?: number | null }
  ): void;
  recordDirectCodexOperatorMessage(threadId: string, text: string, at?: number): number;
  noteThreadFocus(threadId: string, reason?: string): void;
  saveCallbackState(): Promise<void>;
  emit(event: "change"): boolean;
};

function countStringIds(value: string[] | undefined): number {
  return (value ?? []).filter((entry) => entry.trim().length > 0).length;
}

function pluralize(count: number, singular: string, plural: string): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

function codexSessionThreadId(filePath: string): string | null {
  return filePath.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i)?.[1]?.toLowerCase() ?? null;
}

function callbackTurnId(id: string): string | null {
  return id.match(/^callback(?:-fallback)?-[^:]+:([^:]+)$/i)?.[1] ?? null;
}

function directCodexMessageText(record: Record<string, unknown>): string | null {
  if (record.type !== "event_msg" || !record.payload || typeof record.payload !== "object") {
    return null;
  }

  const payload = record.payload as Record<string, unknown>;
  if (payload.type !== "user_message" || typeof payload.message !== "string") {
    return null;
  }

  const text = payload.message.trim();
  if (
    !text ||
    text.startsWith("MANOR JOB BRIEF") ||
    text.startsWith("BUTLER FOLLOW-UP") ||
    text.startsWith("BUTLER CHECKLIST REJECTION FOLLOW-UP")
  ) {
    return null;
  }

  return text;
}

async function listCodexSessionFiles(root: string): Promise<string[]> {
  const entries = await fs.readdir(root, { withFileTypes: true }).catch(() => []);
  const files: string[] = [];
  for (const entry of entries) {
    const filePath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...await listCodexSessionFiles(filePath));
    } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
      files.push(filePath);
    }
  }
  return files;
}

function callbackThreadIds(messages: ButlerMessageView[]): Set<string> {
  const threadIds = new Set<string>();
  for (const message of messages) {
    const threadId = extractOperatorCallbackThreadId(message.id);
    if (threadId) {
      threadIds.add(threadId);
    }
  }
  return threadIds;
}

type DirectCodexTranscriptMessage = {
  id: string;
  text: string;
  at: number;
};

function taskStartedTurn(record: Record<string, unknown>): { turnId: string; at: number } | null {
  if (record.type !== "event_msg" || !record.payload || typeof record.payload !== "object") {
    return null;
  }

  const payload = record.payload as Record<string, unknown>;
  if (payload.type !== "task_started" || typeof payload.turn_id !== "string") {
    return null;
  }

  const timestamp = typeof record.timestamp === "string" ? Date.parse(record.timestamp) : NaN;
  const startedAt = typeof payload.started_at === "number" ? payload.started_at * 1000 : NaN;
  const at = Number.isFinite(timestamp) ? timestamp : startedAt;
  return Number.isFinite(at) ? { turnId: payload.turn_id, at } : null;
}

function closestTaskStartTurnId(taskStarts: { turnId: string; at: number }[], directAt: number): string | null {
  let closest: { turnId: string; distance: number } | null = null;
  for (const taskStart of taskStarts) {
    const distance = Math.abs(taskStart.at - directAt);
    if (distance > 10_000) {
      continue;
    }

    if (!closest || distance < closest.distance) {
      closest = { turnId: taskStart.turnId, distance };
    }
  }

  return closest?.turnId ?? null;
}

function mapTaskStartsToDirectMessages(
  taskStarts: { turnId: string; at: number }[],
  directMessages: DirectCodexTranscriptMessage[]
): Map<string, DirectCodexTranscriptMessage> {
  const anchorsByTurnId = new Map<string, DirectCodexTranscriptMessage>();
  for (const directMessage of directMessages) {
    const turnId = closestTaskStartTurnId(taskStarts, directMessage.at);
    if (turnId) {
      anchorsByTurnId.set(turnId, directMessage);
    }
  }

  const sortedDirectMessages = [...directMessages].sort((left, right) => left.at - right.at);
  for (const taskStart of taskStarts) {
    if (anchorsByTurnId.has(taskStart.turnId)) {
      continue;
    }

    const fallbackAnchor = sortedDirectMessages.filter((directMessage) => directMessage.at <= taskStart.at).at(-1);
    if (fallbackAnchor) {
      anchorsByTurnId.set(taskStart.turnId, fallbackAnchor);
    }
  }

  return anchorsByTurnId;
}

function alignCallbacksToTranscriptTurns(messages: ButlerMessageView[], anchorsByTurnId: Map<string, DirectCodexTranscriptMessage>): boolean {
  let changed = false;
  const offsetsByAnchor = new Map<string, number>();
  for (const message of messages) {
    const turnId = callbackTurnId(message.id);
    const anchor = turnId ? anchorsByTurnId.get(turnId) : null;
    if (!anchor) {
      continue;
    }

    const offset = (offsetsByAnchor.get(anchor.id) ?? 0) + 1;
    offsetsByAnchor.set(anchor.id, offset);
    const at = anchor.at + offset;
    if (message.at !== at) {
      message.at = at;
      changed = true;
    }
  }

  return changed;
}

export async function backfillDirectCodexMessagesFromSessionFiles(messages: ButlerMessageView[], codexHomeDir: string): Promise<boolean> {
  const threadIds = callbackThreadIds(messages);
  if (threadIds.size === 0) {
    return false;
  }

  const sessionRoot = path.join(codexHomeDir, "sessions");
  const files = await listCodexSessionFiles(sessionRoot);
  let changed = false;
  const anchorsByTurnId = new Map<string, DirectCodexTranscriptMessage>();
  for (const filePath of files) {
    const threadId = codexSessionThreadId(filePath);
    if (!threadId || !threadIds.has(threadId)) {
      continue;
    }

    const raw = await fs.readFile(filePath, "utf8").catch(() => "");
    const taskStarts: { turnId: string; at: number }[] = [];
    const directMessages: DirectCodexTranscriptMessage[] = [];
    let sequence = 0;
    for (const line of raw.split("\n")) {
      if (!line.trim()) {
        continue;
      }

      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue;
      }

      const taskStart = taskStartedTurn(parsed);
      if (taskStart) {
        taskStarts.push(taskStart);
        continue;
      }

      const text = directCodexMessageText(parsed);
      if (!text) {
        continue;
      }

      const timestamp = typeof parsed.timestamp === "string" ? Date.parse(parsed.timestamp) : NaN;
      const at = Number.isFinite(timestamp) ? timestamp : Date.now();
      const id = `operator-direct-${threadId}-${at}-${sequence++}`;
      directMessages.push({ id, text, at });
      changed = upsertOperatorMessage(messages, id, text, at, null, { role: "user", normalize: false }) || changed;
    }

    for (const [turnId, directMessage] of mapTaskStartsToDirectMessages(taskStarts, directMessages)) {
      anchorsByTurnId.set(turnId, directMessage);
    }
  }

  changed = alignCallbacksToTranscriptTurns(messages, anchorsByTurnId) || changed;
  return normalizeOperatorMessages(messages) || changed;
}

export function buildDirectCodexMessagePingSummary(input: DirectCodexMessagePingInput): string {
  const text = input.text.trim();
  const imageCount = countStringIds(input.imageReferenceIds);
  const fileCount = countStringIds(input.fileReferenceIds);
  const contextCount = Array.isArray(input.inputItems) ? input.inputItems.length : 0;
  const contextParts = [
    imageCount > 0 ? pluralize(imageCount, "image reference", "image references") : null,
    fileCount > 0 ? pluralize(fileCount, "file reference", "file references") : null,
    contextCount > 0 ? pluralize(contextCount, "selected context item", "selected context items") : null
  ].filter((entry): entry is string => Boolean(entry));

  if (text && contextParts.length === 0) {
    return text;
  }

  const lead = text || "Operator sent a direct Codex message with attachments or selected context.";
  return `${lead}\n\nDirect-message context: ${contextParts.join(", ")}.`;
}

export async function notifyDirectCodexMessage(
  access: DirectCodexMessageAccess,
  input: DirectCodexMessagePingInput & { threadId: string }
): Promise<void> {
  if (!access.store.getThread(input.threadId)) {
    throw new Error(`Job ${input.threadId} is not available for Butler notification.`);
  }

  const privateSteerText = buildDirectCodexMessagePingSummary(input);
  const requestedAt = access.recordDirectCodexOperatorMessage(input.threadId, privateSteerText);
  access.store.refreshCompletedSupervisionChecklistForFollowup(input.threadId, privateSteerText);
  access.registerPendingChatCallback(input.threadId, {
    privateSteerText,
    nextWorkerReportAction: "review",
    requestedAt
  });
  access.noteThreadFocus(input.threadId, "direct_codex_message");
  access.store.addEvent(input.threadId, "butler.direct_message.pinged", "Butler was pinged for an operator direct message to Codex.");
  await access.saveCallbackState();
  access.emit("change");
}
