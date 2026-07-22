import type {
  ManorSettings,
  ManorSettingsProvenance,
  SettingsValidationMap,
  SettingsValidationResult
} from "../shared/settings.js";
import type { AppShellSnapshot, ButlerAuthStatus, ModelOption } from "./types.js";
import type { HostControllerClient, ManorSourceState } from "./host-controller-client.js";
import { isSecretSourceAvailable } from "./manor-settings-runtime.js";
import type { ManorSettingsService } from "./manor-settings-service.js";
import { MANOR_VERSION } from "./manor-version.js";
import type { PiRpcWorkerClient } from "./pi-rpc-worker-client.js";
import { manorWorkerTools } from "./pi-manor-tools-extension.js";
import { redactSensitiveText } from "./redact-sensitive-text.js";
import type { RuntimeBrokerClient } from "./runtime-broker-client.js";
import type { RuntimeEgressClient, RuntimeEgressDomainsResponse } from "./runtime-egress-client.js";
import { selectProviderWebToolSource } from "./provider-web-tools.js";

export const MANOR_AWARENESS_SECTIONS = [
  "overview",
  "agents",
  "providers",
  "models",
  "capabilities",
  "security",
  "services",
  "configuration",
  "all"
] as const;

export type ManorAwarenessSection = typeof MANOR_AWARENESS_SECTIONS[number];

type AwarenessError = {
  component: string;
  message: string;
};

type SafeAuthStatus = {
  mode: ButlerAuthStatus["mode"];
  credentialAcceptedLocally: boolean;
  error: string | null;
  credentialStateObservedAt: number | null;
};

type AgentAwareness = {
  environment: "Butler" | "Worker";
  harness: "pi";
  runtime: "pi-agent" | "pi-rpc";
  ready: boolean;
  runtimeAvailable: boolean;
  availabilityBasis: "active-agent-state" | "paired-runtime-unloaded" | "configured-runtime-client";
  selected: {
    provider: string | null;
    model: string | null;
    thinking: string | null;
    availableInRegistry: boolean | null;
  };
  authentication: SafeAuthStatus;
  availableModelCount: number;
  lastError: string | null;
};

type ProviderAwareness = {
  id: string;
  name: string;
  enabled: boolean;
  configured: boolean;
  credentialAvailable: boolean | null;
  credentialAcceptedLocally: boolean | null;
  locallyUsable: boolean;
  lastKnownReachable: boolean | null;
  selectedBy: Array<"Butler" | "Worker">;
  modelCounts: { butler: number; worker: number; total: number };
  lastValidation: SettingsValidationResult | null;
  evidence: string[];
};

type RuntimeInventorySummary = {
  total: number;
  byStatus: Record<string, number>;
};

