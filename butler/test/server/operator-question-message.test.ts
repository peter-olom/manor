import assert from "node:assert/strict";
import test from "node:test";

import {
  answerOperatorQuestionMessage,
  buildOperatorQuestionTasteMemoryEntries,
  findDurableOperatorTasteNotes,
  postOperatorQuestionMessage,
  recoverInterruptedOperatorQuestionDeliveries,
  settleOperatorQuestionDelivery
} from "../../src/server/butler-agent-operator-question.js";
import { normalizeOperatorMessages, normalizeOperatorQuestion, removeTrivialOperatorQuestionConfirmations } from "../../src/server/butler-operator-messages.js";
import { mapButlerMessage } from "../../src/server/pair-session-manager.js";
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

test("concurrent grouped answers queue only the answer that completes the group", async () => {
  const messages: ButlerMessageView[] = [];
  const message = await postOperatorQuestionMessage(access(messages), {
    questions: [
      {
        prompt: "First?",
        options: [{ id: "yes", label: "Yes" }, { id: "no", label: "No" }]
      },
      {
        prompt: "Second?",
        options: [{ id: "yes", label: "Yes" }, { id: "no", label: "No" }]
      }
    ]
  });
  let saveActive = false;
  let savesOverlapped = false;
  const concurrentState = {
    messages,
    async save() {
      if (saveActive) savesOverlapped = true;
      saveActive = true;
      await new Promise<void>((resolve) => setImmediate(resolve));
      saveActive = false;
    },
    emitChange() {}
  };

  const firstPromise = answerOperatorQuestionMessage(concurrentState, {
    messageId: message.id,
    questionId: message.question.questions![0]!.id,
    optionId: "yes"
  });
  const secondPromise = answerOperatorQuestionMessage(concurrentState, {
    messageId: message.id,
    questionId: message.question.questions![1]!.id,
    optionId: "yes"
  });
  const [first, second] = await Promise.all([firstPromise, secondPromise]);
  assert.equal(savesOverlapped, false);
  assert.equal(first.complete, false);
  assert.equal(first.replyText, null);
  assert.equal(second.complete, true);
  assert.match(second.replyText ?? "", /First/);
  assert.match(second.replyText ?? "", /Second/);
});

test("a failed concurrent save cannot erase a later acknowledged answer", async () => {
  const messages: ButlerMessageView[] = [];
  const message = await postOperatorQuestionMessage(access(messages), {
    questions: [
      { prompt: "First?", options: [{ id: "yes", label: "Yes" }, { id: "no", label: "No" }] },
      { prompt: "Second?", options: [{ id: "yes", label: "Yes" }, { id: "no", label: "No" }] }
    ]
  });
  let saveCount = 0;
  const state = {
    messages,
    async save() {
      saveCount += 1;
      if (saveCount === 1) throw new Error("first save failed");
    },
    emitChange() {}
  };
  const first = answerOperatorQuestionMessage(state, {
    messageId: message.id,
    questionId: message.question.questions![0]!.id,
    optionId: "yes"
  });
  const second = answerOperatorQuestionMessage(state, {
    messageId: message.id,
    questionId: message.question.questions![1]!.id,
    optionId: "yes"
  });

  await assert.rejects(first, /first save failed/);
  const result = await second;
  assert.equal(result.complete, false);
  assert.equal(message.question.questions![0]!.selectedOptionId, null);
  assert.equal(message.question.questions![1]!.selectedOptionId, "yes");
});

test("one model turn cannot post multiple open operator question cards", async () => {
  const messages: ButlerMessageView[] = [];
  const state = access(messages);
  await postOperatorQuestionMessage(state, {
    questions: [{ prompt: "First?", options: [{ id: "yes", label: "Yes" }, { id: "no", label: "No" }] }]
  });
  await assert.rejects(
    postOperatorQuestionMessage(state, {
      questions: [{ prompt: "Second?", options: [{ id: "yes", label: "Yes" }, { id: "no", label: "No" }] }]
    }),
    /already open.*one questions array/i
  );
  assert.equal(messages.filter((entry) => entry.question).length, 1);
});

