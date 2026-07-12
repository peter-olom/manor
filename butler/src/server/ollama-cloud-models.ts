import { readSecretSourceValue } from "./manor-settings-runtime.js";
import { compareModelIdsAscending } from "./model-id-sort.js";
import type { ManorSettings } from "../shared/settings.js";

export type OllamaCloudModelInfo = {
  id: string;
  contextWindow: number | null;
  capabilities: string[] | null;
};

type FetchJsonResult<T> = { ok: boolean; status: number; data: T | null; text: string };

async function fetchJson<T>(url: string, init: RequestInit, timeoutMs: number): Promise<FetchJsonResult<T>> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    const text = await response.text().catch(() => "");
    let data: T | null = null;
    try { data = text ? JSON.parse(text) as T : null; } catch { /* keep null */ }
    return { ok: response.ok, status: response.status, data, text };
  } finally {
    clearTimeout(timeout);
  }
}

function stringArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  return value
    .filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
    .map((entry) => entry.trim());
}

function contextWindowFromModelInfo(value: unknown): number | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  for (const key of Object.keys(value)) {
    if (!key.endsWith(".context_length")) continue;
    const candidate = (value as Record<string, unknown>)[key];
    if (typeof candidate === "number" && Number.isFinite(candidate)) return candidate;
  }
  return null;
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Timed out listing Ollama Cloud models.")), timeoutMs);
    promise.then(resolve, reject).finally(() => clearTimeout(timeout));
  });
}

async function fetchOllamaCloudModelsOnce(settings: ManorSettings, env: NodeJS.ProcessEnv, timeoutMs = 30_000): Promise<OllamaCloudModelInfo[]> {
  const config = settings.providers.ollamaCloud;
  const apiKey = await readSecretSourceValue(config.apiKeySource, env);
  if (!apiKey) throw new Error("No Ollama Cloud API key is available from the configured secret source.");
  const nativeBase = config.webTools.baseUrl.replace(/\/$/, "");
  const headers = { "Authorization": `Bearer ${apiKey}` };

  const tagsRes = await fetchJson<{ models?: { name?: string; model?: string }[] }>(`${nativeBase}/tags`, { method: "GET", headers }, timeoutMs);
  if (!tagsRes.ok || !tagsRes.data?.models) {
    throw new Error(`Failed to list Ollama Cloud models (HTTP ${tagsRes.status}): ${tagsRes.text.slice(0, 800)}`);
  }

  const modelNames = Array.from(new Set(tagsRes.data.models
    .map((m) => m.name ?? m.model)
    .filter((name): name is string => Boolean(name))))
    .sort(compareModelIdsAscending);

  const infos = await Promise.all(modelNames.map(async (name) => {
    try {
      const showRes = await fetchJson<{ capabilities?: string[]; model_info?: Record<string, unknown> }>(`${nativeBase}/show`, {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({ model: name })
      }, Math.min(timeoutMs, 15_000));
      if (showRes.ok) {
        return {
          id: name,
          capabilities: stringArray(showRes.data?.capabilities),
          contextWindow: contextWindowFromModelInfo(showRes.data?.model_info)
        } as OllamaCloudModelInfo;
      }
      return { id: name, contextWindow: null, capabilities: null } as OllamaCloudModelInfo;
    } catch {
      return { id: name, contextWindow: null, capabilities: null } as OllamaCloudModelInfo;
    }
  }));

  return infos.sort((left, right) => compareModelIdsAscending(left.id, right.id));
}

type CacheEntry = {
  models: OllamaCloudModelInfo[];
  fetchedAt: number;
  inFlight: Promise<OllamaCloudModelInfo[]> | null;
};

const CACHE_TTL_MS = 10 * 60 * 1000;
let cache: CacheEntry | null = null;
let cacheGeneration = 0;

export function getCachedOllamaCloudModels(): OllamaCloudModelInfo[] {
  return cache?.models ?? [];
}

export async function fetchOllamaCloudModelsCached(settings: ManorSettings, options: { force?: boolean; env?: NodeJS.ProcessEnv; timeoutMs?: number; requestTimeoutMs?: number } = {}): Promise<OllamaCloudModelInfo[]> {
  const now = Date.now();
  if (!options.force && cache && now - cache.fetchedAt < CACHE_TTL_MS && cache.inFlight === null) {
    return cache.models;
  }
  if (cache?.inFlight) {
    if (!options.timeoutMs) return cache.inFlight;
    return withTimeout(cache.inFlight, options.timeoutMs).catch((error) => {
      if (cache?.models.length) return cache.models;
      throw error;
    });
  }
  const staleModels = cache?.models ?? [];
  const staleFetchedAt = cache?.fetchedAt ?? 0;
  const generation = cacheGeneration;
  const inFlight = fetchOllamaCloudModelsOnce(settings, options.env ?? process.env, options.requestTimeoutMs)
    .then((models) => {
      if (generation === cacheGeneration) {
        cache = { models, fetchedAt: Date.now(), inFlight: null };
      }
      return models;
    })
    .catch((error) => {
      if (generation === cacheGeneration) {
        cache = { models: staleModels, fetchedAt: staleFetchedAt, inFlight: null };
      }
      if (staleModels.length > 0) return staleModels;
      throw error;
    });
  cache = { models: staleModels, fetchedAt: staleFetchedAt, inFlight };
  if (!options.timeoutMs) return inFlight;
  return withTimeout(inFlight, options.timeoutMs).catch((error) => {
    if (staleModels.length) return staleModels;
    throw error;
  });
}

export function clearOllamaCloudModelsCache(): void {
  cacheGeneration += 1;
  cache = null;
}
