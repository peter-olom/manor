import crypto from "node:crypto";

import { upsertOperatorMessage } from "./butler-operator-messages.js";
import { formatOperatorPreferenceMemory, isAcceptedOperatorPreferenceMemory } from "./memory-metadata.js";
import type { ButlerMemoryEntryView, ButlerMessageView, ButlerOperatorQuestionItemView, ButlerOperatorQuestionView } from "./types.js";

type OperatorQuestionItemInput = {
  prompt: string;
  context?: string | null;
  options: Array<{ id?: string | null; label: string; description?: string | null }>;
  allowFreeform?: boolean;
};

type OperatorQuestionInput = {
  prompt?: string;
  context?: string | null;
  options?: Array<{ id?: string | null; label: string; description?: string | null }>;
  allowFreeform?: boolean;
  questions?: OperatorQuestionItemInput[];
};

type OperatorQuestionAnswerInput = {
  messageId: string;
  questionId: string;
  optionId?: string;
  freeformText?: string;
};

type OperatorQuestionTasteMemoryInput = Pick<ButlerMemoryEntryView, "summary" | "details" | "tags">;
type OperatorQuestionTasteMemoryAccess = {
  listButlerMemory(): ButlerMemoryEntryView[];
  recordButlerMemory(input: {
    summary: string;
    details?: string | null;
    source?: ButlerMemoryEntryView["source"];
    sourceMessageId?: string | null;
    tags?: unknown;
    memoryType?: ButlerMemoryEntryView["memoryType"];
    scopeKind?: ButlerMemoryEntryView["scopeKind"];
    reviewState?: ButlerMemoryEntryView["reviewState"];
    confidence?: number | null;
    provenance?: Record<string, unknown>;
  }): ButlerMemoryEntryView;
};

const DURABLE_OPERATOR_TASTE_PATTERN =
  /\b(taste|prefer|preference|style|voice|tone|design|polish|quality|like|dislike|vision|autonomy|handholding|ask|question|decision|planner|critic|loop)\b/i;
const OPERATOR_PREFERENCE_EVIDENCE_PATTERN =
  /\b(operator preference|prefer(?:s|red|ence)?|style|voice|tone|design taste|polish|quality bar|autonomy|handholding|ask fewer|ask before|question policy)\b/i;