test("failed question persistence removes only the new question", async () => {
  const messages: ButlerMessageView[] = [{ id: "existing", role: "assistant", text: "Existing", at: 1, taskDurationMs: null, kind: "message" }];
  await assert.rejects(
    postOperatorQuestionMessage({
      messages,
      async save() {
        messages.push({ id: "concurrent", role: "assistant", text: "Concurrent", at: 2, taskDurationMs: null, kind: "message" });
        throw new Error("save failed");
      },
      emitChange() {}
    }, {
      questions: [{ prompt: "Continue?", options: [{ id: "yes", label: "Yes" }, { id: "no", label: "No" }] }]
    }),
    /save failed/
  );
  assert.deepEqual(messages.map((entry) => entry.id), ["existing", "concurrent"]);
});

test("failed question delivery can be retried and settled exactly once", async () => {
  const messages: ButlerMessageView[] = [];
  const state = access(messages);
  const message = await postOperatorQuestionMessage(state, {
    questions: [{ prompt: "Continue?", options: [{ id: "yes", label: "Yes" }, { id: "no", label: "No" }] }]
  });
  await answerOperatorQuestionMessage(state, {
    messageId: message.id,
    questionId: message.question.id,
    optionId: "yes"
  });
  assert.equal(message.question.deliveryState, "pending");
  assert.equal(await settleOperatorQuestionDelivery(state, { messageId: message.id, delivered: false, error: "provider unavailable" }), true);
  assert.equal(message.question.deliveryState, "failed");

  const retry = await answerOperatorQuestionMessage(state, {
    messageId: message.id,
    questionId: message.question.id,
    optionId: "yes"
  });
  assert.equal(retry.queued, true);
  assert.equal(message.question.deliveryState, "pending");
  assert.equal(await settleOperatorQuestionDelivery(state, { messageId: message.id, delivered: true }), true);
  assert.equal(await settleOperatorQuestionDelivery(state, { messageId: message.id, delivered: true }), false);
  assert.equal(message.question.deliveryState, "delivered");
});

test("delivery settlement remains actionable when persistence fails", async () => {
  const messages: ButlerMessageView[] = [];
  const state = access(messages);
  const message = await postOperatorQuestionMessage(state, {
    questions: [{ prompt: "Continue?", options: [{ id: "yes", label: "Yes" }, { id: "no", label: "No" }] }]
  });
  await answerOperatorQuestionMessage(state, { messageId: message.id, questionId: message.question.id, optionId: "yes" });
  await assert.rejects(
    settleOperatorQuestionDelivery({ messages, async save() { throw new Error("disk full"); }, emitChange() {} }, {
      messageId: message.id,
      delivered: false,
      error: "provider failed"
    }),
    /disk full/
  );
  assert.equal(message.question.deliveryState, "failed");
  assert.equal(message.question.deliveryError, "provider failed");
});

test("restart recovery removes the interrupted synthetic answer so retry stays active", async () => {
  const messages: ButlerMessageView[] = [];
  const state = access(messages);
  const message = await postOperatorQuestionMessage(state, {
    questions: [{ prompt: "Continue?", options: [{ id: "yes", label: "Yes" }, { id: "no", label: "No" }] }]
  });
  const answer = await answerOperatorQuestionMessage(state, {
    messageId: message.id,
    questionId: message.question.id,
    optionId: "yes"
  });
  messages.push({
    id: "pending-operator-2-0",
    role: "user",
    text: answer.replyText!,
    at: (message.at ?? 1) + 1,
    taskDurationMs: null,
    kind: "message"
  });

  assert.equal(recoverInterruptedOperatorQuestionDeliveries(messages), true);
  assert.equal(message.question.deliveryState, "failed");
  assert.equal(messages.some((entry) => entry.id === "pending-operator-2-0"), false);
  assert.equal(messages.at(-1)?.id, message.id);
});

