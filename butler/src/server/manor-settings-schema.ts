import type {
  ManorSettings,
  ManorSettingsProvenance,
  SettingsGroupKey,
  SettingsOpencodeWebTools,
  SettingsProvenance,
  SettingsProviderKey,
  SettingsProviderModel,
  SettingsReasoningEffort,
  SettingsSecretSource,
  SettingsThinkingLevel,
  SettingsValidationKey,
  SettingsValidationMap,
  SettingsWebTools,
  SettingsWorkerRuntime
} from "../shared/settings.js";

const DEFAULT_OLLAMA_CLOUD_MODELS: SettingsProviderModel[] = [];

const DEFAULT_OLLAMA_LOCAL_MODELS: SettingsProviderModel[] = [];

const DEFAULT_OPENCODE_GO_MODELS: SettingsProviderModel[] = [];

export const SETTINGS_GROUP_KEYS: SettingsGroupKey[] = [
  "overview",
  "providers.ollamaLocal",
  "providers.ollamaCloud",
  "providers.opencodeGo",
  "worker",
  "butler",
  "modelTasks",
  "memory",
  "embeddings"
];

export const SETTINGS_VALIDATION_KEYS: SettingsValidationKey[] = [
  "codex",
  "piRpc",
  "ollamaLocal",
  "ollamaCloud",
  "opencodeGo",
  "ollamaWebSearch",
  "ollamaWebFetch",
  "opencodeWebSearch",
  "opencodeWebFetch",
  "memoryEmbeddings"
];

export const DEFAULT_MANOR_SETTINGS: ManorSettings = {
  overview: {
    operatorName: "",
    butlerProvider: "openai-codex",
    codexProvider: "openai-codex"
  },
  providers: {
    ollamaLocal: {
      enabled: false,
      providerId: "ollama-local",
      providerName: "Ollama Local",
      baseUrl: "http://ollama:11434/v1",
      nativeBaseUrl: "http://ollama:11434",
      api: "openai-completions",
      models: DEFAULT_OLLAMA_LOCAL_MODELS,
      contextWindow: 65_536,
      maxTokens: 16_384,
      reasoning: true,
      supportsDeveloperRole: false,
      supportsReasoningEffort: false,
      apiKeySource: null,
      authHeader: false
    },
    ollamaCloud: {
      enabled: true,
      providerId: "ollama-cloud",
      providerName: "Ollama Cloud",
      baseUrl: "https://ollama.com/v1",
      api: "openai-completions",
      models: DEFAULT_OLLAMA_CLOUD_MODELS,
      contextWindow: 131_072,
      maxTokens: 32_768,
      reasoning: true,
      supportsDeveloperRole: false,
      supportsReasoningEffort: false,
      apiKeySource: { type: "env", name: "OLLAMA_API_KEY" },
      webTools: {
        enabled: true,
        baseUrl: "https://ollama.com/api",
        maxResults: 5,
        timeoutMs: 30_000,
        maxContentChars: 12_000,
        forAllPiModels: false
      }
    },
    opencodeGo: {
      enabled: true,
      providerId: "opencode-go",
      providerName: "OpenCode Go",
      baseUrl: "https://opencode.ai/zen/go/v1",
      api: "openai-completions",
      models: DEFAULT_OPENCODE_GO_MODELS,
      contextWindow: 131_072,
      maxTokens: 32_768,
      reasoning: true,
      supportsDeveloperRole: false,
      supportsReasoningEffort: false,
      apiKeySource: { type: "env", name: "OPENCODE_API_KEY" },
      webTools: {
        enabled: false,
        maxResults: 5,
        timeoutMs: 30_000,
        maxContentChars: 12_000
      }
    }
  },
  worker: {
    runtime: "auto",
    defaultModel: null,
    defaultEffort: null
  },
  butler: {
    defaultModel: null,
    defaultThinkingLevel: "medium"
  },
  modelTasks: {
    runnerMode: "auto",
    memorySynthesisModel: null,
    sessionTitleModel: null,
    sessionTitleTimeoutMs: 15_000,
    routingClassifierModel: null,
    workerReviewModel: null,
    memoryPromotionModel: null
  },
  memory: {
    synthesisEnabled: true,
    synthesisEffort: null,
    synthesisTimeoutMs: 90_000,
    synthesisMaxInputChars: 16_000,
    synthesisMaxCandidatesPerRun: 6,
    promotionAutoResolve: true,
    promotionBatchSize: 20,
    promotionMaxBatchesPerRun: 10,
    promotionIntervalMs: 10_000,
    semanticEdgeReviewEnabled: true,
    semanticEdgeReviewBatchSize: 12,
    semanticEdgeReviewIntervalMs: 60_000
  },
  embeddings: {
    enabled: true,
    provider: "ollama",
    host: "http://127.0.0.1:11434",
    model: "qwen3-embedding:0.6b",
    timeoutMs: 10_000,
    backfillBatchSize: 12
  }
};

export const DEFAULT_SETTINGS_PROVENANCE: ManorSettingsProvenance = Object.fromEntries(
  SETTINGS_GROUP_KEYS.map((key) => [key, "default" as SettingsProvenance])
) as ManorSettingsProvenance;

export const DEFAULT_SETTINGS_VALIDATION: SettingsValidationMap = Object.fromEntries(
  SETTINGS_VALIDATION_KEYS.map((key) => [key, { status: "not_configured", lastCheckedAt: null, message: null }])
) as SettingsValidationMap;