const SKIP_OPERATOR_QUESTION_MEMORY_PATTERN =
  /\b(smoke test|test only|verification only|temporary test|do not remember|don't remember)\b/i;
const MAX_FREEFORM_ANSWER_CHARS = 2_000;
const operatorQuestionMutationTails = new WeakMap<ButlerMessageView[], Promise<void>>();

async function runOperatorQuestionMutation<T>(messages: ButlerMessageView[], mutation: () => Promise<T>): Promise<T> {
  const previous = operatorQuestionMutationTails.get(messages) ?? Promise.resolve();
  let release = () => {};
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.catch(() => undefined).then(() => current);
  operatorQuestionMutationTails.set(messages, tail);
  await previous.catch(() => undefined);
  try {
    return await mutation();
  } finally {
    release();
    if (operatorQuestionMutationTails.get(messages) === tail) {
      operatorQuestionMutationTails.delete(messages);
    }
  }
}

function compactText(value: string | null | undefined): string | null {
  const normalized = value?.replace(/\s+/g, " ").trim() ?? "";
  return normalized || null;
}

function isOperatorUserRole(role: string): boolean {
  return role === "user" || role === "user-with-attachments";
}

function truncateMemoryText(value: string, maxLength: number): string {
  return value.length > maxLength ? `${value.slice(0, maxLength - 1).trim()}...` : value;
}

function tagsForOperatorTasteQuestion(text: string): string[] {
  const tags = ["operator-taste", "operator-question"];
  if (/\b(autonomy|handholding|ask|question|decision|delegate|planner|critic|loop)\b/i.test(text)) {
    tags.push("autonomy");
  }
  if (/\b(ui|ux|design|style|polish|quality|look|feel)\b/i.test(text)) {
    tags.push("ui-taste");
  }
  if (/\b(voice|tone|writing|wording|copy)\b/i.test(text)) {
    tags.push("writing-taste");
  }
  return tags;
}

export function findDurableOperatorTasteNotes(memoryEntries: ButlerMemoryEntryView[]): string[] {
  return memoryEntries
    .filter((entry) => isAcceptedOperatorPreferenceMemory(entry))
    .filter((entry) => OPERATOR_PREFERENCE_EVIDENCE_PATTERN.test(`${entry.summary} ${entry.details ?? ""} ${(entry.tags ?? []).join(" ")}`))
    .slice(-6)
    .map(formatOperatorPreferenceMemory);
}

function buildQuestionOptions(input: { options?: Array<{ id?: string | null; label: string; description?: string | null }> }): ButlerOperatorQuestionItemView["options"] {
  const seenOptionIds = new Set<string>();
  return (Array.isArray(input.options) ? input.options : [])
    .map((option, index) => {
      const label = option.label.trim();
      if (!label) return null;
      const baseId = option.id?.trim() || label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || `option-${index + 1}`;
      let id = baseId;
      let suffix = 2;
      while (seenOptionIds.has(id)) {
        id = `${baseId}-${suffix}`;
        suffix += 1;
      }
      seenOptionIds.add(id);
      return { id, label, description: option.description?.trim() || null };
    })
    .filter((option): option is ButlerOperatorQuestionItemView["options"][number] => Boolean(option))
    .slice(0, 6);
}

function buildQuestionItems(input: OperatorQuestionInput, now: number, groupId: string): ButlerOperatorQuestionItemView[] {
  const rawQuestions = Array.isArray(input.questions) && input.questions.length > 0 ? input.questions : [input];
  return rawQuestions.slice(0, 3).map((rawQuestion, index) => {
    const prompt = rawQuestion.prompt?.trim() ?? "";
    if (!prompt) throw new Error("Structured operator questions require a prompt.");
    const options = buildQuestionOptions(rawQuestion);
    if (options.length < 2) throw new Error("Structured operator questions require at least two options.");
    return {
      id: rawQuestions.length === 1 ? groupId : `${groupId}-q${index + 1}`,
      prompt,
      context: rawQuestion.context?.trim() || null,
      options,
      allowFreeform: rawQuestion.allowFreeform === true,
      createdAt: now,
      selectedOptionId: null,
      freeformAnswer: null,
      answeredAt: null
    };
  });
}

function buildOperatorQuestionText(items: ButlerOperatorQuestionItemView[]): string {
  if (items.length === 1) {
    const question = items[0]!;
    return [
      question.prompt,
      question.context,
      "Options:",
      ...question.options.map((option, index) => `${index + 1}. ${option.label}${option.description ? ` - ${option.description}` : ""}`)
    ].filter(Boolean).join("\n");
  }

  return [
    `Butler needs ${items.length} answers before continuing.`,
    ...items.flatMap((question, questionIndex) => [
      "",
      `${questionIndex + 1}. ${question.prompt}`,
      question.context,
      "Options:",
      ...question.options.map((option, optionIndex) => `${optionIndex + 1}. ${option.label}${option.description ? ` - ${option.description}` : ""}`)
    ])
  ].filter((line) => line !== null && line !== undefined).join("\n");
}

function makeOperatorQuestion(groupId: string, items: ButlerOperatorQuestionItemView[]): ButlerOperatorQuestionView {
  const first = items[0]!;
  return {
    id: groupId,
    prompt: items.length === 1 ? first.prompt : `Butler needs ${items.length} answers before continuing.`,
    context: items.length === 1 ? first.context : null,
    options: first.options,
    allowFreeform: first.allowFreeform,
    createdAt: first.createdAt,
    selectedOptionId: first.selectedOptionId ?? null,
    answeredAt: first.answeredAt ?? null,
    deliveryState: "idle",
    deliveryError: null,
    ...(items.length > 1 ? { questions: items } : {})
  };
}

function questionNeedsOperatorAction(question: ButlerOperatorQuestionView): boolean {
  return getOperatorQuestionItems(question).some((item) => !item.selectedOptionId && !compactText(item.freeformAnswer))
    || question.deliveryState === "pending"
    || question.deliveryState === "failed";
}

function hasOpenQuestionInCurrentTurn(messages: ButlerMessageView[]): boolean {
  let lastUserIndex = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index] && isOperatorUserRole(messages[index]!.role)) {
      lastUserIndex = index;
      break;
    }
  }
  return messages.slice(lastUserIndex + 1).some((message) => message.question && questionNeedsOperatorAction(message.question));
}

