import { resolveModelInputCapabilities } from "./model-input-capabilities.js";
import type { ModelOption, ReasoningEffort } from "./types.js";

function normalizeModelLabel(rawLabel: string, id: string): string {
  const source = rawLabel.trim() || id.trim();
  if (!source) return id;
  const parts = source.replace(/\s+/g, "-").split("-").filter(Boolean);
  if (parts.length < 2) return source;
  const head = parts[0]?.toLowerCase() === "gpt" ? "GPT" : parts[0];
  const version = parts[1] ?? "";
  const suffix = parts.slice(2).map((part) => {
    const lower = part.toLowerCase();
    if (lower === "codex") return "Codex";
    if (lower === "mini") return "Mini";
    if (lower === "max") return "Max";
    if (lower === "spark") return "Spark";
    return part.length > 1 ? `${part[0]!.toUpperCase()}${part.slice(1).toLowerCase()}` : part.toUpperCase();
  }).join(" ");
  return `${head}-${version}${suffix ? ` ${suffix}` : ""}`;
}

function isReasoningEffort(value: unknown): value is ReasoningEffort {
  return value === "none" || value === "minimal" || value === "low" || value === "medium" || value === "high" || value === "xhigh" || value === "max";
}

export function codexModelEntryIsSelectable(entry: Record<string, unknown>): boolean {
  if (entry.disabled === true || entry.isDisabled === true) return false;
  if (entry.available === false || entry.isAvailable === false) return false;
  if (entry.supported === false || entry.isSupported === false) return false;
  if (entry.hidden === true || entry.showInPicker === false || entry.show_in_picker === false) return false;
  return typeof entry.visibility !== "string" || entry.visibility === "list";
}

export function codexModelEntryId(entry: Record<string, unknown>): string | null {
  return typeof entry.id === "string" ? entry.id : typeof entry.model === "string" ? entry.model : typeof entry.slug === "string" ? entry.slug : null;
}

function codexModelEntryLabel(entry: Record<string, unknown>, id: string): string {
  return typeof entry.displayName === "string" ? entry.displayName : typeof entry.display_name === "string" ? entry.display_name : id;
}

function supportedReasoningEfforts(entry: Record<string, unknown>): ReasoningEffort[] {
  const raw = Array.isArray(entry.supportedReasoningEfforts) ? entry.supportedReasoningEfforts : Array.isArray(entry.supported_reasoning_levels) ? entry.supported_reasoning_levels : [];
  return raw.map((option) => {
    if (isReasoningEffort(option)) return option;
    if (option && typeof option === "object" && "reasoningEffort" in option) {
      const effort = (option as { reasoningEffort?: unknown }).reasoningEffort;
      return isReasoningEffort(effort) ? effort : null;
    }
    if (option && typeof option === "object" && "effort" in option) {
      const effort = (option as { effort?: unknown }).effort;
      return isReasoningEffort(effort) ? effort : null;
    }
    return null;
  }).filter((value): value is ReasoningEffort => Boolean(value));
}

export function modelOptionFromCodexEntry(entry: Record<string, unknown>): ModelOption | null {
  const id = codexModelEntryId(entry);
  if (!id || !codexModelEntryIsSelectable(entry)) return null;
  const efforts = supportedReasoningEfforts(entry);
  const declaredDefault = isReasoningEffort(entry.defaultReasoningEffort) ? entry.defaultReasoningEffort : isReasoningEffort(entry.default_reasoning_level) ? entry.default_reasoning_level : null;
  const providerInputModalities = [entry.inputModalities, entry.input_modalities, entry.supportedInputModalities, entry.supported_input_modalities]
    .find((value): value is string[] => Array.isArray(value) && value.every((item) => typeof item === "string"));
  return {
    id,
    label: normalizeModelLabel(codexModelEntryLabel(entry, id), id),
    provider: "openai-codex",
    inputCapabilities: resolveModelInputCapabilities({ modelId: id, provider: "openai-codex", providerInputModalities }),
    supportsReasoning: efforts.length > 0,
    supportedThinkingLevels: efforts,
    supportedReasoningEfforts: efforts,
    defaultReasoningEffort: declaredDefault && efforts.includes(declaredDefault) ? declaredDefault : efforts.includes("medium") ? "medium" : efforts[0] ?? null
  };
}

export function hasMissingChatGptOnlyCacheModel(appServerEntries: Record<string, unknown>[], cacheEntries: Record<string, unknown>[]): boolean {
  const appServerIds = new Set(appServerEntries.map(codexModelEntryId).filter((id): id is string => Boolean(id)));
  return cacheEntries.some((entry) => {
    const id = codexModelEntryId(entry);
    return Boolean(id && !appServerIds.has(id) && codexModelEntryIsSelectable(entry) && (entry.supported_in_api === false || entry.supportedInApi === false));
  });
}
