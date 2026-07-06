import crypto from "node:crypto";

import { readSecretSourceValue } from "./manor-settings-runtime.js";
import type { ManorSettings, SettingsProviderModel, SettingsThinkingLevel } from "../shared/settings.js";

export type OpencodeGoModelInfo = { id: string };

type FetchJsonResult<T> = { ok: boolean; status: number; data: T | null; text: string };

const OPENCODE_GO_GLM52_THINKING_LEVEL_MAP = {
  off: null,
  none: null,
  minimal: null,
  low: null,
  medium: null,
  high: "high",
  xhigh: "max"
} satisfies Partial<Record<SettingsThinkingLevel, string | null>>;

const OPENCODE_GO_NO_VARIANT_THINKING_LEVEL_MAP = {
  off: null,
  minimal: null,
  low: null,
  medium: null,
  high: null,
  xhigh: null
} satisfies Partial<Record<SettingsThinkingLevel, string | null>>;

const OPENCODE_GO_STANDARD_REASONING_LEVEL_MAP = {
  off: null,
  minimal: null,
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: null
} satisfies Partial<Record<SettingsThinkingLevel, string | null>>;

const OPENCODE_GO_DEEPSEEK_V4_REASONING_LEVEL_MAP = {
  off: null,
  minimal: null,
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: "max"
} satisfies Partial<Record<SettingsThinkingLevel, string | null>>;

const OPENCODE_GO_NORTH_MINI_CODE_REASONING_LEVEL_MAP = {
  off: "none",
  minimal: null,
  low: null,
  medium: null,
  high: "high",
  xhigh: null
} satisfies Partial<Record<SettingsThinkingLevel, string | null>>;

const OPENCODE_GO_MINIMAX_M3_THINKING_LEVEL_MAP = {
  off: "default",
  minimal: "none",
  low: null,
  medium: null,
  high: null,
  xhigh: "thinking"
} satisfies Partial<Record<SettingsThinkingLevel, string | null>>;

/**
 * Return whether OpenCode's transform layer treats the model as a GLM-5.2
 * variant. OpenCode currently accepts the dotted, dashed, and compact spellings
 * because different upstream providers expose the same model family under
 * slightly different IDs.
 */
function isGlm52ModelId(id: string): boolean {
  const normalized = id.toLowerCase();
  return ["glm-5.2", "glm-5-2", "glm-5p2"].some((alias) => normalized.includes(alias));
}

/**
 * Return whether OpenCode's OpenAI-compatible transform deliberately exposes no
 * selectable variants for the model family. These models may still reason, but
 * OpenCode does not let the user choose a reasoning effort because the upstream
 * either ignores that knob, controls thinking through a provider-specific body
 * field, or enables thinking by model default.
 */
function opencodeGoSuppressesSelectableVariants(id: string): boolean {
  return id.includes("deepseek-chat") ||
    id.includes("deepseek-reasoner") ||
    id.includes("deepseek-r1") ||
    id.includes("deepseek-v3") ||
    id.includes("minimax") ||
    (id.includes("glm") && !isGlm52ModelId(id)) ||
    id.includes("kimi") ||
    id.includes("k2p") ||
    id.includes("qwen") ||
    id.includes("big-pickle") ||
    (id.includes("grok") && !id.includes("grok-3-mini"));
}

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
  const normalized = id.toLowerCase();
  if (normalized.includes("minimax-m3")) {
    return {
      reasoning: true,
      thinkingLevelMap: OPENCODE_GO_MINIMAX_M3_THINKING_LEVEL_MAP,
      compat: { supportsReasoningEffort: true, nativeThinkingFormat: "minimax-m3" }
    };
  }
  if (isGlm52ModelId(id)) {
    return {
      reasoning: true,
      thinkingLevelMap: OPENCODE_GO_GLM52_THINKING_LEVEL_MAP,
      compat: { supportsReasoningEffort: true }
    };
  }
  if (normalized.includes("grok-3-mini")) {
    return {
      reasoning: true,
      thinkingLevelMap: {
        off: null,
        minimal: null,
        low: "low",
        medium: null,
        high: "high",
        xhigh: null
      },
      compat: { supportsReasoningEffort: true }
    };
  }
  if (opencodeGoSuppressesSelectableVariants(normalized)) {
    return {
      reasoning: true,
      thinkingLevelMap: OPENCODE_GO_NO_VARIANT_THINKING_LEVEL_MAP,
      compat: { supportsReasoningEffort: false }
    };
  }
  if (normalized.includes("north-mini-code")) {
    return {
      reasoning: true,
      thinkingLevelMap: OPENCODE_GO_NORTH_MINI_CODE_REASONING_LEVEL_MAP,
      compat: { supportsReasoningEffort: true }
    };
  }
  if (normalized.includes("deepseek-v4")) {
    return {
      reasoning: true,
      thinkingLevelMap: OPENCODE_GO_DEEPSEEK_V4_REASONING_LEVEL_MAP,
      compat: { supportsReasoningEffort: true }
    };
  }
  return {
    reasoning: true,
    thinkingLevelMap: OPENCODE_GO_STANDARD_REASONING_LEVEL_MAP,
    compat: { supportsReasoningEffort: true }
  };
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