test("restart recovery removes a provider user echo when delivery never completed", async () => {
  const messages: ButlerMessageView[] = [];
  const state = access(messages);
  const message = await postOperatorQuestionMessage(state, {
    questions: [{ prompt: "Continue?", options: [{ id: "yes", label: "Yes" }, { id: "no", label: "No" }] }]
  });
  const answer = await answerOperatorQuestionMessage(state, { messageId: message.id, questionId: message.question.id, optionId: "yes" });
  messages.push({ id: "operator-user-echo", role: "user", text: answer.replyText!, at: (message.at ?? 1) + 1, taskDurationMs: null, kind: "message", providerBacked: true });

  assert.equal(recoverInterruptedOperatorQuestionDeliveries(messages), true);
  assert.equal(message.question.deliveryState, "failed");
  assert.equal(messages.some((entry) => entry.id === "operator-user-echo"), false);
});

test("restart recovery marks delivery complete when provider history contains a reply", async () => {
  const messages: ButlerMessageView[] = [];
  const state = access(messages);
  const message = await postOperatorQuestionMessage(state, {
    questions: [{ prompt: "Continue?", options: [{ id: "yes", label: "Yes" }, { id: "no", label: "No" }] }]
  });
  const answer = await answerOperatorQuestionMessage(state, { messageId: message.id, questionId: message.question.id, optionId: "yes" });
  messages.push(
    { id: "operator-user-echo", role: "user", text: answer.replyText!, at: (message.at ?? 1) + 1, taskDurationMs: null, kind: "message", providerBacked: true },
    { id: "operator-assistant-reply", role: "assistant", text: "Continuing now.", at: (message.at ?? 1) + 2, taskDurationMs: null, kind: "message", providerBacked: true }
  );

  assert.equal(recoverInterruptedOperatorQuestionDeliveries(messages), true);
  assert.equal(message.question.deliveryState, "delivered");
  assert.equal(messages.some((entry) => entry.id === "operator-user-echo"), true);
});

test("restart recovery does not confuse the card-creation reply with answer delivery", async () => {
  const messages: ButlerMessageView[] = [];
  const state = access(messages);
  const message = await postOperatorQuestionMessage(state, {
    questions: [{ prompt: "Continue?", options: [{ id: "yes", label: "Yes" }, { id: "no", label: "No" }] }]
  });
  const answer = await answerOperatorQuestionMessage(state, { messageId: message.id, questionId: message.question.id, optionId: "yes" });
  messages.push(
    { id: "pending-operator-answer", role: "user", text: answer.replyText!, at: (message.at ?? 1) + 1, taskDurationMs: null, kind: "message" },
    { id: "operator-session-card-turn", role: "assistant", text: "Card posted.", at: (message.at ?? 1) + 2, taskDurationMs: null, kind: "message", providerBacked: true }
  );

  assert.equal(recoverInterruptedOperatorQuestionDeliveries(messages), true);
  assert.equal(message.question.deliveryState, "failed");
  assert.equal(messages.some((entry) => entry.id === "pending-operator-answer"), false);
});

test("restart recovery does not treat a provider failure row as delivered", async () => {
  const messages: ButlerMessageView[] = [];
  const state = access(messages);
  const message = await postOperatorQuestionMessage(state, {
    questions: [{ prompt: "Continue?", options: [{ id: "yes", label: "Yes" }, { id: "no", label: "No" }] }]
  });
  const answer = await answerOperatorQuestionMessage(state, { messageId: message.id, questionId: message.question.id, optionId: "yes" });
  messages.push(
    { id: "operator-user-answer", role: "user", text: answer.replyText!, at: (message.at ?? 1) + 1, taskDurationMs: null, kind: "message", providerBacked: true },
    { id: "operator-session-error", role: "assistant", text: "Provider failed", at: (message.at ?? 1) + 2, taskDurationMs: null, kind: "message", providerBacked: true, providerSucceeded: false }
  );

  assert.equal(recoverInterruptedOperatorQuestionDeliveries(messages), true);
  assert.equal(message.question.deliveryState, "failed");
  assert.equal(messages.some((entry) => entry.id === "operator-user-answer"), false);
});

