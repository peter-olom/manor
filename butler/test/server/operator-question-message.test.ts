import assert from "node:assert/strict";
import test from "node:test";

import {
  answerOperatorQuestionMessage,
  buildOperatorQuestionTasteMemoryEntries,
  findDurableOperatorTasteNotes,
  postOperatorQuestionMessage
} from "../../src/server/butler-agent-operator-question.js";
import { normalizeOperatorMessages, removeTrivialOperatorQuestionConfirmations } from "../../src/server/butler-operator-messages.js";
import type { ButlerMessageView } from "../../src/server/types.js";

function access(messages: ButlerMessageView[]) {
  let saved = 0;
  let emitted = 0;
  return {
    messages,
    get saved() {
      return saved;
    },
    get emitted() {
      return emitted;
    },
    async save() {
      saved += 1;
    },
    emitChange() {
      emitted += 1;
    }
  };
}

test("operator question helper persists grouped questions and queues only after all answers", async () => {
  const messages: ButlerMessageView[] = [];
  const state = access(messages);
  const message = await postOperatorQuestionMessage(state, {
    prompt: "Fallback?",
    options: [
      { id: "yes", label: "Yes" },
      { id: "no", label: "No" }
    ],
    questions: [
      {
        prompt: "Which direction?",
        options: [
          { id: "simple", label: "Simple" },
          { id: "complete", label: "Complete" }
        ]
      },
      {
        prompt: "How much risk?",
        options: [
          { id: "low", label: "Low" },
          { id: "high", label: "High" }
        ]
      }
    ]
  });

  assert.equal(message.question.questions?.length, 2);

  const first = await answerOperatorQuestionMessage(state, {
    messageId: message.id,
    questionId: message.question.questions![0]!.id,
    optionId: "simple"
  });
  assert.equal(first.complete, false);
  assert.equal(first.queued, false);
  assert.equal(first.replyText, null);
  assert.equal(messages[0]!.question?.questions?.[0]?.selectedOptionId, "simple");

  const second = await answerOperatorQuestionMessage(state, {
    messageId: message.id,
    questionId: message.question.questions![1]!.id,
    optionId: "low"
  });
  assert.equal(second.complete, true);
  assert.equal(second.queued, true);
  assert.match(second.replyText ?? "", /Which direction/);
  assert.match(second.replyText ?? "", /How much risk/);
});

test("operator question answers produce durable taste memory candidates", async () => {
  const messages: ButlerMessageView[] = [];
  const state = access(messages);
  const message = await postOperatorQuestionMessage(state, {
    questions: [
      {
        prompt: "Which autonomy behavior should Butler prefer?",
        context: "This will guide future delegation.",
        options: [
          { id: "few", label: "Ask fewer better questions", description: "Infer from memory and inspect state first." },
          { id: "many", label: "Ask many small questions" }
        ]
      },
      {
        prompt: "Which project should Butler inspect first?",
        options: [
          { id: "current", label: "Current project" },
          { id: "all", label: "All projects" }
        ]
      }
    ]
  });

  await answerOperatorQuestionMessage(state, {
    messageId: message.id,
    questionId: message.question.questions![0]!.id,
    optionId: "few"
  });
  await answerOperatorQuestionMessage(state, {
    messageId: message.id,
    questionId: message.question.questions![1]!.id,
    optionId: "current"
  });

  const entries = buildOperatorQuestionTasteMemoryEntries(message.question);
  assert.equal(entries.length, 1);
  assert.match(entries[0]!.summary, /Operator preference: Which autonomy behavior should Butler prefer -> Ask fewer better questions/);
  assert.deepEqual(entries[0]!.tags, ["operator-taste", "operator-question", "autonomy"]);
});

