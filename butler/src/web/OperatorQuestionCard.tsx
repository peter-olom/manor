import { useMemo, useState } from "react";

import { postJson } from "./api";

import type { PairDetail, PairOperatorQuestion, PairOperatorQuestionItem } from "../shared/pairing";

type DraftAnswer =
  | { kind: "option"; optionId: string }
  | { kind: "freeform"; text: string };

type SubmitDraftsResult =
  | { failedQuestionId: null; error: null }
  | { failedQuestionId: string; error: string };

function draftAnswerIsReady(draft: DraftAnswer | undefined): boolean {
  return Boolean(draft && (draft.kind === "option" || draft.text.trim()));
}

export function getOperatorQuestionItems(question: PairOperatorQuestion): PairOperatorQuestionItem[] {
  return Array.isArray(question.questions) && question.questions.length > 0 ? question.questions : [question];
}

export function operatorQuestionItemIsAnswered(item: PairOperatorQuestionItem): boolean {
  return Boolean(item.selectedOptionId || item.freeformAnswer?.trim());
}

export function hasUnansweredOperatorQuestion(question: PairOperatorQuestion): boolean {
  return getOperatorQuestionItems(question).some((item) => !operatorQuestionItemIsAnswered(item));
}

export function operatorQuestionNeedsAction(question: PairOperatorQuestion): boolean {
  return hasUnansweredOperatorQuestion(question) || question.deliveryState === "failed";
}

export async function submitOperatorQuestionDrafts({
  items,
  drafts,
  submitAnswer,
  onPairUpdate
}: {
  items: PairOperatorQuestionItem[];
  drafts: Record<string, DraftAnswer>;
  submitAnswer: (item: PairOperatorQuestionItem, draft: DraftAnswer) => Promise<PairDetail>;
  onPairUpdate: (pair: PairDetail) => void;
}): Promise<SubmitDraftsResult> {
  const targets = items.filter((item) => !operatorQuestionItemIsAnswered(item));
  for (const item of targets) {
    const draft = drafts[item.id];
    if (!draftAnswerIsReady(draft)) {
      return { failedQuestionId: item.id, error: "Choose or write an answer." };
    }
    try {
      onPairUpdate(await submitAnswer(item, draft!));
    } catch (error) {
      return {
        failedQuestionId: item.id,
        error: error instanceof Error ? error.message : String(error)
      };
    }
  }
  return { failedQuestionId: null, error: null };
}

