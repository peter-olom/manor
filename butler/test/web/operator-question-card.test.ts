import assert from "node:assert/strict";
import test from "node:test";

import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import {
  hasUnansweredOperatorQuestion,
  OperatorQuestionCard,
  operatorQuestionNeedsAction,
  operatorQuestionItemIsAnswered,
  submitOperatorQuestionDrafts
} from "../../src/web/OperatorQuestionCard.js";
import { Composer } from "../../src/web/ButlerPane.js";
import type { PairDetail, PairOperatorQuestion } from "../../src/shared/pairing.js";

const question: PairOperatorQuestion = {
  id: "question-1",
  prompt: "Which direction should Butler take?",
  context: "The choice changes the implementation approach.",
  options: [
    { id: "simple", label: "Use the simpler path", description: "Lowest risk and easiest to maintain." },
    { id: "complete", label: "Build the full version", description: "More complete but slower." }
  ],
  allowFreeform: true,
  createdAt: 1,
  selectedOptionId: null,
  freeformAnswer: null,
  answeredAt: null
};

function render(value: PairOperatorQuestion): string {
  return renderToStaticMarkup(React.createElement(OperatorQuestionCard, {
    pairId: "pair-1",
    messageId: "message-1",
    question: value,
    onPairUpdate: () => undefined
  }));
}

test("operator question card renders an accessible recommended-first form", () => {
  const markup = render(question);

  assert.match(markup, /<fieldset/);
  assert.match(markup, /<legend>Which direction should Butler take/);
  assert.match(markup, /type="radio"/);
  assert.match(markup, /Use the simpler path/);
  assert.match(markup, /Recommended/);
  assert.match(markup, /Write my own answer/);
  assert.equal((markup.match(/>Submit answer</g) ?? []).length, 1);
  assert.doesNotMatch(markup, /<textarea/);
});

test("operator question card preserves an answered freeform response", () => {
  const answered = { ...question, freeformAnswer: "Use the staging server", answeredAt: 2 };
  const markup = render(answered);

  assert.equal(operatorQuestionItemIsAnswered(answered), true);
  assert.equal(hasUnansweredOperatorQuestion(answered), false);
  assert.match(markup, /<textarea[^>]*readOnly/);
  assert.match(markup, /Use the staging server/);
  assert.match(markup, /Answered/);
  assert.doesNotMatch(markup, /Submit answer/);
});

test("operator question card shows grouped progress", () => {
  const grouped: PairOperatorQuestion = {
    ...question,
    prompt: "Butler needs 2 answers before continuing.",
    questions: [
      { ...question, selectedOptionId: "simple", answeredAt: 2 },
      { ...question, id: "question-2", prompt: "Which risk should Butler optimize for?" }
    ]
  };
  const markup = render(grouped);

  assert.match(markup, /1 of 2 ready/);
  assert.match(markup, /1\. Which direction should Butler take/);
  assert.match(markup, /2\. Which risk should Butler optimize for/);
  assert.equal((markup.match(/>Submit answers</g) ?? []).length, 1);
  assert.doesNotMatch(markup, />Submit answer</);
});

test("grouped submission retries only the unanswered item after a partial failure", async () => {
  const grouped = [
    { ...question },
    { ...question, id: "question-2", prompt: "Which risk should Butler optimize for?" }
  ];
  const drafts = {
    "question-1": { kind: "option" as const, optionId: "simple" },
    "question-2": { kind: "option" as const, optionId: "complete" }
  };
  const submitted: string[] = [];
  const updates: PairDetail[] = [];
  const firstPair = { id: "pair-after-first" } as PairDetail;

  const firstAttempt = await submitOperatorQuestionDrafts({
    items: grouped,
    drafts,
    submitAnswer: async (item) => {
      submitted.push(item.id);
      if (item.id === "question-2") throw new Error("Second answer failed");
      return firstPair;
    },
    onPairUpdate: (pair) => updates.push(pair)
  });

  assert.deepEqual(submitted, ["question-1", "question-2"]);
  assert.deepEqual(updates, [firstPair]);
  assert.deepEqual(firstAttempt, { failedQuestionId: "question-2", error: "Second answer failed" });

  const completedItems = [
    { ...grouped[0], selectedOptionId: "simple", answeredAt: 2 },
    grouped[1]
  ];
  const completedPair = { id: "pair-complete" } as PairDetail;
  const retry = await submitOperatorQuestionDrafts({
    items: completedItems,
    drafts,
    submitAnswer: async (item) => {
      submitted.push(item.id);
      return completedPair;
    },
    onPairUpdate: (pair) => updates.push(pair)
  });

  assert.deepEqual(submitted, ["question-1", "question-2", "question-2"]);
  assert.deepEqual(updates, [firstPair, completedPair]);
  assert.deepEqual(retry, { failedQuestionId: null, error: null });
});

test("inactive historical questions cannot be submitted", () => {
  const markup = renderToStaticMarkup(React.createElement(OperatorQuestionCard, {
    pairId: "pair-1",
    messageId: "message-1",
    question,
    active: false,
    onPairUpdate: () => undefined
  }));

  assert.match(markup, /<fieldset[^>]*disabled/);
  assert.match(markup, /No longer active/);
  assert.doesNotMatch(markup, /Submit answer/);
});

test("failed answer delivery remains actionable and offers one retry", () => {
  const failed: PairOperatorQuestion = {
    ...question,
    selectedOptionId: "simple",
    answeredAt: 2,
    deliveryState: "failed",
    deliveryError: "Provider unavailable"
  };
  const markup = render(failed);

  assert.equal(operatorQuestionNeedsAction(failed), true);
  assert.match(markup, /Provider unavailable/);
  assert.match(markup, /Retry response/);
});

test("blocked Butler composer shows one instruction and no bypass controls", () => {
  const blockedReason = "Answer Butler’s open question above to continue.";
  const markup = renderToStaticMarkup(React.createElement(Composer, {
    value: "preserved draft",
    onChange: () => undefined,
    onSubmit: () => undefined,
    busy: false,
    sendDisabled: false,
    model: null,
    availableModels: [],
    thinkingLevel: "medium",
    availableThinkingLevels: [],
    onModelChange: () => undefined,
    onThinkingLevelChange: () => undefined,
    attachments: [],
    onRemoveAttachment: () => undefined,
    onPreviewImage: () => undefined,
    blockedReason
  }));

  assert.equal(markup.split(blockedReason).length - 1, 1);
  assert.match(markup, /role="status"/);
  assert.doesNotMatch(markup, /<textarea/);
  assert.doesNotMatch(markup, /<button/);
});
