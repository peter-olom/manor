import type { PairModelOption, PairWorkerHarness } from "../shared/pairing";

export type WorkerModelIdentity = {
  id: string;
  label: string;
  provider: string | null;
  harness?: PairWorkerHarness | null;
};

const PROVIDER_LABELS: Record<string, string> = {
  "openai-codex": "OpenAI",
  openai: "OpenAI",
  "ollama-local": "Ollama Local",
  "ollama-cloud": "Ollama Cloud",
  "opencode-go": "OpenCode Go"
};

export function workerProviderLabel(provider: string | null | undefined): string {
  return provider ? PROVIDER_LABELS[provider] ?? provider : "Unknown provider";
}

export function providerModelRef(provider: string | null | undefined, model: string | null | undefined): string {
  if (!model) return provider ?? "";
  if (!provider || model.startsWith(`${provider}/`)) return model;
  return `${provider}/${model}`;
}

export function workerProviderForModelLabel(model: WorkerModelIdentity): string {
  return workerProviderLabel(model.provider);
}

export function workerHarnessForModel(model: WorkerModelIdentity): PairWorkerHarness | null {
  return model.harness ?? null;
}

export function workerModelSelectionId(model: Pick<WorkerModelIdentity, "id">): string {
  return encodeURIComponent(model.id);
}

export function workerModelPickerOption<T extends WorkerModelIdentity>(model: T): T & { selectionId: string; hint: string } {
  return {
    ...model,
    selectionId: workerModelSelectionId(model),
    hint: workerProviderForModelLabel(model)
  };
}

export function workerModelForSelection<T extends WorkerModelIdentity>(models: readonly T[], selectionId: string | null | undefined): T | null {
  if (!selectionId) return null;
  return models.find((model) => workerModelSelectionId(model) === selectionId) ?? null;
}

export function workerModelForRoute<T extends WorkerModelIdentity>(models: readonly T[], modelId: string | null | undefined, harness: PairWorkerHarness | null | undefined): T | null {
  if (!modelId) return null;
  return models.find((model) => model.id === modelId) ?? null;
}

export function workerModelSelectionValue(models: readonly WorkerModelIdentity[], modelId: string | null | undefined, harness: PairWorkerHarness | null | undefined): string | null {
  const model = workerModelForRoute(models, modelId, harness);
  return model ? workerModelSelectionId(model) : null;
}

export function isSameWorkerRoute(model: Pick<WorkerModelIdentity, "id" | "harness">, modelId: string | null | undefined, harness: PairWorkerHarness | null | undefined): boolean {
  return model.id === modelId;
}

export function workerModelLabel(models: PairModelOption[], modelId: string | null | undefined, harness?: PairWorkerHarness | null): string {
  if (!modelId) return "Unknown model";
  return workerModelForRoute(models, modelId, harness)?.label ?? modelId.split("/").at(-1) ?? modelId;
}