export async function postOperatorQuestionMessage(
  access: {
    messages: ButlerMessageView[];
    save(): Promise<void>;
    emitChange(): void;
  },
  input: OperatorQuestionInput
): Promise<ButlerMessageView & { question: ButlerOperatorQuestionView }> {
  return runOperatorQuestionMutation(access.messages, async () => {
    if (hasOpenQuestionInCurrentTurn(access.messages)) {
      throw new Error("An operator question is already open. Put up to three questions in one questions array and wait for the operator's answers.");
    }
    const now = Date.now();
    const groupId = `operator-question-${crypto.randomUUID()}`;
    const items = buildQuestionItems(input, now, groupId);
    const question = makeOperatorQuestion(groupId, items);
    const text = buildOperatorQuestionText(items);

    upsertOperatorMessage(access.messages, question.id, text, now, null, { question });
    try {
      await access.save();
    } catch (error) {
      const questionIndex = access.messages.findIndex((entry) => entry.id === question.id);
      if (questionIndex >= 0) access.messages.splice(questionIndex, 1);
      throw error;
    }
    access.emitChange();
    const message = access.messages.find((entry) => entry.id === question.id);
    if (!message?.question) throw new Error("Structured operator question was not persisted.");
    return message as ButlerMessageView & { question: ButlerOperatorQuestionView };
  });
}

export function getOperatorQuestionItems(question: ButlerOperatorQuestionView): ButlerOperatorQuestionItemView[] {
  return Array.isArray(question.questions) && question.questions.length > 0 ? question.questions : [question];
}

export function formatOperatorQuestionAnswerReply(question: ButlerOperatorQuestionView): string {
  return getOperatorQuestionItems(question)
    .map((item) => {
      const option = item.options.find((entry) => entry.id === item.selectedOptionId);
      if (option) {
        return [`For "${item.prompt}", I choose: ${option.label}.`, option.description ? `Context: ${option.description}` : null].filter(Boolean).join("\n");
      }
      return item.freeformAnswer ? `For "${item.prompt}", my answer is: ${item.freeformAnswer}` : null;
    })
    .filter((entry): entry is string => Boolean(entry))
    .join("\n\n");
}

export function recoverInterruptedOperatorQuestionDeliveries(messages: ButlerMessageView[]): boolean {
  const removeReplyIds = new Set<string>();
  let changed = false;
  for (const questionMessage of messages) {
    if (!questionMessage.question || questionMessage.question.deliveryState !== "pending") continue;
    const questionAt = questionMessage.at ?? questionMessage.question.createdAt;
    const replyText = formatOperatorQuestionAnswerReply(questionMessage.question);
    const replies = messages.filter((message) => isOperatorUserRole(message.role) && (message.at ?? 0) >= questionAt && message.text === replyText);
    const providerReplies = replies.filter((message) => message.providerBacked === true || message.id.startsWith("operator-user-"));
    const latestReplyAt = providerReplies.reduce((latest, message) => Math.max(latest, message.at ?? 0), 0);
    const delivered = latestReplyAt > 0 && messages.some((message) =>
      (message.providerBacked === true || message.id.startsWith("operator-session-"))
      && message.providerSucceeded !== false
      && message.role === "assistant"
      && message.id !== questionMessage.id
      && (message.at ?? 0) >= latestReplyAt
    );
    questionMessage.question.deliveryState = delivered ? "delivered" : "failed";
    questionMessage.question.deliveryError = delivered ? null : "Butler restarted before it could continue from this answer.";
    if (!delivered) replies.forEach((message) => removeReplyIds.add(message.id));
    changed = true;
  }
  if (!changed) return false;
  for (let index = messages.length - 1; index >= 0; index -= 1) if (removeReplyIds.has(messages[index]!.id)) messages.splice(index, 1);
  return true;
}

