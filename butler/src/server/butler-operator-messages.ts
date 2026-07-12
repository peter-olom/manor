import { promises as fs } from "node:fs";
import path from "node:path";

import {
  SNAPSHOT_MESSAGE_TAIL_LIMIT,
  contentAttachmentSummary,
  contentToText,
  extractMessageTimestamp,
  isButlerBackgroundPromptText,
  isTrivialOperatorQuestionConfirmation
} from "./butler-agent-helpers.js";
import type { ButlerMessageView, ButlerOperatorQuestionItemView, ButlerOperatorQuestionView, ButlerTraceItemView, ButlerTraceMetaView } from "./types.js";

type OperatorMessageOptions = {
  role?: string;
  displayText?: string | null;
  question?: ButlerOperatorQuestionView | null;
  trace?: ButlerTraceItemView[] | null;
  traceMeta?: ButlerTraceMetaView | null;
  normalize?: boolean;
};

type ProviderBackedOperatorMessageOptions = {
  normalize?: boolean;
  providerSucceeded?: boolean;
  trace?: ButlerTraceItemView[] | null;
  traceMeta?: ButlerTraceMetaView | null;
};

const MAX_OPERATOR_MESSAGES = SNAPSHOT_MESSAGE_TAIL_LIMIT;
const RECENT_USER_ONLY_GROUP_MS = 30 * 60 * 1000;
const PROVIDER_DUPLICATE_WINDOW_MS = 2_000;
const STORED_REFERENCE_PATTERN = /\n\nStored reference (?:files|images):/i;
const CALLBACK_THREAD_PATTERN = /^callback(?:-fallback)?-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}):/i;
const DIRECT_OPERATOR_THREAD_PATTERN = /^operator-direct-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})-/i;
const ATTACHMENT_SUMMARY_PATTERN =
  /^Attached \d+ (?:image|images|file|files|attachment|attachments)(?:, \d+ (?:image|images|file|files|attachment|attachments))*$/;

function isOperatorUserRole(role: string | null | undefined): boolean {
  return role === "user" || role === "user-with-attachments";
}

function isOperatorUserMessage(message: ButlerMessageView): boolean {
  return isOperatorUserRole(message.role);
}

function isProviderBackedAssistantMessage(message: ButlerMessageView): boolean {
  return message.role === "assistant" && message.id.startsWith("operator-session-");
}

function isDirectOperatorMessage(message: ButlerMessageView): boolean {
  return Boolean(extractDirectOperatorThreadId(message.id)) && isOperatorUserMessage(message);
}

function isLeakedProviderAttachmentSummary(message: ButlerMessageView): boolean {
  return isProviderBackedAssistantMessage(message) && ATTACHMENT_SUMMARY_PATTERN.test(message.text.trim());
}

export function removeTrivialOperatorQuestionConfirmations(messages: ButlerMessageView[], options: { providerBackedOnly?: boolean } = {}): boolean {
  let changed = false;
  const providerBackedOnly = options.providerBackedOnly ?? true;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!;
    if (message.role !== "assistant" || (providerBackedOnly && !isProviderBackedAssistantMessage(message)) || !isTrivialOperatorQuestionConfirmation(message.text)) {
      continue;
    }

    const previous = messages
      .slice(0, index)
      .reverse()
      .find((entry) => entry.kind === "message");
    if (!previous?.question) {
      continue;
    }

    messages.splice(index, 1);
    changed = true;
  }
  return changed;
}

export function extractOperatorCallbackThreadId(id: string): string | null {
  return id.match(CALLBACK_THREAD_PATTERN)?.[1]?.toLowerCase() ?? null;
}

function extractDirectOperatorThreadId(id: string): string | null {
  return id.match(DIRECT_OPERATOR_THREAD_PATTERN)?.[1]?.toLowerCase() ?? null;
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

function normalizeQuestionOption(raw: unknown, index: number): ButlerOperatorQuestionView["options"][number] | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const record = raw as Partial<ButlerOperatorQuestionView["options"][number]>;
  const label = typeof record.label === "string" && record.label.trim() ? record.label.trim() : null;
  if (!label) {
    return null;
  }
  return {
    id: typeof record.id === "string" && record.id.trim() ? record.id.trim() : `option-${index + 1}`,
    label,
    description: typeof record.description === "string" && record.description.trim() ? record.description.trim() : null
  };
}

function normalizeAnsweredOption(record: Partial<ButlerOperatorQuestionItemView>, options: ButlerOperatorQuestionItemView["options"]): string | null {
  if (typeof record.selectedOptionId !== "string" || !record.selectedOptionId.trim()) {
    return null;
  }
  const selectedOptionId = record.selectedOptionId.trim();
  return options.some((option) => option.id === selectedOptionId) ? selectedOptionId : null;
}