export type ManorSystemAwarenessSnapshot = {
  schemaVersion: 1;
  generatedAt: number;
  section: ManorAwarenessSection;
  readOnly: true;
  overview?: {
    version: string;
    hotReload: boolean;
    butler: AgentAwareness;
    worker: AgentAwareness;
    providerCount: number;
    lastKnownReachableProviderCount: number;
    uniqueModelCount: number;
    contentAdmissionMode: ManorSettings["security"]["contentAdmissionMode"];
    runtimeEgressMode: RuntimeEgressDomainsResponse["mode"] | null;
    sourceRelation: ManorSourceState["runtime"]["relation"] | null;
  };
  agents?: { butler: AgentAwareness; worker: AgentAwareness };
  providers?: ProviderAwareness[];
  models?: {
    butler: Array<ModelOption & { selected: boolean }>;
    worker: Array<ModelOption & { selected: boolean }>;
    freshness: {
      observedAt: number;
      registryRefreshedAt: null;
      note: string;
    };
  };
  capabilities?: {
    butlerTools: Array<{ name: string; description: string }>;
    workerTools: Array<{ name: string; description: string; source: "pi-core" | "manor-extension" | "provider-extension" }>;
    cliTargets: ["Butler CLI", "Worker CLI"];
  };
  security?: {
    contentAdmission: {
      mode: ManorSettings["security"]["contentAdmissionMode"];
      modelConfigured: boolean;
    };
    runtimeEgress: {
      mode: RuntimeEgressDomainsResponse["mode"] | null;
      domainCounts: { total: number | null; builtIn: number | null; operator: number | null };
    };
    boundary: string;
  };
  services?: {
    source: {
      available: boolean;
      checkoutHead: string | null;
      checkoutDirty: boolean | null;
      changedFileCount: number | null;
      relation: ManorSourceState["runtime"]["relation"] | null;
      summary: string | null;
      runtimeServices: Array<{
        name: string;
        startedAt: string | null;
        sourceHead: string | null;
        dirty: boolean | null;
      }>;
    };
    previews: RuntimeInventorySummary | null;
    stacks: RuntimeInventorySummary | null;
    managedServices: RuntimeInventorySummary | null;
    desktopProof: {
      available: boolean;
      status: string;
      healthy: boolean | null;
      activeSessionCount: number | null;
    } | null;
  };
  configuration?: {
    provenance: ManorSettingsProvenance;
    defaults: {
      butlerModel: string | null;
      butlerThinking: string;
      workerModel: string | null;
      workerEffort: string | null;
    };
    vision: {
      enabled: boolean;
      companionModel: string | null;
      unavailableBehavior: "block" | "continue";
    };
    modelTasks: {
      memorySynthesisModel: string | null;
      sessionTitleModel: string | null;
      memoryPromotionModel: string | null;
    };
    runtime: {
      version: string;
      node: string;
      platform: string;
      architecture: string;
      piVersion: string | null;
      hotReload: boolean;
    };
  };
  provenance: Array<{
    source: string;
    kind: "live-runtime" | "runtime-setting" | "stored-validation" | "read-only-health";
    observedAt: number;
  }>;
  errors: AwarenessError[];
};

export type ManorSystemAwarenessAccess = {
  settingsService: Pick<ManorSettingsService, "getSettings" | "getProvenance" | "getValidation">;
  butlerAgent: {
    getShellSnapshot(): AppShellSnapshot["butler"];
    getButlerAuthStatus(): ButlerAuthStatus;
  };
  piRpcWorkerClient: Pick<PiRpcWorkerClient, "getConnectionState" | "getAuthStatus" | "getThreadModelOption" | "getThreadModelIdentity"> | null;
  runtimeEgress: Pick<RuntimeEgressClient, "list"> | null;
  hostController: Pick<HostControllerClient, "getSourceState"> | null;
  runtimeBroker: Pick<RuntimeBrokerClient, "listLeases" | "listStacks" | "listServices" | "getDesktopProofStatus"> | null;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
};

export type ManorSystemAwarenessContext = {
  butler?: {
    shell: AppShellSnapshot["butler"];
    auth: ButlerAuthStatus;
  } | null;
  workerThreadId?: string | null;
  workerEffort?: string | null;
};

export type ManorSystemAwarenessReader = (
  section?: ManorAwarenessSection,
  context?: ManorSystemAwarenessContext
) => Promise<ManorSystemAwarenessSnapshot>;

function safeError(error: unknown): string {
  return redactSensitiveText(error instanceof Error ? error.message : String(error))
    .replace(/https?:\/\/\S+/gi, "[redacted endpoint]")
    .replace(/(?:^|\s)(?:\/[^\s:]+){2,}/g, " [redacted path]")
    .slice(0, 800);
}

function safeAuth(status: ButlerAuthStatus): SafeAuthStatus {
  return {
    mode: status.mode,
    credentialAcceptedLocally: status.loggedIn,
    error: status.validationError ? safeError(status.validationError) : null,
    credentialStateObservedAt: status.lastValidatedAt
  };
}

