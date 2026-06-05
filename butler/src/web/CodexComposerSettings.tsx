import { useEffect, useId, useRef, useState } from "react";

import { ChevronDownIcon } from "./icons";
import type { ModelOption, ReasoningEffort } from "./types";

type CodexComposerSettingsProps = {
  availableModels: ModelOption[];
  selectedModel: string | null;
  selectedModelLabel: string;
  selectedEffort: ReasoningEffort | null;
  selectedEffortLabel: string;
  effortOptions: ReasoningEffort[];
  budgetLabel: string;
  capReached: boolean;
  maxButlerTurns: number | null;
  onComposeChange: (model: string, effort: ReasoningEffort | null) => void;
  onThreadLimitChange: (maxTurns: number | null) => void;
};

type SettingsControlsProps = CodexComposerSettingsProps & {
  budgetClassName: string;
};

function SettingsControls({
  availableModels,
  selectedModel,
  selectedEffort,
  effortOptions,
  budgetLabel,
  capReached,
  maxButlerTurns,
  onComposeChange,
  onThreadLimitChange,
  budgetClassName
}: SettingsControlsProps) {
  const budgetValueClassName = budgetClassName === "composer-thread-budget" ? "composer-thread-budget-value" : undefined;

  return (
    <>
      <select
        value={selectedModel ?? ""}
        onChange={(event) => {
          const nextModel = event.target.value;
          const model = availableModels.find((entry) => entry.id === nextModel);
          onComposeChange(nextModel, model?.defaultReasoningEffort ?? null);
        }}
        aria-label="Codex model"
      >
        {availableModels.map((model) => (
          <option key={model.id} value={model.id}>
            {model.label}
          </option>
        ))}
      </select>
      <select
        value={selectedEffort ?? ""}
        onChange={(event) => onComposeChange(selectedModel ?? "", (event.target.value || null) as ReasoningEffort | null)}
        disabled={!selectedModel || effortOptions.length === 0}
        aria-label="Codex reasoning"
      >
        {effortOptions.length === 0 ? (
          <option value="">Standard</option>
        ) : (
          effortOptions.map((effort) => (
            <option key={effort} value={effort}>
              {effort}
            </option>
          ))
        )}
      </select>
      <label className={`${budgetClassName}${capReached ? " is-capped" : ""}`}>
        <span className={budgetValueClassName}>{budgetLabel}</span>
        <select
          value={maxButlerTurns === null ? "null" : String(maxButlerTurns)}
          onChange={(event) => onThreadLimitChange(event.target.value === "null" ? null : Number(event.target.value))}
          aria-label="Butler thread turn limit"
        >
          <option value="20">20 turns</option>
          <option value="40">40 turns</option>
          <option value="100">100 turns</option>
          <option value="null">No limit</option>
        </select>
      </label>
    </>
  );
}

export function CodexComposerSettings(props: CodexComposerSettingsProps) {
  const [dialogOpen, setDialogOpen] = useState(false);
  const titleId = useId();
  const dialogRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!dialogOpen) return;
    const previousActiveElement = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setDialogOpen(false);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    requestAnimationFrame(() => dialogRef.current?.focus());
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      previousActiveElement?.focus();
    };
  }, [dialogOpen]);

  return (
    <>
      <button
        className="composer-settings-trigger"
        type="button"
        aria-haspopup="dialog"
        aria-expanded={dialogOpen}
        aria-controls={dialogOpen ? titleId : undefined}
        onClick={() => setDialogOpen(true)}
      >
        <span className="composer-settings-trigger-copy">
          <span>{props.selectedModelLabel}</span>
          <span>{props.selectedEffortLabel}</span>
          <span>{props.budgetLabel}</span>
        </span>
        <ChevronDownIcon />
      </button>
      {dialogOpen ? (
        <div className="composer-settings-dialog-backdrop" onMouseDown={() => setDialogOpen(false)}>
          <section
            className="composer-settings-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby={titleId}
            tabIndex={-1}
            ref={dialogRef}
            onMouseDown={(event) => event.stopPropagation()}
          >
            <div className="composer-settings-dialog-head">
              <h2 id={titleId}>Codex settings</h2>
              <button type="button" onClick={() => setDialogOpen(false)} aria-label="Close Codex settings">
                ×
              </button>
            </div>
            <div className="composer-settings-panel">
              <SettingsControls {...props} budgetClassName="composer-settings-budget" />
            </div>
          </section>
        </div>
      ) : null}
      <div className="composer-inline-controls composer-inline-controls-thread">
        <SettingsControls {...props} budgetClassName="composer-thread-budget" />
      </div>
    </>
  );
}
