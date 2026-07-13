import type { Model, Usage } from "@earendil-works/pi-ai";
import { calculateCost } from "@earendil-works/pi-ai";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";

import { getActiveManorSettings } from "./manor-settings-runtime.js";
import { resolveModelCostEstimate } from "./model-cost-estimates.js";
import type {
  ModelUsageCost,
  ModelUsageCostBasis,
  ModelUsageProviderRow,
  ModelUsageRow,
  ModelUsageSummary,
  ModelUsageTokens
} from "../shared/model-usage.js";

type UsageSample = {
  at: number;
  sessionId: string;
  provider: string;
  model: string;
  tokens: ModelUsageTokens;
  cost: ModelUsageCost;
};

export type PricingModel = Pick<Model<any>, "id" | "provider" | "cost">;

const ZERO_TOKENS: ModelUsageTokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };

function finite(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

function timestamp(value: unknown, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

function tokensFromUsage(usage: Partial<Usage>): ModelUsageTokens {
  const input = finite(usage.input);
  const output = finite(usage.output);
  const cacheRead = finite(usage.cacheRead);
  const cacheWrite = finite(usage.cacheWrite);
  return { input, output, cacheRead, cacheWrite, total: input + output + cacheRead + cacheWrite };
}

function recordedCost(usage: Partial<Usage>): Omit<ModelUsageCost, "basis"> {
  const cost = usage.cost;
  const input = finite(cost?.input);
  const output = finite(cost?.output);
  const cacheRead = finite(cost?.cacheRead);
  const cacheWrite = finite(cost?.cacheWrite);
  return { input, output, cacheRead, cacheWrite, total: input + output + cacheRead + cacheWrite };
}

function hasPricing(model: PricingModel | null): boolean {
  if (!model) return false;
  return finite(model.cost.input) + finite(model.cost.output) + finite(model.cost.cacheRead) + finite(model.cost.cacheWrite) > 0;
}

function calculateModelCost(model: PricingModel, tokens: ModelUsageTokens): Omit<ModelUsageCost, "basis"> {
  const calculated = calculateCost(model as Model<any>, {
    ...tokens,
    totalTokens: tokens.total,
    cost: { ...ZERO_COST }
  });
  return {
    input: finite(calculated.input),
    output: finite(calculated.output),
    cacheRead: finite(calculated.cacheRead),
    cacheWrite: finite(calculated.cacheWrite),
    total: finite(calculated.total)
  };
}

function providerCostBasis(provider: string, model: string, priced: boolean, oauth: boolean): ModelUsageCostBasis {
  const settings = getActiveManorSettings();
  if (provider === settings.providers.ollamaLocal.providerId || provider === "ollama-local") return "local";
  if (provider === settings.providers.ollamaCloud.providerId || provider === "ollama-cloud") return "included";
  if (provider === settings.providers.opencodeGo.providerId || provider === "opencode-go") {
    return priced ? "usage" : model.toLowerCase().includes("free") ? "included" : "unavailable";
  }
  if (oauth || provider === "openai-codex" || provider === "codex") return priced ? "estimated" : "included";
  if (priced) return "metered";
  if (model.toLowerCase().includes("free")) return "included";
  return "unavailable";
}

function costForUsage(
  provider: string,
  modelId: string,
  usage: Partial<Usage>,
  pricingModel: PricingModel | null,
  oauth: boolean,
  basisOverride?: ModelUsageCostBasis
): ModelUsageCost {
  const tokens = tokensFromUsage(usage);
  const priced = hasPricing(pricingModel) || basisOverride === "estimated";
  const stored = recordedCost(usage);
  const catalogBasis = basisOverride ?? providerCostBasis(provider, modelId, priced, oauth);
  const basis = stored.total > 0 && catalogBasis === "unavailable"
    ? provider === getActiveManorSettings().providers.opencodeGo.providerId || provider === "opencode-go"
      ? "usage"
      : oauth || provider === "openai-codex" || provider === "codex"
        ? "estimated"
        : "metered"
    : catalogBasis;
  const amount = stored.total > 0
    ? stored
    : priced && basis !== "included" && basis !== "local"
      ? calculateModelCost(pricingModel!, tokens)
      : stored;
  return { ...amount, basis };
}

export function createUsageSample(input: {
  at: number;
  sessionId: string;
  provider: string;
  model: string;
  usage: Partial<Usage>;
  pricingModel?: PricingModel | null;
  oauth?: boolean;
}): UsageSample | null {
  const tokens = tokensFromUsage(input.usage);
  if (tokens.total <= 0) return null;
  const settings = getActiveManorSettings();
  const ollamaRoute = input.provider === settings.providers.ollamaCloud.providerId
    || input.provider === settings.providers.ollamaLocal.providerId
    || input.provider === "ollama-cloud"
    || input.provider === "ollama-local";
  const estimate = ollamaRoute && !hasPricing(input.pricingModel ?? null)
    ? resolveModelCostEstimate(input.model)
    : null;
  const pricingModel = estimate
    ? { id: input.model, provider: input.provider, cost: estimate.cost }
    : input.pricingModel ?? null;
  return {
    at: input.at,
    sessionId: input.sessionId,
    provider: input.provider,
    model: input.model,
    tokens,
    cost: costForUsage(
      input.provider,
      input.model,
      input.usage,
      pricingModel,
      input.oauth ?? false,
      ollamaRoute && (hasPricing(pricingModel) || estimate !== null) ? "estimated" : undefined
    )
  };
}

function isAssistantMessage(message: AgentMessage): message is Extract<AgentMessage, { role: "assistant" }> {
  return message.role === "assistant";
}

export function usageSamplesFromPiEntries(
  entries: readonly SessionEntry[],
  sessionId: string,
  models: readonly PricingModel[],
  isOauthModel: (model: PricingModel) => boolean = () => false
): UsageSample[] {
  const byKey = new Map(models.map((model) => [`${model.provider}/${model.id}`, model]));
  const settings = getActiveManorSettings();
  const openCodeProvider = settings.providers.opencodeGo.providerId;
  return entries.flatMap((entry) => {
    if (entry.type !== "message" || !isAssistantMessage(entry.message)) return [];
    const message = entry.message;
    const provider = String(message.provider || "unknown");
    const model = message.responseModel || message.model || "unknown";
    const ollamaRoute = provider === settings.providers.ollamaCloud.providerId
      || provider === settings.providers.ollamaLocal.providerId
      || provider === "ollama-cloud"
      || provider === "ollama-local";
    const pricingModel = byKey.get(`${provider}/${model}`)
      ?? byKey.get(`${provider}/${message.model}`)
      ?? (ollamaRoute ? byKey.get(`${openCodeProvider}/${model}`) ?? byKey.get(`opencode-go/${model}`) : null)
      ?? null;
    const sample = createUsageSample({
      at: timestamp(message.timestamp, timestamp(entry.timestamp, Date.now())),
      sessionId,
      provider,
      model,
      usage: message.usage,
      pricingModel,
      oauth: pricingModel ? isOauthModel(pricingModel) : false
    });
    return sample ? [sample] : [];
  });
}

function combinedBasis(rows: readonly ModelUsageRow[]): ModelUsageCostBasis {
  const bases = new Set(rows.map((row) => row.cost.basis));
  if (bases.size === 0) return "unavailable";
  if (bases.size === 1) return rows[0]!.cost.basis;
  return "partial";
}

export function summarizeUsage(samples: readonly UsageSample[]): ModelUsageSummary {
  const rows = new Map<string, ModelUsageRow & { sessionIds: Set<string> }>();
  const providerRows = new Map<string, ModelUsageProviderRow & { sessionIds: Set<string>; modelIds: Set<string> }>();
  for (const sample of samples) {
    const key = `${sample.provider}/${sample.model}`;
    const row = rows.get(key) ?? {
      provider: sample.provider,
      model: sample.model,
      tokens: { ...ZERO_TOKENS },
      cost: { ...ZERO_COST, basis: sample.cost.basis },
      requests: 0,
      sessions: 0,
      sessionIds: new Set<string>()
    };
    row.tokens.input += sample.tokens.input;
    row.tokens.output += sample.tokens.output;
    row.tokens.cacheRead += sample.tokens.cacheRead;
    row.tokens.cacheWrite += sample.tokens.cacheWrite;
    row.tokens.total += sample.tokens.total;
    row.cost.input += sample.cost.input;
    row.cost.output += sample.cost.output;
    row.cost.cacheRead += sample.cost.cacheRead;
    row.cost.cacheWrite += sample.cost.cacheWrite;
    row.cost.total += sample.cost.total;
    if (row.cost.basis !== sample.cost.basis) row.cost.basis = "partial";
    row.requests += 1;
    row.sessionIds.add(sample.sessionId);
    row.sessions = row.sessionIds.size;
    rows.set(key, row);

    const providerRow = providerRows.get(sample.provider) ?? {
      provider: sample.provider,
      tokens: { ...ZERO_TOKENS },
      cost: { ...ZERO_COST, basis: sample.cost.basis },
      requests: 0,
      sessions: 0,
      modelCount: 0,
      sessionIds: new Set<string>(),
      modelIds: new Set<string>()
    };
    providerRow.tokens.input += sample.tokens.input;
    providerRow.tokens.output += sample.tokens.output;
    providerRow.tokens.cacheRead += sample.tokens.cacheRead;
    providerRow.tokens.cacheWrite += sample.tokens.cacheWrite;
    providerRow.tokens.total += sample.tokens.total;
    providerRow.cost.input += sample.cost.input;
    providerRow.cost.output += sample.cost.output;
    providerRow.cost.cacheRead += sample.cost.cacheRead;
    providerRow.cost.cacheWrite += sample.cost.cacheWrite;
    providerRow.cost.total += sample.cost.total;
    if (providerRow.cost.basis !== sample.cost.basis) providerRow.cost.basis = "partial";
    providerRow.requests += 1;
    providerRow.sessionIds.add(sample.sessionId);
    providerRow.modelIds.add(sample.model);
    providerRow.sessions = providerRow.sessionIds.size;
    providerRow.modelCount = providerRow.modelIds.size;
    providerRows.set(sample.provider, providerRow);
  }
  const models = [...rows.values()]
    .map(({ sessionIds: _sessionIds, ...row }) => row)
    .sort((left, right) => right.cost.total - left.cost.total || right.tokens.total - left.tokens.total || left.model.localeCompare(right.model));
  const providers = [...providerRows.values()]
    .map(({ sessionIds: _sessionIds, modelIds: _modelIds, ...row }) => row)
    .sort((left, right) => right.cost.total - left.cost.total || right.tokens.total - left.tokens.total || left.provider.localeCompare(right.provider));
  const sessionIds = new Set(samples.map((sample) => sample.sessionId));
  const summary: ModelUsageSummary = {
    tokens: { ...ZERO_TOKENS },
    cost: { ...ZERO_COST, basis: combinedBasis(models) },
    requests: samples.length,
    sessions: sessionIds.size,
    unpricedModels: models.filter((row) => row.cost.basis === "unavailable" || row.cost.basis === "included" || row.cost.basis === "local" || row.cost.basis === "partial").length,
    models,
    providers
  };
  for (const row of models) {
    summary.tokens.input += row.tokens.input;
    summary.tokens.output += row.tokens.output;
    summary.tokens.cacheRead += row.tokens.cacheRead;
    summary.tokens.cacheWrite += row.tokens.cacheWrite;
    summary.tokens.total += row.tokens.total;
    summary.cost.input += row.cost.input;
    summary.cost.output += row.cost.output;
    summary.cost.cacheRead += row.cost.cacheRead;
    summary.cost.cacheWrite += row.cost.cacheWrite;
    summary.cost.total += row.cost.total;
  }
  return summary;
}

export type { UsageSample };
