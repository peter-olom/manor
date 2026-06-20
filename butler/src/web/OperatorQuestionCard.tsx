import { useState } from "react";

import type { ButlerOperatorQuestion, ButlerOperatorQuestionItem } from "./types";

export type OperatorQuestionSelection = {
  questionId: string;
  optionId: string;
  reply: string;
};

export function getOperatorQuestionItems(question: ButlerOperatorQuestion): ButlerOperatorQuestionItem[] {
  return Array.isArray(question.questions) && question.questions.length > 0 ? question.questions : [question];
}

export function hasUnansweredOperatorQuestion(question: ButlerOperatorQuestion): boolean {
  return getOperatorQuestionItems(question).some((item) => !item.selectedOptionId);
}

export function formatQuestionOptionReply(question: ButlerOperatorQuestionItem, optionId: string): string {
  const option = question.options.find((entry) => entry.id === optionId);
  if (!option) {
    return "";
  }
  return [
    `For "${question.prompt}", I choose: ${option.label}.`,
    option.description ? `Context: ${option.description}` : null
  ].filter(Boolean).join("\n");
}

export function OperatorQuestionCard({
  question,
  onSelect
}: {
  question: ButlerOperatorQuestion;
  onSelect: (selection: OperatorQuestionSelection) => Promise<void> | void;
}) {
  const [pendingSelections, setPendingSelections] = useState<Record<string, string>>({});
  const items = getOperatorQuestionItems(question);
  const answeredCount = items.filter((item) => Boolean(item.selectedOptionId)).length;

  async function selectOption(item: ButlerOperatorQuestionItem, optionId: string) {
    if (item.selectedOptionId) {
      return;
    }
    const reply = formatQuestionOptionReply(item, optionId);
    if (!reply) {
      return;
    }
    setPendingSelections((current) => ({ ...current, [item.id]: optionId }));
    try {
      await onSelect({ questionId: item.id, optionId, reply });
    } finally {
      setPendingSelections((current) => {
        const next = { ...current };
        delete next[item.id];
        return next;
      });
    }
  }

  return (
    <div className="operator-question-card" role="group" aria-label={question.prompt}>
      {items.length > 1 ? <div className="operator-question-progress">{answeredCount}/{items.length} answered</div> : null}
      {items.map((item, index) => {
        const selectedId = item.selectedOptionId ?? pendingSelections[item.id] ?? null;
        const isPending = Boolean(pendingSelections[item.id]) && !item.selectedOptionId;
        return (
          <div className="operator-question-item" key={item.id}>
            {items.length > 1 ? <div className="operator-question-prompt">{index + 1}. {item.prompt}</div> : null}
            {item.context ? <div className="operator-question-context">{item.context}</div> : null}
            <div className="operator-question-options">
              {item.options.map((option) => {
                const selected = option.id === selectedId;
                return (
                  <button
                    key={option.id}
                    className={`operator-question-option${selected ? " is-selected" : ""}`}
                    type="button"
                    disabled={Boolean(selectedId)}
                    aria-pressed={selected}
                    onClick={() => void selectOption(item, option.id)}
                  >
                    <span className="operator-question-option-label">{option.label}</span>
                    {option.description ? <span className="operator-question-option-description">{option.description}</span> : null}
                    {selected ? <span className="operator-question-selected-label">{isPending ? "Saving" : "Selected"}</span> : null}
                  </button>
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}
