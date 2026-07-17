import { memo, useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";

import { ChevronDownIcon, CloseIcon, SearchIcon } from "./icons";

export type ModelPickerOption = {
  id: string;
  selectionId?: string;
  label: string;
  provider: string | null;
  hint?: string | null;
  disabled?: boolean;
  disabledReason?: string | null;
};

export type ModelPickerGroup = {
  provider: string;
  label: string;
  options: ModelPickerOption[];
};

export type ModelPickerProps = {
  label: string;
  value: string | null;
  options: readonly ModelPickerOption[];
  groups?: readonly ModelPickerGroup[];
  placeholder?: string;
  disabled?: boolean;
  disabledPlaceholder?: string;
  allowClear?: boolean;
  clearLabel?: string;
  compact?: boolean;
  anchor?: "above" | "below";
  className?: string;
  onChange: (next: string | null) => void;
};

type FlatEntry = {
  option: ModelPickerOption;
  groupLabel: string;
  groupIndex: number;
};

export function modelOptionValue(option: ModelPickerOption): string {
  if (option.selectionId) return option.selectionId;
  return option.provider && !option.id.startsWith(`${option.provider}/`) ? `${option.provider}/${option.id}` : option.id;
}

export function modelOptionSelectionValue(option: ModelPickerOption): string {
  return option.selectionId ?? option.id;
}

function findOptionValue(options: readonly ModelPickerOption[], value: string | null): string | null {
  if (!value) return null;
  const bySelection = options.find((option) => option.selectionId === value);
  if (bySelection) return modelOptionSelectionValue(bySelection);
  const direct = options.filter((option) => option.id === value);
  if (direct.length === 1) return modelOptionSelectionValue(direct[0]);
  const qualified = options.filter((option) => modelOptionValue(option) === value);
  if (qualified.length === 1) return modelOptionSelectionValue(qualified[0]);
  return null;
}

function resolveSelectedLabel(options: readonly ModelPickerOption[], value: string | null, placeholder: string): string {
  if (!value) return placeholder;
  const match = options.find((option) => modelOptionSelectionValue(option) === value);
  if (!match) return placeholder;
  return match.label;
}

const PROVIDER_ORDER = ["openai-codex", "ollama-local", "ollama-cloud", "opencode-go"];

const PROVIDER_LABELS: Record<string, string> = {
  "openai-codex": "OpenAI / Codex",
  "openai": "OpenAI",
  "ollama-local": "Ollama Local",
  "ollama-cloud": "Ollama Cloud",
  "opencode-go": "OpenCode Go"
};

function providerLabel(provider: string): string {
  return PROVIDER_LABELS[provider] ?? provider;
}

function providerSortKey(provider: string): number {
  const index = PROVIDER_ORDER.indexOf(provider);
  return index === -1 ? PROVIDER_ORDER.length + 1 : index;
}

function normalizeGroups(options: readonly ModelPickerOption[], explicitGroups?: readonly ModelPickerGroup[]): ModelPickerGroup[] {
  if (explicitGroups && explicitGroups.length > 0) {
    const seen = new Set<string>();
    const result: ModelPickerGroup[] = [];
    for (const group of explicitGroups) {
      const key = group.provider;
      if (seen.has(key)) continue;
      seen.add(key);
      result.push({ provider: group.provider, label: group.label || providerLabel(group.provider), options: group.options });
    }
    return result.sort((a, b) => providerSortKey(a.provider) - providerSortKey(b.provider));
  }
  const byProvider = new Map<string, ModelPickerOption[]>();
  for (const option of options) {
    const key = option.provider ?? "default";
    const list = byProvider.get(key);
    if (list) list.push(option);
    else byProvider.set(key, [option]);
  }
  return [...byProvider.keys()]
    .sort((a, b) => providerSortKey(a) - providerSortKey(b))
    .map((provider) => ({
      provider,
      label: providerLabel(provider),
      options: byProvider.get(provider) ?? []
    }));
}

function flattenEntries(groups: readonly ModelPickerGroup[]): FlatEntry[] {
  const entries: FlatEntry[] = [];
  groups.forEach((group, groupIndex) => {
    for (const option of group.options) {
      entries.push({ option, groupLabel: group.label, groupIndex });
    }
  });
  return entries;
}

function matchesQuery(option: ModelPickerOption, query: string): boolean {
  if (!query) return true;
  const needle = query.toLowerCase();
  if (option.label.toLowerCase().includes(needle)) return true;
  if (option.id.toLowerCase().includes(needle)) return true;
  if (option.provider && option.provider.toLowerCase().includes(needle)) return true;
  if (option.hint && option.hint.toLowerCase().includes(needle)) return true;
  return false;
}

function highlightLabel(label: string, query: string): ReactNode {
  if (!query) return label;
  const needle = query.toLowerCase();
  const lower = label.toLowerCase();
  const start = lower.indexOf(needle);
  if (start === -1) return label;
  const end = start + needle.length;
  return (
    <>
      {label.slice(0, start)}
      <mark className="model-picker-match">{label.slice(start, end)}</mark>
      {label.slice(end)}
    </>
  );
}

export const ModelPicker = memo(function ModelPicker({
  label,
  value,
  options,
  groups,
  placeholder = "Default",
  disabled = false,
  disabledPlaceholder,
  allowClear = false,
  clearLabel = "Clear",
  compact = false,
  anchor = "above",
  className,
  onChange
}: ModelPickerProps) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(-1);

  const resolvedGroups = useMemo(() => normalizeGroups(options, groups), [options, groups]);
  const entries = useMemo(() => flattenEntries(resolvedGroups), [resolvedGroups]);
  const filtered = useMemo(() => {
    const trimmed = query.trim().toLowerCase();
    if (!trimmed) return entries;
    return entries.filter((entry) => matchesQuery(entry.option, query));
  }, [entries, query]);

  const selectedValue = findOptionValue(options, value);
  const selectedLabel = resolveSelectedLabel(options, selectedValue, placeholder);
  const isDisabled = disabled || options.length === 0;
  const displayPlaceholder = isDisabled && disabledPlaceholder ? disabledPlaceholder : placeholder;

  const close = useCallback(() => {
    setOpen(false);
    setQuery("");
    setActiveIndex(-1);
  }, []);

  useEffect(() => {
    if (!open) return;
    const onPointer = (event: MouseEvent) => {
      const root = rootRef.current;
      if (!root) return;
      if (event.target instanceof Node && root.contains(event.target)) return;
      close();
    };
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopImmediatePropagation();
        close();
        triggerRef.current?.focus({ preventScroll: true });
      }
    };
    document.addEventListener("mousedown", onPointer);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("mousedown", onPointer);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [open, close]);

  useEffect(() => {
    if (!open) return;
    const input = searchRef.current;
    if (input) input.focus({ preventScroll: true });
  }, [open]);

  useEffect(() => {
    if (!open) return;
    if (filtered.length === 0) {
      setActiveIndex(-1);
      return;
    }
    if (activeIndex < 0 || activeIndex >= filtered.length) {
      const selectedIndex = selectedValue
        ? filtered.findIndex((entry) => modelOptionSelectionValue(entry.option) === selectedValue)
        : -1;
      setActiveIndex(selectedIndex >= 0 ? selectedIndex : 0);
    }
  }, [open, filtered, activeIndex, selectedValue]);

  useEffect(() => {
    if (!open) return;
    const list = listRef.current;
    if (!list) return;
    const item = list.querySelector<HTMLElement>(`[data-index="${activeIndex}"]`);
    if (item) item.scrollIntoView({ block: "nearest" });
  }, [activeIndex, open]);

  const choose = useCallback((next: string | null) => {
    onChange(next);
    close();
    triggerRef.current?.focus({ preventScroll: true });
  }, [onChange, close]);

  const onTriggerKeyDown = useCallback((event: ReactKeyboardEvent<HTMLButtonElement>) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      if (open) {
        const entry = filtered[activeIndex];
        if (entry && !entry.option.disabled) choose(modelOptionSelectionValue(entry.option));
      } else {
        setOpen(true);
      }
      return;
    }
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setOpen(true);
    }
  }, [open, filtered, activeIndex, choose]);

  const onSearchKeyDown = useCallback((event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActiveIndex((current) => Math.min(current + 1, filtered.length - 1));
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      setActiveIndex((current) => Math.max(current - 1, 0));
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      const entry = filtered[activeIndex];
      if (entry && !entry.option.disabled) choose(modelOptionSelectionValue(entry.option));
      return;
    }
    if (event.key === "Tab") {
      close();
      return;
    }
  }, [filtered, activeIndex, choose]);

  const triggerClass = [
    "model-picker-trigger",
    compact ? "is-compact" : "",
    open ? "is-open" : "",
    isDisabled ? "is-disabled" : "",
    allowClear && selectedValue && !isDisabled ? "has-clear" : "",
    className ?? ""
  ].filter(Boolean).join(" ");

  const shownLabel = isDisabled && disabledPlaceholder ? disabledPlaceholder : selectedLabel;

  const rootClass = ["model-picker", compact ? "is-compact" : "", className ?? ""].filter(Boolean).join(" ");

  return (
    <div className={rootClass} ref={rootRef}>
      <button
        ref={triggerRef}
        type="button"
        className={triggerClass}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={label}
        title={label}
        disabled={isDisabled}
        onClick={() => setOpen((current) => !current)}
        onKeyDown={onTriggerKeyDown}
      >
        <span className="model-picker-trigger-label">{shownLabel || displayPlaceholder}</span>
        <span className="model-picker-chevron" aria-hidden="true">
          <ChevronDownIcon />
        </span>
      </button>
      {allowClear && selectedValue && !isDisabled ? (
        <button
          type="button"
          className="model-picker-clear"
          aria-label={clearLabel}
          onClick={() => choose(null)}
        >
          <CloseIcon />
        </button>
      ) : null}
      {open ? (
        <div className={`model-picker-popover is-anchor-${anchor}`} role="dialog" aria-label={label}>
          <div className="model-picker-search">
            <span className="model-picker-search-icon" aria-hidden="true"><SearchIcon /></span>
            <input
              ref={searchRef}
              type="search"
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
                setActiveIndex(-1);
              }}
              onKeyDown={onSearchKeyDown}
              placeholder="Search models…"
              aria-label={`Search ${label}`}
              autoComplete="off"
              spellCheck={false}
            />
            {query ? (
              <button
                type="button"
                className="model-picker-search-clear"
                aria-label="Clear search"
                onClick={() => {
                  setQuery("");
                  searchRef.current?.focus({ preventScroll: true });
                }}
              >
                <CloseIcon />
              </button>
            ) : null}
          </div>
          <div className="model-picker-list" ref={listRef} role="listbox" aria-label={label}>
            {filtered.length === 0 ? (
              <div className="model-picker-empty">No models match “{query}”.</div>
            ) : (
              filtered.map((entry, filteredIndex) => {
                const optionValue = modelOptionValue(entry.option);
                const isSelected = modelOptionSelectionValue(entry.option) === selectedValue;
                const isActive = filteredIndex === activeIndex;
                const previous = filtered[filteredIndex - 1];
                const showGroupHeader = (!previous || previous.groupLabel !== entry.groupLabel) && entry.groupLabel !== "default";
                return (
                  <div key={optionValue}>
                    {showGroupHeader ? (
                      <div className="model-picker-group" role="presentation">{entry.groupLabel}</div>
                    ) : null}
                    <button
                      type="button"
                      role="option"
                      aria-selected={isSelected}
                      data-index={filteredIndex}
                      data-value={optionValue}
                      className={`model-picker-option ${isSelected ? "is-selected" : ""} ${isActive ? "is-active" : ""} ${entry.option.disabled ? "is-disabled" : ""}`}
                      disabled={entry.option.disabled}
                      title={entry.option.disabledReason ?? entry.option.hint ?? entry.option.label}
                      onClick={() => {
                        if (entry.option.disabled) return;
                        choose(modelOptionSelectionValue(entry.option));
                      }}
                      onMouseEnter={() => setActiveIndex(filteredIndex)}
                    >
                      <span className="model-picker-option-label">
                        {highlightLabel(entry.option.label, query)}
                      </span>
                      {entry.option.hint ? (
                        <span className="model-picker-option-hint">{entry.option.hint}</span>
                      ) : null}
                      {entry.option.provider ? (
                        <span className="model-picker-option-provider">{entry.option.provider}</span>
                      ) : null}
                    </button>
                  </div>
                );
              })
            )}
          </div>
          {allowClear ? (
            <div className="model-picker-footer">
              <button
                type="button"
                className="model-picker-footer-clear"
                onClick={() => choose(null)}
                disabled={!selectedValue}
              >
                {clearLabel}
              </button>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
});
