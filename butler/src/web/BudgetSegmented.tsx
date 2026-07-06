import { memo } from "react";

type BudgetSegmentedProps = {
  label: string;
  value: string | null | undefined;
  options: readonly string[];
  disabled?: boolean;
  onChange: (value: string) => void;
  className?: string;
};

const OPTION_LABELS: Record<string, string> = {
  off: "Off",
  default: "Default",
  none: "None",
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "XHigh",
  max: "Max",
  thinking: "Thinking"
};

function displayLabel(option: string): string {
  return OPTION_LABELS[option] ?? option.charAt(0).toUpperCase() + option.slice(1);
}

export const BudgetSegmented = memo(function BudgetSegmented({
  label,
  value,
  options,
  disabled = false,
  onChange,
  className
}: BudgetSegmentedProps) {
  const list = options;
  const selected = value ?? list[0] ?? "";
  const isEmpty = list.length === 0;

  return (
    <label className={`budget-segmented ${disabled || isEmpty ? "is-disabled" : ""} ${className ?? ""}`.trim()}>
      <span className="sr-only">{label}</span>
      <select
        value={selected}
        aria-label={label}
        title={label}
        disabled={disabled || isEmpty}
        onChange={(event) => onChange(event.currentTarget.value)}
      >
        {isEmpty ? (
          <option value="">N/A</option>
        ) : (
          list.map((option) => (
            <option key={option} value={option}>
              {displayLabel(option)}
            </option>
          ))
        )}
      </select>
    </label>
  );
});
