import crypto from "node:crypto";

import { upsertOperatorMessage } from "./butler-operator-messages.js";
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
  optionId: string;
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
  }): ButlerMemoryEntryView;
};

const DURABLE_OPERATOR_TASTE_PATTERN =
  /\b(taste|prefer|preference|style|voice|tone|design|polish|quality|like|dislike|vision|autonomy|handholding|ask|question|decision|planner|critic|loop)\b/i;
const SKIP_OPERATOR_QUESTION_MEMORY_PATTERN =
  /\b(smoke test|test only|verification only|temporary test|do not remember|don't remember)\b/i;

function compactText(value: string | null | undefined): string | null {
  const normalized = value?.replace(/\s+/g, " ").trim() ?? "";
  return normalized || null;
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
    .filter((entry) => DURABLE_OPERATOR_TASTE_PATTERN.test(`${entry.summary} ${entry.details ?? ""} ${(entry.tags ?? []).join(" ")}`))
    .slice(-6)
    .map((entry) => `${entry.summary}${entry.details ? ` - ${entry.details}` : ""}`);
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
    ...(items.length > 1 ? { questions: items } : {})
  };
}

export async function postOperatorQuestionMessage(
  access: {
    messages: ButlerMessageView[];
    save(): Promise<void>;
    emitChange(): void;
  },
  input: OperatorQuestionInput
): Promise<ButlerMessageView & { question: ButlerOperatorQuestionView }> {
  const now = Date.now();
  const groupId = `operator-question-${crypto.randomUUID()}`;
  const items = buildQuestionItems(input, now, groupId);
  const question = makeOperatorQuestion(groupId, items);
  const text = buildOperatorQuestionText(items);

  upsertOperatorMessage(access.messages, question.id, text, now, null, { question });
  await access.save();
  access.emitChange();
  const message = access.messages.find((entry) => entry.id === question.id);
  if (!message?.question) throw new Error("Structured operator question was not persisted.");
  return message as ButlerMessageView & { question: ButlerOperatorQuestionView };
}

export function getOperatorQuestionItems(question: ButlerOperatorQuestionView): ButlerOperatorQuestionItemView[] {
  return Array.isArray(question.questions) && question.questions.length > 0 ? question.questions : [question];
}

export function formatOperatorQuestionAnswerReply(question: ButlerOperatorQuestionView): string {
  return getOperatorQuestionItems(question)
    .map((item) => {
      const option = item.options.find((entry) => entry.id === item.selectedOptionId);
      return option
        ? [`For "${item.prompt}", I choose: ${option.label}.`, option.description ? `Context: ${option.description}` : null].filter(Boolean).join("\n")
        : null;
    })
    .filter((entry): entry is string => Boolean(entry))
    .join("\n\n");
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
      if (!selected) {
        return null;
      }
      const itemText = [item.prompt, item.context, selected.label, selected.description].filter(Boolean).join(" ");
      if (!DURABLE_OPERATOR_TASTE_PATTERN.test(itemText)) {
        return null;
      }
      const prompt = compactText(item.prompt);
      const label = compactText(selected.label);
      if (!prompt || !label) {
        return null;
      }
      const details = [
        "Selected via Butler structured question.",
        compactText(item.context) ? `Question context: ${compactText(item.context)}` : null,
        compactText(selected.description) ? `Selected option context: ${compactText(selected.description)}` : null
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
      sourceMessageId: message.id
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
  const message = access.messages.find((entry) => entry.id === input.messageId && entry.question);
  if (!message?.question) {
    throw new Error("Operator question was not found.");
  }

  const items = getOperatorQuestionItems(message.question);
  const wasComplete = items.every((item) => Boolean(item.selectedOptionId));
  if (wasComplete) {
    return { complete: true, queued: false, message: message as ButlerMessageView & { question: ButlerOperatorQuestionView }, replyText: null };
  }

  const target = items.find((item) => item.id === input.questionId || (items.length === 1 && message.question?.id === input.questionId));
  if (!target) {
    throw new Error("Operator question item was not found.");
  }

  const selected = target.options.find((option) => option.id === input.optionId);
  if (!selected) {
    throw new Error("Operator question option was not found.");
  }

  target.selectedOptionId = selected.id;
  target.answeredAt = Date.now();
  if (!message.question.questions || message.question.questions.length === 0) {
    message.question.selectedOptionId = target.selectedOptionId;
    message.question.answeredAt = target.answeredAt;
  } else if (message.question.questions[0]?.id === target.id) {
    message.question.selectedOptionId = target.selectedOptionId;
    message.question.answeredAt = target.answeredAt;
  }

  await access.save();
  access.emitChange();

  const complete = items.every((item) => Boolean(item.selectedOptionId));
  const replyText = complete ? formatOperatorQuestionAnswerReply(message.question) : null;
  return { complete, queued: Boolean(replyText), message: message as ButlerMessageView & { question: ButlerOperatorQuestionView }, replyText };
}
