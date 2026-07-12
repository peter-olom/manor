import crypto from "node:crypto";

import { readSecretSourceValue } from "./manor-settings-runtime.js";
import { compareModelIdsAscending } from "./model-id-sort.js";
import { opencodeOpenAiCompatibleModelMetadata } from "./opencode-openai-compatible-transform.js";
import type { ManorSettings, SettingsProviderModel } from "../shared/settings.js";

export type OpencodeGoModelInfo = { id: string };

type FetchJsonResult<T> = { ok: boolean; status: number; data: T | null; text: string };

/**
 * Mirrors OpenCode's OpenAI-compatible variant transform for OpenCode Go.
 *
 * The live OpenCode Go model endpoint is the correct source for availability,
 * but it only returns OpenAI-style model records and does not include variants
 * or the models.dev reasoning metadata that OpenCode has before it calls its
 * transform layer. Pi's registry is convenient, but it can lag the subscription
 * and attach generic thinking levels that OpenCode itself does not expose.
 * Keeping this adapter provider-scoped lets Manor use live OpenCode Go
 * availability while still presenting the same thinking selector OpenCode would
 * compute for an OpenAI-compatible model.
 *
 * Pi cannot store `max`, `default`, or `thinking` as thinking level keys yet,
 * so native OpenCode variants are encoded over Pi's fixed transport levels.
 * Manor displays provider-native labels, Pi stores the transport value, and the
 * OpenCode Go extension restores the native request payload when a model needs
 * more than OpenAI-compatible `reasoning_effort`. When OpenCode returns an
 * empty variant set, we keep `reasoning: true` but expose no selectable levels.
 * That preserves reasoning-capable model metadata without inventing a request
 * parameter OpenCode would not send.
 */
export function opencodeGoModelMetadata(id: string): Omit<Exclude<SettingsProviderModel, string>, "id"> {
  return opencodeOpenAiCompatibleModelMetadata(id, { nativeMinimaxM3: true });
}

/**
 * Convert the live OpenCode Go model record into the provider model shape used
 * by Manor and Pi. This is intentionally small: OpenCode Go owns which models
 * are served, and this function only adds the local metadata that OpenCode's
 * public list endpoint omits.
 */
export function opencodeGoModelToProviderInput(model: OpencodeGoModelInfo): SettingsProviderModel {
  return {
    id: model.id,
    contextWindow: null,
    ...opencodeGoModelMetadata(model.id)
  };
}

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
    const timeout = setTimeout(() => reject(new Error("Timed out listing OpenCode Go models.")), timeoutMs);
    promise.then(resolve, reject).finally(() => clearTimeout(timeout));
  });
}

async function fetchOpencodeGoModelsOnce(settings: ManorSettings, apiKey: string, timeoutMs = 30_000): Promise<OpencodeGoModelInfo[]> {
  const config = settings.providers.opencodeGo;
  const base = config.baseUrl.replace(/\/$/, "");
  const res = await fetchJson<{ data?: { id?: string }[] }>(
    `${base}/models`,
    { method: "GET", headers: { "Authorization": `Bearer ${apiKey}` } },
    timeoutMs
  );
  if (!res.ok || !res.data?.data) {
    throw new Error(`Failed to list OpenCode Go models (HTTP ${res.status}): ${res.text.slice(0, 800)}`);
  }
  return Array.from(new Set(res.data.data
    .map((model) => model?.id)
    .filter((id): id is string => Boolean(id))))
    .sort(compareModelIdsAscending)
    .map((id) => ({ id }));
}

type CacheEntry = {
  models: OpencodeGoModelInfo[];
  fetchedAt: number;
  inFlight: Promise<OpencodeGoModelInfo[]> | null;
};

const CACHE_TTL_MS = 10 * 60 * 1000;
const cache = new Map<string, CacheEntry>();
let cacheGeneration = 0;

function cacheKey(settings: ManorSettings, apiKey: string): string {
  const config = settings.providers.opencodeGo;
  const keyHash = crypto.createHash("sha256").update(apiKey).digest("hex").slice(0, 16);
  return `${config.baseUrl.replace(/\/$/, "")}:${keyHash}`;
}

export async function fetchOpencodeGoModelsCached(settings: ManorSettings, options: { force?: boolean; env?: NodeJS.ProcessEnv; timeoutMs?: number; requestTimeoutMs?: number } = {}): Promise<OpencodeGoModelInfo[]> {
  const apiKey = await readSecretSourceValue(settings.providers.opencodeGo.apiKeySource, options.env ?? process.env);
  if (!apiKey) throw new Error("No OpenCode Go API key is available from the configured secret source.");
  const key = cacheKey(settings, apiKey);
  const entry = cache.get(key) ?? null;
  const now = Date.now();
  if (!options.force && entry && now - entry.fetchedAt < CACHE_TTL_MS && entry.inFlight === null) {
    return entry.models;
  }
  if (entry?.inFlight) {
    if (!options.timeoutMs) return entry.inFlight;
    return withTimeout(entry.inFlight, options.timeoutMs).catch((error) => {
      if (entry.models.length) return entry.models;
      throw error;
    });
  }
  const generation = cacheGeneration;
  const inFlight = fetchOpencodeGoModelsOnce(settings, apiKey, options.requestTimeoutMs)
    .then((models) => {
      if (generation === cacheGeneration) {
        cache.set(key, { models, fetchedAt: Date.now(), inFlight: null });
      }
      return models;
    })
    .catch((error) => {
      if (generation === cacheGeneration) {
        cache.set(key, { models: entry?.models ?? [], fetchedAt: entry?.fetchedAt ?? 0, inFlight: null });
      }
      if ((entry?.models.length ?? 0) > 0) return entry!.models;
      throw error;
    });
  cache.set(key, { models: entry?.models ?? [], fetchedAt: entry?.fetchedAt ?? 0, inFlight });
  if (!options.timeoutMs) return inFlight;
  return withTimeout(inFlight, options.timeoutMs).catch((error) => {
    if (entry?.models.length) return entry.models;
    throw error;
  });
}

export function clearOpencodeGoModelsCache(): void {
  cacheGeneration += 1;
  cache.clear();
}
