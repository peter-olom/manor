import { memo } from "react";

import { DEFAULT_THINKING_LEVELS } from "../shared/pairing";

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
  const list = options.length > 0 ? options : DEFAULT_THINKING_LEVELS;
  const selected = value ?? list[0] ?? "";

  return (
    <label className={`budget-segmented ${disabled ? "is-disabled" : ""} ${className ?? ""}`.trim()}>
      <span className="sr-only">{label}</span>
      <select
        value={selected}
        aria-label={label}
        title={label}
        disabled={disabled || list.length === 0}
        onChange={(event) => onChange(event.currentTarget.value)}
      >
        {list.map((option) => (
          <option key={option} value={option}>
            {option}
          </option>
        ))}
      </select>
    </label>
  );
});
