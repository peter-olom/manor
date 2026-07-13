import manifestJson from "./model-cost-estimates.json" with { type: "json" };

import type { PricingModel } from "./model-usage.js";

type ManifestEntry = {
  aliases?: string[];
  publisher: string;
  rateModel: string;
  asOf: string;
  sourceUrl: string;
  free?: boolean;
  cachePolicy?: "published" | "input-rate";
  cost: PricingModel["cost"];
};

type Manifest = {
  catalogVersion: string;
  models: Record<string, ManifestEntry>;
};

export type ModelCostEstimate = ManifestEntry & { canonicalId: string };

const manifest = manifestJson as Manifest;

function normalize(value: string): string {
  return value.trim().toLowerCase().replace(/_/g, "-");
}

function candidates(modelId: string): string[] {
  const id = normalize(modelId);
  const leaf = id.split("/").filter(Boolean).at(-1) ?? id;
  return Array.from(new Set([id, leaf].filter(Boolean)));
}

const byAlias = new Map<string, ModelCostEstimate>();
for (const [canonicalId, entry] of Object.entries(manifest.models)) {
  const estimate = { ...entry, canonicalId };
  for (const alias of [canonicalId, ...(entry.aliases ?? [])]) byAlias.set(normalize(alias), estimate);
}

export function resolveModelCostEstimate(modelId: string): ModelCostEstimate | null {
  return candidates(modelId).map((candidate) => byAlias.get(candidate)).find(Boolean) ?? null;
}

export function modelCostEstimateCatalogVersion(): string {
  return manifest.catalogVersion;
}

export function modelCostEstimateCatalogFingerprint(): string {
  return JSON.stringify(manifest);
}
