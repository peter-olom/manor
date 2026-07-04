import { promises as fs } from "node:fs";
import path from "node:path";

import { AuthStorage, ModelRegistry } from "@mariozechner/pi-coding-agent";
import type { Api, Model } from "@mariozechner/pi-ai";

import { getActiveManorSettings, readSecretSourceValue } from "./manor-settings-runtime.js";
import { assertOllamaLocalBaseUrl, fetchOllamaLocalModels } from "./ollama-local-models.js";
import { fetchOllamaCloudModelsCached } from "./ollama-cloud-models.js";
import type { SettingsSecretSource } from "../shared/settings.js";
import type { ModelOption } from "./types.js";

export type ProviderModelRef = {
  provider: string | null;
  model: string | null;
};

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
  const model = trimmed.slice(slash + 1);
  let decodedModel = model;
  try {
    decodedModel = decodeURIComponent(model);
  } catch {
    decodedModel = model;
  }
  return {
    provider: trimmed.slice(0, slash),
    model: decodedModel
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

type ProviderModelEntry = {
  id: string;
  api: string;
  reasoning: boolean;
  contextWindow: number | null;
};

type ProviderModelInput = string | {
  id: string;
  api?: string | null;
  reasoning?: boolean | null;
  contextWindow?: number | null;
};

function resolveModelEntry(entry: ProviderModelInput, providerApi: string, providerReasoning: boolean): ProviderModelEntry {
  if (typeof entry === "string") {
    return { id: entry, api: providerApi, reasoning: providerReasoning, contextWindow: null };
  }
  return {
    id: entry.id,
    api: entry.api ?? providerApi,
    reasoning: entry.reasoning ?? providerReasoning,
    contextWindow: typeof entry.contextWindow === "number" && Number.isFinite(entry.contextWindow) ? entry.contextWindow : null
  };
}

type CloudLikeProvider = {
  enabled: boolean;
  providerId: string;
  providerName: string;
  baseUrl: string;
  api: string;
  models: ProviderModelInput[];
  contextWindow: number;
  maxTokens: number;
  reasoning: boolean;
  supportsDeveloperRole: boolean;
  supportsReasoningEffort: boolean;
  apiKeySource?: SettingsSecretSource | null;
  authHeader?: boolean;
  maxTokensField?: "max_tokens" | "max_completion_tokens";
};

type OllamaLocalProvider = CloudLikeProvider & {
  nativeBaseUrl: string;
};

function buildProviderConfig(provider: CloudLikeProvider, apiKey: string) {
  const maxTokensField = provider.maxTokensField ?? (
    provider.providerId.includes("ollama") || provider.baseUrl.includes("ollama")
      ? "max_tokens"
      : undefined
  );
  const compat = {
    supportsDeveloperRole: provider.supportsDeveloperRole,
    supportsReasoningEffort: provider.supportsReasoningEffort,
    ...(maxTokensField ? { maxTokensField } : {})
  };
  return {
    name: provider.providerName,
    baseUrl: provider.baseUrl,
    api: provider.api as Api,
    apiKey,
    authHeader: provider.authHeader ?? true,
    compat: compat as never,
    models: provider.models.map((entry) => {
      const resolved = resolveModelEntry(entry, provider.api, provider.reasoning);
      return {
        id: resolved.id,
        name: modelName(resolved.id),
        reasoning: resolved.reasoning,
        input: ["text"],
        contextWindow: resolved.contextWindow ?? provider.contextWindow,
        maxTokens: provider.maxTokens,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        api: resolved.api as Api,
        compat
      } as never;
    })
  };
}

type ResolvedProviderConfig = ReturnType<typeof buildProviderConfig>;

async function resolveOllamaLocalProviderModels(provider: OllamaLocalProvider): Promise<ProviderModelInput[]> {
  if (provider.models.length > 0) return provider.models;
  const discovered = await fetchOllamaLocalModels({ nativeBaseUrl: provider.nativeBaseUrl, timeoutMs: 2_500 }).catch(() => []);
  return discovered.map((model) => ({ id: model.id, contextWindow: model.contextWindow }));
}

async function buildOllamaLocalProviderConfig(provider: OllamaLocalProvider, env: NodeJS.ProcessEnv): Promise<ResolvedProviderConfig | null> {
  if (!provider.enabled) return null;
  try {
    assertOllamaLocalBaseUrl(provider.baseUrl, "Ollama Local OpenAI-compatible base URL");
    assertOllamaLocalBaseUrl(provider.nativeBaseUrl, "Ollama Local native base URL");
  } catch {
    return null;
  }
  const models = await resolveOllamaLocalProviderModels(provider);
  if (models.length === 0) return null;
  const apiKey = provider.apiKeySource ? await readSecretSourceValue(provider.apiKeySource, env) : null;
  return buildProviderConfig({ ...provider, models }, apiKey || "ollama");
}

async function registerCloudLikeProvider(registry: ModelRegistry, provider: CloudLikeProvider, env: NodeJS.ProcessEnv): Promise<boolean> {
  if (!provider.enabled) return false;
  if (provider.models.length === 0) return false;
  const apiKey = provider.apiKeySource ? await readSecretSourceValue(provider.apiKeySource, env) : null;
  if (!apiKey) return false;
  const config = buildProviderConfig(provider, apiKey);
  registry.registerProvider(provider.providerId, config as never);
  return true;
}

async function registerOllamaCloudProvider(registry: ModelRegistry, provider: CloudLikeProvider, env: NodeJS.ProcessEnv): Promise<boolean> {
  if (!provider.enabled) return false;
  const apiKey = provider.apiKeySource ? await readSecretSourceValue(provider.apiKeySource, env) : null;
  if (!apiKey) return false;
  let models = provider.models;
  if (models.length === 0) {
    const discovered = await fetchOllamaCloudModelsCached(getActiveManorSettings(env)).catch(() => []);
    if (discovered.length === 0) return false;
    models = discovered.map((model) => ({ id: model.id, contextWindow: model.contextWindow }));
  }
  const config = buildProviderConfig({ ...provider, models }, apiKey);
  registry.registerProvider(provider.providerId, config as never);
  return true;
}

async function registerOllamaLocalProvider(registry: ModelRegistry, provider: OllamaLocalProvider, env: NodeJS.ProcessEnv): Promise<boolean> {
  const config = await buildOllamaLocalProviderConfig(provider, env);
  if (!config) return false;
  registry.registerProvider(provider.providerId, config as never);
  return true;
}

export async function registerManorProviders(registry: ModelRegistry, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const settings = getActiveManorSettings(env);
  await registerOllamaLocalProvider(registry, settings.providers.ollamaLocal as OllamaLocalProvider, env);
  await registerOllamaCloudProvider(registry, settings.providers.ollamaCloud as CloudLikeProvider, env);
  await registerCloudLikeProvider(registry, settings.providers.opencodeGo as CloudLikeProvider, env);
}

export async function createManorModelRegistry(piAuthPath: string, env: NodeJS.ProcessEnv = process.env): Promise<ModelRegistry> {
  const registry = ModelRegistry.inMemory(AuthStorage.create(piAuthPath));
  await registerManorProviders(registry, env);
  return registry;
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

async function readModelsJsonObject(filePath: string): Promise<{ current: Record<string, unknown>; currentText: string | null }> {
  let text: string;
  try {
    text = await fs.readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { current: {}, currentText: null };
    throw error;
  }

  try {
    const parsed: unknown = JSON.parse(text);
    if (!isJsonObject(parsed)) throw new Error("root value must be an object");
    return { current: parsed, currentText: text };
  } catch {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    await fs.writeFile(`${filePath}.invalid-${stamp}`, text, "utf8").catch(() => undefined);
    return { current: {}, currentText: null };
  }
}

export async function syncManorPiModelsJson(piAuthPath: string, env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
  const settings = getActiveManorSettings(env);
  const localProvider = settings.providers.ollamaLocal as OllamaLocalProvider;
  const localConfig = await buildOllamaLocalProviderConfig(localProvider, env);
  if (!localConfig) return false;

  const agentDir = path.dirname(piAuthPath);
  const modelsPath = path.join(agentDir, "models.json");
  const { current, currentText } = await readModelsJsonObject(modelsPath);
  const providers = isJsonObject(current.providers) ? { ...current.providers } : {};
  providers[localProvider.providerId] = localConfig;
  const next = { ...current, providers };
  const nextText = `${JSON.stringify(next, null, 2)}\n`;
  if (currentText === nextText) return false;
  await fs.mkdir(agentDir, { recursive: true });
  await fs.writeFile(modelsPath, nextText, "utf8");
  return true;
}
