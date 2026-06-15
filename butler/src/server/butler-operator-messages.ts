import { promises as fs } from "node:fs";
import path from "node:path";

import {
  SNAPSHOT_MESSAGE_TAIL_LIMIT,
  contentAttachmentSummary,
  contentToText,
  extractMessageTimestamp,
  isButlerBackgroundPromptText
} from "./butler-agent-helpers.js";
import { stripElapsedTaskTimeFooter } from "./task-timing.js";
import type { ButlerMessageView } from "./types.js";

type OperatorMessageOptions = {
  role?: string;
  displayText?: string | null;
};

const MAX_OPERATOR_MESSAGES = SNAPSHOT_MESSAGE_TAIL_LIMIT;
const RECENT_USER_ONLY_GROUP_MS = 30 * 60 * 1000;
const PROVIDER_DUPLICATE_WINDOW_MS = 2_000;
const STORED_REFERENCE_PATTERN = /\n\nStored reference (?:files|images):/i;

function isOperatorUserRole(role: string | null | undefined): boolean {
  return role === "user" || role === "user-with-attachments";
}

function isOperatorUserMessage(message: ButlerMessageView): boolean {
  return isOperatorUserRole(message.role);
}

function isProviderBackedAssistantMessage(message: ButlerMessageView): boolean {
  return message.role === "assistant" && message.id.startsWith("operator-session-");
}

function isPersistableAssistantText(text: string): boolean {
  const normalized = text.trim();
  return normalized.length > 0 && normalized !== "INTERNAL_REVIEW_COMPLETE";
}

export function isPersistableProviderOperatorMessage(role: string, text: string): boolean {
  if (isOperatorUserRole(role)) {
    return text.trim().length > 0 && !isButlerBackgroundPromptText(text);
  }

  return role === "assistant" && isPersistableAssistantText(text);
}

function displayTextForPersistedUserText(text: string): string | null {
  const index = text.search(STORED_REFERENCE_PATTERN);
  if (index < 0) {
    return null;
  }

  const displayText = text.slice(0, index).trim();
  return displayText && displayText !== text.trim() ? displayText : null;
}

function matchingProviderBackedOperatorMessageId(messages: ButlerMessageView[], role: string, text: string, at: number): string | null {
  const normalizedText = text.trim();
  if (!normalizedText) {
    return null;
  }

  for (const message of messages) {
    if (isOperatorUserRole(role)) {
      if (!isOperatorUserMessage(message)) {
        continue;
      }
    } else if (message.role !== role || !message.id.startsWith("operator-session-")) {
      continue;
    }

    if (message.text.trim() !== normalizedText) {
      continue;
    }

    const messageAt = message.at ?? 0;
    if (Math.abs(messageAt - at) <= PROVIDER_DUPLICATE_WINDOW_MS) {
      return message.id;
    }
  }

  return null;
}

function groupOperatorMessages(messages: ButlerMessageView[]): ButlerMessageView[][] {
  const groups: ButlerMessageView[][] = [];
  let current: ButlerMessageView[] = [];

  for (const message of messages) {
    if (isOperatorUserMessage(message) && current.length > 0) {
      groups.push(current);
      current = [message];
    } else {
      current.push(message);
    }
  }

  if (current.length > 0) {
    groups.push(current);
  }

  return groups;
}

function capOversizedGroup(group: ButlerMessageView[]): ButlerMessageView[] {
  if (group.length <= MAX_OPERATOR_MESSAGES) {
    return group;
  }

  if (isOperatorUserMessage(group[0]!)) {
    return [group[0]!, ...group.slice(-(MAX_OPERATOR_MESSAGES - 1))];
  }

  return group.slice(-MAX_OPERATOR_MESSAGES);
}

export function normalizeOperatorMessages(messages: ButlerMessageView[]): boolean {
  const beforeIds = messages.map((message) => message.id).join("\n");
  messages.sort((left, right) => (left.at ?? 0) - (right.at ?? 0));

  const groups = groupOperatorMessages(messages);
  const hasAssistantGroup = groups.some((group) => group.some((message) => !isOperatorUserMessage(message)));
  const latestAt = messages.reduce((latest, message) => Math.max(latest, message.at ?? 0), 0);
  const prunedGroups = hasAssistantGroup
    ? groups.filter((group, index) => {
        const groupAt = group.reduce((latest, message) => Math.max(latest, message.at ?? 0), 0);
        if (!group.some(isOperatorUserMessage) && group.every(isProviderBackedAssistantMessage)) {
          return index === groups.length - 1 || latestAt - groupAt <= RECENT_USER_ONLY_GROUP_MS;
        }

        if (group.some((message) => !isOperatorUserMessage(message))) {
          return true;
        }

        return index === groups.length - 1 || latestAt - groupAt <= RECENT_USER_ONLY_GROUP_MS;
      })
    : groups;

  const keptGroups: ButlerMessageView[][] = [];
  let keptCount = 0;
  for (let index = prunedGroups.length - 1; index >= 0; index -= 1) {
    const group = prunedGroups[index]!;
    if (keptCount + group.length > MAX_OPERATOR_MESSAGES && keptGroups.length > 0) {
      break;
    }

    const cappedGroup = keptGroups.length === 0 ? capOversizedGroup(group) : group;
    keptGroups.unshift(cappedGroup);
    keptCount += cappedGroup.length;
  }

  const nextMessages = keptGroups.flat();
  messages.splice(0, messages.length, ...nextMessages);

  const afterIds = messages.map((message) => message.id).join("\n");
  return beforeIds !== afterIds;
}