test("restart recovery does not treat an attachment user turn as an assistant reply", async () => {
  const messages: ButlerMessageView[] = [];
  const state = access(messages);
  const message = await postOperatorQuestionMessage(state, {
    questions: [{ prompt: "Continue?", options: [{ id: "yes", label: "Yes" }, { id: "no", label: "No" }] }]
  });
  const answer = await answerOperatorQuestionMessage(state, { messageId: message.id, questionId: message.question.id, optionId: "yes" });
  messages.push(
    { id: "operator-user-answer", role: "user", text: answer.replyText!, at: (message.at ?? 1) + 1, taskDurationMs: null, kind: "message", providerBacked: true },
    { id: "operator-user-attachment", role: "user-with-attachments", text: "Attached 1 image", at: (message.at ?? 1) + 2, taskDurationMs: null, kind: "message", providerBacked: true }
  );

  assert.equal(recoverInterruptedOperatorQuestionDeliveries(messages), true);
  assert.equal(message.question.deliveryState, "failed");
});

test("attachment user turns start a new question-card boundary", async () => {
  const messages: ButlerMessageView[] = [];
  const state = access(messages);
  await postOperatorQuestionMessage(state, {
    questions: [{ prompt: "First?", options: [{ id: "yes", label: "Yes" }, { id: "no", label: "No" }] }]
  });
  messages.push({ id: "attachment", role: "user-with-attachments", text: "Attached 1 image", at: Date.now(), taskDurationMs: null, kind: "message" });
  const next = await postOperatorQuestionMessage(state, {
    questions: [{ prompt: "Second?", options: [{ id: "yes", label: "Yes" }, { id: "no", label: "No" }] }]
  });
  assert.equal(next.question.prompt, "Second?");
});

test("operator question accepts and reloads an allowed freeform answer", async () => {
  const messages: ButlerMessageView[] = [];
  const state = access(messages);
  const message = await postOperatorQuestionMessage(state, {
    questions: [{
      prompt: "Where should this run?",
      options: [
        { id: "cloud", label: "Cloud" },
        { id: "local", label: "Local" }
      ],
      allowFreeform: true
    }]
  });

  const answer = await answerOperatorQuestionMessage(state, {
    messageId: message.id,
    questionId: message.question.id,
    freeformText: "A private staging server\nwith restricted access"
  });

  assert.equal(answer.complete, true);
  assert.equal(answer.queued, true);
  assert.match(answer.replyText ?? "", /A private staging server\nwith restricted access/);
  assert.equal(message.question.selectedOptionId, null);
  assert.equal(message.question.freeformAnswer, "A private staging server\nwith restricted access");
  assert.equal(normalizeOperatorQuestion(JSON.parse(JSON.stringify(message.question)))?.freeformAnswer, "A private staging server\nwith restricted access");
});

test("operator question rolls answer state back when persistence fails", async () => {
  const messages: ButlerMessageView[] = [];
  const message = await postOperatorQuestionMessage(access(messages), {
    questions: [{
      prompt: "Which direction?",
      options: [{ id: "simple", label: "Simple" }, { id: "complete", label: "Complete" }]
    }]
  });

  await assert.rejects(
    answerOperatorQuestionMessage({
      messages,
      async save() { throw new Error("disk unavailable"); },
      emitChange() {}
    }, {
      messageId: message.id,
      questionId: message.question.id,
      optionId: "simple"
    }),
    /disk unavailable/
  );
  assert.equal(message.question.selectedOptionId, null);
  assert.equal(message.question.answeredAt, null);

  const retried = await answerOperatorQuestionMessage(access(messages), {
    messageId: message.id,
    questionId: message.question.id,
    optionId: "simple"
  });
  assert.equal(retried.complete, true);
  assert.equal(retried.queued, true);
});

