import type { SettingsProviderModel, SettingsThinkingLevel } from "../shared/settings.js";

const GLM52_THINKING_LEVEL_MAP = {
  off: null,
  none: null,
  minimal: null,
  low: null,
  medium: null,
  high: "high",
  xhigh: "max"
} satisfies Partial<Record<SettingsThinkingLevel, string | null>>;

const NO_VARIANT_THINKING_LEVEL_MAP = {
  off: null,
  minimal: null,
  low: null,
  medium: null,
  high: null,
  xhigh: null
} satisfies Partial<Record<SettingsThinkingLevel, string | null>>;

const STANDARD_REASONING_LEVEL_MAP = {
  off: null,
  minimal: null,
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: null
} satisfies Partial<Record<SettingsThinkingLevel, string | null>>;

const DEEPSEEK_V4_REASONING_LEVEL_MAP = {
  off: null,
  minimal: null,
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: "max"
} satisfies Partial<Record<SettingsThinkingLevel, string | null>>;

const NORTH_MINI_CODE_REASONING_LEVEL_MAP = {
  off: "none",
  minimal: null,
  low: null,
  medium: null,
  high: "high",
  xhigh: null
} satisfies Partial<Record<SettingsThinkingLevel, string | null>>;

const MINIMAX_M3_THINKING_LEVEL_MAP = {
  off: "default",
  minimal: "none",
  low: null,
  medium: null,
  high: null,
  xhigh: "thinking"
} satisfies Partial<Record<SettingsThinkingLevel, string | null>>;

/**
 * OpenCode recognizes the dotted, dashed, and compact GLM-5.2 spellings
 * because upstream catalogs do not agree on one canonical ID.
 */
export function isOpencodeGlm52ModelId(id: string): boolean {
  const normalized = id.toLowerCase();
  return ["glm-5.2", "glm-5-2", "glm-5p2"].some((alias) => normalized.includes(alias));
}

function suppressesSelectableOpenAiCompatibleVariants(id: string): boolean {
  return id.includes("deepseek-chat") ||
    id.includes("deepseek-reasoner") ||
    id.includes("deepseek-r1") ||
    id.includes("deepseek-v3") ||
    id.includes("minimax") ||
    (id.includes("glm") && !isOpencodeGlm52ModelId(id)) ||
    id.includes("kimi") ||
    id.includes("k2p") ||
    id.includes("qwen") ||
    id.includes("big-pickle") ||
    (id.includes("grok") && !id.includes("grok-3-mini"));
}

/**
 * Mirror OpenCode's variant rules for models carried over an
 * OpenAI-compatible transport. Model availability still comes from the live
 * provider endpoint; this helper only fills the model-level thinking metadata
 * that the provider list normally omits.
 *
 * MiniMax M3 is configurable because OpenCode sends provider-native `thinking`
 * objects for that family. OpenCode Go has a request hook that restores that
 * native payload, so it enables the native labels. Ollama Cloud's documented
 * OpenAI-compatible surface uses `reasoning_effort`/`reasoning.effort`, so it
 * keeps MiniMax M3 in the no-selectable-variant bucket unless Ollama publishes
 * a compatible native transport.
 */
export function opencodeOpenAiCompatibleModelMetadata(
  id: string,
  options: { nativeMinimaxM3?: boolean } = {}
): Omit<Exclude<SettingsProviderModel, string>, "id"> {
  const normalized = id.toLowerCase();
  if (options.nativeMinimaxM3 && normalized.includes("minimax-m3")) {
    return {
      reasoning: true,
      thinkingLevelMap: MINIMAX_M3_THINKING_LEVEL_MAP,
      compat: { supportsReasoningEffort: true, nativeThinkingFormat: "minimax-m3" }
    };
  }
  if (isOpencodeGlm52ModelId(id)) {
    return {
      reasoning: true,
      thinkingLevelMap: GLM52_THINKING_LEVEL_MAP,
      compat: { supportsReasoningEffort: true }
    };
  }
  if (normalized.includes("grok-3-mini")) {
    return {
      reasoning: true,
      thinkingLevelMap: {
        off: null,
        minimal: null,
        low: "low",
        medium: null,
        high: "high",
        xhigh: null
      },
      compat: { supportsReasoningEffort: true }
    };
  }
  if (suppressesSelectableOpenAiCompatibleVariants(normalized)) {
    return {
      reasoning: true,
      thinkingLevelMap: NO_VARIANT_THINKING_LEVEL_MAP,
      compat: { supportsReasoningEffort: false }
    };
  }
  if (normalized.includes("north-mini-code")) {
    return {
      reasoning: true,
      thinkingLevelMap: NORTH_MINI_CODE_REASONING_LEVEL_MAP,
      compat: { supportsReasoningEffort: true }
    };
  }
  if (normalized.includes("deepseek-v4")) {
    return {
      reasoning: true,
      thinkingLevelMap: DEEPSEEK_V4_REASONING_LEVEL_MAP,
      compat: { supportsReasoningEffort: true }
    };
  }
  return {
    reasoning: true,
    thinkingLevelMap: STANDARD_REASONING_LEVEL_MAP,
    compat: { supportsReasoningEffort: true }
  };
}
