import { AuthStorage, ModelRegistry } from "@mariozechner/pi-coding-agent";
import type { Api, Model } from "@mariozechner/pi-ai";

import { getActiveManorSettings, readSecretSourceValue } from "./manor-settings-runtime.js";
import type { SettingsProviderModel, SettingsSecretSource } from "../shared/settings.js";
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

type ProviderModelEntry = {
  id: string;
  api: string;
  reasoning: boolean;
};

function resolveModelEntry(entry: SettingsProviderModel, providerApi: string, providerReasoning: boolean): ProviderModelEntry {
  if (typeof entry === "string") {
    return { id: entry, api: providerApi, reasoning: providerReasoning };
  }
  return {
    id: entry.id,
    api: entry.api ?? providerApi,
    reasoning: entry.reasoning ?? providerReasoning
  };
}

type CloudLikeProvider = {
  enabled: boolean;
  providerId: string;
  providerName: string;
  baseUrl: string;
  api: string;
  models: SettingsProviderModel[];
  contextWindow: number;
  maxTokens: number;
  reasoning: boolean;
  supportsDeveloperRole: boolean;
  supportsReasoningEffort: boolean;
  apiKeySource: SettingsSecretSource;
};

function buildProviderConfig(provider: CloudLikeProvider, apiKey: string) {
  return {
    name: provider.providerName,
    baseUrl: provider.baseUrl,
    api: provider.api as Api,
    apiKey,
    authHeader: true,
    compat: {
      supportsDeveloperRole: provider.supportsDeveloperRole,
      supportsReasoningEffort: provider.supportsReasoningEffort
    } as never,
    models: provider.models.map((entry) => {
      const resolved = resolveModelEntry(entry, provider.api, provider.reasoning);
      return {
        id: resolved.id,
        name: modelName(resolved.id),
        reasoning: resolved.reasoning,
        input: ["text"],
        contextWindow: provider.contextWindow,
        maxTokens: provider.maxTokens,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        api: resolved.api as Api
      } as never;
    })
  };
}

async function registerCloudLikeProvider(registry: ModelRegistry, provider: CloudLikeProvider, env: NodeJS.ProcessEnv): Promise<boolean> {
  if (!provider.enabled) return false;
  const apiKey = await readSecretSourceValue(provider.apiKeySource, env);
  if (!apiKey) return false;
  const config = buildProviderConfig(provider, apiKey);
  registry.registerProvider(provider.providerId, config as never);
  return true;
}

export async function registerManorProviders(registry: ModelRegistry, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const settings = getActiveManorSettings(env);
  await registerCloudLikeProvider(registry, settings.providers.ollamaCloud as CloudLikeProvider, env);
  await registerCloudLikeProvider(registry, settings.providers.opencodeGo as CloudLikeProvider, env);
}

export async function createManorModelRegistry(piAuthPath: string, env: NodeJS.ProcessEnv = process.env): Promise<ModelRegistry> {
  const registry = ModelRegistry.inMemory(AuthStorage.create(piAuthPath));
  await registerManorProviders(registry, env);
  return registry;
}
