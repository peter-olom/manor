import manifestJson from "./model-input-capabilities.json" with { type: "json" };

export type ImageInputCapability = "supported" | "unsupported" | "unknown";
export type InputCapabilitySource = "override" | "provider" | "manifest" | "unknown";

export type ModelInputCapabilities = {
  image: ImageInputCapability;
  source: InputCapabilitySource;
};

export type ModelInputCapabilityOverride = ImageInputCapability | null | undefined;

type ManifestModelCapability = {
  aliases?: string[];
  input: string[];
  providerOverrides?: Record<string, { input: string[] }>;
};

type ModelInputCapabilityManifest = {
  catalogVersion: string;
  models: Record<string, ManifestModelCapability>;
};

const manifest = manifestJson as ModelInputCapabilityManifest;

function normalize(value: string): string {
  return value.trim().toLowerCase().replace(/_/g, "-");
}

function candidateIds(modelId: string, provider?: string | null): string[] {
  const id = normalize(modelId);
  const providerId = normalize(provider ?? "");
  const withoutProvider = providerId && id.startsWith(`${providerId}/`)
    ? id.slice(providerId.length + 1)
    : id;
  const leaf = withoutProvider.split("/").filter(Boolean).at(-1) ?? withoutProvider;
  return Array.from(new Set([id, withoutProvider, leaf].filter(Boolean)));
}

const manifestByAlias = new Map<string, ManifestModelCapability>();
for (const [canonicalId, entry] of Object.entries(manifest.models)) {
  for (const alias of [canonicalId, ...(entry.aliases ?? [])]) {
    manifestByAlias.set(normalize(alias), entry);
  }
}

function imageCapability(input: readonly string[]): Exclude<ImageInputCapability, "unknown"> {
  return input.some((entry) => normalize(entry) === "image") ? "supported" : "unsupported";
}

function manifestEntry(modelId: string, provider?: string | null): ManifestModelCapability | null {
  return candidateIds(modelId, provider)
    .map((candidate) => manifestByAlias.get(candidate))
    .find(Boolean) ?? null;
}

function providerOverride(entry: ManifestModelCapability, provider?: string | null): { input: string[] } | undefined {
  const providerId = normalize(provider ?? "");
  if (!providerId) return undefined;
  return Object.entries(entry.providerOverrides ?? {})
    .find(([key]) => normalize(key) === providerId)?.[1];
}

export function resolveModelInputCapabilities(input: {
  modelId: string;
  provider?: string | null;
  providerInputModalities?: readonly string[] | null;
  override?: ModelInputCapabilityOverride;
}): ModelInputCapabilities {
  if (input.override) {
    return { image: input.override, source: "override" };
  }

  if (input.providerInputModalities) {
    return { image: imageCapability(input.providerInputModalities), source: "provider" };
  }

  const entry = manifestEntry(input.modelId, input.provider);
  if (entry) {
    const routeOverride = providerOverride(entry, input.provider);
    return { image: imageCapability(routeOverride?.input ?? entry.input), source: "manifest" };
  }

  return { image: "unknown", source: "unknown" };
}

export function modelInputCapabilityCatalogVersion(): string {
  return manifest.catalogVersion;
}