export function cloneManorSettings(settings: ManorSettings): ManorSettings {
  return JSON.parse(JSON.stringify(settings)) as ManorSettings;
}

export function emptySettingsProvenance(): ManorSettingsProvenance {
  return { ...DEFAULT_SETTINGS_PROVENANCE };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function text(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function nullableText(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function bool(value: unknown, fallback: boolean): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value !== "string") return fallback;
  const normalized = value.trim().toLowerCase();
  if (!normalized) return fallback;
  return normalized !== "0" && normalized !== "false" && normalized !== "off" && normalized !== "no";
}

function integer(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(parsed)));
}

function baseUrl(value: unknown, fallback: string): string {
  return text(value, fallback).replace(/\/+$/, "");
}

function csv(value: unknown, fallback: string[]): string[] {
  const list = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split(",")
      : [];
  const normalized = list
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => entry.trim())
    .filter(Boolean);
  return normalized.length > 0 ? normalized : [...fallback];
}

function providerModels(value: unknown, fallback: SettingsProviderModel[]): SettingsProviderModel[] {
  const modelCompat = (entry: unknown): Record<string, unknown> | undefined => {
    if (!isRecord(entry)) return undefined;
    const compat: Record<string, unknown> = {};
    if (typeof entry.supportsDeveloperRole === "boolean") compat.supportsDeveloperRole = entry.supportsDeveloperRole;
    if (typeof entry.supportsReasoningEffort === "boolean") compat.supportsReasoningEffort = entry.supportsReasoningEffort;
    if (entry.maxTokensField === "max_tokens" || entry.maxTokensField === "max_completion_tokens") compat.maxTokensField = entry.maxTokensField;
    if (typeof entry.thinkingFormat === "string" && entry.thinkingFormat.trim()) compat.thinkingFormat = entry.thinkingFormat.trim();
    return Object.keys(compat).length > 0 ? compat : undefined;
  };
  const coerce = (entry: unknown): SettingsProviderModel | null => {
    if (typeof entry === "string") {
      const trimmed = entry.trim();
      return trimmed || null;
    }
    if (isRecord(entry) && typeof entry.id === "string" && entry.id.trim()) {
      const api = typeof entry.api === "string" && entry.api.trim() ? entry.api.trim() : null;
      const reasoning = typeof entry.reasoning === "boolean" ? entry.reasoning : null;
      const contextWindow = typeof entry.contextWindow === "number" && Number.isFinite(entry.contextWindow) ? entry.contextWindow : null;
      const thinkingLevelMap = isRecord(entry.thinkingLevelMap)
        ? Object.fromEntries(
          Object.entries(entry.thinkingLevelMap)
            .filter(([level, value]) =>
              (level === "off" || level === "none" || level === "minimal" || level === "low" || level === "medium" || level === "high" || level === "xhigh" || level === "max")
              && (typeof value === "string" || value === null)
            )
        ) as Partial<Record<SettingsThinkingLevel, string | null>>
        : undefined;
      return {
        id: entry.id.trim(),
        api,
        reasoning,
        contextWindow,
        ...(thinkingLevelMap && Object.keys(thinkingLevelMap).length > 0 ? { thinkingLevelMap } : {}),
        ...(modelCompat(entry.compat) ? { compat: modelCompat(entry.compat) } : {})
      };
    }
    return null;
  };
  const list: SettingsProviderModel[] = [];
  if (Array.isArray(value)) {
    for (const entry of value) {
      const coerced = coerce(entry);
      if (coerced) list.push(coerced);
    }
  }
  return list.length > 0 ? list : fallback.map((entry) => (typeof entry === "string" ? entry : { ...entry }));
}

function secretSource(value: unknown, fallback: SettingsSecretSource): SettingsSecretSource {
  if (!isRecord(value)) return { ...fallback };
  if (value.type === "env") {
    return { type: "env", name: text(value.name, "OLLAMA_API_KEY") };
  }
  if (value.type === "file") {
    return { type: "file", pathEnv: text(value.pathEnv, "OLLAMA_API_KEY_FILE") };
  }
  if (value.type === "asiri") {
    return { type: "asiri", workspace: text(value.workspace, ""), path: text(value.path, "") };
  }
  return { ...fallback };
}

function webTools(value: unknown, fallback: SettingsWebTools): SettingsWebTools {
  const raw = isRecord(value) ? value : {};
  return {
    enabled: bool(raw.enabled, fallback.enabled),
    baseUrl: baseUrl(raw.baseUrl, fallback.baseUrl),
    maxResults: integer(raw.maxResults, fallback.maxResults, 1, 10),
    timeoutMs: integer(raw.timeoutMs, fallback.timeoutMs, 1_000, 10 * 60_000),
    maxContentChars: integer(raw.maxContentChars, fallback.maxContentChars, 1_000, 200_000),
    forAllPiModels: bool(raw.forAllPiModels, false)
  };
}

function opencodeWebTools(value: unknown, fallback: SettingsOpencodeWebTools): SettingsOpencodeWebTools {
  const raw = isRecord(value) ? value : {};
  return {
    enabled: bool(raw.enabled, fallback.enabled),
    maxResults: integer(raw.maxResults, fallback.maxResults, 1, 10),
    timeoutMs: integer(raw.timeoutMs, fallback.timeoutMs, 1_000, 10 * 60_000),
    maxContentChars: integer(raw.maxContentChars, fallback.maxContentChars, 1_000, 200_000)
  };
}

