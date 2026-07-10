import type { PairCodexModelOption, PairWorker } from "../shared/pairing";

const PROVIDER_LABELS: Record<string, string> = {
  "openai-codex": "OpenAI / Codex",
  openai: "OpenAI / Codex",
  "ollama-local": "Ollama Local",
  "ollama-cloud": "Ollama Cloud",
  "opencode-go": "OpenCode Go"
};

export function workerProviderLabel(provider: string | null | undefined): string {
  return provider ? PROVIDER_LABELS[provider] ?? provider : "Unknown provider";
}

export function workerProviderForModelLabel(model: PairCodexModelOption): string {
  return model.provider ? workerProviderLabel(model.provider) : PROVIDER_LABELS["openai-codex"];
}

export function workerRuntimeLabel(runtime: PairWorker["runtime"]): string {
  if (runtime === "pi-rpc") return "Pi";
  if (runtime === "openai") return "Codex";
  return "Unknown harness";
}

export function workerRuntimeForModel(model: PairCodexModelOption): "openai" | "pi-rpc" {
  if (!model.provider) return "openai";
  if (model.provider === "openai" || model.provider === "openai-codex") return "openai";
  return "pi-rpc";
}

export function workerModelLabel(models: PairCodexModelOption[], modelId: string | null | undefined): string {
  if (!modelId) return "Unknown model";
  return models.find((model) => model.id === modelId)?.label ?? modelId.split("/").at(-1) ?? modelId;
}