test("durable taste retrieval ignores legacy task facts and artifact notes", () => {
  const notes = findDurableOperatorTasteNotes([
    {
      id: "legacy-chatbox",
      summary: "Victor's last assignment was ChatBox, not Asiri.",
      details: "Correction from a prior task; asks and questions were discussed.",
      source: "butler_tool",
      sourceMessageId: null,
      tags: ["operator-taste", "question"],
      createdAt: 1,
      memoryType: "legacy_global",
      scopeKind: "global",
      reviewState: "legacy",
      confidence: null,
      expiresAt: null,
      supersedesId: null,
      contentVersion: 1
    },
    {
      id: "legacy-artifact",
      summary: "PDF artifact was regenerated with ASCII-safe bullets.",
      details: "One-time glyph rendering repair note.",
      source: "manual_chat_save",
      sourceMessageId: null,
      tags: ["design", "quality"],
      createdAt: 2,
      memoryType: "legacy_global",
      scopeKind: "global",
      reviewState: "legacy",
      confidence: null,
      expiresAt: null,
      supersedesId: null,
      contentVersion: 1
    },
    {
      id: "accepted-preference",
      summary: "Operator preference: Ask fewer better questions",
      details: "Infer from memory and inspect state first.",
      source: "butler_tool",
      sourceMessageId: "operator-question-1",
      tags: ["operator-taste", "operator-question", "autonomy"],
      createdAt: 3,
      memoryType: "operator_preference",
      scopeKind: "global",
      reviewState: "accepted",
      confidence: 1,
      expiresAt: null,
      supersedesId: null,
      contentVersion: 1
    }
  ]);

  assert.deepEqual(notes, ["Operator preference: Ask fewer better questions - Infer from memory and inspect state first."]);
});

test("operator question taste memory skips explicit smoke tests", async () => {
  const messages: ButlerMessageView[] = [];
  const state = access(messages);
  const message = await postOperatorQuestionMessage(state, {
    prompt: "Smoke test only: which autonomy behavior should Butler prefer?",
    options: [
      { id: "few", label: "Ask fewer better questions" },
      { id: "many", label: "Ask many small questions" }
    ]
  });

  await answerOperatorQuestionMessage(state, {
    messageId: message.id,
    questionId: message.question.id,
    optionId: "few"
  });

  assert.deepEqual(buildOperatorQuestionTasteMemoryEntries(message.question), []);
});

test("operator question normalization removes trivial provider confirmations", () => {
  const messages: ButlerMessageView[] = [
    {
      id: "operator-question-1",
      role: "assistant",
      text: "Which direction?\nOptions:\n1. Simple\n2. Complete",
      at: 1,
      taskDurationMs: null,
      kind: "message",
      question: {
        id: "operator-question-1",
        prompt: "Which direction?",
        context: null,
        options: [
          { id: "simple", label: "Simple", description: null },
          { id: "complete", label: "Complete", description: null }
        ],
        allowFreeform: false,
        createdAt: 1,
        selectedOptionId: null,
        answeredAt: null
      }
    },
    {
      id: "operator-session-2",
      role: "assistant",
      text: "Asked.",
      at: 2,
      taskDurationMs: null,
      kind: "message"
    }
  ];

  assert.equal(normalizeOperatorMessages(messages), true);
  assert.deepEqual(messages.map((message) => message.id), ["operator-question-1"]);
});

test("operator question visible cleanup removes trivial session confirmations", () => {
  const messages: ButlerMessageView[] = [
    {
      id: "operator-question-1",
      role: "assistant",
      text: "Which direction?\nOptions:\n1. Simple\n2. Complete",
      at: 1,
      taskDurationMs: null,
      kind: "message",
      question: {
        id: "operator-question-1",
        prompt: "Which direction?",
        context: null,
        options: [
          { id: "simple", label: "Simple", description: null },
          { id: "complete", label: "Complete", description: null }
        ],
        allowFreeform: false,
        createdAt: 1,
        selectedOptionId: null,
        answeredAt: null
      }
    },
    {
      id: "message-2",
      role: "assistant",
      text: "Asked.",
      at: 2,
      taskDurationMs: null,
      kind: "message"
    }
  ];

  assert.equal(removeTrivialOperatorQuestionConfirmations(messages, { providerBackedOnly: false }), true);
  assert.deepEqual(messages.map((message) => message.id), ["operator-question-1"]);
});
