import { promises as fs } from "node:fs";
import path from "node:path";

import { AuthStorage, ModelRegistry } from "@earendil-works/pi-coding-agent";
import type { Api, Model } from "@earendil-works/pi-ai";
import { getModels } from "@earendil-works/pi-ai/compat";

import { getActiveManorSettings, readSecretSourceValue } from "./manor-settings-runtime.js";
import { assertOllamaLocalBaseUrl, fetchOllamaLocalModels } from "./ollama-local-models.js";
import { fetchOllamaCloudModelsCached } from "./ollama-cloud-models.js";
import { fetchOpencodeGoModelsCached, opencodeGoModelToProviderInput } from "./opencode-go-models.js";
import { compareModelIdsAscending } from "./model-id-sort.js";
import { resolveModelInputCapabilities } from "./model-input-capabilities.js";
import {
  getModelCapabilityMetadata,
  mergeThinkingLevelMaps,
  ollamaOpenAiThinkingMetadata
} from "./model-capabilities.js";
import { opencodeOpenAiCompatibleModelMetadata } from "./opencode-openai-compatible-transform.js";
import { enrichModelsWithOpenRouterCapabilities } from "./openrouter-model-capabilities.js";
import type { SettingsSecretSource } from "../shared/settings.js";
import type { PiThinkingLevel } from "./pi-thinking-levels.js";
import type { ButlerThinkingLevel, ModelOption, ReasoningEffort } from "./types.js";

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

export function shouldExposeManorModel(model: { provider: string | null }, env: NodeJS.ProcessEnv = process.env): boolean {
  const settings = getActiveManorSettings(env);
  switch (model.provider) {
    case settings.providers.ollamaLocal.providerId:
    case "ollama-local":
      return settings.providers.ollamaLocal.enabled;
    case settings.providers.ollamaCloud.providerId:
    case "ollama-cloud":
      return settings.providers.ollamaCloud.enabled;
    case settings.providers.opencodeGo.providerId:
    case "opencode-go":
      return settings.providers.opencodeGo.enabled;
    case "opencode":
      return false;
    default:
      return true;
  }
}

const PI_THINKING_LEVEL_ORDER: PiThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh"];
const EXPLICIT_ONLY_PI_THINKING_LEVELS = new Set<PiThinkingLevel>(["xhigh"]);

function isReasoningEffort(value: ButlerThinkingLevel): value is ReasoningEffort {
  return value === "none" || value === "minimal" || value === "low" || value === "medium" || value === "high" || value === "xhigh" || value === "max";
}

function displayThinkingLevelForTransportLevel(level: PiThinkingLevel, mapped: string | null | undefined): ButlerThinkingLevel {
  if (level === "off" && mapped === "none") return "off";
  if (mapped === "default" || mapped === "none" || mapped === "thinking" || mapped === "max") return mapped;
  return level;
}

function nativeThinkingFormat(model: Model<Api>): string | null {
  const value = (model.compat as { nativeThinkingFormat?: unknown } | undefined)?.nativeThinkingFormat;
  return typeof value === "string" ? value : null;
}

/**
 * Derive the picker-facing thinking levels from Manor's richer map instead of
 * Pi's helper. Pi currently understands the common levels only, while Manor and
 * OpenCode both need to preserve provider-specific levels such as `max`.
 *
 * The compatibility rule intentionally matches Pi for ordinary models: when a
 * reasoning model has no explicit map, `minimal` through `high` remain
 * available and `xhigh` is opt-in. If a provider maps Pi's `xhigh` transport
 * level to native `max`, Manor displays that option as `max` so the picker
 * shows provider semantics instead of Pi's implementation detail.
 */
function supportedThinkingLevelsForModel(model: Model<Api>): { levels: ButlerThinkingLevel[]; transports: Partial<Record<ButlerThinkingLevel, PiThinkingLevel>> } {
  if (!model.reasoning) return { levels: [], transports: {} };
  const thinkingLevelMap = (model as { thinkingLevelMap?: Partial<Record<ButlerThinkingLevel, string | null>> }).thinkingLevelMap;
  const levels: ButlerThinkingLevel[] = [];
  const transports: Partial<Record<ButlerThinkingLevel, PiThinkingLevel>> = {};
  for (const level of PI_THINKING_LEVEL_ORDER) {
    const mapped = thinkingLevelMap?.[level];
    if (mapped === null) continue;
    if (EXPLICIT_ONLY_PI_THINKING_LEVELS.has(level) && mapped === undefined) continue;
    const displayLevel = displayThinkingLevelForTransportLevel(level, mapped);
    if (!levels.includes(displayLevel)) {
      levels.push(displayLevel);
      transports[displayLevel] = level;
    }
  }
  return { levels, transports };
}

