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
  return normalizeMemoryCodexModel(env.MANOR_MEMORY_SYNTHESIS_MODEL);
}

export function resolveMemoryServiceModel(serviceModel: string | null | undefined, defaultModel: string | null | undefined): string | null {
  return normalizeMemoryCodexModel(serviceModel) ?? normalizeMemoryCodexModel(defaultModel);
}

export function readMemorySynthesisConfig(env: NodeJS.ProcessEnv = process.env): MemorySynthesisConfig {
  return {
    enabled: boolFromEnv(env.MANOR_MEMORY_SYNTHESIS_ENABLED, true),
    model: resolveMemorySynthesisModel(env),
    effort: effortFromEnv(env.MANOR_MEMORY_SYNTHESIS_EFFORT),
    timeoutMs: intFromEnv(env.MANOR_MEMORY_SYNTHESIS_TIMEOUT_MS, 90_000, 5_000, 10 * 60_000),
    maxInputChars: intFromEnv(env.MANOR_MEMORY_SYNTHESIS_MAX_INPUT_CHARS, 16_000, 2_000, 200_000),
    maxCandidatesPerRun: intFromEnv(env.MANOR_MEMORY_SYNTHESIS_MAX_CANDIDATES, 6, 1, 50),
    promotionAutoResolve: boolFromEnv(env.MANOR_MEMORY_PROMOTION_AUTO_RESOLVE, true),
    promotionBatchSize: intFromEnv(env.MANOR_MEMORY_PROMOTION_BATCH_SIZE, 20, 1, 50),
    promotionMaxBatchesPerRun: intFromEnv(env.MANOR_MEMORY_PROMOTION_MAX_BATCHES_PER_RUN, 10, 1, 25),
    promotionIntervalMs: intFromEnv(env.MANOR_MEMORY_PROMOTION_INTERVAL_MS, 10_000, 1_000, 5 * 60_000),
    semanticEdgeReviewEnabled: boolFromEnv(env.MANOR_MEMORY_SEMANTIC_EDGES_ENABLED, true),
    semanticEdgeReviewBatchSize: intFromEnv(env.MANOR_MEMORY_SEMANTIC_EDGES_BATCH_SIZE, 12, 1, 50),
    semanticEdgeReviewIntervalMs: intFromEnv(env.MANOR_MEMORY_SEMANTIC_EDGES_INTERVAL_MS, 60_000, 5_000, 30 * 60_000)
  };
}