const MODEL_TIER_RANK: Record<string, number> = {
  max: 90,
  ultra: 80,
  pro: 70,
  plus: 60,
  code: 50,
  omni: 45,
  flash: 40,
  mini: 30,
  small: 20,
  preview: 10
};

function modelFamilyPrefix(id: string): string {
  return id.toLowerCase().match(/^[^0-9]+/)?.[0] ?? id.toLowerCase();
}

function modelVersionParts(id: string): number[] {
  return Array.from(id.matchAll(/\d+(?:\.\d+)*/g))
    .flatMap((match) => match[0].split(".").map((part) => Number(part)))
    .filter((value) => Number.isFinite(value));
}

function modelTierRank(id: string): number {
  const tokens = id.toLowerCase().split(/[^a-z0-9]+/g);
  return tokens.reduce((score, token) => Math.max(score, MODEL_TIER_RANK[token] ?? 0), 0);
}

function compareNumberArraysAscending(left: readonly number[], right: readonly number[]): number {
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index++) {
    const leftPart = left[index] ?? -1;
    const rightPart = right[index] ?? -1;
    if (leftPart !== rightPart) return leftPart - rightPart;
  }
  return 0;
}

function compareModelIdsAscending(left: string, right: string): number {
  const leftFamily = modelFamilyPrefix(left);
  const rightFamily = modelFamilyPrefix(right);
  if (leftFamily === rightFamily) {
    const versionOrder = compareNumberArraysAscending(modelVersionParts(left), modelVersionParts(right));
    if (versionOrder !== 0) return versionOrder;
    const tierOrder = modelTierRank(left) - modelTierRank(right);
    if (tierOrder !== 0) return tierOrder;
  }
  return left.localeCompare(right, undefined, { numeric: true, sensitivity: "base" });
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

export async function fetchOpencodeGoModelsCached(settings: ManorSettings, options: { force?: boolean; env?: NodeJS.ProcessEnv; timeoutMs?: number } = {}): Promise<OpencodeGoModelInfo[]> {
  const apiKey = await readSecretSourceValue(settings.providers.opencodeGo.apiKeySource, options.env ?? process.env);
  if (!apiKey) throw new Error("No OpenCode Go API key is available from the configured secret source.");
  const key = cacheKey(settings, apiKey);
  const entry = cache.get(key) ?? null;
  const now = Date.now();
  if (!options.force && entry && now - entry.fetchedAt < CACHE_TTL_MS && entry.inFlight === null) {
    return entry.models;
  }
  if (entry?.inFlight) {
    return options.timeoutMs ? withTimeout(entry.inFlight, options.timeoutMs) : entry.inFlight;
  }
  const generation = cacheGeneration;
  const inFlight = fetchOpencodeGoModelsOnce(settings, apiKey, options.timeoutMs)
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
      throw error;
    });
  cache.set(key, { models: entry?.models ?? [], fetchedAt: entry?.fetchedAt ?? 0, inFlight });
  return options.timeoutMs ? withTimeout(inFlight, options.timeoutMs) : inFlight;
}

export function clearOpencodeGoModelsCache(): void {
  cacheGeneration += 1;
  cache.clear();
}
