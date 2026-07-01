import { normalizeMemoryCodexModel } from "./memory-codex-model.js";
import { getActiveManorSettings } from "./manor-settings-runtime.js";
import type { MemorySynthesisConfig } from "./types.js";

export function resolveMemorySynthesisModel(env: NodeJS.ProcessEnv = process.env): string | null {
  return normalizeMemoryCodexModel(getActiveManorSettings(env).modelTasks.memorySynthesisModel);
}

export function resolveMemoryServiceModel(serviceModel: string | null | undefined, defaultModel: string | null | undefined): string | null {
  return normalizeMemoryCodexModel(serviceModel) ?? normalizeMemoryCodexModel(defaultModel);
}

export function readMemorySynthesisConfig(env: NodeJS.ProcessEnv = process.env): MemorySynthesisConfig {
  const settings = getActiveManorSettings(env);
  const memory = settings.memory;
  return {
    enabled: memory.synthesisEnabled,
    model: resolveMemorySynthesisModel(env),
    effort: memory.synthesisEffort,
    timeoutMs: memory.synthesisTimeoutMs,
    maxInputChars: memory.synthesisMaxInputChars,
    maxCandidatesPerRun: memory.synthesisMaxCandidatesPerRun,
    promotionAutoResolve: memory.promotionAutoResolve,
    promotionBatchSize: memory.promotionBatchSize,
    promotionMaxBatchesPerRun: memory.promotionMaxBatchesPerRun,
    promotionIntervalMs: memory.promotionIntervalMs,
    semanticEdgeReviewEnabled: memory.semanticEdgeReviewEnabled,
    semanticEdgeReviewBatchSize: memory.semanticEdgeReviewBatchSize,
    semanticEdgeReviewIntervalMs: memory.semanticEdgeReviewIntervalMs
  };
}