export function buildOperatorQuestionTasteMemoryEntries(question: ButlerOperatorQuestionView): OperatorQuestionTasteMemoryInput[] {
  const allQuestionText = [
    question.prompt,
    question.context,
    ...getOperatorQuestionItems(question).flatMap((item) => [
      item.prompt,
      item.context,
      ...item.options.flatMap((option) => [option.label, option.description])
    ])
  ]
    .map((entry) => compactText(entry))
    .filter((entry): entry is string => Boolean(entry))
    .join(" ");
  if (SKIP_OPERATOR_QUESTION_MEMORY_PATTERN.test(allQuestionText)) {
    return [];
  }

  return getOperatorQuestionItems(question)
    .map((item) => {
      const selected = item.options.find((option) => option.id === item.selectedOptionId);
      const answer = selected?.label ?? compactText(item.freeformAnswer);
      if (!answer) {
        return null;
      }
      const itemText = [item.prompt, item.context, answer, selected?.description].filter(Boolean).join(" ");
      if (!DURABLE_OPERATOR_TASTE_PATTERN.test(itemText)) {
        return null;
      }
      const prompt = compactText(item.prompt);
      const label = compactText(answer);
      if (!prompt || !label) {
        return null;
      }
      const details = [
        "Selected via Butler structured question.",
        compactText(item.context) ? `Question context: ${compactText(item.context)}` : null,
        compactText(selected?.description) ? `Selected option context: ${compactText(selected?.description)}` : null
      ]
        .filter((entry): entry is string => Boolean(entry))
        .join(" ");
      return {
        summary: `Operator preference: ${truncateMemoryText(prompt.replace(/[?.!]\s*$/, ""), 140)} -> ${truncateMemoryText(label, 80)}`,
        details: details || null,
        tags: tagsForOperatorTasteQuestion(itemText)
      };
    })
    .filter((entry): entry is OperatorQuestionTasteMemoryInput => Boolean(entry))
    .slice(0, 3);
}

export function recordOperatorQuestionTasteMemory(
  access: OperatorQuestionTasteMemoryAccess,
  message: ButlerMessageView & { question: ButlerOperatorQuestionView }
): number {
  const candidates = buildOperatorQuestionTasteMemoryEntries(message.question);
  if (candidates.length === 0) {
    return 0;
  }
  const existing = new Set(
    access
      .listButlerMemory()
      .map((entry) => `${entry.summary.trim().toLowerCase()}\n${(entry.details ?? "").trim().toLowerCase()}`)
  );
  let recorded = 0;
  for (const candidate of candidates) {
    const key = `${candidate.summary.trim().toLowerCase()}\n${(candidate.details ?? "").trim().toLowerCase()}`;
    if (existing.has(key)) {
      continue;
    }
    existing.add(key);
    access.recordButlerMemory({
      ...candidate,
      source: "butler_tool",
      sourceMessageId: message.id,
      memoryType: "operator_preference",
      scopeKind: "global",
      reviewState: "accepted",
      confidence: 1,
      provenance: {
        source: "operator_question",
        messageId: message.id
      }
    });
    recorded += 1;
  }
  return recorded;
}

export async function answerOperatorQuestionMessage(
  access: {
    messages: ButlerMessageView[];
    save(): Promise<void>;
    emitChange(): void;
  },
  input: OperatorQuestionAnswerInput
): Promise<{ complete: boolean; queued: boolean; message: ButlerMessageView & { question: ButlerOperatorQuestionView }; replyText: string | null }> {
  return runOperatorQuestionMutation(access.messages, () => answerOperatorQuestionMessageUnlocked(access, input));
}

