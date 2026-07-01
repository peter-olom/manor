import type {
  ManorSettings,
  ManorSettingsProvenance,
  SettingsGroupKey,
  SettingsProvenance,
  SettingsReasoningEffort,
  SettingsSecretSource,
  SettingsThinkingLevel,
  SettingsValidationKey,
  SettingsValidationMap,
  SettingsWorkerRuntime
} from "../shared/settings.js";

const DEFAULT_OLLAMA_CLOUD_MODELS = [
  "gpt-oss:120b",
  "glm-5.2",
  "kimi-k2.6",
  "qwen3.5",
  "deepseek-v4-flash",
  "minimax-m3"
];

export const SETTINGS_GROUP_KEYS: SettingsGroupKey[] = [
  "providers.ollamaCloud",
  "providers.ollamaWebTools",
  "worker",
  "butler",
  "modelTasks",
  "memory",
  "embeddings"
];

export const SETTINGS_VALIDATION_KEYS: SettingsValidationKey[] = [
  "codex",
  "piRpc",
  "ollamaCloud",
  "ollamaWebSearch",
  "ollamaWebFetch",
  "memoryEmbeddings"
];

export const DEFAULT_MANOR_SETTINGS: ManorSettings = {
  providers: {
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
      apiKeySource: { type: "env", name: "OLLAMA_API_KEY" }
    },
    ollamaWebTools: {
      enabled: true,
      baseUrl: "https://ollama.com/api",
      maxResults: 5,
      timeoutMs: 30_000,
      maxContentChars: 12_000,
      forAllPiModels: false,
      apiKeySource: { type: "env", name: "OLLAMA_API_KEY" }
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

function reasoningEffort(value: unknown): SettingsReasoningEffort | null {
  return value === "minimal" || value === "low" || value === "medium" || value === "high" || value === "xhigh" ? value : null;
}

function thinkingLevel(value: unknown): SettingsThinkingLevel {
  return value === "off" || value === "low" || value === "medium" || value === "high" || value === "xhigh" ? value : "medium";
}

function workerRuntime(value: unknown): SettingsWorkerRuntime {
  return value === "codex" || value === "pi-rpc" ? value : "auto";
}

function runnerMode(value: unknown): ManorSettings["modelTasks"]["runnerMode"] {
  return value === "codex" || value === "pi" ? value : "auto";
}

function memoryEffort(value: unknown): ManorSettings["memory"]["synthesisEffort"] {
  return value === "low" || value === "medium" || value === "high" ? value : null;
}

export function normalizeManorSettings(value: unknown): ManorSettings {
  const raw = isRecord(value) ? value : {};
  const providers = isRecord(raw.providers) ? raw.providers : {};
  const ollamaCloud = isRecord(providers.ollamaCloud) ? providers.ollamaCloud : {};
  const ollamaWebTools = isRecord(providers.ollamaWebTools) ? providers.ollamaWebTools : {};
  const worker = isRecord(raw.worker) ? raw.worker : {};
  const butler = isRecord(raw.butler) ? raw.butler : {};
  const modelTasks = isRecord(raw.modelTasks) ? raw.modelTasks : {};
  const memory = isRecord(raw.memory) ? raw.memory : {};
  const embeddings = isRecord(raw.embeddings) ? raw.embeddings : {};

  return {
    providers: {
      ollamaCloud: {
        enabled: bool(ollamaCloud.enabled, DEFAULT_MANOR_SETTINGS.providers.ollamaCloud.enabled),
        providerId: text(ollamaCloud.providerId, DEFAULT_MANOR_SETTINGS.providers.ollamaCloud.providerId),
        providerName: text(ollamaCloud.providerName, DEFAULT_MANOR_SETTINGS.providers.ollamaCloud.providerName),
        baseUrl: baseUrl(ollamaCloud.baseUrl, DEFAULT_MANOR_SETTINGS.providers.ollamaCloud.baseUrl),
        api: text(ollamaCloud.api, DEFAULT_MANOR_SETTINGS.providers.ollamaCloud.api),
        models: csv(ollamaCloud.models, DEFAULT_MANOR_SETTINGS.providers.ollamaCloud.models),
        contextWindow: integer(ollamaCloud.contextWindow, DEFAULT_MANOR_SETTINGS.providers.ollamaCloud.contextWindow, 8_192, 2_000_000),
        maxTokens: integer(ollamaCloud.maxTokens, DEFAULT_MANOR_SETTINGS.providers.ollamaCloud.maxTokens, 1_024, 2_000_000),
        reasoning: bool(ollamaCloud.reasoning, DEFAULT_MANOR_SETTINGS.providers.ollamaCloud.reasoning),
        supportsDeveloperRole: bool(ollamaCloud.supportsDeveloperRole, false),
        supportsReasoningEffort: bool(ollamaCloud.supportsReasoningEffort, false),
        apiKeySource: secretSource(ollamaCloud.apiKeySource, DEFAULT_MANOR_SETTINGS.providers.ollamaCloud.apiKeySource)
      },
      ollamaWebTools: {
        enabled: bool(ollamaWebTools.enabled, DEFAULT_MANOR_SETTINGS.providers.ollamaWebTools.enabled),
        baseUrl: baseUrl(ollamaWebTools.baseUrl, DEFAULT_MANOR_SETTINGS.providers.ollamaWebTools.baseUrl),
        maxResults: integer(ollamaWebTools.maxResults, DEFAULT_MANOR_SETTINGS.providers.ollamaWebTools.maxResults, 1, 10),
        timeoutMs: integer(ollamaWebTools.timeoutMs, DEFAULT_MANOR_SETTINGS.providers.ollamaWebTools.timeoutMs, 1_000, 10 * 60_000),
        maxContentChars: integer(ollamaWebTools.maxContentChars, DEFAULT_MANOR_SETTINGS.providers.ollamaWebTools.maxContentChars, 1_000, 200_000),
        forAllPiModels: bool(ollamaWebTools.forAllPiModels, false),
        apiKeySource: secretSource(ollamaWebTools.apiKeySource, DEFAULT_MANOR_SETTINGS.providers.ollamaWebTools.apiKeySource)
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

  apply("providers.ollamaCloud", "MANOR_OLLAMA_CLOUD_ENABLED", (value) => { settings.providers.ollamaCloud.enabled = bool(value, settings.providers.ollamaCloud.enabled); });
  apply("providers.ollamaCloud", "MANOR_OLLAMA_CLOUD_PROVIDER_ID", (value) => { settings.providers.ollamaCloud.providerId = text(value, settings.providers.ollamaCloud.providerId); });
  apply("providers.ollamaCloud", "MANOR_OLLAMA_CLOUD_PROVIDER_NAME", (value) => { settings.providers.ollamaCloud.providerName = text(value, settings.providers.ollamaCloud.providerName); });
  apply("providers.ollamaCloud", "MANOR_OLLAMA_CLOUD_BASE_URL", (value) => { settings.providers.ollamaCloud.baseUrl = baseUrl(value, settings.providers.ollamaCloud.baseUrl); });
  apply("providers.ollamaCloud", "MANOR_OLLAMA_CLOUD_API", (value) => { settings.providers.ollamaCloud.api = text(value, settings.providers.ollamaCloud.api); });
  apply("providers.ollamaCloud", "MANOR_OLLAMA_CLOUD_MODELS", (value) => { settings.providers.ollamaCloud.models = csv(value, settings.providers.ollamaCloud.models); });
  apply("providers.ollamaCloud", "MANOR_OLLAMA_CLOUD_CONTEXT_WINDOW", (value) => { settings.providers.ollamaCloud.contextWindow = integer(value, settings.providers.ollamaCloud.contextWindow, 8_192, 2_000_000); });
  apply("providers.ollamaCloud", "MANOR_OLLAMA_CLOUD_MAX_TOKENS", (value) => { settings.providers.ollamaCloud.maxTokens = integer(value, settings.providers.ollamaCloud.maxTokens, 1_024, 2_000_000); });
  apply("providers.ollamaCloud", "MANOR_OLLAMA_CLOUD_REASONING", (value) => { settings.providers.ollamaCloud.reasoning = bool(value, settings.providers.ollamaCloud.reasoning); });
  apply("providers.ollamaCloud", "MANOR_OLLAMA_CLOUD_SUPPORTS_DEVELOPER_ROLE", (value) => { settings.providers.ollamaCloud.supportsDeveloperRole = bool(value, false); });
  apply("providers.ollamaCloud", "MANOR_OLLAMA_CLOUD_SUPPORTS_REASONING_EFFORT", (value) => { settings.providers.ollamaCloud.supportsReasoningEffort = bool(value, false); });
  if (hasEnv(env, "OLLAMA_API_KEY") || hasEnv(env, "OLLAMA_API_KEY_FILE")) {
    markEnvGroup(envGroups, "providers.ollamaCloud");
    markEnvGroup(envGroups, "providers.ollamaWebTools");
    settings.providers.ollamaCloud.apiKeySource = envSource(env);
    settings.providers.ollamaWebTools.apiKeySource = envSource(env);
  }

  apply("providers.ollamaWebTools", "MANOR_OLLAMA_WEB_TOOLS_ENABLED", (value) => { settings.providers.ollamaWebTools.enabled = bool(value, settings.providers.ollamaWebTools.enabled); });
  apply("providers.ollamaWebTools", "MANOR_OLLAMA_WEB_TOOLS_BASE_URL", (value) => { settings.providers.ollamaWebTools.baseUrl = baseUrl(value, settings.providers.ollamaWebTools.baseUrl); });
  apply("providers.ollamaWebTools", "MANOR_OLLAMA_WEB_SEARCH_MAX_RESULTS", (value) => { settings.providers.ollamaWebTools.maxResults = integer(value, settings.providers.ollamaWebTools.maxResults, 1, 10); });
  apply("providers.ollamaWebTools", "MANOR_OLLAMA_WEB_TOOLS_TIMEOUT_MS", (value) => { settings.providers.ollamaWebTools.timeoutMs = integer(value, settings.providers.ollamaWebTools.timeoutMs, 1_000, 10 * 60_000); });
  apply("providers.ollamaWebTools", "MANOR_OLLAMA_WEB_TOOLS_MAX_CONTENT_CHARS", (value) => { settings.providers.ollamaWebTools.maxContentChars = integer(value, settings.providers.ollamaWebTools.maxContentChars, 1_000, 200_000); });
  apply("providers.ollamaWebTools", "MANOR_OLLAMA_WEB_TOOLS_FOR_ALL_PI_MODELS", (value) => { settings.providers.ollamaWebTools.forAllPiModels = bool(value, false); });

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
    case "providers.ollamaCloud": return settings.providers.ollamaCloud;
    case "providers.ollamaWebTools": return settings.providers.ollamaWebTools;
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
    case "providers.ollamaCloud": next.providers.ollamaCloud = { ...next.providers.ollamaCloud, ...(isRecord(value) ? value : {}) } as never; break;
    case "providers.ollamaWebTools": next.providers.ollamaWebTools = { ...next.providers.ollamaWebTools, ...(isRecord(value) ? value : {}) } as never; break;
    case "worker": next.worker = { ...next.worker, ...(isRecord(value) ? value : {}) } as never; break;
    case "butler": next.butler = { ...next.butler, ...(isRecord(value) ? value : {}) } as never; break;
    case "modelTasks": next.modelTasks = { ...next.modelTasks, ...(isRecord(value) ? value : {}) } as never; break;
    case "memory": next.memory = { ...next.memory, ...(isRecord(value) ? value : {}) } as never; break;
    case "embeddings": next.embeddings = { ...next.embeddings, ...(isRecord(value) ? value : {}) } as never; break;
  }
  return normalizeManorSettings(next);
}
