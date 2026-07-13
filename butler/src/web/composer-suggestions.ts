import type { PairComposerInputItem, PairComposerSuggestion } from "../shared/pairing";

export type ComposerTriggerMatch = {
  trigger: "@" | "$" | "/";
  query: string;
  start: number;
  end: number;
};

export function findComposerTrigger(value: string, caret: number): ComposerTriggerMatch | null {
  const before = value.slice(0, caret);
  const match = before.match(/(^|\s)([@$/])(\S*)$/);
  if (!match) return null;
  const trigger = match[2] as ComposerTriggerMatch["trigger"];
  if (trigger === "/" && before.slice(0, before.length - match[0].length).trim()) return null;
  const tokenLength = (match[2]?.length ?? 0) + (match[3]?.length ?? 0);
  return { trigger, query: match[3] ?? "", start: caret - tokenLength, end: caret };
}

export function applyComposerSuggestion(
  value: string,
  match: ComposerTriggerMatch,
  suggestion: PairComposerSuggestion
): { value: string; caret: number; inputItem: PairComposerInputItem | null } {
  if (suggestion.kind === "action") {
    return { value: suggestion.insertText, caret: suggestion.insertText.length, inputItem: null };
  }
  const replacement = suggestion.kind === "command" ? `${suggestion.insertText} ` : "";
  const prefix = value.slice(0, match.start);
  const suffix = value.slice(match.end);
  const spacer = suggestion.kind === "command" || !prefix || /\s$/.test(prefix) || !suffix || /^\s/.test(suffix) ? "" : " ";
  const nextValue = `${prefix}${spacer}${replacement}${suffix}`;
  return {
    value: nextValue,
    caret: prefix.length + spacer.length + replacement.length,
    inputItem: suggestion.inputItem ?? null
  };
}

export function composerItemKey(item: PairComposerInputItem): string {
  if (item.type === "skill") return `skill:${item.id ?? item.path ?? item.name}`;
  return `${item.type}:${item.path}`;
}

export function composerItemLabel(item: PairComposerInputItem): string {
  if (item.type === "file") return `@${item.name}`;
  if (item.type === "skill") return `$${item.name}`;
  return `$${item.name ?? item.path}`;
}

export function addComposerContextItem(current: PairComposerInputItem[], item: PairComposerInputItem): PairComposerInputItem[] {
  const key = composerItemKey(item);
  return [...current.filter((candidate) => {
    if (item.type === "skill" && candidate.type === "skill") return false;
    return composerItemKey(candidate) !== key;
  }), item];
}
