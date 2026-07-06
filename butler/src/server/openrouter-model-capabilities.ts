import {
  mergeModelCapabilityMetadata,
  modelAliases,
  thinkingLevelMapFromSupportedEfforts,
  type ModelCapabilityMetadata
} from "./model-capabilities.js";
import type { SettingsProviderModel } from "../shared/settings.js";

type OpenRouterReasoning = {
  supported_efforts?: string[] | null;
};

type OpenRouterModel = {
  id?: string;
  canonical_slug?: string;
  context_length?: number;
  top_provider?: {
    context_length?: number;
  } | null;
  supported_parameters?: string[];
  reasoning?: OpenRouterReasoning | null;
};

type CacheEntry = {
  fetchedAt: number;
  models: Map<string, ModelCapabilityMetadata>;
  inFlight: Promise<Map<string, ModelCapabilityMetadata>> | null;
};

export type OpenRouterCapabilitiesState = "idle" | "loading" | "ready" | "error";

const OPENROUTER_MODELS_URL = "https://openrouter.ai/api/v1/models";
const CACHE_TTL_MS = 60 * 60 * 1000;
let cache: CacheEntry | null = null;
let state: OpenRouterCapabilitiesState = "idle";

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Timed out loading OpenRouter model capabilities.")), timeoutMs);
    promise.then(resolve, reject).finally(() => clearTimeout(timeout));
  });
}

function capabilityAliases(model: OpenRouterModel): string[] {
  return Array.from(new Set([
    ...(model.id ? modelAliases(model.id) : []),
    ...(model.canonical_slug ? modelAliases(model.canonical_slug) : [])
  ]));
}

function modelCapability(model: OpenRouterModel): ModelCapabilityMetadata | null {
  const reasoning = model.reasoning ?? null;
  const supportedEfforts = reasoning && Object.hasOwn(reasoning, "supported_efforts") ? reasoning.supported_efforts ?? null : undefined;
  const thinkingLevelMap = supportedEfforts !== undefined ? thinkingLevelMapFromSupportedEfforts(supportedEfforts) : undefined;
  const supportsReasoning = Boolean(thinkingLevelMap);
  if (!supportsReasoning && !model.context_length && !model.top_provider?.context_length) return null;
  return {
    reasoning: supportsReasoning || undefined,
    contextWindow: model.top_provider?.context_length ?? model.context_length,
    thinkingLevelMap,
    compat: thinkingLevelMap ? { supportsReasoningEffort: true } : undefined,
    __source: "openrouter"
  };
}

async function fetchOpenRouterCapabilities(timeoutMs: number): Promise<Map<string, ModelCapabilityMetadata>> {
  const response = await fetch(OPENROUTER_MODELS_URL, { signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) throw new Error(`Failed to load OpenRouter model capabilities (HTTP ${response.status}).`);
  const payload = await response.json() as { data?: OpenRouterModel[] };
  const models = new Map<string, ModelCapabilityMetadata>();
  for (const model of payload.data ?? []) {
    const capability = modelCapability(model);
    if (!capability) continue;
    for (const alias of capabilityAliases(model)) {
      models.set(alias, capability);
    }
  }
  return models;
}

export function getOpenRouterCapabilitiesState(): OpenRouterCapabilitiesState {
  return state;
}

export async function fetchOpenRouterModelCapabilitiesCached(options: { timeoutMs?: number; force?: boolean } = {}): Promise<Map<string, ModelCapabilityMetadata>> {
  const now = Date.now();
  if (!options.force && cache && now - cache.fetchedAt < CACHE_TTL_MS && !cache.inFlight) {
    state = "ready";
    return cache.models;
  }
  if (!options.force && cache?.inFlight) {
    state = "loading";
    return options.timeoutMs ? withTimeout(cache.inFlight, options.timeoutMs) : cache.inFlight;
  }

  const timeoutMs = options.timeoutMs ?? 2_000;
  state = "loading";
  const inFlight = fetchOpenRouterCapabilities(timeoutMs)
    .then((models) => {
      cache = { fetchedAt: Date.now(), models, inFlight: null };
      state = "ready";
      return models;
    })
    .catch((error) => {
      cache = cache ? { ...cache, inFlight: null } : null;
      state = "error";
      throw error;
    });
  cache = { fetchedAt: cache?.fetchedAt ?? 0, models: cache?.models ?? new Map(), inFlight };
  return options.timeoutMs ? withTimeout(inFlight, options.timeoutMs) : inFlight;
}

export async function enrichModelsWithOpenRouterCapabilities(
  models: SettingsProviderModel[],
  options: { timeoutMs?: number } = {}
): Promise<SettingsProviderModel[]> {
  const capabilities = await fetchOpenRouterModelCapabilitiesCached(options).catch(() => new Map<string, ModelCapabilityMetadata>());
  return models.map((model) => {
    const id = typeof model === "string" ? model : model.id;
    const metadata = modelAliases(id).map((alias) => capabilities.get(alias)).find(Boolean);
    return metadata ? mergeModelCapabilityMetadata(model, metadata) : model;
  });
}

export function clearOpenRouterModelCapabilitiesCache(): void {
  cache = null;
  state = "idle";
}