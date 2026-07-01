export type SettingsProvenance = "default" | "env_seed" | "ui";

export type SettingsGroupKey =
  | "providers.ollamaCloud"
  | "providers.ollamaWebTools"
  | "worker"
  | "butler"
  | "modelTasks"
  | "memory"
  | "embeddings";

export type SettingsSecretSource =
  | { type: "env"; name: string }
  | { type: "file"; pathEnv: string }
  | { type: "asiri"; workspace: string; path: string };

export type SettingsRunnerMode = "auto" | "codex" | "pi";
export type SettingsWorkerRuntime = "auto" | "codex" | "pi-rpc";
export type SettingsReasoningEffort = "minimal" | "low" | "medium" | "high" | "xhigh";
export type SettingsThinkingLevel = "off" | "low" | "medium" | "high" | "xhigh";

export type ManorSettings = {
  providers: {
    ollamaCloud: {
      enabled: boolean;
      providerId: string;
      providerName: string;
      baseUrl: string;
      api: string;
      models: string[];
      contextWindow: number;
      maxTokens: number;
      reasoning: boolean;
      supportsDeveloperRole: boolean;
      supportsReasoningEffort: boolean;
      apiKeySource: SettingsSecretSource;
    };
    ollamaWebTools: {
      enabled: boolean;
      baseUrl: string;
      maxResults: number;
      timeoutMs: number;
      maxContentChars: number;
      forAllPiModels: boolean;
      apiKeySource: SettingsSecretSource;
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
  | "ollamaCloud"
  | "ollamaWebSearch"
  | "ollamaWebFetch"
  | "memoryEmbeddings";

export type SettingsValidationResult = {
  status: SettingsValidationStatus;
  lastCheckedAt: number | null;
  message: string | null;
};

export type SettingsValidationMap = Record<SettingsValidationKey, SettingsValidationResult>;