function reasoningEffort(value: unknown): SettingsReasoningEffort | null {
  return value === "none" || value === "minimal" || value === "low" || value === "medium" || value === "high" || value === "xhigh" || value === "max" ? value : null;
}

function thinkingLevel(value: unknown): SettingsThinkingLevel {
  return value === "off" || value === "none" || value === "minimal" || value === "low" || value === "medium" || value === "high" || value === "xhigh" || value === "max" ? value : "medium";
}

function workerRuntime(value: unknown): SettingsWorkerRuntime {
  if (value === "codex") {
    throw new Error("MANOR_WORKER_RUNTIME=codex is no longer supported. Use 'openai' for OpenAI Codex, or 'pi-rpc' for Pi RPC. Run Reseed to reset settings.");
  }
  return value === "openai" || value === "pi-rpc" ? value : "auto";
}

function runnerMode(value: unknown): ManorSettings["modelTasks"]["runnerMode"] {
  return value === "codex" || value === "pi" ? value : "auto";
}

function memoryEffort(value: unknown): ManorSettings["memory"]["synthesisEffort"] {
  return value === "low" || value === "medium" || value === "high" ? value : null;
}

function checkBreakingShape(providers: Record<string, unknown>): void {
  if ("ollamaWebTools" in providers) {
    throw new Error("providers.ollamaWebTools has been moved to providers.ollamaCloud.webTools. Run Reseed to reset settings.");
  }
}

function providerKey(value: unknown, fallback: SettingsProviderKey): SettingsProviderKey {
  return value === "openai-codex" || value === "ollama-local" || value === "ollama-cloud" || value === "opencode-go" ? value : fallback;
}

