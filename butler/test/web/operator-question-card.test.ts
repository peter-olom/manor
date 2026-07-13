import assert from "node:assert/strict";
import test from "node:test";

import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import {
  hasUnansweredOperatorQuestion,
  OperatorQuestionCard,
  operatorQuestionNeedsAction,
  operatorQuestionItemIsAnswered,
  SKILL_PROPOSAL_CONTENT_MARKER,
  splitSkillProposalContent,
  submitOperatorQuestionDrafts
} from "../../src/web/OperatorQuestionCard.js";
import { Composer, reduceComposerFileDrag } from "../../src/web/ButlerPane.js";
import { isVisionImageFile } from "../../src/web/api.js";
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
  assert.doesNotMatch(markup, /Review approved content/);
});

test("skill proposals keep the decision summary visible and full content collapsed", () => {
  const proposal = {
    ...question,
    context: `Purpose: Review pull requests\nTarget: Butler Pi\n${SKILL_PROPOSAL_CONTENT_MARKER}\n---\nname: review-pr\n---\n\nCheck the full diff. <safe>`
  };
  const markup = render(proposal);

  assert.match(markup, /Purpose: Review pull requests/);
  assert.match(markup, /Target: Butler Pi/);
  assert.match(markup, /<details class="operator-question-approved-content">/);
  assert.match(markup, /<summary>Review approved content<\/summary>/);
  assert.match(markup, /<pre aria-label="Full approved skill content" tabindex="0">/);
  assert.match(markup, /name: review-pr/);
  assert.match(markup, /&lt;safe&gt;/);
  assert.doesNotMatch(markup, /<details[^>]*open/);
  assert.equal((markup.match(/Approved content evidence:/g) ?? []).length, 0);
});

test("skill proposal content marker supports inline and following-line payloads", () => {
  assert.deepEqual(splitSkillProposalContent(`Summary\n${SKILL_PROPOSAL_CONTENT_MARKER} inline`), { summary: "Summary", payload: "inline" });
  assert.deepEqual(splitSkillProposalContent(`Summary\n${SKILL_PROPOSAL_CONTENT_MARKER}\nnext line`), { summary: "Summary", payload: "next line" });
  assert.equal(splitSkillProposalContent("Generic operator context"), null);
});

test("skill proposal content marker decodes the exact approved SKILL.md", () => {
  assert.deepEqual(
    splitSkillProposalContent(`Summary\n${SKILL_PROPOSAL_CONTENT_MARKER} Complete content\nMANOR_FULL_SKILL_CONTENT_V1_JSON\n"---\\nname: smoke\\n---\\n"`),
    { summary: "Summary", payload: "---\nname: smoke\n---\n" }
  );
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
    onUploadFiles: () => undefined,
    uploadingFiles: false,
    uploadError: null,
    onRemoveAttachment: () => undefined,
    onPreviewImage: () => undefined,
    blockedReason
  }));

  assert.equal(markup.split(blockedReason).length - 1, 1);
  assert.match(markup, /role="status"/);
  assert.doesNotMatch(markup, /<textarea/);
  assert.doesNotMatch(markup, /<button/);
});

test("Butler composer offers a general multiple-file picker", () => {
  const markup = renderToStaticMarkup(React.createElement(Composer, {
    value: "",
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
    onUploadFiles: () => undefined,
    uploadingFiles: false,
    uploadError: null,
    onRemoveAttachment: () => undefined,
    onPreviewImage: () => undefined,
    blockedReason: null
  }));

  assert.match(markup, /aria-label="Attach files"/);
  assert.match(markup, /type="file"/);
  assert.doesNotMatch(markup, /accept=/);
  assert.match(markup, /multiple=""/);
});

test("attachment classification keeps supported images first class", () => {
  assert.equal(isVisionImageFile("image/png", "reference.png"), true);
  assert.equal(isVisionImageFile("", "reference.jpeg"), true);
  assert.equal(isVisionImageFile("application/pdf", "reference.pdf"), false);
  assert.equal(isVisionImageFile("image/svg+xml", "reference.svg"), false);
});

test("composer file drag state handles nesting, disabled drops, and forwarding", () => {
  const file = new File(["report"], "report.pdf", { type: "application/pdf" });
  const entered = reduceComposerFileDrag({ phase: "enter", depth: 0, hasFileType: true, files: [], canAttach: true });
  const nested = reduceComposerFileDrag({ phase: "enter", depth: entered.depth, hasFileType: true, files: [], canAttach: true });
  const leftChild = reduceComposerFileDrag({ phase: "leave", depth: nested.depth, hasFileType: false, files: [], canAttach: true });
  const dropped = reduceComposerFileDrag({ phase: "drop", depth: leftChild.depth, hasFileType: true, files: [file], canAttach: true });
  const disabled = reduceComposerFileDrag({ phase: "drop", depth: 1, hasFileType: true, files: [file], canAttach: false });

  assert.deepEqual([entered.depth, nested.depth, leftChild.depth], [1, 2, 1]);
  assert.equal(leftChild.active, true);
  assert.deepEqual(dropped.filesToUpload, [file]);
  assert.equal(dropped.depth, 0);
  assert.deepEqual(disabled.filesToUpload, []);
  assert.equal(disabled.preventDefault, true);
});