export function modelToModelOption(model: Model<Api>): ModelOption {
  const { levels: supportedThinkingLevels, transports } = supportedThinkingLevelsForModel(model);
  const exposesNativeThinkingVariants = nativeThinkingFormat(model) !== null;
  const supportedReasoningEfforts = exposesNativeThinkingVariants
    ? []
    : supportedThinkingLevels.filter(isReasoningEffort);
  const registeredInputCapabilities = (model.compat as {
    manorInputCapabilities?: ModelOption["inputCapabilities"];
  } | undefined)?.manorInputCapabilities;
  return {
    id: model.id,
    label: model.name || model.id,
    provider: model.provider,
    inputCapabilities: registeredInputCapabilities ?? resolveModelInputCapabilities({
      modelId: model.id,
      provider: model.provider,
      providerInputModalities: model.input
    }),
    supportsReasoning: model.reasoning,
    supportedThinkingLevels,
    supportedReasoningEfforts,
    defaultReasoningEffort: supportedReasoningEfforts.includes("medium") ? "medium" : supportedReasoningEfforts[0] ?? null,
    thinkingLevelTransports: transports
  };
}

type ProviderModelEntry = {
  id: string;
  api?: string | null;
  input?: ("text" | "image")[] | null;
  reasoning?: boolean | null;
  contextWindow: number | null;
  thinkingLevelMap?: Partial<Record<ButlerThinkingLevel, string | null>>;
  compat?: Record<string, unknown>;
};

type ProviderModelInput = string | {
  id: string;
  api?: string | null;
  input?: ("text" | "image")[] | null;
  reasoning?: boolean | null;
  contextWindow?: number | null;
  thinkingLevelMap?: Partial<Record<ButlerThinkingLevel, string | null>>;
  compat?: Record<string, unknown>;
};

function modelInputId(entry: ProviderModelInput): string {
  return typeof entry === "string" ? entry : entry.id;
}

function sortModelInputsAscending(models: ProviderModelInput[]): ProviderModelInput[] {
  return [...models].sort((left, right) => compareModelIdsAscending(modelInputId(left), modelInputId(right)));
}

