import { normalizeMemoryCodexModel } from "./memory-codex-model.js";
import type { MemorySynthesisConfig } from "./types.js";

function boolFromEnv(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value === "") return fallback;
  return value !== "0" && value.toLowerCase() !== "false" && value.toLowerCase() !== "off";
}

function intFromEnv(value: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(parsed)));
}

function effortFromEnv(value: string | undefined): MemorySynthesisConfig["effort"] {
  return value === "low" || value === "medium" || value === "high" ? value : null;
}

export function resolveMemorySynthesisModel(env: NodeJS.ProcessEnv = process.env): string | null {
  return normalizeMemoryCodexModel(env.MANOR_MEMORY_SYNTHESIS_MODEL ?? env.MANOR_MEMORY_EXEC_MODEL ?? env.MANOR_MEMORY_REVIEW_MODEL);
}

export function readMemorySynthesisConfig(env: NodeJS.ProcessEnv = process.env): MemorySynthesisConfig {
  return {
    enabled: boolFromEnv(env.MANOR_MEMORY_SYNTHESIS_ENABLED ?? env.MANOR_MEMORY_REVIEW_ENABLED, true),
    provider: "codex_exec",
    model: resolveMemorySynthesisModel(env),
    effort: effortFromEnv(env.MANOR_MEMORY_SYNTHESIS_EFFORT),
    timeoutMs: intFromEnv(env.MANOR_MEMORY_SYNTHESIS_TIMEOUT_MS, 90_000, 5_000, 10 * 60_000),
    maxInputChars: intFromEnv(env.MANOR_MEMORY_SYNTHESIS_MAX_INPUT_CHARS, 16_000, 2_000, 200_000),
    maxCandidatesPerRun: intFromEnv(env.MANOR_MEMORY_SYNTHESIS_MAX_CANDIDATES, 6, 1, 50),
    autoPromoteHighConfidence: boolFromEnv(env.MANOR_MEMORY_SYNTHESIS_AUTO_PROMOTE_HIGH_CONFIDENCE, false)
  };
}
