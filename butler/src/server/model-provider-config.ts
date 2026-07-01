import { AuthStorage, ModelRegistry } from "@mariozechner/pi-coding-agent";
import type { Api, Model } from "@mariozechner/pi-ai";

import { getActiveManorSettings, readSecretSourceValue } from "./manor-settings-runtime.js";
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

export async function registerManorProviders(registry: ModelRegistry, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const settings = getActiveManorSettings(env);
  const ollamaCloud = settings.providers.ollamaCloud;
  if (!ollamaCloud.enabled) {
    return;
  }

  const apiKey = await readSecretSourceValue(ollamaCloud.apiKeySource, env);
  if (!apiKey) {
    return;
  }

  const config = {
    name: ollamaCloud.providerName,
    baseUrl: ollamaCloud.baseUrl,
    api: ollamaCloud.api as Api,
    apiKey,
    authHeader: true,
    compat: {
      supportsDeveloperRole: ollamaCloud.supportsDeveloperRole,
      supportsReasoningEffort: ollamaCloud.supportsReasoningEffort
    } as never,
    models: ollamaCloud.models.map((id) => ({
      id,
      name: modelName(id),
      reasoning: ollamaCloud.reasoning,
      input: ["text"],
      contextWindow: ollamaCloud.contextWindow,
      maxTokens: ollamaCloud.maxTokens,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
    }))
  };

  registry.registerProvider(ollamaCloud.providerId, config as never);
}

export async function createManorModelRegistry(piAuthPath: string, env: NodeJS.ProcessEnv = process.env): Promise<ModelRegistry> {
  const registry = ModelRegistry.inMemory(AuthStorage.create(piAuthPath));
  await registerManorProviders(registry, env);
  return registry;
}
