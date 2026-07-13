export type ModelUsageCostBasis =
  | "metered"
  | "usage"
  | "estimated"
  | "included"
  | "local"
  | "unavailable"
  | "partial";

export type ModelUsageTokens = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
};

export type ModelUsageCost = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
  basis: ModelUsageCostBasis;
};

export type ModelUsageRow = {
  provider: string;
  model: string;
  tokens: ModelUsageTokens;
  cost: ModelUsageCost;
  requests: number;
  sessions: number;
};

export type ModelUsageProviderRow = {
  provider: string;
  tokens: ModelUsageTokens;
  cost: ModelUsageCost;
  requests: number;
  sessions: number;
  modelCount: number;
};

export type ModelUsageSummary = {
  tokens: ModelUsageTokens;
  cost: ModelUsageCost;
  requests: number;
  sessions: number;
  unpricedModels: number;
  models: ModelUsageRow[];
  providers: ModelUsageProviderRow[];
};

export type ModelUsageRange = "7d" | "30d" | "all";

export type ModelUsageResponse = {
  range: ModelUsageRange;
  from: number | null;
  to: number;
  resetAt: number | null;
  summary: ModelUsageSummary;
};