function resolveModelEntry(entry: ProviderModelInput): ProviderModelEntry {
  if (typeof entry === "string") {
    return { id: entry, contextWindow: null };
  }
  return {
    id: entry.id,
    api: entry.api ?? null,
    input: entry.input ?? null,
    reasoning: entry.reasoning ?? null,
    contextWindow: typeof entry.contextWindow === "number" && Number.isFinite(entry.contextWindow) ? entry.contextWindow : null,
    thinkingLevelMap: entry.thinkingLevelMap,
    compat: entry.compat
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

const CONFIGURED_PROVIDER_DISCOVERY_TIMEOUT_MS = 1_500;
const MANOR_MANAGED_PROVIDER_IDS_KEY = "manorManagedProviderIds";

/**
 * Build the Pi provider config Manor registers at runtime or writes to
 * models.json. Most providers benefit from Pi's built-in catalog as a metadata
 * base, but OpenCode Go deliberately opts out because its subscription model
 * list can move faster than Pi's generated registry. For that provider, live
 * OpenCode discovery plus the provider-specific adapter is the authority.
 */
function buildProviderConfig(provider: CloudLikeProvider, apiKey: string, options: { useBuiltInModels?: boolean } = {}) {
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
  const builtInModels = new Map<string, Model<Api>>();
  if (options.useBuiltInModels !== false) {
    try {
      for (const model of getModels(provider.providerId as never)) {
        builtInModels.set(model.id, model);
      }
    } catch { /* provider not in built-in catalog */ }
  }
  return {
    name: provider.providerName,
    baseUrl: provider.baseUrl,
    api: provider.api as Api,
    apiKey,
    authHeader: provider.authHeader ?? true,
    compat: compat as never,
    models: provider.models.map((entry) => {
      const resolved = resolveModelEntry(entry);
      const builtIn = builtInModels.get(resolved.id);
      const capabilities = getModelCapabilityMetadata(resolved.id);
      const inputCapabilities = resolveModelInputCapabilities({
        modelId: resolved.id,
        provider: provider.providerId,
        providerInputModalities: resolved.input ?? builtIn?.input
      });
      const thinkingLevelMap = mergeThinkingLevelMaps(
        builtIn?.thinkingLevelMap,
        capabilities?.thinkingLevelMap,
        resolved.thinkingLevelMap
      );
      const modelCompat = {
        ...(builtIn?.compat ?? {}),
        ...compat,
        ...(capabilities?.compat ?? {}),
        ...(resolved.compat ?? {}),
        manorInputCapabilities: inputCapabilities
      };
      return {
        id: resolved.id,
        name: builtIn?.name ?? modelName(resolved.id),
        reasoning: resolved.reasoning ?? builtIn?.reasoning ?? capabilities?.reasoning ?? provider.reasoning,
        thinkingLevelMap,
        input: inputCapabilities.image === "supported" ? ["text", "image"] : ["text"],
        contextWindow: resolved.contextWindow ?? builtIn?.contextWindow ?? capabilities?.contextWindow ?? provider.contextWindow,
        maxTokens: builtIn?.maxTokens ?? provider.maxTokens,
        cost: builtIn?.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        api: (resolved.api ?? builtIn?.api ?? provider.api) as Api,
        compat: modelCompat
      } as never;
    })
  };
}

type ResolvedProviderConfig = ReturnType<typeof buildProviderConfig>;

async function modelsJsonApiKey(provider: CloudLikeProvider, env: NodeJS.ProcessEnv, actualApiKey: string): Promise<string> {
  const source = provider.apiKeySource;
  if (!source) return actualApiKey;
  if (source.type === "env") return `$${source.name}`;
  if (source.type === "file" && /^[A-Za-z_][A-Za-z0-9_]*$/.test(source.pathEnv)) {
    return `!sh -c 'cat "$${source.pathEnv}"'`;
  }
  return actualApiKey;
}

async function resolveOllamaLocalProviderModels(provider: OllamaLocalProvider): Promise<ProviderModelInput[]> {
  if (provider.models.length > 0) return provider.models;
  const discovered = await fetchOllamaLocalModels({ nativeBaseUrl: provider.nativeBaseUrl, timeoutMs: 2_500 }).catch(() => []);
  return discovered.map((model) => {
    const metadata = ollamaOpenAiThinkingMetadata(model.capabilities);
    return {
      id: model.id,
      input: model.capabilities.length > 0
        ? model.capabilities.includes("vision") ? ["text", "image"] : ["text"]
        : null,
      contextWindow: model.contextWindow,
      reasoning: metadata?.reasoning ?? null,
      thinkingLevelMap: metadata?.thinkingLevelMap,
      compat: metadata?.compat
    };
  });
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

function mergeDiscoveredModels(configured: ProviderModelInput[], discovered: ProviderModelInput[]): ProviderModelInput[] {
  if (discovered.length === 0) return configured;
  const configuredById = new Map(configured.map((entry) => [modelInputId(entry), entry]));
  return discovered.map((entry) => {
    const id = modelInputId(entry);
    const configuredEntry = configuredById.get(id);
    if (!configuredEntry) return entry;
    if (typeof configuredEntry === "string" && typeof entry === "string") return entry;
    const configuredObject = typeof configuredEntry === "string" ? { id: configuredEntry } : configuredEntry;
    const discoveredObject = typeof entry === "string" ? { id: entry } : entry;
    return {
      ...discoveredObject,
      ...configuredObject,
      contextWindow: configuredObject.contextWindow ?? discoveredObject.contextWindow ?? null
    };
  });
}

function withOllamaCloudOpenCodeMetadata(entry: ProviderModelInput): ProviderModelInput {
  const base = typeof entry === "string" ? { id: entry } : entry;
  if (base.reasoning === false) return base;
  const metadata = opencodeOpenAiCompatibleModelMetadata(base.id);
  return {
    ...base,
    reasoning: base.reasoning ?? metadata.reasoning ?? null,
    thinkingLevelMap: mergeThinkingLevelMaps(metadata.thinkingLevelMap, base.thinkingLevelMap),
    compat: metadata.compat || base.compat
      ? { ...(metadata.compat ?? {}), ...(base.compat ?? {}) }
      : undefined
  };
}

async function buildOllamaCloudProviderConfig(provider: CloudLikeProvider, env: NodeJS.ProcessEnv, options: { forModelsJson?: boolean } = {}): Promise<ResolvedProviderConfig | null> {
  if (!provider.enabled) return null;
  const apiKey = provider.apiKeySource ? await readSecretSourceValue(provider.apiKeySource, env) : null;
  if (!apiKey) return null;
  const settings = getActiveManorSettings(env);
  const discovered = await fetchOllamaCloudModelsCached(settings, {
    env,
    timeoutMs: CONFIGURED_PROVIDER_DISCOVERY_TIMEOUT_MS
  }).catch(() => []);
  let models = provider.models;
  models = mergeDiscoveredModels(models, discovered.map((model) => {
    const metadata = model.capabilities?.some((entry) => entry.trim().toLowerCase() === "thinking")
      ? opencodeOpenAiCompatibleModelMetadata(model.id)
      : ollamaOpenAiThinkingMetadata(model.capabilities);
    return {
      id: model.id,
      input: model.capabilities
        ? model.capabilities.includes("vision") ? ["text", "image"] : ["text"]
        : null,
      contextWindow: model.contextWindow,
      reasoning: metadata?.reasoning ?? null,
      thinkingLevelMap: metadata?.thinkingLevelMap,
      compat: metadata?.compat
    };
  }));
  if (models.length === 0) return null;
  models = await enrichModelsWithOpenRouterCapabilities(models, { timeoutMs: CONFIGURED_PROVIDER_DISCOVERY_TIMEOUT_MS })
    .catch(() => models);
  models = sortModelInputsAscending(models.map(withOllamaCloudOpenCodeMetadata));
  const configApiKey = options.forModelsJson ? await modelsJsonApiKey(provider, env, apiKey) : apiKey;
  return buildProviderConfig({
    ...provider,
    models,
    reasoning: false,
    supportsReasoningEffort: true
  }, configApiKey, { useBuiltInModels: false });
}

async function registerOllamaCloudProvider(registry: ModelRegistry, provider: CloudLikeProvider, env: NodeJS.ProcessEnv): Promise<boolean> {
  const config = await buildOllamaCloudProviderConfig(provider, env);
  if (!config) return false;
  registry.registerProvider(provider.providerId, config as never);
  return true;
}

async function buildOpencodeGoProviderConfig(provider: CloudLikeProvider, env: NodeJS.ProcessEnv, options: { forModelsJson?: boolean } = {}): Promise<ResolvedProviderConfig | null> {
  if (!provider.enabled) return null;
  const apiKey = provider.apiKeySource ? await readSecretSourceValue(provider.apiKeySource, env) : null;
  if (!apiKey) return null;
  const settings = getActiveManorSettings(env);
  const discovered = await fetchOpencodeGoModelsCached(settings, {
    env,
    timeoutMs: CONFIGURED_PROVIDER_DISCOVERY_TIMEOUT_MS
  }).catch(() => []);
  const discoveredModels = discovered.map(opencodeGoModelToProviderInput);
  if (discoveredModels.length === 0) return null;
  const models = mergeDiscoveredModels(provider.models, discoveredModels);
  const configApiKey = options.forModelsJson ? await modelsJsonApiKey(provider, env, apiKey) : apiKey;
  return buildProviderConfig({ ...provider, models }, configApiKey);
}

async function registerOpencodeGoProvider(registry: ModelRegistry, provider: CloudLikeProvider, env: NodeJS.ProcessEnv): Promise<boolean> {
  const config = await buildOpencodeGoProviderConfig(provider, env);
  if (!config) return false;
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
  await registerOpencodeGoProvider(registry, settings.providers.opencodeGo as CloudLikeProvider, env);
}

function registryHasModel(registry: ModelRegistry, reference: string): boolean {
  const ref = parseProviderModelRef(reference);
  if (!ref.model) return true;
  return registry.getAvailable().some((model) =>
    model.id === ref.model && (!ref.provider || model.provider === ref.provider));
}

async function recoverPreferredDynamicModel(
  reference: string,
  env: NodeJS.ProcessEnv,
  timeoutMs: number
): Promise<void> {
  const ref = parseProviderModelRef(reference);
  if (!ref.provider || !ref.model) return;
  const settings = getActiveManorSettings(env);
  if (ref.provider === settings.providers.ollamaCloud.providerId) {
    await fetchOllamaCloudModelsCached(settings, { env, timeoutMs }).catch(() => []);
  } else if (ref.provider === settings.providers.opencodeGo.providerId) {
    await fetchOpencodeGoModelsCached(settings, { env, timeoutMs }).catch(() => []);
  }
}

export async function createManorModelRegistry(
  piAuthPath: string,
  env: NodeJS.ProcessEnv = process.env,
  options: { preferredModelRef?: string | null; recoveryTimeoutMs?: number } = {}
): Promise<ModelRegistry> {
  const buildRegistry = async () => {
    const registry = ModelRegistry.inMemory(AuthStorage.create(piAuthPath));
    await registerManorProviders(registry, env);
    return registry;
  };
  let registry = await buildRegistry();
  const preferredModelRef = options.preferredModelRef?.trim() ?? "";
  if (preferredModelRef && !registryHasModel(registry, preferredModelRef)) {
    await recoverPreferredDynamicModel(preferredModelRef, env, options.recoveryTimeoutMs ?? 10_000);
    registry = await buildRegistry();
  }
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

function readManagedProviderIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0);
}

export async function syncManorPiModelsJson(piAuthPath: string, env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
  const settings = getActiveManorSettings(env);
  const localProvider = settings.providers.ollamaLocal as OllamaLocalProvider;
  const cloudProvider = settings.providers.ollamaCloud as CloudLikeProvider;
  const opencodeProvider = settings.providers.opencodeGo as CloudLikeProvider;
  const localConfig = await buildOllamaLocalProviderConfig(localProvider, env);
  const cloudConfig = await buildOllamaCloudProviderConfig(cloudProvider, env, { forModelsJson: true });
  const opencodeConfig = await buildOpencodeGoProviderConfig(opencodeProvider, env, { forModelsJson: true });
  const managedProviders = [
    [localProvider.providerId, localConfig],
    [cloudProvider.providerId, cloudConfig],
    [opencodeProvider.providerId, opencodeConfig]
  ] as const;
  const managedProviderIds = new Set([
    "ollama-local",
    "ollama-cloud",
    "opencode-go",
    localProvider.providerId,
    cloudProvider.providerId,
    opencodeProvider.providerId
  ]);
  const enabledProviders = managedProviders.filter((entry): entry is readonly [string, ResolvedProviderConfig] => Boolean(entry[1]));

  const agentDir = path.dirname(piAuthPath);
  const modelsPath = path.join(agentDir, "models.json");
  const { current, currentText } = await readModelsJsonObject(modelsPath);
  if (enabledProviders.length === 0 && currentText === null) return false;
  const providers = isJsonObject(current.providers) ? { ...current.providers } : {};
  for (const providerId of readManagedProviderIds(current[MANOR_MANAGED_PROVIDER_IDS_KEY])) {
    managedProviderIds.add(providerId);
  }
  for (const providerId of managedProviderIds) {
    delete providers[providerId];
  }
  for (const [providerId, config] of enabledProviders) {
    providers[providerId] = config;
  }
  const next: Record<string, unknown> = { ...current, providers };
  if (enabledProviders.length > 0) {
    next[MANOR_MANAGED_PROVIDER_IDS_KEY] = enabledProviders.map(([providerId]) => providerId);
  } else {
    delete next[MANOR_MANAGED_PROVIDER_IDS_KEY];
  }
  const nextText = `${JSON.stringify(next, null, 2)}\n`;
  if (currentText === nextText) return false;
  await fs.mkdir(agentDir, { recursive: true });
  await fs.writeFile(modelsPath, nextText, "utf8");
  return true;
}
