import { memo } from "react";

import type { PairModelOption } from "../shared/pairing";

type ModelSelectProps = {
  label: string;
  value: string | null | undefined;
  options: readonly PairModelOption[];
  disabled?: boolean;
  onChange: (model: string) => void;
  className?: string;
};

function modelLabel(model: PairModelOption): string {
  return model.provider ? `${model.label} · ${model.provider}` : model.label;
}

export const ModelSelect = memo(function ModelSelect({
  label,
  value,
  options,
  disabled = false,
  onChange,
  className
}: ModelSelectProps) {
  const selected = value ?? "";
  return (
    <label className={`model-select ${disabled ? "is-disabled" : ""} ${className ?? ""}`.trim()}>
      <span className="sr-only">{label}</span>
      <select
        value={selected}
        aria-label={label}
        title={label}
        disabled={disabled || options.length === 0}
        onChange={(event) => onChange(event.currentTarget.value)}
      >
        {options.length === 0 ? <option value="">Default</option> : null}
        {options.map((option) => (
          <option key={option.id} value={option.id}>
            {modelLabel(option)}
          </option>
        ))}
      </select>
    </label>
  );
});
