import type { ButlerThinkingLevel, ModelOption, ReasoningEffort } from "./types.js";

export type PiThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

/**
 * Translate Manor's richer effort vocabulary into the levels Pi can send over
 * its current CLI/RPC surface.
 *
 * Manor exposes `none` and `max` because providers such as Codex and OpenCode
 * use those terms. Pi's runtime currently accepts only `off`, `minimal`, `low`,
 * `medium`, `high`, and `xhigh`. For OpenCode Go GLM-5.2, `max` is represented
 * as Pi `xhigh`, and the generated model metadata maps that transport value to
 * OpenCode's native `reasoning_effort: "max"` before the request is sent.
 */
export function piThinkingLevelForEffort(effort: ReasoningEffort): PiThinkingLevel {
  if (effort === "none") return "low";
  if (effort === "minimal") return "low";
  if (effort === "max") return "xhigh";
  return effort;
}

/**
 * Convert a Butler UI thinking level into a Pi session level. Worker efforts use
 * `none` as a very small reasoning budget, while Butler's thinking selector has
 * a real `off` state, so `none` maps to `off` here.
 */
export function piThinkingLevelForButlerLevel(level: ButlerThinkingLevel): PiThinkingLevel {
  if (level === "default") return "off";
  if (level === "none") return "off";
  if (level === "max") return "xhigh";
  if (level === "thinking") return "xhigh";
  return level;
}

/**
 * Convert a picker-facing Butler level to the Pi transport level for a specific
 * model. Most models use the same display and transport value. Provider-native
 * variants are different: OpenCode Go MiniMax M3 displays `none` and
 * `thinking`, but Pi still needs one of its fixed internal levels so an
 * extension can translate the final payload to OpenCode's native shape.
 */
export function piThinkingLevelForModelOption(level: ButlerThinkingLevel, model: ModelOption | null | undefined): PiThinkingLevel {
  const transport = model?.thinkingLevelTransports?.[level];
  return transport ?? piThinkingLevelForButlerLevel(level);
}

/**
 * Convert a stored Pi session level back into the level Manor should display.
 * This keeps OpenCode Go's `max` visible in the UI even though Pi stores the
 * transport level as `xhigh`.
 */
export function displayThinkingLevelForPiLevel(level: ButlerThinkingLevel | null | undefined, supportedLevels: readonly ButlerThinkingLevel[]): ButlerThinkingLevel | null {
  if (!level) return null;
  if (level === "xhigh" && supportedLevels.includes("max") && !supportedLevels.includes("xhigh")) return "max";
  return level;
}

export function displayThinkingLevelForModelOption(level: PiThinkingLevel | ButlerThinkingLevel | null | undefined, model: ModelOption | null | undefined): ButlerThinkingLevel | null {
  if (!level) return null;
  const transports = model?.thinkingLevelTransports;
  if (transports) {
    for (const [display, transport] of Object.entries(transports)) {
      if (transport === level) return display as ButlerThinkingLevel;
    }
  }
  return displayThinkingLevelForPiLevel(level as ButlerThinkingLevel, model?.supportedThinkingLevels ?? []);
}
