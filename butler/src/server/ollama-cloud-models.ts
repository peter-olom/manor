import { readSecretSourceValue } from "./manor-settings-runtime.js";
import type { ManorSettings } from "../shared/settings.js";

export type OllamaCloudModelInfo = { id: string; contextWindow: number | null };

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

  const modelNames = tagsRes.data.models
    .map((m) => m.name ?? m.model)
    .filter((name): name is string => Boolean(name));

  const infos = await Promise.all(modelNames.map(async (name) => {
    try {
      const showRes = await fetchJson<{ model_info?: Record<string, unknown> }>(`${nativeBase}/show`, {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({ model: name })
      }, Math.min(timeoutMs, 15_000));
      let contextWindow: number | null = null;
      if (showRes.ok && showRes.data?.model_info) {
        for (const key of Object.keys(showRes.data.model_info)) {
          if (key.endsWith(".context_length")) {
            const val = showRes.data.model_info[key];
            if (typeof val === "number") { contextWindow = val; break; }
          }
        }
      }
      return { id: name, contextWindow } as OllamaCloudModelInfo;
    } catch {
      return { id: name, contextWindow: null } as OllamaCloudModelInfo;
    }
  }));

  return infos;
}

type CacheEntry = {
  models: OllamaCloudModelInfo[];
  fetchedAt: number;
  inFlight: Promise<OllamaCloudModelInfo[]> | null;
};

const CACHE_TTL_MS = 10 * 60 * 1000;
let cache: CacheEntry | null = null;

export function getCachedOllamaCloudModels(): OllamaCloudModelInfo[] {
  return cache?.models ?? [];
}

export async function fetchOllamaCloudModelsCached(settings: ManorSettings, options: { force?: boolean; env?: NodeJS.ProcessEnv; timeoutMs?: number } = {}): Promise<OllamaCloudModelInfo[]> {
  const now = Date.now();
  if (!options.force && cache && now - cache.fetchedAt < CACHE_TTL_MS && cache.inFlight === null) {
    return cache.models;
  }
  if (cache?.inFlight) {
    return options.timeoutMs ? withTimeout(cache.inFlight, options.timeoutMs) : cache.inFlight;
  }
  const inFlight = fetchOllamaCloudModelsOnce(settings, options.env ?? process.env, options.timeoutMs)
    .then((models) => {
      cache = { models, fetchedAt: Date.now(), inFlight: null };
      return models;
    })
    .catch((error) => {
      cache = { models: cache?.models ?? [], fetchedAt: cache?.fetchedAt ?? 0, inFlight: null };
      throw error;
    });
  cache = { models: cache?.models ?? [], fetchedAt: cache?.fetchedAt ?? 0, inFlight };
  return options.timeoutMs ? withTimeout(inFlight, options.timeoutMs) : inFlight;
}

export function clearOllamaCloudModelsCache(): void {
  cache = null;
}