async function answerOperatorQuestionMessageUnlocked(
  access: {
    messages: ButlerMessageView[];
    save(): Promise<void>;
    emitChange(): void;
  },
  input: OperatorQuestionAnswerInput
): Promise<{ complete: boolean; queued: boolean; message: ButlerMessageView & { question: ButlerOperatorQuestionView }; replyText: string | null }> {
  const message = access.messages.find((entry) => entry.id === input.messageId && entry.question);
  if (!message?.question) {
    throw new Error("Operator question was not found.");
  }

  const items = getOperatorQuestionItems(message.question);
  const isAnswered = (item: ButlerOperatorQuestionItemView) => Boolean(item.selectedOptionId || compactText(item.freeformAnswer));
  const wasComplete = items.every(isAnswered);
  const target = items.find((item) => item.id === input.questionId || (items.length === 1 && message.question?.id === input.questionId));
  if (!target) {
    throw new Error("Operator question item was not found.");
  }

  const optionId = compactText(input.optionId);
  const freeformText = input.freeformText?.trim() || null;
  if (Boolean(optionId) === Boolean(freeformText)) {
    throw new Error("Choose one option or provide one freeform answer.");
  }
  if (freeformText && !target.allowFreeform) {
    throw new Error("This operator question does not allow a freeform answer.");
  }
  if (freeformText && freeformText.length > MAX_FREEFORM_ANSWER_CHARS) {
    throw new Error(`Freeform answers must be ${MAX_FREEFORM_ANSWER_CHARS} characters or fewer.`);
  }

  const selected = optionId ? target.options.find((option) => option.id === optionId) : null;
  if (optionId && !selected) {
    throw new Error("Operator question option was not found.");
  }
  if (isAnswered(target)) {
    const matchesStoredAnswer = optionId
      ? target.selectedOptionId === optionId
      : compactText(target.freeformAnswer) === compactText(freeformText);
    if (!matchesStoredAnswer) {
      throw new Error("This operator question has already been answered.");
    }
    if (wasComplete && message.question.deliveryState === "failed") {
      const previousDeliveryError = message.question.deliveryError ?? null;
      message.question.deliveryState = "pending";
      message.question.deliveryError = null;
      try {
        await access.save();
      } catch (error) {
        message.question.deliveryState = "failed";
        message.question.deliveryError = previousDeliveryError;
        throw error;
      }
      access.emitChange();
      return {
        complete: true,
        queued: true,
        message: message as ButlerMessageView & { question: ButlerOperatorQuestionView },
        replyText: formatOperatorQuestionAnswerReply(message.question)
      };
    }
    return { complete: wasComplete, queued: false, message: message as ButlerMessageView & { question: ButlerOperatorQuestionView }, replyText: null };
  }

  const previousTarget = {
    selectedOptionId: target.selectedOptionId ?? null,
    freeformAnswer: target.freeformAnswer ?? null,
    answeredAt: target.answeredAt ?? null
  };
  const previousRoot = {
    selectedOptionId: message.question.selectedOptionId ?? null,
    freeformAnswer: message.question.freeformAnswer ?? null,
    answeredAt: message.question.answeredAt ?? null,
    deliveryState: message.question.deliveryState ?? "idle",
    deliveryError: message.question.deliveryError ?? null
  };

  target.selectedOptionId = selected?.id ?? null;
  target.freeformAnswer = freeformText;
  target.answeredAt = Date.now();
  if (!message.question.questions || message.question.questions.length === 0) {
    message.question.selectedOptionId = target.selectedOptionId;
    message.question.freeformAnswer = target.freeformAnswer;
    message.question.answeredAt = target.answeredAt;
  } else if (message.question.questions[0]?.id === target.id) {
    message.question.selectedOptionId = target.selectedOptionId;
    message.question.freeformAnswer = target.freeformAnswer;
    message.question.answeredAt = target.answeredAt;
  }

  const complete = items.every(isAnswered);
  const replyText = complete ? formatOperatorQuestionAnswerReply(message.question) : null;
  message.question.deliveryState = complete ? "pending" : "idle";
  message.question.deliveryError = null;
  try {
    await access.save();
  } catch (error) {
    target.selectedOptionId = previousTarget.selectedOptionId;
    target.freeformAnswer = previousTarget.freeformAnswer;
    target.answeredAt = previousTarget.answeredAt;
    message.question.selectedOptionId = previousRoot.selectedOptionId;
    message.question.freeformAnswer = previousRoot.freeformAnswer;
    message.question.answeredAt = previousRoot.answeredAt;
    message.question.deliveryState = previousRoot.deliveryState;
    message.question.deliveryError = previousRoot.deliveryError;
    throw error;
  }
  access.emitChange();

  return { complete, queued: Boolean(replyText), message: message as ButlerMessageView & { question: ButlerOperatorQuestionView }, replyText };
}

export async function settleOperatorQuestionDelivery(
  access: {
    messages: ButlerMessageView[];
    save(): Promise<void>;
    emitChange(): void;
  },
  input: { messageId: string; delivered: boolean; error?: string | null }
): Promise<boolean> {
  return runOperatorQuestionMutation(access.messages, async () => {
    const message = access.messages.find((entry) => entry.id === input.messageId && entry.question);
    if (!message?.question || message.question.deliveryState !== "pending") return false;
    message.question.deliveryState = input.delivered ? "delivered" : "failed";
    message.question.deliveryError = input.delivered ? null : compactText(input.error) ?? "Butler could not continue from this answer.";
    try {
      await access.save();
    } catch (error) {
      access.emitChange();
      throw error;
    }
    access.emitChange();
    return true;
  });
}
