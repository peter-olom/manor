import { promises as fs } from "node:fs";

import { AuthStorage, ModelRegistry } from "@mariozechner/pi-coding-agent";
import type { Api, Model } from "@mariozechner/pi-ai";

import type { ModelOption } from "./types.js";

export type ProviderModelRef = {
  provider: string | null;
  model: string | null;
};

const DEFAULT_OLLAMA_CLOUD_MODELS = [
  "gpt-oss:120b",
  "glm-5.2",
  "kimi-k2.6",
  "qwen3.5",
  "deepseek-v4-flash",
  "minimax-m3"
];

function envBool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value.trim() === "") return fallback;
  const normalized = value.trim().toLowerCase();
  return normalized !== "0" && normalized !== "false" && normalized !== "off" && normalized !== "no";
}

function splitCsv(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

async function readSecretValue(env: NodeJS.ProcessEnv, key: string, fileKey: string): Promise<string | null> {
  const direct = env[key]?.trim();
  if (direct) return direct;

  const filePath = env[fileKey]?.trim();
  if (!filePath) return null;
  const content = await fs.readFile(filePath, "utf8").catch(() => "");
  return content.trim() || null;
}

function modelName(modelId: string): string {
  return modelId
    .replace(/[-_:]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (value) => value.toUpperCase()) || modelId;
}

export function parseProviderModelRef(value: string | null | undefined): ProviderModelRef {
  const trimmed = value?.trim() ?? "";
  if (!trimmed) return { provider: null, model: null };
  const slash = trimmed.indexOf("/");
  if (slash <= 0 || slash === trimmed.length - 1) return { provider: null, model: trimmed };
  return {
    provider: trimmed.slice(0, slash),
    model: trimmed.slice(slash + 1)
  };
}

export function formatProviderModelRef(ref: ProviderModelRef): string | null {
  if (!ref.model) return null;
  return ref.provider ? `${ref.provider}/${ref.model}` : ref.model;
}

export function isCodexPreferredModelRef(ref: string | ProviderModelRef | null | undefined): boolean {
  const parsed = typeof ref === "string" ? parseProviderModelRef(ref) : (ref ?? { provider: null, model: null });
  if (!parsed.provider) return true;
  return parsed.provider === "openai" || parsed.provider === "openai-codex" || parsed.provider === "codex";
}

export function modelToModelOption(model: Model<Api>): ModelOption {
  const thinkingLevels = model.reasoning ? Object.entries(model.thinkingLevelMap ?? {})
    .filter(([, value]) => value !== null)
    .map(([level]) => level)
    .filter((level) => level !== "off" && level !== "minimal") : [];
  const supportedReasoningEfforts = thinkingLevels.length > 0 ? thinkingLevels : model.reasoning ? ["low", "medium", "high", "xhigh"] : [];
  return {
    id: model.id,
    label: model.name || model.id,
    provider: model.provider,
    supportsReasoning: model.reasoning,
    supportedReasoningEfforts: supportedReasoningEfforts as ModelOption["supportedReasoningEfforts"],
    defaultReasoningEffort: supportedReasoningEfforts.includes("medium") ? "medium" as never : (supportedReasoningEfforts[0] as never) ?? null
  };
}

export async function registerManorProviders(registry: ModelRegistry, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  if (!envBool(env.MANOR_OLLAMA_CLOUD_ENABLED, true)) {
    return;
  }

  const apiKey = await readSecretValue(env, "OLLAMA_API_KEY", "OLLAMA_API_KEY_FILE");
  if (!apiKey) {
    return;
  }

  const providerName = env.MANOR_OLLAMA_CLOUD_PROVIDER_ID?.trim() || "ollama-cloud";
  const baseUrl = env.MANOR_OLLAMA_CLOUD_BASE_URL?.trim() || "https://ollama.com/v1";
  const models = splitCsv(env.MANOR_OLLAMA_CLOUD_MODELS);
  const modelIds = models.length > 0 ? models : DEFAULT_OLLAMA_CLOUD_MODELS;
  const contextWindow = Number.isFinite(Number(env.MANOR_OLLAMA_CLOUD_CONTEXT_WINDOW))
    ? Math.max(8_192, Number(env.MANOR_OLLAMA_CLOUD_CONTEXT_WINDOW))
    : 131_072;
  const maxTokens = Number.isFinite(Number(env.MANOR_OLLAMA_CLOUD_MAX_TOKENS))
    ? Math.max(1_024, Number(env.MANOR_OLLAMA_CLOUD_MAX_TOKENS))
    : 32_768;

  const config = {
    name: env.MANOR_OLLAMA_CLOUD_PROVIDER_NAME?.trim() || "Ollama Cloud",
    baseUrl,
    api: (env.MANOR_OLLAMA_CLOUD_API?.trim() || "openai-completions") as Api,
    apiKey,
    authHeader: true,
    compat: {
      supportsDeveloperRole: envBool(env.MANOR_OLLAMA_CLOUD_SUPPORTS_DEVELOPER_ROLE, false),
      supportsReasoningEffort: envBool(env.MANOR_OLLAMA_CLOUD_SUPPORTS_REASONING_EFFORT, false)
    } as never,
    models: modelIds.map((id) => ({
      id,
      name: modelName(id),
      reasoning: envBool(env.MANOR_OLLAMA_CLOUD_REASONING, true),
      input: ["text"],
      contextWindow,
      maxTokens,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
    }))
  };

  registry.registerProvider(providerName, config as never);
}

export async function createManorModelRegistry(piAuthPath: string, env: NodeJS.ProcessEnv = process.env): Promise<ModelRegistry> {
  const registry = ModelRegistry.inMemory(AuthStorage.create(piAuthPath));
  await registerManorProviders(registry, env);
  return registry;
}