test("operator question rejects unavailable or ambiguous freeform answers", async () => {
  const messages: ButlerMessageView[] = [];
  const state = access(messages);
  const message = await postOperatorQuestionMessage(state, {
    questions: [{
      prompt: "Which direction?",
      options: [
        { id: "simple", label: "Simple" },
        { id: "complete", label: "Complete" }
      ]
    }]
  });

  await assert.rejects(
    answerOperatorQuestionMessage(state, {
      messageId: message.id,
      questionId: message.question.id,
      freeformText: "Something else"
    }),
    /does not allow/
  );
  await assert.rejects(
    answerOperatorQuestionMessage(state, {
      messageId: message.id,
      questionId: message.question.id,
      optionId: "simple",
      freeformText: "Something else"
    }),
    /Choose one option/
  );
});

test("paired Butler messages preserve structured question state", async () => {
  const messages: ButlerMessageView[] = [];
  const message = await postOperatorQuestionMessage(access(messages), {
    questions: [{
      prompt: "Which direction?",
      options: [
        { id: "simple", label: "Simple" },
        { id: "complete", label: "Complete" }
      ],
      allowFreeform: true
    }]
  });

  const paired = mapButlerMessage(message);
  assert.equal(paired.question?.prompt, "Which direction?");
  assert.equal(paired.question?.allowFreeform, true);
  assert.deepEqual(paired.question?.options.map((option) => option.id), ["simple", "complete"]);
});

test("paired user messages preserve attachment presentation", () => {
  const attachment = { id: "file-1", kind: "file" as const, name: "report.pdf", mimeType: "application/pdf", sizeBytes: 30, url: "/api/files/file-1" };
  const paired = mapButlerMessage({ id: "user-1", role: "user", text: "internal", displayText: "Review this", at: 100, taskDurationMs: null, kind: "message", attachments: [attachment] });

  assert.equal(paired.text, "Review this");
  assert.deepEqual(paired.attachments, [attachment]);
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

test("durable taste retrieval bounds oversized preference context", () => {
  const notes = findDurableOperatorTasteNotes([{
    id: "oversized-preference",
    summary: "Operator preference: Keep worker context focused",
    details: `Selected option context: ${"x".repeat(20_000)}`,
    source: "butler_tool",
    sourceMessageId: "operator-question-oversized",
    tags: ["operator-taste", "operator-question"],
    createdAt: 1,
    memoryType: "operator_preference",
    scopeKind: "global",
    reviewState: "accepted",
    confidence: 1,
    expiresAt: null,
    supersedesId: null,
    contentVersion: 1
  }]);

  assert.equal(notes.length, 1);
  assert.equal(notes[0]?.length, 1_600);
  assert.match(notes[0] ?? "", /\.\.\.$/);
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

  messages.push({
    id: "operator-session-4",
    role: "assistant",
    text: "Card posted — awaiting operator response.",
    at: 4,
    taskDurationMs: null,
    kind: "message"
  });
  assert.equal(removeTrivialOperatorQuestionConfirmations(messages, { providerBackedOnly: false }), true);
  assert.deepEqual(messages.map((message) => message.id), ["operator-question-1"]);

  messages.push({
    id: "operator-session-4",
    role: "assistant",
    text: "Operator question card posted with two entries, awaiting your selections.",
    at: 4,
    taskDurationMs: null,
    kind: "message"
  });
  assert.equal(removeTrivialOperatorQuestionConfirmations(messages, { providerBackedOnly: false }), true);
  assert.deepEqual(messages.map((message) => message.id), ["operator-question-1"]);
});

test("operator question cleanup removes provider success narration", () => {
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
      text: "Done — I posted a structured question card.",
      at: 2,
      taskDurationMs: null,
      kind: "message"
    }
  ];

  assert.equal(removeTrivialOperatorQuestionConfirmations(messages, { providerBackedOnly: false }), true);
  assert.deepEqual(messages.map((message) => message.id), ["operator-question-1"]);

  messages.push({
    id: "operator-session-3",
    role: "assistant",
    text: "Structured question card posted. Waiting for your answer.",
    at: 3,
    taskDurationMs: null,
    kind: "message"
  });
  assert.equal(removeTrivialOperatorQuestionConfirmations(messages, { providerBackedOnly: false }), true);
  assert.deepEqual(messages.map((message) => message.id), ["operator-question-1"]);
});