export function normalizeManorSettings(value: unknown): ManorSettings {
  const raw = isRecord(value) ? value : {};
  const overview = isRecord(raw.overview) ? raw.overview : {};
  const providers = isRecord(raw.providers) ? raw.providers : {};
  checkBreakingShape(providers);
  const ollamaLocal = isRecord(providers.ollamaLocal) ? providers.ollamaLocal : {};
  const ollamaCloud = isRecord(providers.ollamaCloud) ? providers.ollamaCloud : {};
  const opencodeGo = isRecord(providers.opencodeGo) ? providers.opencodeGo : {};
  const worker = isRecord(raw.worker) ? raw.worker : {};
  const butler = isRecord(raw.butler) ? raw.butler : {};
  const modelTasks = isRecord(raw.modelTasks) ? raw.modelTasks : {};
  const memory = isRecord(raw.memory) ? raw.memory : {};
  const embeddings = isRecord(raw.embeddings) ? raw.embeddings : {};

  return {
    overview: {
      operatorName: typeof overview.operatorName === "string" ? overview.operatorName.trim() : "",
      butlerProvider: providerKey(overview.butlerProvider, DEFAULT_MANOR_SETTINGS.overview.butlerProvider),
      codexProvider: providerKey(overview.codexProvider, DEFAULT_MANOR_SETTINGS.overview.codexProvider)
    },
    providers: {
      ollamaLocal: {
        enabled: bool(ollamaLocal.enabled, DEFAULT_MANOR_SETTINGS.providers.ollamaLocal.enabled),
        providerId: text(ollamaLocal.providerId, DEFAULT_MANOR_SETTINGS.providers.ollamaLocal.providerId),
        providerName: text(ollamaLocal.providerName, DEFAULT_MANOR_SETTINGS.providers.ollamaLocal.providerName),
        baseUrl: baseUrl(ollamaLocal.baseUrl, DEFAULT_MANOR_SETTINGS.providers.ollamaLocal.baseUrl),
        nativeBaseUrl: baseUrl(ollamaLocal.nativeBaseUrl, DEFAULT_MANOR_SETTINGS.providers.ollamaLocal.nativeBaseUrl),
        api: text(ollamaLocal.api, DEFAULT_MANOR_SETTINGS.providers.ollamaLocal.api),
        models: providerModels(ollamaLocal.models, DEFAULT_MANOR_SETTINGS.providers.ollamaLocal.models),
        contextWindow: integer(ollamaLocal.contextWindow, DEFAULT_MANOR_SETTINGS.providers.ollamaLocal.contextWindow, 8_192, 2_000_000),
        maxTokens: integer(ollamaLocal.maxTokens, DEFAULT_MANOR_SETTINGS.providers.ollamaLocal.maxTokens, 1_024, 2_000_000),
        reasoning: bool(ollamaLocal.reasoning, DEFAULT_MANOR_SETTINGS.providers.ollamaLocal.reasoning),
        supportsDeveloperRole: bool(ollamaLocal.supportsDeveloperRole, false),
        supportsReasoningEffort: bool(ollamaLocal.supportsReasoningEffort, false),
        apiKeySource: "apiKeySource" in ollamaLocal
          ? ollamaLocal.apiKeySource === null
            ? null
            : secretSource(ollamaLocal.apiKeySource, { type: "env", name: "OLLAMA_LOCAL_API_KEY" })
          : DEFAULT_MANOR_SETTINGS.providers.ollamaLocal.apiKeySource,
        authHeader: bool(ollamaLocal.authHeader, false)
      },
      ollamaCloud: {
        enabled: bool(ollamaCloud.enabled, DEFAULT_MANOR_SETTINGS.providers.ollamaCloud.enabled),
        providerId: text(ollamaCloud.providerId, DEFAULT_MANOR_SETTINGS.providers.ollamaCloud.providerId),
        providerName: text(ollamaCloud.providerName, DEFAULT_MANOR_SETTINGS.providers.ollamaCloud.providerName),
        baseUrl: baseUrl(ollamaCloud.baseUrl, DEFAULT_MANOR_SETTINGS.providers.ollamaCloud.baseUrl),
        api: text(ollamaCloud.api, DEFAULT_MANOR_SETTINGS.providers.ollamaCloud.api),
        models: providerModels(ollamaCloud.models, DEFAULT_MANOR_SETTINGS.providers.ollamaCloud.models),
        contextWindow: integer(ollamaCloud.contextWindow, DEFAULT_MANOR_SETTINGS.providers.ollamaCloud.contextWindow, 8_192, 2_000_000),
        maxTokens: integer(ollamaCloud.maxTokens, DEFAULT_MANOR_SETTINGS.providers.ollamaCloud.maxTokens, 1_024, 2_000_000),
        reasoning: bool(ollamaCloud.reasoning, DEFAULT_MANOR_SETTINGS.providers.ollamaCloud.reasoning),
        supportsDeveloperRole: bool(ollamaCloud.supportsDeveloperRole, false),
        supportsReasoningEffort: bool(ollamaCloud.supportsReasoningEffort, false),
        apiKeySource: secretSource(ollamaCloud.apiKeySource, DEFAULT_MANOR_SETTINGS.providers.ollamaCloud.apiKeySource),
        webTools: webTools(ollamaCloud.webTools, DEFAULT_MANOR_SETTINGS.providers.ollamaCloud.webTools)
      },
      opencodeGo: {
        enabled: bool(opencodeGo.enabled, DEFAULT_MANOR_SETTINGS.providers.opencodeGo.enabled),
        providerId: text(opencodeGo.providerId, DEFAULT_MANOR_SETTINGS.providers.opencodeGo.providerId),
        providerName: text(opencodeGo.providerName, DEFAULT_MANOR_SETTINGS.providers.opencodeGo.providerName),
        baseUrl: baseUrl(opencodeGo.baseUrl, DEFAULT_MANOR_SETTINGS.providers.opencodeGo.baseUrl),
        api: text(opencodeGo.api, DEFAULT_MANOR_SETTINGS.providers.opencodeGo.api),
        models: providerModels(opencodeGo.models, DEFAULT_MANOR_SETTINGS.providers.opencodeGo.models),
        contextWindow: integer(opencodeGo.contextWindow, DEFAULT_MANOR_SETTINGS.providers.opencodeGo.contextWindow, 8_192, 2_000_000),
        maxTokens: integer(opencodeGo.maxTokens, DEFAULT_MANOR_SETTINGS.providers.opencodeGo.maxTokens, 1_024, 2_000_000),
        reasoning: bool(opencodeGo.reasoning, DEFAULT_MANOR_SETTINGS.providers.opencodeGo.reasoning),
        supportsDeveloperRole: bool(opencodeGo.supportsDeveloperRole, false),
        supportsReasoningEffort: bool(opencodeGo.supportsReasoningEffort, false),
        apiKeySource: secretSource(opencodeGo.apiKeySource, DEFAULT_MANOR_SETTINGS.providers.opencodeGo.apiKeySource),
        webTools: opencodeWebTools(opencodeGo.webTools, DEFAULT_MANOR_SETTINGS.providers.opencodeGo.webTools)
      }
    },
    worker: {
      runtime: workerRuntime(worker.runtime),
      defaultModel: nullableText(worker.defaultModel),
      defaultEffort: reasoningEffort(worker.defaultEffort)
    },
    butler: {
      defaultModel: nullableText(butler.defaultModel),
      defaultThinkingLevel: thinkingLevel(butler.defaultThinkingLevel)
    },
    modelTasks: {
      runnerMode: runnerMode(modelTasks.runnerMode),
      memorySynthesisModel: nullableText(modelTasks.memorySynthesisModel),
      sessionTitleModel: nullableText(modelTasks.sessionTitleModel),
      sessionTitleTimeoutMs: integer(modelTasks.sessionTitleTimeoutMs, 15_000, 1_000, 60_000),
      routingClassifierModel: nullableText(modelTasks.routingClassifierModel),
      workerReviewModel: nullableText(modelTasks.workerReviewModel),
      memoryPromotionModel: nullableText(modelTasks.memoryPromotionModel)
    },
    memory: {
      synthesisEnabled: bool(memory.synthesisEnabled, true),
      synthesisEffort: memoryEffort(memory.synthesisEffort),
      synthesisTimeoutMs: integer(memory.synthesisTimeoutMs, 90_000, 5_000, 10 * 60_000),
      synthesisMaxInputChars: integer(memory.synthesisMaxInputChars, 16_000, 2_000, 200_000),
      synthesisMaxCandidatesPerRun: integer(memory.synthesisMaxCandidatesPerRun, 6, 1, 50),
      promotionAutoResolve: bool(memory.promotionAutoResolve, true),
      promotionBatchSize: integer(memory.promotionBatchSize, 20, 1, 50),
      promotionMaxBatchesPerRun: integer(memory.promotionMaxBatchesPerRun, 10, 1, 25),
      promotionIntervalMs: integer(memory.promotionIntervalMs, 10_000, 1_000, 5 * 60_000),
      semanticEdgeReviewEnabled: bool(memory.semanticEdgeReviewEnabled, true),
      semanticEdgeReviewBatchSize: integer(memory.semanticEdgeReviewBatchSize, 12, 1, 50),
      semanticEdgeReviewIntervalMs: integer(memory.semanticEdgeReviewIntervalMs, 60_000, 5_000, 30 * 60_000)
    },
    embeddings: {
      enabled: bool(embeddings.enabled, true),
      provider: "ollama",
      host: baseUrl(embeddings.host, DEFAULT_MANOR_SETTINGS.embeddings.host),
      model: text(embeddings.model, DEFAULT_MANOR_SETTINGS.embeddings.model),
      timeoutMs: integer(embeddings.timeoutMs, DEFAULT_MANOR_SETTINGS.embeddings.timeoutMs, 1_000, 10 * 60_000),
      backfillBatchSize: integer(embeddings.backfillBatchSize, DEFAULT_MANOR_SETTINGS.embeddings.backfillBatchSize, 1, 32)
    }
  };
}