function normalizeQuestionItem(raw: unknown, index: number): ButlerOperatorQuestionItemView | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const record = raw as Partial<ButlerOperatorQuestionItemView>;
  const prompt = typeof record.prompt === "string" && record.prompt.trim() ? record.prompt.trim() : null;
  const options = Array.isArray(record.options)
    ? record.options.map((option, index) => normalizeQuestionOption(option, index)).filter((option): option is ButlerOperatorQuestionView["options"][number] => Boolean(option))
    : [];
  if (!prompt || options.length === 0) {
    return null;
  }
  const selectedOptionId = normalizeAnsweredOption(record, options);
  const freeformAnswer = record.allowFreeform === true && typeof record.freeformAnswer === "string" && record.freeformAnswer.trim()
    ? record.freeformAnswer.trim()
    : null;
  const answered = Boolean(selectedOptionId || freeformAnswer);
  return {
    id: typeof record.id === "string" && record.id.trim() ? record.id.trim() : `question-${Date.now()}-${index + 1}`,
    prompt,
    context: typeof record.context === "string" && record.context.trim() ? record.context.trim() : null,
    options,
    allowFreeform: record.allowFreeform === true,
    createdAt: typeof record.createdAt === "number" && Number.isFinite(record.createdAt) ? record.createdAt : Date.now(),
    selectedOptionId,
    freeformAnswer: selectedOptionId ? null : freeformAnswer,
    answeredAt: answered && typeof record.answeredAt === "number" && Number.isFinite(record.answeredAt) ? record.answeredAt : null
  };
}

export function normalizeOperatorQuestion(raw: unknown): ButlerOperatorQuestionView | null {
  const base = normalizeQuestionItem(raw, 0);
  if (!base || !raw || typeof raw !== "object") {
    return null;
  }

  const record = raw as Partial<ButlerOperatorQuestionView>;
  const questions = Array.isArray(record.questions)
    ? record.questions.map((question, index) => normalizeQuestionItem(question, index)).filter((question): question is ButlerOperatorQuestionItemView => Boolean(question))
    : [];
  const items = questions.length > 1 ? questions : [base];
  const answered = items.every((question) => Boolean(question.selectedOptionId || question.freeformAnswer));
  const rawDeliveryState = record.deliveryState;
  const deliveryState = !answered
    ? "idle"
    : rawDeliveryState === "pending" || rawDeliveryState === "failed" || rawDeliveryState === "delivered"
      ? rawDeliveryState
      : "delivered";

  return {
    ...base,
    id: typeof record.id === "string" && record.id.trim() ? record.id.trim() : base.id,
    ...(questions.length > 1 ? { questions } : {}),
    deliveryState,
    deliveryError: deliveryState === "failed" && typeof record.deliveryError === "string" && record.deliveryError.trim()
      ? record.deliveryError.trim()
      : null
  };
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

function alignCallbacksToDirectOperatorMessages(messages: ButlerMessageView[]): boolean {
  const directAnchorsByThreadId = new Map<string, ButlerMessageView[]>();
  for (const message of messages) {
    const threadId = extractDirectOperatorThreadId(message.id);
    if (!threadId || !isOperatorUserMessage(message)) {
      continue;
    }

    const anchors = directAnchorsByThreadId.get(threadId) ?? [];
    anchors.push(message);
    directAnchorsByThreadId.set(threadId, anchors);
  }

  for (const anchors of directAnchorsByThreadId.values()) {
    anchors.sort((left, right) => (left.at ?? 0) - (right.at ?? 0));
  }

  const callbackOffsetsByAnchor = new Map<string, number>();
  let changed = false;
  const callbacks = messages
    .filter((message) => Boolean(extractOperatorCallbackThreadId(message.id)))
    .sort((left, right) => (left.at ?? 0) - (right.at ?? 0));

  for (const callback of callbacks) {
    const threadId = extractOperatorCallbackThreadId(callback.id);
    if (!threadId) {
      continue;
    }

    const anchors = directAnchorsByThreadId.get(threadId) ?? [];
    const callbackAt = callback.at ?? 0;
    const anchor = anchors.filter((entry) => (entry.at ?? 0) <= callbackAt).at(-1);
    if (!anchor || anchor.at === null) {
      continue;
    }

    const offset = (callbackOffsetsByAnchor.get(anchor.id) ?? 0) + 1;
    callbackOffsetsByAnchor.set(anchor.id, offset);
    const nextAt = anchor.at + offset;
    if (callback.at !== nextAt) {
      callback.at = nextAt;
      changed = true;
    }
  }

  return changed;
}

export function normalizeOperatorMessages(messages: ButlerMessageView[]): boolean {
  const beforeSignature = JSON.stringify(messages.map((message) => [message.id, message.at ?? null, message.question ?? null]));
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (isLeakedProviderAttachmentSummary(messages[index]!)) {
      messages.splice(index, 1);
    }
  }
  alignCallbacksToDirectOperatorMessages(messages);
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (isDirectOperatorMessage(messages[index]!)) {
      messages.splice(index, 1);
    }
  }
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
  const removedTrivialConfirmations = removeTrivialOperatorQuestionConfirmations(messages, { providerBackedOnly: true });

  const afterSignature = JSON.stringify(messages.map((message) => [message.id, message.at ?? null, message.question ?? null]));
  return removedTrivialConfirmations || beforeSignature !== afterSignature;
}

