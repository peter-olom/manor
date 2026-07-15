import type { SettingsProviderModel, SettingsThinkingLevel } from "../shared/settings.js";

export type CapabilitySource = "provider-manifest" | "openrouter" | "builtin-fallback" | "user-config";

export type ModelCapabilityMetadata = {
  reasoning?: boolean;
  contextWindow?: number;
  thinkingLevelMap?: Partial<Record<SettingsThinkingLevel, string | null>>;
  compat?: Record<string, unknown>;
  __source?: CapabilitySource;
};

const BUILTIN_FALLBACK_CAPABILITIES: Array<ModelCapabilityMetadata & { ids: string[] }> = [
  {
    ids: ["glm-5.2", "glm-5.2-20260616", "z-ai/glm-5.2", "z-ai/glm-5.2-20260616"],
    reasoning: true,
    thinkingLevelMap: { off: null, none: null, minimal: null, low: null, medium: null, high: "high", xhigh: "max" },
    compat: { supportsReasoningEffort: true },
    __source: "builtin-fallback"
  }
];

export function modelAliases(id: string): string[] {
  const normalized = id.trim().toLowerCase().replace(/_/g, "-");
  const parts = normalized.split("/").filter(Boolean);
  const leaf = parts.at(-1) ?? normalized;
  return Array.from(new Set([normalized, leaf]));
}

function mergeRecord<T extends string>(...maps: Array<Partial<Record<T, string | null>> | null | undefined>): Partial<Record<T, string | null>> | undefined {
  let merged: Partial<Record<T, string | null>> | undefined;
  for (const map of maps) {
    if (!map) continue;
    merged = { ...(merged ?? {}), ...map };
  }
  return merged;
}

export function mergeThinkingLevelMaps(...maps: Array<Partial<Record<SettingsThinkingLevel, string | null>> | null | undefined>): Partial<Record<SettingsThinkingLevel, string | null>> | undefined {
  return mergeRecord(...maps);
}

/**
 * Ollama's native model metadata exposes a coarse `thinking` capability, while
 * the Pi/OpenAI-compatible route needs concrete effort values in the outgoing
 * request. OpenCode's provider layer handles this as two separate concerns:
 * first decide whether a model can reason, then attach provider-specific
 * variants that map UI choices to the transport payload.
 *
 * We mirror that shape for Ollama. The picker shows the human-facing `max`
 * variant, but Pi still transports it as its fixed `xhigh` level; the model map
 * then converts that to Ollama's `max` effort. `off` is also explicit because
 * Ollama can enable thinking by default for thinking-capable models, and an
 * omitted request field is not a reliable off switch.
 */
export function ollamaOpenAiThinkingMetadata(capabilities: readonly string[] | null | undefined): ModelCapabilityMetadata | null {
  if (!capabilities) return null;
  const normalized = new Set(capabilities.map((entry) => entry.trim().toLowerCase()).filter(Boolean));
  if (!normalized.has("thinking")) {
    return { reasoning: false, __source: "provider-manifest" };
  }
  return {
    reasoning: true,
    thinkingLevelMap: {
      off: "none",
      none: "none",
      minimal: null,
      low: "low",
      medium: "medium",
      high: "high",
      xhigh: "max",
      max: "max"
    },
    compat: { supportsReasoningEffort: true },
    __source: "provider-manifest"
  };
}

export function thinkingLevelMapFromSupportedEfforts(efforts: readonly string[] | null): Partial<Record<SettingsThinkingLevel, string | null>> | undefined {
  if (efforts === null) return undefined;
  if (efforts.length === 0) return undefined;
  const supported = new Set(efforts.map((e) => e.trim().toLowerCase()).filter(Boolean));
  const allLevels: SettingsThinkingLevel[] = ["off", "none", "minimal", "low", "medium", "high", "xhigh", "max"];
  const matched = allLevels.filter((level) => supported.has(level));
  if (matched.length === 0) return undefined;
  return Object.fromEntries(
    allLevels.map((level) => [level, supported.has(level) ? (level === "off" ? "none" : level) : null])
  ) as Partial<Record<SettingsThinkingLevel, string | null>>;
}

export function getModelCapabilityMetadata(id: string): ModelCapabilityMetadata | null {
  const aliases = modelAliases(id);
  return BUILTIN_FALLBACK_CAPABILITIES.find((entry) => entry.ids.some((alias) => aliases.includes(alias))) ?? null;
}

export function mergeModelCapabilityMetadata(model: SettingsProviderModel, metadata: ModelCapabilityMetadata | null | undefined): SettingsProviderModel {
  if (!metadata) return model;
  const base = typeof model === "string" ? { id: model } : model;
  const compat = metadata.compat || base.compat ? { ...(metadata.compat ?? {}), ...(base.compat ?? {}) } : undefined;
  return {
    ...base,
    reasoning: base.reasoning ?? metadata.reasoning ?? null,
    contextWindow: base.contextWindow ?? metadata.contextWindow ?? null,
    thinkingLevelMap: mergeThinkingLevelMaps(metadata.thinkingLevelMap, base.thinkingLevelMap),
    ...(compat ? { compat } : {})
  };
}

export function applyModelCapabilityMetadata(model: SettingsProviderModel): SettingsProviderModel {
  const id = typeof model === "string" ? model : model.id;
  return mergeModelCapabilityMetadata(model, getModelCapabilityMetadata(id));
}