function markEnvGroup(seen: Set<SettingsGroupKey>, key: SettingsGroupKey): void {
  seen.add(key);
}

function envSource(env: NodeJS.ProcessEnv): SettingsSecretSource {
  if (env.OLLAMA_API_KEY_FILE?.trim()) return { type: "file", pathEnv: "OLLAMA_API_KEY_FILE" };
  return { type: "env", name: "OLLAMA_API_KEY" };
}

function ollamaLocalEnvSource(env: NodeJS.ProcessEnv): SettingsSecretSource {
  if (env.OLLAMA_LOCAL_API_KEY_FILE?.trim()) return { type: "file", pathEnv: "OLLAMA_LOCAL_API_KEY_FILE" };
  return { type: "env", name: "OLLAMA_LOCAL_API_KEY" };
}

function opencodeEnvSource(env: NodeJS.ProcessEnv): SettingsSecretSource {
  if (env.OPENCODE_API_KEY_FILE?.trim()) return { type: "file", pathEnv: "OPENCODE_API_KEY_FILE" };
  return { type: "env", name: "OPENCODE_API_KEY" };
}

function hasEnv(env: NodeJS.ProcessEnv, key: string): boolean {
  return env[key] !== undefined && `${env[key]}`.trim() !== "";
}

export function buildManorSettingsFromEnv(env: NodeJS.ProcessEnv = process.env): { settings: ManorSettings; provenance: ManorSettingsProvenance } {
  const settings = cloneManorSettings(DEFAULT_MANOR_SETTINGS);
  const envGroups = new Set<SettingsGroupKey>();

  const apply = (group: SettingsGroupKey, key: string, write: (value: string) => void) => {
    if (env[key] === undefined) return;
    markEnvGroup(envGroups, group);
    write(env[key] ?? "");
  };

  apply("overview", "MANOR_OPERATOR_NAME", (value) => { settings.overview.operatorName = value.trim(); });
  apply("overview", "MANOR_BUTLER_PROVIDER", (value) => { settings.overview.butlerProvider = providerKey(value, settings.overview.butlerProvider); });
  apply("overview", "MANOR_CODEX_PROVIDER", (value) => { settings.overview.codexProvider = providerKey(value, settings.overview.codexProvider); });

  apply("providers.ollamaLocal", "MANOR_OLLAMA_LOCAL_ENABLED", (value) => { settings.providers.ollamaLocal.enabled = bool(value, settings.providers.ollamaLocal.enabled); });
  apply("providers.ollamaLocal", "MANOR_OLLAMA_LOCAL_PROVIDER_ID", (value) => { settings.providers.ollamaLocal.providerId = text(value, settings.providers.ollamaLocal.providerId); });
  apply("providers.ollamaLocal", "MANOR_OLLAMA_LOCAL_PROVIDER_NAME", (value) => { settings.providers.ollamaLocal.providerName = text(value, settings.providers.ollamaLocal.providerName); });
  apply("providers.ollamaLocal", "MANOR_OLLAMA_LOCAL_BASE_URL", (value) => { settings.providers.ollamaLocal.baseUrl = baseUrl(value, settings.providers.ollamaLocal.baseUrl); });
  apply("providers.ollamaLocal", "MANOR_OLLAMA_LOCAL_NATIVE_BASE_URL", (value) => { settings.providers.ollamaLocal.nativeBaseUrl = baseUrl(value, settings.providers.ollamaLocal.nativeBaseUrl); });
  apply("providers.ollamaLocal", "MANOR_OLLAMA_LOCAL_API", (value) => { settings.providers.ollamaLocal.api = text(value, settings.providers.ollamaLocal.api); });
  apply("providers.ollamaLocal", "MANOR_OLLAMA_LOCAL_MODELS", (value) => {
    settings.providers.ollamaLocal.models = csv(value, []);
  });
  apply("providers.ollamaLocal", "MANOR_OLLAMA_LOCAL_CONTEXT_WINDOW", (value) => { settings.providers.ollamaLocal.contextWindow = integer(value, settings.providers.ollamaLocal.contextWindow, 8_192, 2_000_000); });
  apply("providers.ollamaLocal", "MANOR_OLLAMA_LOCAL_MAX_TOKENS", (value) => { settings.providers.ollamaLocal.maxTokens = integer(value, settings.providers.ollamaLocal.maxTokens, 1_024, 2_000_000); });
  apply("providers.ollamaLocal", "MANOR_OLLAMA_LOCAL_REASONING", (value) => { settings.providers.ollamaLocal.reasoning = bool(value, settings.providers.ollamaLocal.reasoning); });
  apply("providers.ollamaLocal", "MANOR_OLLAMA_LOCAL_SUPPORTS_DEVELOPER_ROLE", (value) => { settings.providers.ollamaLocal.supportsDeveloperRole = bool(value, false); });
  apply("providers.ollamaLocal", "MANOR_OLLAMA_LOCAL_SUPPORTS_REASONING_EFFORT", (value) => { settings.providers.ollamaLocal.supportsReasoningEffort = bool(value, false); });
  apply("providers.ollamaLocal", "MANOR_OLLAMA_LOCAL_AUTH_HEADER", (value) => { settings.providers.ollamaLocal.authHeader = bool(value, false); });
  if (hasEnv(env, "OLLAMA_LOCAL_API_KEY") || hasEnv(env, "OLLAMA_LOCAL_API_KEY_FILE")) {
    markEnvGroup(envGroups, "providers.ollamaLocal");
    settings.providers.ollamaLocal.apiKeySource = ollamaLocalEnvSource(env);
  }

  apply("providers.ollamaCloud", "MANOR_OLLAMA_CLOUD_ENABLED", (value) => { settings.providers.ollamaCloud.enabled = bool(value, settings.providers.ollamaCloud.enabled); });
  apply("providers.ollamaCloud", "MANOR_OLLAMA_CLOUD_PROVIDER_ID", (value) => { settings.providers.ollamaCloud.providerId = text(value, settings.providers.ollamaCloud.providerId); });
  apply("providers.ollamaCloud", "MANOR_OLLAMA_CLOUD_PROVIDER_NAME", (value) => { settings.providers.ollamaCloud.providerName = text(value, settings.providers.ollamaCloud.providerName); });
  apply("providers.ollamaCloud", "MANOR_OLLAMA_CLOUD_BASE_URL", (value) => { settings.providers.ollamaCloud.baseUrl = baseUrl(value, settings.providers.ollamaCloud.baseUrl); });
  apply("providers.ollamaCloud", "MANOR_OLLAMA_CLOUD_API", (value) => { settings.providers.ollamaCloud.api = text(value, settings.providers.ollamaCloud.api); });
  apply("providers.ollamaCloud", "MANOR_OLLAMA_CLOUD_MODELS", (value) => {
    const ids = csv(value, []);
    if (ids.length > 0) settings.providers.ollamaCloud.models = ids;
  });
  apply("providers.ollamaCloud", "MANOR_OLLAMA_CLOUD_CONTEXT_WINDOW", (value) => { settings.providers.ollamaCloud.contextWindow = integer(value, settings.providers.ollamaCloud.contextWindow, 8_192, 2_000_000); });
  apply("providers.ollamaCloud", "MANOR_OLLAMA_CLOUD_MAX_TOKENS", (value) => { settings.providers.ollamaCloud.maxTokens = integer(value, settings.providers.ollamaCloud.maxTokens, 1_024, 2_000_000); });
  apply("providers.ollamaCloud", "MANOR_OLLAMA_CLOUD_REASONING", (value) => { settings.providers.ollamaCloud.reasoning = bool(value, settings.providers.ollamaCloud.reasoning); });
  apply("providers.ollamaCloud", "MANOR_OLLAMA_CLOUD_SUPPORTS_DEVELOPER_ROLE", (value) => { settings.providers.ollamaCloud.supportsDeveloperRole = bool(value, false); });
  apply("providers.ollamaCloud", "MANOR_OLLAMA_CLOUD_SUPPORTS_REASONING_EFFORT", (value) => { settings.providers.ollamaCloud.supportsReasoningEffort = bool(value, false); });
  apply("providers.ollamaCloud", "MANOR_OLLAMA_WEB_TOOLS_ENABLED", (value) => { settings.providers.ollamaCloud.webTools.enabled = bool(value, settings.providers.ollamaCloud.webTools.enabled); });
  apply("providers.ollamaCloud", "MANOR_OLLAMA_WEB_TOOLS_BASE_URL", (value) => { settings.providers.ollamaCloud.webTools.baseUrl = baseUrl(value, settings.providers.ollamaCloud.webTools.baseUrl); });
  apply("providers.ollamaCloud", "MANOR_OLLAMA_WEB_SEARCH_MAX_RESULTS", (value) => { settings.providers.ollamaCloud.webTools.maxResults = integer(value, settings.providers.ollamaCloud.webTools.maxResults, 1, 10); });
  apply("providers.ollamaCloud", "MANOR_OLLAMA_WEB_TOOLS_TIMEOUT_MS", (value) => { settings.providers.ollamaCloud.webTools.timeoutMs = integer(value, settings.providers.ollamaCloud.webTools.timeoutMs, 1_000, 10 * 60_000); });
  apply("providers.ollamaCloud", "MANOR_OLLAMA_WEB_TOOLS_MAX_CONTENT_CHARS", (value) => { settings.providers.ollamaCloud.webTools.maxContentChars = integer(value, settings.providers.ollamaCloud.webTools.maxContentChars, 1_000, 200_000); });
  apply("providers.ollamaCloud", "MANOR_OLLAMA_WEB_TOOLS_FOR_ALL_PI_MODELS", (value) => { settings.providers.ollamaCloud.webTools.forAllPiModels = bool(value, false); });
  if (hasEnv(env, "OLLAMA_API_KEY") || hasEnv(env, "OLLAMA_API_KEY_FILE")) {
    markEnvGroup(envGroups, "providers.ollamaCloud");
    settings.providers.ollamaCloud.apiKeySource = envSource(env);
  }

  apply("providers.opencodeGo", "MANOR_OPENCODE_GO_ENABLED", (value) => { settings.providers.opencodeGo.enabled = bool(value, settings.providers.opencodeGo.enabled); });
  apply("providers.opencodeGo", "MANOR_OPENCODE_GO_PROVIDER_ID", (value) => { settings.providers.opencodeGo.providerId = text(value, settings.providers.opencodeGo.providerId); });
  apply("providers.opencodeGo", "MANOR_OPENCODE_GO_PROVIDER_NAME", (value) => { settings.providers.opencodeGo.providerName = text(value, settings.providers.opencodeGo.providerName); });
  apply("providers.opencodeGo", "MANOR_OPENCODE_GO_BASE_URL", (value) => { settings.providers.opencodeGo.baseUrl = baseUrl(value, settings.providers.opencodeGo.baseUrl); });
  apply("providers.opencodeGo", "MANOR_OPENCODE_GO_API", (value) => { settings.providers.opencodeGo.api = text(value, settings.providers.opencodeGo.api); });
  apply("providers.opencodeGo", "MANOR_OPENCODE_GO_MODELS", (value) => {
    const ids = csv(value, []);
    if (ids.length > 0) settings.providers.opencodeGo.models = ids;
  });
  apply("providers.opencodeGo", "MANOR_OPENCODE_GO_CONTEXT_WINDOW", (value) => { settings.providers.opencodeGo.contextWindow = integer(value, settings.providers.opencodeGo.contextWindow, 8_192, 2_000_000); });
  apply("providers.opencodeGo", "MANOR_OPENCODE_GO_MAX_TOKENS", (value) => { settings.providers.opencodeGo.maxTokens = integer(value, settings.providers.opencodeGo.maxTokens, 1_024, 2_000_000); });
  apply("providers.opencodeGo", "MANOR_OPENCODE_GO_REASONING", (value) => { settings.providers.opencodeGo.reasoning = bool(value, settings.providers.opencodeGo.reasoning); });
  apply("providers.opencodeGo", "MANOR_OPENCODE_GO_SUPPORTS_DEVELOPER_ROLE", (value) => { settings.providers.opencodeGo.supportsDeveloperRole = bool(value, false); });
  apply("providers.opencodeGo", "MANOR_OPENCODE_GO_SUPPORTS_REASONING_EFFORT", (value) => { settings.providers.opencodeGo.supportsReasoningEffort = bool(value, false); });
  apply("providers.opencodeGo", "MANOR_OPENCODE_GO_WEB_TOOLS_ENABLED", (value) => { settings.providers.opencodeGo.webTools.enabled = bool(value, settings.providers.opencodeGo.webTools.enabled); });
  if (hasEnv(env, "OPENCODE_API_KEY") || hasEnv(env, "OPENCODE_API_KEY_FILE")) {
    markEnvGroup(envGroups, "providers.opencodeGo");
    settings.providers.opencodeGo.apiKeySource = opencodeEnvSource(env);
  }

  apply("worker", "MANOR_WORKER_RUNTIME", (value) => { settings.worker.runtime = workerRuntime(value); });
  apply("worker", "MANOR_WORKER_MODEL", (value) => { settings.worker.defaultModel = nullableText(value); });
  apply("worker", "MANOR_WORKER_EFFORT", (value) => { settings.worker.defaultEffort = reasoningEffort(value); });
  apply("butler", "MANOR_BUTLER_MODEL", (value) => { settings.butler.defaultModel = nullableText(value); });
  apply("butler", "MANOR_BUTLER_THINKING_LEVEL", (value) => { settings.butler.defaultThinkingLevel = thinkingLevel(value); });

  apply("modelTasks", "MANOR_MODEL_TASK_RUNNER", (value) => { settings.modelTasks.runnerMode = runnerMode(value); });
  apply("modelTasks", "MANOR_MEMORY_SYNTHESIS_MODEL", (value) => { settings.modelTasks.memorySynthesisModel = nullableText(value); });
  apply("modelTasks", "MANOR_MEMORY_REVIEW_MODEL", (value) => { settings.modelTasks.memorySynthesisModel ??= nullableText(value); });
  apply("modelTasks", "MANOR_SESSION_TITLE_MODEL", (value) => { settings.modelTasks.sessionTitleModel = nullableText(value); });
  apply("modelTasks", "MANOR_SESSION_TITLE_TIMEOUT_MS", (value) => { settings.modelTasks.sessionTitleTimeoutMs = integer(value, settings.modelTasks.sessionTitleTimeoutMs, 1_000, 60_000); });
  apply("modelTasks", "MANOR_ROUTING_CLASSIFIER_MODEL", (value) => { settings.modelTasks.routingClassifierModel = nullableText(value); });
  apply("modelTasks", "MANOR_WORKER_REVIEW_MODEL", (value) => { settings.modelTasks.workerReviewModel = nullableText(value); });
  apply("modelTasks", "MANOR_MEMORY_PROMOTION_MODEL", (value) => { settings.modelTasks.memoryPromotionModel = nullableText(value); });

  apply("memory", "MANOR_MEMORY_SYNTHESIS_ENABLED", (value) => { settings.memory.synthesisEnabled = bool(value, settings.memory.synthesisEnabled); });
  apply("memory", "MANOR_MEMORY_SYNTHESIS_EFFORT", (value) => { settings.memory.synthesisEffort = memoryEffort(value); });
  apply("memory", "MANOR_MEMORY_SYNTHESIS_TIMEOUT_MS", (value) => { settings.memory.synthesisTimeoutMs = integer(value, settings.memory.synthesisTimeoutMs, 5_000, 10 * 60_000); });
  apply("memory", "MANOR_MEMORY_SYNTHESIS_MAX_INPUT_CHARS", (value) => { settings.memory.synthesisMaxInputChars = integer(value, settings.memory.synthesisMaxInputChars, 2_000, 200_000); });
  apply("memory", "MANOR_MEMORY_SYNTHESIS_MAX_CANDIDATES", (value) => { settings.memory.synthesisMaxCandidatesPerRun = integer(value, settings.memory.synthesisMaxCandidatesPerRun, 1, 50); });
  apply("memory", "MANOR_MEMORY_PROMOTION_AUTO_RESOLVE", (value) => { settings.memory.promotionAutoResolve = bool(value, settings.memory.promotionAutoResolve); });
  apply("memory", "MANOR_MEMORY_PROMOTION_BATCH_SIZE", (value) => { settings.memory.promotionBatchSize = integer(value, settings.memory.promotionBatchSize, 1, 50); });
  apply("memory", "MANOR_MEMORY_PROMOTION_MAX_BATCHES_PER_RUN", (value) => { settings.memory.promotionMaxBatchesPerRun = integer(value, settings.memory.promotionMaxBatchesPerRun, 1, 25); });
  apply("memory", "MANOR_MEMORY_PROMOTION_INTERVAL_MS", (value) => { settings.memory.promotionIntervalMs = integer(value, settings.memory.promotionIntervalMs, 1_000, 5 * 60_000); });
  apply("memory", "MANOR_MEMORY_SEMANTIC_EDGES_ENABLED", (value) => { settings.memory.semanticEdgeReviewEnabled = bool(value, settings.memory.semanticEdgeReviewEnabled); });
  apply("memory", "MANOR_MEMORY_SEMANTIC_EDGES_BATCH_SIZE", (value) => { settings.memory.semanticEdgeReviewBatchSize = integer(value, settings.memory.semanticEdgeReviewBatchSize, 1, 50); });
  apply("memory", "MANOR_MEMORY_SEMANTIC_EDGES_INTERVAL_MS", (value) => { settings.memory.semanticEdgeReviewIntervalMs = integer(value, settings.memory.semanticEdgeReviewIntervalMs, 5_000, 30 * 60_000); });

  apply("embeddings", "MANOR_MEMORY_EMBEDDINGS_ENABLED", (value) => { settings.embeddings.enabled = bool(value, settings.embeddings.enabled); });
  apply("embeddings", "MANOR_MEMORY_EMBEDDINGS_HOST", (value) => { settings.embeddings.host = baseUrl(value, settings.embeddings.host); });
  apply("embeddings", "MANOR_MEMORY_EMBEDDINGS_MODEL", (value) => { settings.embeddings.model = text(value, settings.embeddings.model); });
  apply("embeddings", "MANOR_MEMORY_EMBEDDINGS_TIMEOUT_MS", (value) => { settings.embeddings.timeoutMs = integer(value, settings.embeddings.timeoutMs, 1_000, 10 * 60_000); });
  apply("embeddings", "MANOR_MEMORY_EMBEDDINGS_BACKFILL_BATCH_SIZE", (value) => { settings.embeddings.backfillBatchSize = integer(value, settings.embeddings.backfillBatchSize, 1, 32); });

  return {
    settings: normalizeManorSettings(settings),
    provenance: Object.fromEntries(SETTINGS_GROUP_KEYS.map((key) => [key, envGroups.has(key) ? "env_seed" : "default"])) as ManorSettingsProvenance
  };
}

