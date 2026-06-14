import { normalizeMemoryCodexModel } from "./memory-codex-model.js";

export function resolveMemorySynthesisModel(env: NodeJS.ProcessEnv = process.env): string | null {
  return normalizeMemoryCodexModel(env.MANOR_MEMORY_SYNTHESIS_MODEL ?? env.MANOR_MEMORY_EXEC_MODEL);
}