function uniqueModels(models: ModelOption[]): ModelOption[] {
  const seen = new Set<string>();
  return models.filter((model) => {
    const key = `${model.provider ?? "unknown"}/${model.id}/${model.harness ?? "pi"}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function validationForProvider(id: string, settings: ManorSettings, validation: SettingsValidationMap): SettingsValidationResult | null {
  // piRpc validation only proves that the shared Pi inventory is populated. It
  // does not validate either OpenAI transport, so it must not be attributed to
  // those providers as reachability evidence.
  if (id === "openai" || id === "openai-codex") return null;
  if (id === "ollama-local" || id === settings.providers.ollamaLocal.providerId) return validation.ollamaLocal;
  if (id === "ollama-cloud" || id === settings.providers.ollamaCloud.providerId) return validation.ollamaCloud;
  if (id === "opencode-go" || id === settings.providers.opencodeGo.providerId) return validation.opencodeGo;
  return null;
}

function safeValidation(value: SettingsValidationResult | null): SettingsValidationResult | null {
  if (!value) return null;
  return {
    status: value.status,
    lastCheckedAt: value.lastCheckedAt,
    message: value.message ? safeError(value.message) : null
  };
}

function providerConfiguration(id: string, settings: ManorSettings, env: NodeJS.ProcessEnv, butlerAuth: ButlerAuthStatus, workerAuth: ButlerAuthStatus) {
  if (id === "openai" || id === "openai-codex") {
    const matchingAuth = id === "openai"
      ? [butlerAuth, workerAuth].some((status) => status.providerCredentials?.openai === true || status.mode === "api" && status.loggedIn)
      : [butlerAuth, workerAuth].some((status) => status.providerCredentials?.openaiCodex === true || status.mode === "chatgpt" && status.loggedIn);
    const envCredential = id === "openai" && isSecretSourceAvailable({ type: "env", name: "OPENAI_API_KEY" }, env);
    return {
      name: id === "openai" ? "OpenAI API" : "ChatGPT/Codex",
      enabled: true,
      configured: matchingAuth || envCredential,
      credentialAvailable: matchingAuth || envCredential,
      credentialAcceptedLocally: matchingAuth
    };
  }
  const provider = id === "ollama-local" || id === settings.providers.ollamaLocal.providerId
    ? settings.providers.ollamaLocal
    : id === "ollama-cloud" || id === settings.providers.ollamaCloud.providerId
      ? settings.providers.ollamaCloud
      : id === "opencode-go" || id === settings.providers.opencodeGo.providerId
        ? settings.providers.opencodeGo
        : null;
  if (!provider) {
    return { name: id, enabled: true, configured: true, credentialAvailable: null, credentialAcceptedLocally: null };
  }
  const isLocal = provider === settings.providers.ollamaLocal;
  const credentialAvailable = isLocal || Boolean(provider.apiKeySource && isSecretSourceAvailable(provider.apiKeySource, env));
  return {
    name: provider.providerName,
    enabled: provider.enabled,
    configured: provider.enabled,
    credentialAvailable,
    credentialAcceptedLocally: isLocal ? null : credentialAvailable ? null : false
  };
}

function buildProviders(input: {
  settings: ManorSettings;
  validation: SettingsValidationMap;
  env: NodeJS.ProcessEnv;
  butlerAuth: ButlerAuthStatus;
  workerAuth: ButlerAuthStatus;
  butlerModels: ModelOption[];
  workerModels: ModelOption[];
  butlerProvider: string | null;
  workerProvider: string | null;
}): ProviderAwareness[] {
  const configuredIds = [
    "openai",
    "openai-codex",
    input.settings.providers.ollamaLocal.providerId,
    input.settings.providers.ollamaCloud.providerId,
    input.settings.providers.opencodeGo.providerId
  ];
  const ids = [...new Set([
    ...configuredIds,
    ...input.butlerModels.map((model) => model.provider).filter((provider): provider is string => Boolean(provider)),
    ...input.workerModels.map((model) => model.provider).filter((provider): provider is string => Boolean(provider))
  ])];
  return ids.sort((left, right) => left.localeCompare(right)).map((id) => {
    const config = providerConfiguration(id, input.settings, input.env, input.butlerAuth, input.workerAuth);
    const butlerCount = input.butlerModels.filter((model) => model.provider === id).length;
    const workerCount = input.workerModels.filter((model) => model.provider === id).length;
    const validation = safeValidation(validationForProvider(id, input.settings, input.validation));
    const selectedBy: ProviderAwareness["selectedBy"] = [];
    if (input.butlerProvider === id) selectedBy.push("Butler");
    if (input.workerProvider === id) selectedBy.push("Worker");
    const lastKnownReachable = validation?.status === "ok" ? true : validation?.status === "failed" ? false : null;
    const evidence = ["runtime settings"];
    if (butlerCount > 0) evidence.push("live Butler model registry");
    if (workerCount > 0) evidence.push("live Worker model registry");
    if (validation?.lastCheckedAt) evidence.push("stored validation result");
    return {
      id,
      ...config,
      locallyUsable: (butlerCount + workerCount > 0) && config.credentialAvailable !== false,
      lastKnownReachable,
      selectedBy,
      modelCounts: { butler: butlerCount, worker: workerCount, total: butlerCount + workerCount },
      lastValidation: validation,
      evidence
    };
  });
}

function inventorySummary(items: Array<{ status?: unknown }>): RuntimeInventorySummary {
  const normalized = items.map((item) => typeof item.status === "string" ? item.status : "unknown");
  return {
    total: normalized.length,
    byStatus: normalized.reduce<Record<string, number>>((counts, status) => {
      counts[status] = (counts[status] ?? 0) + 1;
      return counts;
    }, {})
  };
}

function selectedModel(models: ModelOption[], selectedId: string | null, provider: string | null): Array<ModelOption & { selected: boolean }> {
  return models.map((model) => ({
    ...model,
    selected: (model.id === selectedId && (provider === null || model.provider === provider))
      || (provider !== null && model.provider === provider && `${provider}/${model.id}` === selectedId)
  }));
}

function canonicalModelKey(model: ModelOption): string {
  const provider = model.provider ?? "unknown";
  const id = model.id.startsWith(`${provider}/`) ? model.id.slice(provider.length + 1) : model.id;
  return `${provider}/${id}`;
}

function formatAgent(agent: AgentAwareness): string {
  const selected = [agent.selected.provider, agent.selected.model, agent.selected.thinking].filter(Boolean).join(" / ") || "none";
  return `${agent.environment}: runtime=${agent.runtimeAvailable ? "available" : "unavailable"} (${agent.availabilityBasis}); ready=${agent.ready}; harness=${agent.harness}; selected=${selected}; models=${agent.availableModelCount}; credential accepted locally=${agent.authentication.credentialAcceptedLocally ? agent.authentication.mode : "no"}`;
}

export function formatManorSystemAwareness(snapshot: ManorSystemAwarenessSnapshot): string {
  const lines = [
    `Manor system awareness (${snapshot.section})`,
    `Observed: ${new Date(snapshot.generatedAt).toISOString()}`,
    "Mode: read-only"
  ];
  if (snapshot.overview) {
    lines.push(
      `Manor version: ${snapshot.overview.version}`,
      formatAgent(snapshot.overview.butler),
      formatAgent(snapshot.overview.worker),
      `Providers: ${snapshot.overview.providerCount} configured or known; ${snapshot.overview.lastKnownReachableProviderCount} have a successful stored validation result.`,
      `Unique models: ${snapshot.overview.uniqueModelCount}.`,
      `Security: Content Admission ${snapshot.overview.contentAdmissionMode}; runtime egress ${snapshot.overview.runtimeEgressMode ?? "unavailable"}.`,
      `Runtime source relation: ${snapshot.overview.sourceRelation ?? "unavailable"}.`
    );
  }
  if (snapshot.agents) lines.push(formatAgent(snapshot.agents.butler), formatAgent(snapshot.agents.worker));
  if (snapshot.providers) {
    lines.push(...snapshot.providers.map((provider) => {
      const selected = provider.selectedBy.length > 0 ? `; selected by ${provider.selectedBy.join(" and ")}` : "";
      return `${provider.id}: enabled=${provider.enabled}; configured=${provider.configured}; credential=${provider.credentialAvailable ?? "unknown"}; credential accepted locally=${provider.credentialAcceptedLocally ?? "unknown"}; locally usable=${provider.locallyUsable}; last-known reachable=${provider.lastKnownReachable ?? "unknown"}; models=${provider.modelCounts.total}${selected}`;
    }));
  }
  if (snapshot.models) {
    const modelLine = (environment: string, model: ModelOption & { selected: boolean }) => {
      const levels = model.supportedThinkingLevels.length > 0 ? model.supportedThinkingLevels.join(",") : "none";
      const context = model.contextWindow ? `; context=${model.contextWindow}` : "";
      const maxOutput = model.maxTokens ? `; max output=${model.maxTokens}` : "";
      const provider = model.provider ?? "unknown";
      const modelRef = model.id.startsWith(`${provider}/`) ? model.id : `${provider}/${model.id}`;
      return `${environment}${model.selected ? " *" : ""} ${modelRef}; image=${model.inputCapabilities.image}; thinking=${levels}${context}${maxOutput}`;
    };
    lines.push(...snapshot.models.butler.map((model) => modelLine("Butler", model)));
    lines.push(...snapshot.models.worker.map((model) => modelLine("Worker", model)));
  }
  if (snapshot.capabilities) {
    lines.push(`Butler tools (${snapshot.capabilities.butlerTools.length}): ${snapshot.capabilities.butlerTools.map((tool) => tool.name).join(", ")}`);
    lines.push(`Worker Manor tools (${snapshot.capabilities.workerTools.length}): ${snapshot.capabilities.workerTools.map((tool) => tool.name).join(", ")}`);
    lines.push(`CLI targets: ${snapshot.capabilities.cliTargets.join(", ")}`);
  }
  if (snapshot.security) {
    lines.push(`Content Admission: ${snapshot.security.contentAdmission.mode}; model configured=${snapshot.security.contentAdmission.modelConfigured}.`);
    lines.push(`Runtime egress: ${snapshot.security.runtimeEgress.mode ?? "unavailable"}; domains=${snapshot.security.runtimeEgress.domainCounts.total ?? "unavailable"}.`);
    lines.push(snapshot.security.boundary);
  }
  if (snapshot.services) {
    lines.push(`Runtime source: ${snapshot.services.source.summary ?? "unavailable"}`);
    lines.push(`Managed runtime: previews=${snapshot.services.previews?.total ?? "unavailable"}; stacks=${snapshot.services.stacks?.total ?? "unavailable"}; services=${snapshot.services.managedServices?.total ?? "unavailable"}.`);
    lines.push(`Desktop proof: ${snapshot.services.desktopProof?.status ?? "unavailable"}.`);
  }
  if (snapshot.configuration) {
    lines.push(`Runtime: Manor ${snapshot.configuration.runtime.version}; Node ${snapshot.configuration.runtime.node}; Pi ${snapshot.configuration.runtime.piVersion ?? "unknown"}; hot reload=${snapshot.configuration.runtime.hotReload}.`);
    lines.push(`Defaults: Butler ${snapshot.configuration.defaults.butlerModel ?? "none"} / ${snapshot.configuration.defaults.butlerThinking}; Worker ${snapshot.configuration.defaults.workerModel ?? "none"} / ${snapshot.configuration.defaults.workerEffort ?? "none"}.`);
    lines.push(`Vision: enabled=${snapshot.configuration.vision.enabled}; companion=${snapshot.configuration.vision.companionModel ?? "none"}; unavailable=${snapshot.configuration.vision.unavailableBehavior}.`);
  }
  if (snapshot.errors.length > 0) {
    lines.push("Unavailable observations:", ...snapshot.errors.map((error) => `${error.component}: ${error.message}`));
  }
  lines.push("Structured snapshot:", JSON.stringify(snapshot));
  return lines.join("\n");
}

async function settle<T>(component: string, read: (() => Promise<T>) | null, errors: AwarenessError[], timeoutMs = 3_000): Promise<T | null> {
  if (!read) {
    errors.push({ component, message: "Not configured." });
    return null;
  }
  try {
    let timer: NodeJS.Timeout | null = null;
    try {
      return await Promise.race([
        read(),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error(`Read timed out after ${timeoutMs} ms.`)), timeoutMs);
        })
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  } catch (error) {
    errors.push({ component, message: safeError(error) });
    return null;
  }
}

export async function buildManorSystemAwareness(
  access: ManorSystemAwarenessAccess,
  section: ManorAwarenessSection = "overview",
  context: ManorSystemAwarenessContext = {}
): Promise<ManorSystemAwarenessSnapshot> {
  const generatedAt = (access.now ?? Date.now)();
  const errors: AwarenessError[] = [];
  const env = access.env ?? process.env;
  const settings = access.settingsService.getSettings();
  const provenance = access.settingsService.getProvenance();
  const validation = access.settingsService.getValidation();
  const butler = context.butler === null ? null : context.butler?.shell ?? access.butlerAgent.getShellSnapshot();
  const butlerAuth = context.butler === null
    ? { mode: "unknown", loggedIn: false, validationError: "The paired Butler runtime is not loaded.", lastValidatedAt: null } satisfies ButlerAuthStatus
    : context.butler?.auth ?? access.butlerAgent.getButlerAuthStatus();
  const workerConnection = access.piRpcWorkerClient?.getConnectionState() ?? {
    connected: false,
    lastError: "Worker Pi runtime is unavailable.",
    compose: { provider: null, model: null, effort: null, availableModels: [] }
  };
  const workerAvailableModels = workerConnection.compose.availableModels.map((model) => ({ ...model, harness: "pi" as const }));
  const threadModel = context.workerThreadId ? access.piRpcWorkerClient?.getThreadModelOption(context.workerThreadId) ?? null : null;
  const threadIdentity = context.workerThreadId ? access.piRpcWorkerClient?.getThreadModelIdentity(context.workerThreadId) ?? null : null;
  const workerCompose = {
    provider: threadIdentity?.provider ?? threadModel?.provider ?? workerConnection.compose.provider,
    model: threadIdentity?.model ?? threadModel?.id ?? workerConnection.compose.model,
    effort: context.workerThreadId
      ? context.workerEffort ?? threadModel?.defaultReasoningEffort ?? null
      : context.workerEffort ?? workerConnection.compose.effort,
    availableModels: workerAvailableModels
  };
  const workerAuth = access.piRpcWorkerClient
    ? await settle("worker authentication", () => access.piRpcWorkerClient!.getAuthStatus(), errors)
      ?? { mode: "none", loggedIn: false, validationError: "Worker authentication status is unavailable.", lastValidatedAt: null }
    : { mode: "none", loggedIn: false, validationError: null, lastValidatedAt: null } satisfies ButlerAuthStatus;
  const butlerModels = uniqueModels(butler?.compose.availableModels ?? []);
  const workerModels = uniqueModels(workerCompose.availableModels);
  const butlerAgent: AgentAwareness = {
    environment: "Butler",
    harness: "pi",
    runtime: "pi-agent",
    ready: butler?.ready ?? false,
    runtimeAvailable: Boolean(butler),
    availabilityBasis: butler ? "active-agent-state" : "paired-runtime-unloaded",
    selected: {
      provider: butler?.compose.provider ?? null,
      model: butler?.compose.model ?? null,
      thinking: butler?.compose.thinkingLevel ?? null,
      availableInRegistry: butler?.compose.model
        ? butlerModels.some((model) => model.id === butler.compose.model && model.provider === butler.compose.provider)
        : null
    },
    authentication: safeAuth(butlerAuth),
    availableModelCount: butlerModels.length,
    lastError: butler?.lastError ? safeError(butler.lastError) : butler ? null : "The paired Butler runtime is not loaded."
  };
  const workerAgent: AgentAwareness = {
    environment: "Worker",
    harness: "pi",
    runtime: "pi-rpc",
    ready: Boolean(access.piRpcWorkerClient) && workerConnection.lastError === null,
    runtimeAvailable: Boolean(access.piRpcWorkerClient),
    availabilityBasis: "configured-runtime-client",
    selected: {
      provider: workerCompose.provider,
      model: workerCompose.model,
      thinking: workerCompose.effort,
      availableInRegistry: workerCompose.model
        ? workerModels.some((model) => model.id === workerCompose.model && model.provider === workerCompose.provider)
        : null
    },
    authentication: safeAuth(workerAuth),
    availableModelCount: workerModels.length,
    lastError: workerConnection.lastError ? safeError(workerConnection.lastError) : null
  };
  const providers = buildProviders({
    settings,
    validation,
    env,
    butlerAuth,
    workerAuth,
    butlerModels,
    workerModels,
    butlerProvider: butler?.compose.provider ?? null,
    workerProvider: workerCompose.provider
  });
  const needsSecurity = section === "overview" || section === "security" || section === "all";
  const needsServices = section === "overview" || section === "services" || section === "all";
  const [egress, source, previews, stacks, managedServices, desktopProof] = await Promise.all([
    needsSecurity ? settle("runtime egress", access.runtimeEgress ? () => access.runtimeEgress!.list() : null, errors) : Promise.resolve(null),
    needsServices ? settle("runtime source", access.hostController ? () => access.hostController!.getSourceState() : null, errors) : Promise.resolve(null),
    needsServices ? settle("runtime previews", access.runtimeBroker ? () => access.runtimeBroker!.listLeases() : null, errors) : Promise.resolve(null),
    needsServices ? settle("runtime stacks", access.runtimeBroker ? () => access.runtimeBroker!.listStacks() : null, errors) : Promise.resolve(null),
    needsServices ? settle("runtime services", access.runtimeBroker ? () => access.runtimeBroker!.listServices() : null, errors) : Promise.resolve(null),
    needsServices ? settle("desktop proof", access.runtimeBroker ? () => access.runtimeBroker!.getDesktopProofStatus() : null, errors) : Promise.resolve(null)
  ]);
  const include = (target: Exclude<ManorAwarenessSection, "overview" | "all">) => section === target || section === "all";
  const workerWebToolSource = include("capabilities")
    ? await settle("Worker provider web tools", () => selectProviderWebToolSource(workerCompose.provider, env), errors)
    : null;
  const snapshot: ManorSystemAwarenessSnapshot = {
    schemaVersion: 1,
    generatedAt,
    section,
    readOnly: true,
    provenance: [
      { source: "Butler model registry and active session", kind: "live-runtime", observedAt: generatedAt },
      { source: "Worker Pi model registry and connection state", kind: "live-runtime", observedAt: generatedAt },
      { source: "Manor settings service", kind: "runtime-setting", observedAt: generatedAt },
      { source: "Manor settings validation history", kind: "stored-validation", observedAt: generatedAt },
      ...(needsServices || needsSecurity ? [{ source: "Manor internal read-only health clients", kind: "read-only-health" as const, observedAt: generatedAt }] : [])
    ],
    errors
  };
  if (section === "overview" || section === "all") {
    snapshot.overview = {
      version: MANOR_VERSION,
      hotReload: env.BUTLER_HOT_RELOAD === "1",
      butler: butlerAgent,
      worker: workerAgent,
      providerCount: providers.length,
      lastKnownReachableProviderCount: providers.filter((provider) => provider.lastKnownReachable === true).length,
      uniqueModelCount: new Set([...butlerModels, ...workerModels].map(canonicalModelKey)).size,
      contentAdmissionMode: settings.security.contentAdmissionMode,
      runtimeEgressMode: egress?.mode ?? null,
      sourceRelation: source?.runtime.relation ?? null
    };
  }
  if (include("agents")) snapshot.agents = { butler: butlerAgent, worker: workerAgent };
  if (include("providers")) snapshot.providers = providers;
  if (include("models")) {
    snapshot.models = {
      butler: selectedModel(butlerModels, butler?.compose.model ?? null, butler?.compose.provider ?? null),
      worker: selectedModel(workerModels, workerCompose.model, workerCompose.provider),
      freshness: {
        observedAt: generatedAt,
        registryRefreshedAt: null,
        note: "Pi exposes the active registry but does not expose its last refresh timestamp. Observation time is not refresh time."
      }
    };
  }
  if (include("capabilities")) {
    snapshot.capabilities = {
      butlerTools: (butler?.tools ?? []).map((tool) => ({ name: tool.name, description: tool.description })),
      workerTools: [
        ...[
          ["read", "Read files."],
          ["bash", "Run shell commands."],
          ["edit", "Apply targeted file edits."],
          ["write", "Write files."],
          ["grep", "Search file contents."],
          ["find", "Find files."],
          ["ls", "List directories."]
        ].map(([name, description]) => ({ name: name!, description: description!, source: "pi-core" as const })),
        ...manorWorkerTools.map((tool) => ({ name: tool.name, description: tool.description, source: "manor-extension" as const })),
        ...(workerWebToolSource ? [
          { name: "web_search", description: `Search the web through the active ${workerWebToolSource} extension.`, source: "provider-extension" as const },
          { name: "web_fetch", description: `Fetch a web page through the active ${workerWebToolSource} extension.`, source: "provider-extension" as const }
        ] : [])
      ],
      cliTargets: ["Butler CLI", "Worker CLI"]
    };
  }
  if (include("security")) {
    snapshot.security = {
      contentAdmission: {
        mode: settings.security.contentAdmissionMode,
        modelConfigured: Boolean(settings.security.contentAdmissionModel)
      },
      runtimeEgress: {
        mode: egress?.mode ?? null,
        domainCounts: {
          total: egress ? egress.domains.length : null,
          builtIn: egress ? egress.domains.filter((entry) => entry.source === "built-in").length : null,
          operator: egress ? egress.domains.filter((entry) => entry.source === "operator").length : null
        }
      },
      boundary: "Manor is a trusted personal appliance. Content Admission and proxy policy are bounded controls, not a complete sandbox or exfiltration boundary."
    };
  }
  if (include("services")) {
    snapshot.services = {
      source: {
        available: Boolean(source),
        checkoutHead: source?.checkout.head ?? null,
        checkoutDirty: source?.checkout.dirty ?? null,
        changedFileCount: source?.checkout.changedFileCount ?? null,
        relation: source?.runtime.relation ?? null,
        summary: source?.runtime.summary ? safeError(source.runtime.summary) : null,
        runtimeServices: (source?.runtime.services ?? []).map((service) => ({
          name: service.service,
          startedAt: service.startedAt,
          sourceHead: service.head,
          dirty: service.dirty
        }))
      },
      previews: previews ? inventorySummary(previews) : null,
      stacks: stacks ? inventorySummary(stacks) : null,
      managedServices: managedServices ? inventorySummary(managedServices) : null,
      desktopProof: desktopProof
        ? {
            available: desktopProof.available,
            status: desktopProof.status,
            healthy: desktopProof.health?.ok ?? null,
            activeSessionCount: desktopProof.health?.activeSessionCount ?? null
          }
        : null
    };
  }
  if (include("configuration")) {
    snapshot.configuration = {
      provenance,
      defaults: {
        butlerModel: settings.butler.defaultModel,
        butlerThinking: settings.butler.defaultThinkingLevel,
        workerModel: settings.worker.defaultModel,
        workerEffort: settings.worker.defaultEffort
      },
      vision: settings.vision,
      modelTasks: {
        memorySynthesisModel: settings.modelTasks.memorySynthesisModel,
        sessionTitleModel: settings.modelTasks.sessionTitleModel,
        memoryPromotionModel: settings.modelTasks.memoryPromotionModel
      },
      runtime: {
        version: MANOR_VERSION,
        node: process.version,
        platform: process.platform,
        architecture: process.arch,
        piVersion: env.PI_VERSION?.trim() || null,
        hotReload: env.BUTLER_HOT_RELOAD === "1"
      }
    };
  }
  return snapshot;
}