export function OperatorQuestionCard({
  pairId,
  messageId,
  question,
  onPairUpdate,
  active = true
}: {
  pairId: string;
  messageId: string;
  question: PairOperatorQuestion;
  onPairUpdate: (pair: PairDetail) => void;
  active?: boolean;
}) {
  const items = getOperatorQuestionItems(question);
  const answeredCount = items.filter(operatorQuestionItemIsAnswered).length;
  const [drafts, setDrafts] = useState<Record<string, DraftAnswer>>({});
  const [submitting, setSubmitting] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [retryPending, setRetryPending] = useState(false);
  const [retryError, setRetryError] = useState<string | null>(null);
  const readyCount = items.filter((item) => operatorQuestionItemIsAnswered(item) || draftAnswerIsReady(drafts[item.id])).length;
  const progress = useMemo(() => `${readyCount} of ${items.length} ready`, [readyCount, items.length]);
  const allAnswered = answeredCount === items.length;
  const unansweredItems = items.filter((item) => !operatorQuestionItemIsAnswered(item));
  const canSubmitAnswers = active && unansweredItems.length > 0 && unansweredItems.every((item) => draftAnswerIsReady(drafts[item.id]));

  function updateDraft(itemId: string, draft: DraftAnswer) {
    setDrafts((current) => ({ ...current, [itemId]: draft }));
    setErrors((current) => ({ ...current, [itemId]: "" }));
  }

  async function submitAnswers() {
    const targets = items.filter((item) => !operatorQuestionItemIsAnswered(item));
    if (!active || submitting || targets.length === 0 || !targets.every((item) => draftAnswerIsReady(drafts[item.id]))) return;
    setSubmitting(true);
    setErrors((current) => {
      const next = { ...current };
      targets.forEach((item) => { delete next[item.id]; });
      return next;
    });
    try {
      const result = await submitOperatorQuestionDrafts({
        items,
        drafts,
        submitAnswer: async (item, draft) => {
          const payload = await postJson<{ pair: PairDetail }>(
            `/api/pairs/${encodeURIComponent(pairId)}/operator-question-answer`,
            {
              messageId,
              questionId: item.id,
              ...(draft.kind === "option" ? { optionId: draft.optionId } : { freeformText: draft.text.trim() })
            }
          );
          return payload.pair;
        },
        onPairUpdate
      });
      if (result.failedQuestionId) {
        setErrors((current) => ({ ...current, [result.failedQuestionId]: result.error }));
      }
    } finally {
      setSubmitting(false);
    }
  }

  async function retryDelivery() {
    const item = items.find(operatorQuestionItemIsAnswered);
    if (!item || !active || question.deliveryState !== "failed" || retryPending) return;
    const answer = item.selectedOptionId
      ? { optionId: item.selectedOptionId }
      : item.freeformAnswer
        ? { freeformText: item.freeformAnswer }
        : null;
    if (!answer) return;
    setRetryPending(true);
    setRetryError(null);
    try {
      const payload = await postJson<{ pair: PairDetail }>(
        `/api/pairs/${encodeURIComponent(pairId)}/operator-question-answer`,
        { messageId, questionId: item.id, ...answer }
      );
      onPairUpdate(payload.pair);
    } catch (error) {
      setRetryError(error instanceof Error ? error.message : String(error));
    } finally {
      setRetryPending(false);
    }
  }

  return (
    <div className="operator-question-card" aria-label={question.prompt}>
      {items.length > 1 ? <div className="operator-question-progress" aria-live="polite">{progress}</div> : null}
      {allAnswered && question.deliveryState === "pending" ? (
        <div className="operator-question-delivery" aria-live="polite">Answer saved. Resuming Butler…</div>
      ) : null}
      {allAnswered && question.deliveryState === "failed" ? (
        <div className="operator-question-delivery is-error" role="alert">
          <span>{question.deliveryError || "Butler could not continue from this answer."}</span>
          {active ? (
            <button className="button operator-question-retry" type="button" disabled={retryPending} onClick={() => void retryDelivery()}>
              {retryPending ? "Retrying…" : "Retry response"}
            </button>
          ) : null}
        </div>
      ) : null}
      {retryError ? <p className="operator-question-error" role="alert">{retryError}</p> : null}
      {items.map((item, itemIndex) => {
        const answered = operatorQuestionItemIsAnswered(item);
        const draft = drafts[item.id];
        const contextId = item.context ? `${item.id}-context` : undefined;
        const error = errors[item.id];
        return (
          <fieldset
            className={`operator-question-item${answered ? " is-answered" : ""}`}
            key={item.id}
            disabled={answered || !active || submitting}
            aria-describedby={contextId}
          >
            <legend>{items.length > 1 ? `${itemIndex + 1}. ${item.prompt}` : item.prompt}</legend>
            {item.context ? <p className="operator-question-context" id={contextId}>{item.context}</p> : null}
            <div className="operator-question-options">
              {item.options.map((option, optionIndex) => {
                const selected = item.selectedOptionId === option.id || (draft?.kind === "option" && draft.optionId === option.id);
                return (
                  <label className={`operator-question-option${selected ? " is-selected" : ""}`} key={option.id}>
                    <input
                      type="radio"
                      name={item.id}
                      value={option.id}
                      checked={selected}
                      onChange={() => updateDraft(item.id, { kind: "option", optionId: option.id })}
                    />
                    <span className="operator-question-option-copy">
                      <span className="operator-question-option-heading">
                        <span className="operator-question-option-label">{option.label}</span>
                        {optionIndex === 0 ? <span className="operator-question-recommended">Recommended</span> : null}
                      </span>
                      {option.description ? <span className="operator-question-option-description">{option.description}</span> : null}
                    </span>
                  </label>
                );
              })}
              {item.allowFreeform ? (
                <div className={`operator-question-freeform${draft?.kind === "freeform" || item.freeformAnswer ? " is-selected" : ""}`}>
                  <label className="operator-question-option">
                    <input
                      type="radio"
                      name={item.id}
                      value="freeform"
                      checked={Boolean(item.freeformAnswer) || draft?.kind === "freeform"}
                      onChange={() => updateDraft(item.id, { kind: "freeform", text: "" })}
                    />
                    <span className="operator-question-option-copy">
                      <span className="operator-question-option-label">Write my own answer</span>
                    </span>
                  </label>
                  {draft?.kind === "freeform" || item.freeformAnswer ? (
                    <textarea
                      aria-label={`Answer: ${item.prompt}`}
                      maxLength={2000}
                      rows={3}
                      readOnly={answered}
                      value={item.freeformAnswer ?? (draft?.kind === "freeform" ? draft.text : "")}
                      onChange={(event) => updateDraft(item.id, { kind: "freeform", text: event.target.value })}
                    />
                  ) : null}
                </div>
              ) : null}
            </div>
            {answered || !active ? (
              <div className="operator-question-footer">
                <span className="operator-question-status" aria-live="polite">{answered ? "Answered" : "No longer active"}</span>
              </div>
            ) : null}
            {error ? <p className="operator-question-error" role="alert">{error}</p> : null}
          </fieldset>
        );
      })}
      {!allAnswered && active ? (
        <div className="operator-question-footer">
          <span className="operator-question-status" aria-live="polite">{submitting ? `Saving ${items.length > 1 ? "answers" : "answer"}…` : ""}</span>
          <button
            className="button is-primary operator-question-submit"
            type="button"
            disabled={!canSubmitAnswers || submitting}
            onClick={() => void submitAnswers()}
          >
            {submitting ? "Submitting…" : items.length > 1 ? "Submit answers" : "Submit answer"}
          </button>
        </div>
      ) : null}
    </div>
  );
}