export function groupValue(settings: ManorSettings, key: SettingsGroupKey): unknown {
  switch (key) {
    case "overview": return settings.overview;
    case "providers.ollamaLocal": return settings.providers.ollamaLocal;
    case "providers.ollamaCloud": return settings.providers.ollamaCloud;
    case "providers.opencodeGo": return settings.providers.opencodeGo;
    case "worker": return settings.worker;
    case "butler": return settings.butler;
    case "modelTasks": return settings.modelTasks;
    case "memory": return settings.memory;
    case "embeddings": return settings.embeddings;
  }
}

export function applyGroupValue(settings: ManorSettings, key: SettingsGroupKey, value: unknown): ManorSettings {
  const next = cloneManorSettings(settings);
  switch (key) {
    case "overview": next.overview = { ...next.overview, ...(isRecord(value) ? value : {}) } as never; break;
    case "providers.ollamaLocal": next.providers.ollamaLocal = { ...next.providers.ollamaLocal, ...(isRecord(value) ? value : {}) } as never; break;
    case "providers.ollamaCloud": next.providers.ollamaCloud = { ...next.providers.ollamaCloud, ...(isRecord(value) ? value : {}) } as never; break;
    case "providers.opencodeGo": next.providers.opencodeGo = { ...next.providers.opencodeGo, ...(isRecord(value) ? value : {}) } as never; break;
    case "worker": next.worker = { ...next.worker, ...(isRecord(value) ? value : {}) } as never; break;
    case "butler": next.butler = { ...next.butler, ...(isRecord(value) ? value : {}) } as never; break;
    case "modelTasks": next.modelTasks = { ...next.modelTasks, ...(isRecord(value) ? value : {}) } as never; break;
    case "memory": next.memory = { ...next.memory, ...(isRecord(value) ? value : {}) } as never; break;
    case "embeddings": next.embeddings = { ...next.embeddings, ...(isRecord(value) ? value : {}) } as never; break;
  }
  return normalizeManorSettings(next);
}
