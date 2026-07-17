import { modelAliases } from "./model-capabilities.js";

function modelLeaf(id: string): string {
  return modelAliases(id).at(-1) ?? id.trim().toLowerCase();
}

function providerFromModelRef(id: string): string | null {
  const normalized = id.trim().toLowerCase();
  const slash = normalized.indexOf("/");
  return slash > 0 ? normalized.slice(0, slash) : null;
}

function isOpenAiRuntimeProvider(provider: string | null | undefined): boolean {
  return provider === "openai" || provider === "openai-codex";
}

function isCodexManagedRegularGptModel(id: string, provider: string | null | undefined): boolean {
  if (provider && !isOpenAiRuntimeProvider(provider)) return false;
  const leaf = modelLeaf(id);
  return /^gpt-\d/.test(leaf) && !leaf.includes("codex") && !leaf.includes("oss");
}

function compareVersion(left: number[], right: number[]): number {
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const delta = (left[index] ?? 0) - (right[index] ?? 0);
    if (delta !== 0) return delta;
  }
  return 0;
}

export function isChatGptSubscriptionModelAvailable(model: { id: string; provider?: string | null }): boolean {
  const provider = model.provider ?? providerFromModelRef(model.id);
  if (provider && !isOpenAiRuntimeProvider(provider)) return true;
  const leaf = modelLeaf(model.id);
  const match = leaf.match(/^gpt-(\d+(?:\.\d+)*)(.*)$/);
  if (!match) return true;
  const version = match[1]!.split(".").map((part) => Number.parseInt(part, 10)).filter(Number.isFinite);
  const minimumVersion = [5, 3];
  const comparison = compareVersion(version, minimumVersion);
  if (comparison < 0) return false;
  if (comparison > 0) return true;
  const suffix = match[2]!.toLowerCase();
  return suffix.includes("codex") && suffix.includes("spark");
}

export { isCodexManagedRegularGptModel, isOpenAiRuntimeProvider };