export function upsertOperatorMessage(messages: ButlerMessageView[], id: string, text: string, at: number, taskDurationMs: number | null = null, options: OperatorMessageOptions = {}): boolean {
  const existingMessage = messages.find((entry) => entry.id === id);
  const role = options.role ?? "assistant";
  const displayText = options.displayText?.trim() || null;
  let changed = false;
  if (existingMessage) {
    changed =
      existingMessage.text !== text ||
      existingMessage.at !== at ||
      existingMessage.taskDurationMs !== taskDurationMs ||
      existingMessage.role !== role ||
      existingMessage.displayText !== (displayText ?? undefined);
    existingMessage.text = text;
    existingMessage.at = at;
    existingMessage.taskDurationMs = taskDurationMs;
    existingMessage.role = role;
    if (displayText) existingMessage.displayText = displayText;
    else delete existingMessage.displayText;
  } else {
    changed = true;
    messages.push({
      id,
      role,
      text,
      ...(displayText ? { displayText } : {}),
      at,
      taskDurationMs,
      kind: "message"
    });
  }
  changed = normalizeOperatorMessages(messages) || changed;
  return changed;
}

export function upsertProviderBackedOperatorMessage(messages: ButlerMessageView[], id: string, text: string, at: number, role: string, displayText: string | null = null): boolean {
  const existingId = matchingProviderBackedOperatorMessageId(messages, role, text, at) ?? id;
  return upsertOperatorMessage(messages, existingId, text, at, null, {
    role,
    displayText
  });
}

export function removeOperatorMessage(messages: ButlerMessageView[], id: string | null | undefined): boolean {
  if (!id) return false;
  const index = messages.findIndex((entry) => entry.id === id);
  if (index < 0) return false;
  messages.splice(index, 1);
  return true;
}

function persistedUserText(message: Record<string, unknown>): string {
  const text = contentToText(message.content).trim();
  if (text) return text;
  return contentAttachmentSummary(message.content).trim();
}

function persistedAssistantText(message: Record<string, unknown>): string {
  return stripElapsedTaskTimeFooter(contentToText(message.content)).trim();
}

export async function backfillOperatorMessagesFromSessionFiles(messages: ButlerMessageView[], sessionDir: string): Promise<boolean> {
  const entries = await fs.readdir(sessionDir, { withFileTypes: true }).catch(() => []);
  let changed = false;
  for (const entry of entries.filter((item) => item.isFile() && item.name.endsWith(".jsonl")).sort((left, right) => left.name.localeCompare(right.name))) {
    const filePath = path.join(sessionDir, entry.name);
    const raw = await fs.readFile(filePath, "utf8").catch(() => "");
    let hideAssistantReply = false;
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      let parsed: Record<string, unknown>;
      try { parsed = JSON.parse(line) as Record<string, unknown>; } catch { continue; }
      const message = parsed.message && typeof parsed.message === "object" ? parsed.message as Record<string, unknown> : null;
      const role = typeof message?.role === "string" ? message.role : null;
      if (parsed.type !== "message" || !message) continue;
      const at = extractMessageTimestamp(message) ?? extractMessageTimestamp(parsed) ?? Date.now();
      if (role === "user" || role === "user-with-attachments") {
        const text = persistedUserText(message);
        hideAssistantReply = role === "user" && isButlerBackgroundPromptText(text);
        if (!isPersistableProviderOperatorMessage(role, text)) continue;
        const id = typeof parsed.id === "string" && parsed.id.trim() ? `operator-user-${parsed.id}` : `operator-user-${at}`;
        changed = upsertProviderBackedOperatorMessage(messages, id, text, at, role, displayTextForPersistedUserText(text)) || changed;
        continue;
      }

      if (role === "assistant") {
        if (hideAssistantReply) continue;
        const text = persistedAssistantText(message);
        if (!isPersistableProviderOperatorMessage(role, text)) continue;
        const id = typeof parsed.id === "string" && parsed.id.trim() ? `operator-session-${parsed.id}` : `operator-session-${at}`;
        changed = upsertProviderBackedOperatorMessage(messages, id, text, at, role) || changed;
      }
    }
  }
  return normalizeOperatorMessages(messages) || changed;
}
