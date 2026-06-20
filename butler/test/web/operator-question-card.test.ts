import assert from "node:assert/strict";
import test from "node:test";

import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { formatQuestionOptionReply, OperatorQuestionCard } from "../../src/web/OperatorQuestionCard.js";
import type { ButlerOperatorQuestion } from "../../src/web/types.js";

const question: ButlerOperatorQuestion = {
  id: "question-1",
  prompt: "Which direction should Butler take?",
  context: "The choice changes the implementation approach.",
  options: [
    { id: "recommended", label: "Use the simpler path", description: "Lowest risk and easiest to maintain." },
    { id: "ambitious", label: "Build the full version", description: "More complete but slower." }
  ],
  allowFreeform: true,
  createdAt: 1
};

test("operator question card renders selectable options", () => {
  const markup = renderToStaticMarkup(
    React.createElement(OperatorQuestionCard, {
      question,
      onSelect: () => undefined
    })
  );

  assert.match(markup, /Which direction should Butler take/);
  assert.match(markup, /Use the simpler path/);
  assert.match(markup, /Build the full version/);
});

test("operator question option formats a normal Butler reply", () => {
  assert.equal(
    formatQuestionOptionReply(question, "recommended"),
    'For "Which direction should Butler take?", I choose: Use the simpler path.\nContext: Lowest risk and easiest to maintain.'
  );
});

test("operator question card visually marks selected answers", () => {
  const markup = renderToStaticMarkup(
    React.createElement(OperatorQuestionCard, {
      question: { ...question, selectedOptionId: "recommended", answeredAt: 2 },
      onSelect: () => undefined
    })
  );

  assert.match(markup, /is-selected/);
  assert.match(markup, /aria-pressed="true"/);
  assert.match(markup, /Selected/);
});

test("operator question card renders grouped questions with progress", () => {
  const markup = renderToStaticMarkup(
    React.createElement(OperatorQuestionCard, {
      question: {
        ...question,
        prompt: "Butler needs 2 answers before continuing.",
        questions: [
          { ...question, id: "question-1", selectedOptionId: "recommended", answeredAt: 2 },
          { ...question, id: "question-2", prompt: "Which risk should Butler optimize for?", selectedOptionId: null, answeredAt: null }
        ]
      },
      onSelect: () => undefined
    })
  );

  assert.match(markup, /1\/2 answered/);
  assert.match(markup, /1. Which direction should Butler take/);
  assert.match(markup, /2. Which risk should Butler optimize for/);
});
