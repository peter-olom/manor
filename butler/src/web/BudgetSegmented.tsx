import { memo, useCallback } from "react";

export type BudgetLevel = "low" | "medium" | "high" | "xhigh";

const DEFAULT_LEVELS: BudgetLevel[] = ["low", "medium", "high", "xhigh"];

type BudgetSegmentedProps = {
  label: string;
  value: string | null | undefined;
  options: readonly string[];
  disabled?: boolean;
  onChange: (value: string) => void;
  className?: string;
};

export const BudgetSegmented = memo(function BudgetSegmented({
  label,
  value,
  options,
  disabled = false,
  onChange,
  className
}: BudgetSegmentedProps) {
  const handleClick = useCallback(
    (next: string) => () => {
      if (disabled) return;
      if (next === value) return;
      onChange(next);
    },
    [disabled, onChange, value]
  );

  const list = options.length > 0 ? options : DEFAULT_LEVELS;

  return (
    <div
      className={`budget-segmented ${disabled ? "is-disabled" : ""} ${className ?? ""}`.trim()}
      role="radiogroup"
      aria-label={label}
    >
      <span className="budget-segmented-label">{label}</span>
      <div className="budget-segmented-options">
        {list.map((option) => (
          <button
            key={option}
            type="button"
            role="radio"
            aria-checked={option === value}
            className={`budget-segmented-option ${option === value ? "is-selected" : ""}`}
            disabled={disabled}
            onClick={handleClick(option)}
          >
            {option}
          </button>
        ))}
      </div>
    </div>
  );
});