export function upsertOperatorMessage(messages: ButlerMessageView[], id: string, text: string, at: number, taskDurationMs: number | null = null, options: OperatorMessageOptions = {}): boolean {
  const existingMessage = messages.find((entry) => entry.id === id);
  const role = options.role ?? "assistant";
  const displayText = options.displayText?.trim() || null;
  const question = options.question ? normalizeOperatorQuestion(options.question) : null;
  const updatesTrace = Object.prototype.hasOwnProperty.call(options, "trace");
  const updatesTraceMeta = Object.prototype.hasOwnProperty.call(options, "traceMeta");
  const trace = updatesTrace ? options.trace ?? null : existingMessage?.trace ?? null;
  const traceMeta = updatesTraceMeta ? options.traceMeta ?? null : existingMessage?.traceMeta ?? null;
  let changed = false;
  if (existingMessage) {
    changed =
      existingMessage.text !== text ||
      existingMessage.at !== at ||
      existingMessage.taskDurationMs !== taskDurationMs ||
      existingMessage.role !== role ||
      existingMessage.displayText !== (displayText ?? undefined) ||
      JSON.stringify(existingMessage.question ?? null) !== JSON.stringify(question) ||
      JSON.stringify(existingMessage.trace ?? null) !== JSON.stringify(trace) ||
      JSON.stringify(existingMessage.traceMeta ?? null) !== JSON.stringify(traceMeta);
    existingMessage.text = text;
    existingMessage.at = at;
    existingMessage.taskDurationMs = taskDurationMs;
    existingMessage.role = role;
    if (displayText) existingMessage.displayText = displayText;
    else delete existingMessage.displayText;
    if (question) existingMessage.question = question;
    else delete existingMessage.question;
    if (updatesTrace) {
      if (trace && trace.length > 0) existingMessage.trace = trace;
      else delete existingMessage.trace;
    }
    if (updatesTraceMeta) {
      if (traceMeta) existingMessage.traceMeta = traceMeta;
      else delete existingMessage.traceMeta;
    }
  } else {
    changed = true;
    const next: ButlerMessageView = {
      id,
      role,
      text,
      at,
      taskDurationMs,
      kind: "message"
    };
    if (displayText) next.displayText = displayText;
    if (question) next.question = question;
    if (trace && trace.length > 0) next.trace = trace;
    if (traceMeta) next.traceMeta = traceMeta;
    messages.push(next);
  }
  if (options.normalize !== false) changed = normalizeOperatorMessages(messages) || changed;
  return changed;
}

export function upsertProviderBackedOperatorMessage(
  messages: ButlerMessageView[],
  id: string,
  text: string,
  at: number,
  role: string,
  displayText: string | null = null,
  options: ProviderBackedOperatorMessageOptions = {}
): boolean {
  const existingId = matchingProviderBackedOperatorMessageId(messages, role, text, at) ?? id;
  const operatorOptions: OperatorMessageOptions = {
    role,
    displayText,
    normalize: options.normalize
  };
  if (Object.prototype.hasOwnProperty.call(options, "trace")) operatorOptions.trace = options.trace ?? null;
  if (Object.prototype.hasOwnProperty.call(options, "traceMeta")) operatorOptions.traceMeta = options.traceMeta ?? null;
  let changed = upsertOperatorMessage(messages, existingId, text, at, null, operatorOptions);
  const stored = messages.find((message) => message.id === existingId);
  if (stored && stored.providerBacked !== true) { stored.providerBacked = true; changed = true; }
  if (stored && role === "assistant" && stored.providerSucceeded !== (options.providerSucceeded !== false)) { stored.providerSucceeded = options.providerSucceeded !== false; changed = true; }
  return changed;
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
  return contentToText(message.content).trim();
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
        hideAssistantReply = isButlerBackgroundPromptText(text);
        if (!isPersistableProviderOperatorMessage(role, text)) continue;
        const id = typeof parsed.id === "string" && parsed.id.trim() ? `operator-user-${parsed.id}` : `operator-user-${at}`;
        changed = upsertProviderBackedOperatorMessage(messages, id, text, at, role, displayTextForPersistedUserText(text), { normalize: false }) || changed;
        continue;
      }

      if (role === "assistant") {
        if (hideAssistantReply) continue;
        const text = persistedAssistantText(message);
        if (!isPersistableProviderOperatorMessage(role, text)) continue;
        const id = typeof parsed.id === "string" && parsed.id.trim() ? `operator-session-${parsed.id}` : `operator-session-${at}`;
        changed = upsertProviderBackedOperatorMessage(messages, id, text, at, role, null, {
          normalize: false,
          providerSucceeded: message.stopReason !== "error" && message.stopReason !== "aborted"
        }) || changed;
      }
    }
  }
  return normalizeOperatorMessages(messages) || changed;
}
