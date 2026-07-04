export type SettingsProvenance = "default" | "env_seed" | "ui";

export type SettingsGroupKey =
  | "overview"
  | "providers.ollamaLocal"
  | "providers.ollamaCloud"
  | "providers.opencodeGo"
  | "worker"
  | "butler"
  | "modelTasks"
  | "memory"
  | "embeddings";

export type SettingsProviderKey = "openai-codex" | "ollama-local" | "ollama-cloud" | "opencode-go";

export type SettingsSecretSource =
  | { type: "env"; name: string }
  | { type: "file"; pathEnv: string }
  | { type: "asiri"; workspace: string; path: string };

export type SettingsRunnerMode = "auto" | "codex" | "pi";
export type SettingsWorkerRuntime = "auto" | "openai" | "pi-rpc";
export type SettingsReasoningEffort = "minimal" | "low" | "medium" | "high" | "xhigh";
export type SettingsThinkingLevel = "off" | "low" | "medium" | "high" | "xhigh";

export type SettingsProviderModel =
  | string
  | { id: string; api?: string | null; reasoning?: boolean | null };

export type SettingsWebTools = {
  enabled: boolean;
  baseUrl: string;
  maxResults: number;
  timeoutMs: number;
  maxContentChars: number;
  forAllPiModels: boolean;
};

export type SettingsOpencodeWebTools = {
  enabled: boolean;
  maxResults: number;
  timeoutMs: number;
  maxContentChars: number;
};

export type ManorSettings = {
  overview: {
    operatorName: string;
    butlerProvider: SettingsProviderKey;
    codexProvider: SettingsProviderKey;
  };
  providers: {
    ollamaLocal: {
      enabled: boolean;
      providerId: string;
      providerName: string;
      baseUrl: string;
      nativeBaseUrl: string;
      api: string;
      models: SettingsProviderModel[];
      contextWindow: number;
      maxTokens: number;
      reasoning: boolean;
      supportsDeveloperRole: boolean;
      supportsReasoningEffort: boolean;
      apiKeySource: SettingsSecretSource | null;
      authHeader: boolean;
    };
    ollamaCloud: {
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
      webTools: SettingsWebTools;
    };
    opencodeGo: {
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
      webTools: SettingsOpencodeWebTools;
    };
  };
  worker: {
    runtime: SettingsWorkerRuntime;
    defaultModel: string | null;
    defaultEffort: SettingsReasoningEffort | null;
  };
  butler: {
    defaultModel: string | null;
    defaultThinkingLevel: SettingsThinkingLevel;
  };
  modelTasks: {
    runnerMode: SettingsRunnerMode;
    memorySynthesisModel: string | null;
    sessionTitleModel: string | null;
    sessionTitleTimeoutMs: number;
    routingClassifierModel: string | null;
    workerReviewModel: string | null;
    memoryPromotionModel: string | null;
  };
  memory: {
    synthesisEnabled: boolean;
    synthesisEffort: "low" | "medium" | "high" | null;
    synthesisTimeoutMs: number;
    synthesisMaxInputChars: number;
    synthesisMaxCandidatesPerRun: number;
    promotionAutoResolve: boolean;
    promotionBatchSize: number;
    promotionMaxBatchesPerRun: number;
    promotionIntervalMs: number;
    semanticEdgeReviewEnabled: boolean;
    semanticEdgeReviewBatchSize: number;
    semanticEdgeReviewIntervalMs: number;
  };
  embeddings: {
    enabled: boolean;
    provider: "ollama";
    host: string;
    model: string;
    timeoutMs: number;
    backfillBatchSize: number;
  };
};

export type ManorSettingsProvenance = Record<SettingsGroupKey, SettingsProvenance>;

export type SettingsValidationStatus = "not_configured" | "ok" | "failed";

export type SettingsValidationKey =
  | "codex"
  | "piRpc"
  | "ollamaLocal"
  | "ollamaCloud"
  | "opencodeGo"
  | "ollamaWebSearch"
  | "ollamaWebFetch"
  | "opencodeWebSearch"
  | "opencodeWebFetch"
  | "memoryEmbeddings";

export type SettingsValidationResult = {
  status: SettingsValidationStatus;
  lastCheckedAt: number | null;
  message: string | null;
};

export type SettingsValidationMap = Record<SettingsValidationKey, SettingsValidationResult>;

export type SettingsProviderAvailability = {
  secretAvailable: boolean;
  enabled: boolean;
  reason: string | null;
};

export type SettingsProviderAvailabilityMap = {
  "openai-codex": SettingsProviderAvailability;
  "ollama-local": SettingsProviderAvailability;
  "ollama-cloud": SettingsProviderAvailability;
  "opencode-go": SettingsProviderAvailability;
};
