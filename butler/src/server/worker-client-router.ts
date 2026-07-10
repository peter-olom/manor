import path from "node:path";

import type { CodexInputItem } from "./image-store.js";
import { isOpenAiRuntimeProvider } from "./chatgpt-entitlement.js";
import { shouldExposeManorModel } from "./model-provider-config.js";
import { getActiveManorSettings } from "./manor-settings-runtime.js";
import { cleanupGitReviewBaseline } from "./git-review-scope.js";
import type { CodexAppServerClient } from "./codex-client.js";
import type { PiRpcWorkerClient } from "./pi-rpc-worker-client.js";
import type { WorkerProviderAffinity } from "./pair-store.js";
import type { ButlerStateStore } from "./state-store.js";
import { assertCallbackReviewCurrent, monitorCallbackReviewCurrent } from "./butler-job-mutation-guard.js";
import type { ModelOption, ReasoningEffort } from "./types.js";
import { workerExecutionEndAt } from "./worker-execution-window.js";
import { workerFileChangeAttribution } from "./worker-review-attribution.js";
import { isWorkerReviewBaselineReferenced } from "./worker-review-baseline.js";

export type WorkerRuntime = "openai" | "pi-rpc";
export type WorkerRuntimePreference = WorkerRuntime | "auto";

export type WorkerClientAccess = {
  store: ButlerStateStore;
  codexClient: CodexAppServerClient;
  piRpcWorkerClient?: PiRpcWorkerClient | null;
  getCodexAuthStatus?: () => { loggedIn: boolean };
  getWorkerAffinity?: () => WorkerProviderAffinity | null;
  recordSuccessfulWorkerSelection?: (input: { provider: string; model: string; effort?: string | null }) => unknown;
  cleanupReviewBaseline?: typeof cleanupGitReviewBaseline;
};

type WorkerStartOptions = {
  task: string;
  input?: CodexInputItem[] | ((threadId: string) => CodexInputItem[] | Promise<CodexInputItem[]>);
  cwd?: string | null;
  developerInstructions?: string | null;
  effort?: ReasoningEffort | null;
  openWindow?: boolean;
  runtime?: WorkerRuntimePreference | null;
  model?: string | null;
  recordSelection?: boolean;
};

export type UnifiedWorkerCompose = {
  runtime: WorkerRuntimePreference;
  provider: string | null;
  model: string | null;
  effort: ReasoningEffort | null;
  availableModels: ModelOption[];
  availableEfforts: ReasoningEffort[];
};

export type WorkerThreadStartResult = {
  threadId: string;
  turnId: string | null;
  runtime: WorkerRuntime;
  provider: string | null;
  model: string | null;
  effort: ReasoningEffort | null;
};

type DeletedWorkerReviewAttribution = { sourceThreadId: string; reviewCwd: string; paths: string[]; attributionUnknown: boolean; createdAt: number; endedAt: number };

function captureDeletedWorkerReviewAttribution(store: ButlerStateStore, threadId: string): DeletedWorkerReviewAttribution | null {
  const deleted = store.getThread(threadId);
  const reviewCwd = deleted?.executionContract?.reviewBaselineCwd ?? deleted?.executionContract?.workspaceCwd ?? deleted?.cwd;
  if (!deleted || !reviewCwd) return null;
  const attribution = workerFileChangeAttribution(deleted);
  return {
    sourceThreadId: threadId,
    reviewCwd,
    paths: attribution.paths,
    attributionUnknown: !deleted.executionContract?.reviewBaselineCwd || deleted.executionContract.reviewBaselineCaptureFailed === true || attribution.overflow || attribution.paths.length === 0,
    createdAt: deleted.createdAt,
    endedAt: workerExecutionEndAt(deleted)
  };
}

function preserveDeletedWorkerReviewAttribution(store: ButlerStateStore, deleted: DeletedWorkerReviewAttribution): void {
  for (const candidate of store.listThreads()) {
    if (candidate.id === deleted.sourceThreadId) continue;
    const candidateCwd = candidate.executionContract?.reviewBaselineCwd ?? candidate.executionContract?.workspaceCwd ?? candidate.cwd;
    if (!candidateCwd) continue;
    const deletedCwd = path.resolve(deleted.reviewCwd);
    const candidateResolvedCwd = path.resolve(candidateCwd);
    const matchesWorkspace = candidateResolvedCwd === deletedCwd || (deleted.attributionUnknown && candidateResolvedCwd.startsWith(`${deletedCwd}${path.sep}`));
    if (!matchesWorkspace) continue;
    const candidateRecord = store.getThread(candidate.id);
    if (!candidateRecord) continue;
    const candidateEnd = workerExecutionEndAt(candidateRecord);
    if (deleted.createdAt > candidateEnd || candidate.createdAt > deleted.endedAt) continue;
    store.recordWorkerReviewPeerContext(candidate.id, { sourceThreadId: deleted.sourceThreadId, baselineTreeSha: candidateRecord.executionContract?.reviewBaselineTreeSha ?? null, paths: deleted.paths, attributionUnknown: deleted.attributionUnknown, recordedAt: Date.now() });
    store.addEvent(candidate.id, "butler.review.deleted_peer_context", deleted.attributionUnknown
      ? `Preserved unknown change ownership from deleted Worker ${deleted.sourceThreadId}.`
      : `Preserved ${deleted.paths.length} changed path${deleted.paths.length === 1 ? "" : "s"} from deleted Worker ${deleted.sourceThreadId}.`);
  }
}

function configuredWorkerRuntime(): WorkerRuntimePreference {
  return "auto";
}

function configuredWorkerModel(): string | null {
  return getActiveManorSettings().worker.defaultModel;
}

function configuredWorkerEffort(): ReasoningEffort | null {
  return getActiveManorSettings().worker.defaultEffort as ReasoningEffort | null;
}

function codexWorkerIsAuthenticated(access: WorkerClientAccess): boolean {
  return access.getCodexAuthStatus?.().loggedIn === true || Boolean(process.env.OPENAI_API_KEY?.trim());
}

function workerProviderError(error: unknown, provider: string | null): Error {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("Open Settings")) return error instanceof Error ? error : new Error(message);
  if (!/auth|log.?in|sign.?in|unauthori[sz]ed|forbidden|invalid (?:api )?key|\b401\b|\b403\b/i.test(message)) {
    return error instanceof Error ? error : new Error(message);
  }
  return new Error(`The ${provider ?? "selected"} Worker provider needs to be reconnected. Open Settings → Providers, repair its authentication, then retry.`);
}

function workerProviderKey(model: ModelOption): string {
  return isOpenAiRuntimeProvider(model.provider) ? "openai-codex" : model.provider || "openai-codex";
}

function providerQualifiedModel(model: ModelOption): string {
  return model.provider ? `${model.provider}/${model.id}` : model.id;
}

function qualifyModelOption(model: ModelOption): ModelOption {
  return {
    ...model,
    id: providerQualifiedModel(model)
  };
}

function isPiWorkerModel(model: ModelOption): boolean {
  const settings = getActiveManorSettings();
  return new Set([
    settings.providers.ollamaLocal.providerId,
    settings.providers.ollamaCloud.providerId,
    settings.providers.opencodeGo.providerId
  ]).has(model.provider ?? "") && shouldExposeManorModel(model);
}

function resolveAvailableModelId(modelRef: string | null | undefined, availableModels: ModelOption[]): string | null {
  const trimmed = modelRef?.trim() || null;
  if (!trimmed) return null;
  if (availableModels.some((entry) => entry.id === trimmed)) return trimmed;
  return null;
}

function resolveEffortForModel(model: ModelOption | null, requested: ReasoningEffort | null): ReasoningEffort | null {
  if (!model) return requested;
  if (!model.supportsReasoning || model.supportedReasoningEfforts.length === 0) return null;
  if (requested && model.supportedReasoningEfforts.includes(requested)) return requested;
  return model.defaultReasoningEffort ?? model.supportedReasoningEfforts[0] ?? null;
}

function resolveWorkerModel(
  availableModels: ModelOption[],
  overrideModel: string | null | undefined,
  configuredModel: string | null,
  affinity: WorkerProviderAffinity | null
): string | null {
  const explicit = resolveAvailableModelId(overrideModel, availableModels);
  if (explicit) return explicit;

  const groups = new Map<string, ModelOption[]>();
  for (const model of availableModels) {
    const provider = workerProviderKey(model);
    groups.set(provider, [...(groups.get(provider) ?? []), model]);
  }
  if (groups.size === 0) return null;
  const settings = getActiveManorSettings();
  const providerPriority = [
    "openai-codex",
    settings.providers.opencodeGo.providerId,
    settings.providers.ollamaCloud.providerId,
    settings.providers.ollamaLocal.providerId
  ];

  if (affinity?.hasSuccessfulDelegation && affinity.lastProvider) {
    const lastProviderModels = groups.get(affinity.lastProvider);
    if (lastProviderModels?.length) {
      return resolveAvailableModelId(affinity.modelByProvider[affinity.lastProvider], lastProviderModels)
        ?? lastProviderModels[0]!.id;
    }

    const configured = resolveAvailableModelId(configuredModel, availableModels);
    if (configured) return configured;
    for (const provider of providerPriority) {
      const models = groups.get(provider);
      if (!models) continue;
      const remembered = resolveAvailableModelId(affinity.modelByProvider[provider], models);
      if (remembered) return remembered;
    }
    for (const [provider, models] of groups) {
      const remembered = resolveAvailableModelId(affinity.modelByProvider[provider], models);
      if (remembered) return remembered;
    }
    for (const provider of providerPriority) {
      const providerDefault = groups.get(provider)?.[0]?.id;
      if (providerDefault) return providerDefault;
    }
  }

  if (groups.size > 1) {
    const configured = resolveAvailableModelId(configuredModel, availableModels);
    if (configured) return configured;
    for (const provider of providerPriority) {
      const providerDefault = groups.get(provider)?.[0]?.id;
      if (providerDefault) return providerDefault;
    }
  }
  return groups.values().next().value?.[0]?.id ?? null;
}

export function resolveThreadWorkerRuntime(access: WorkerClientAccess, threadId: string): WorkerRuntime {
  const thread = access.store.getThread(threadId);
  if (thread?.source === "pi-rpc" || threadId.startsWith("pi-")) return "pi-rpc";
  return "openai";
}

export function resolveNewWorkerRuntime(access: WorkerClientAccess, input: { runtime?: WorkerRuntimePreference | null; model?: string | null } = {}): WorkerRuntime {
  const preference = input.runtime ?? configuredWorkerRuntime();
  if (preference === "pi-rpc") {
    if (!access.piRpcWorkerClient) throw new Error("Pi RPC worker runtime is not available");
    return "pi-rpc";
  }
  if (preference === "openai") {
    if (!codexWorkerIsAuthenticated(access)) {
      throw new Error("Codex is not connected for Worker jobs. Open Settings → Providers → OpenAI / Codex and sign in, then retry.");
    }
    return "openai";
  }
  const selectedModel = input.model?.trim() || configuredWorkerModel();
  const piState = access.piRpcWorkerClient && typeof access.piRpcWorkerClient.getConnectionState === "function"
    ? access.piRpcWorkerClient.getConnectionState()
    : null;
  const piModels = piState?.compose.availableModels.map(qualifyModelOption).filter(isPiWorkerModel) ?? [];
  if (selectedModel && resolveAvailableModelId(selectedModel, piModels)) {
    if (!access.piRpcWorkerClient) throw new Error(`Model ${selectedModel} requires Pi RPC, but Pi RPC worker runtime is not available`);
    return "pi-rpc";
  }
  if (!codexWorkerIsAuthenticated(access)) {
    if (piModels.length > 0) return "pi-rpc";
    throw new Error("No connected Worker provider is available. Open Settings → Providers to connect Codex, Ollama, or OpenCode Go, then retry.");
  }
  return "openai";
}

export function getUnifiedWorkerCompose(access: WorkerClientAccess, overrideModel?: string | null, overrideEffort?: string | null, overrideRuntime?: WorkerRuntimePreference | null): UnifiedWorkerCompose {
  const codexState = typeof access.codexClient.getConnectionState === "function"
    ? access.codexClient.getConnectionState()
    : null;
  const piState = access.piRpcWorkerClient && typeof access.piRpcWorkerClient.getConnectionState === "function"
    ? access.piRpcWorkerClient.getConnectionState()
    : null;
  const codexCompose = codexState?.compose ?? { model: null, effort: null, availableModels: [] };
  const piCompose = piState?.compose ?? null;
  const codexModels = codexWorkerIsAuthenticated(access)
    ? codexCompose.availableModels.filter((model) => model.provider !== "opencode")
    : [];
  const piModels = piCompose?.availableModels.map(qualifyModelOption).filter(isPiWorkerModel) ?? [];
  const seen = new Set<string>();
  const availableModels = [...codexModels, ...piModels].filter((model) => {
    if (seen.has(model.id)) return false;
    seen.add(model.id);
    return true;
  });
  const configuredModel = configuredWorkerModel();
  const runtimePreference = overrideRuntime ?? configuredWorkerRuntime();
  const selectableModels = runtimePreference === "pi-rpc"
    ? piModels
    : runtimePreference === "openai"
      ? codexModels
      : availableModels;
  const affinity = access.getWorkerAffinity?.() ?? null;
  const model = resolveWorkerModel(selectableModels, overrideModel, configuredModel, affinity);
  const selected = selectableModels.find((entry) => entry.id === model) ?? null;
  const selectedProvider = selected ? workerProviderKey(selected) : null;
  const affinityEffort = selectedProvider && affinity?.modelByProvider[selectedProvider] === model
    ? affinity.effortByProvider[selectedProvider] as ReasoningEffort | null | undefined
    : null;
  const effort = resolveEffortForModel(
    selected,
    (overrideEffort as ReasoningEffort | null) ?? affinityEffort ?? configuredWorkerEffort() ?? selected?.defaultReasoningEffort ?? null
  );
  const availableEfforts = Array.from(new Set((selected ? selected.supportedReasoningEfforts : selectableModels.flatMap((entry) => entry.supportedReasoningEfforts)) as ReasoningEffort[]));
  const runtime = runtimePreference === "auto" && model
    ? resolveNewWorkerRuntime(access, { runtime: runtimePreference, model })
    : runtimePreference;
  return {
    runtime,
    provider: selectedProvider,
    model,
    effort,
    availableModels: selectableModels,
    availableEfforts
  };
}

export async function updateUnifiedWorkerCompose(access: WorkerClientAccess, input: { model?: string | null; effort?: ReasoningEffort | null; runtime?: WorkerRuntimePreference | null }): Promise<{ model: string | null; effort: ReasoningEffort | null; runtime: WorkerRuntime; provider: string | null }> {
  const compose = getUnifiedWorkerCompose(access, input.model ?? null, input.effort ?? null, input.runtime ?? null);
  const model = resolveAvailableModelId(input.model, compose.availableModels) ?? compose.model;
  const effort = compose.effort;
  const runtime = resolveNewWorkerRuntime(access, { model, runtime: input.runtime ?? "auto" });
  const selected = compose.availableModels.find((entry) => entry.id === model) ?? null;
  const provider = runtime === "openai" ? selected?.provider ?? "openai-codex" : selected?.provider ?? null;
  if (runtime === "pi-rpc") {
    if (!access.piRpcWorkerClient) throw new Error("Pi RPC worker runtime is not available");
    if (model) await access.piRpcWorkerClient.updateComposeSettings(model, effort);
  } else if (model) {
    await access.codexClient.updateComposeSettings(model, effort ?? null);
  } else if (effort) {
    if (typeof access.codexClient.getConnectionState !== "function") {
      return { model, effort, runtime, provider };
    }
    const current = access.codexClient.getConnectionState().compose.model;
    if (!current) throw new Error("No Codex worker model is selected");
    await access.codexClient.updateComposeSettings(current, effort);
  }
  return { model, effort, runtime, provider };
}

export async function startWorkerThread(access: WorkerClientAccess, options: WorkerStartOptions): Promise<WorkerThreadStartResult> {
  let provider: string | null = null;
  try {
    const runtimePreference = options.runtime ?? configuredWorkerRuntime();
    if (runtimePreference === "openai" && !codexWorkerIsAuthenticated(access)) {
      provider = "openai-codex";
      resolveNewWorkerRuntime(access, { runtime: runtimePreference, model: options.model });
    }
    const preview = getUnifiedWorkerCompose(access, options.model ?? null, options.effort ?? null, options.runtime ?? null);
    provider = preview.provider;
    if (!preview.model || !preview.provider) {
      throw new Error("No connected Worker model is available. Open Settings → Providers to connect or repair a provider, then retry.");
    }
    const runtime = resolveNewWorkerRuntime(access, { ...options, model: preview.model });
    const compose = {
      runtime,
      provider: preview.provider,
      model: preview.model,
      effort: options.effort === null ? null : preview.effort
    };
    const client = runtime === "pi-rpc" ? access.piRpcWorkerClient : access.codexClient;
    if (!client) throw new Error("Pi RPC worker runtime is not available");
    const { runtime: _runtime, recordSelection: _recordSelection, ...clientOptions } = options;
    const result = await client.startThread({
      ...clientOptions,
      provider: compose.provider,
      model: compose.model,
      effort: compose.effort
    });
    if (options.recordSelection !== false && compose.provider && compose.model) {
      access.recordSuccessfulWorkerSelection?.({ provider: compose.provider, model: compose.model, effort: compose.effort });
    }
    return {
      ...result,
      runtime,
      provider: compose.provider,
      model: compose.model,
      effort: compose.effort
    };
  } catch (error) {
    throw workerProviderError(error, provider);
  }
}

export async function loadWorkerThread(access: WorkerClientAccess, threadId: string): Promise<void> {
  assertCallbackReviewCurrent(threadId);
  const runtime = resolveThreadWorkerRuntime(access, threadId);
  const client = runtime === "pi-rpc" ? access.piRpcWorkerClient : access.codexClient;
  if (!client) throw new Error("Pi RPC worker runtime is not available");
  const callbackMonitor = monitorCallbackReviewCurrent(threadId);
  let timeout: ReturnType<typeof setTimeout> | null = null;
  try {
    await Promise.race([
      client.loadThread(threadId),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error("Worker thread load timed out.")), 30_000);
      }),
      ...(callbackMonitor ? [callbackMonitor.promise] : [])
    ]);
  } catch (error) {
    if (runtime === "openai") access.codexClient.invalidateThreadOperations(threadId);
    throw error;
  } finally {
    if (timeout) clearTimeout(timeout);
    callbackMonitor?.dispose();
  }
  assertCallbackReviewCurrent(threadId);
}

async function stopWorkerMessageBounded(client: { stopThread(threadId: string): Promise<boolean> }, threadId: string): Promise<void> {
  let timeout: ReturnType<typeof setTimeout> | null = null;
  try {
    await Promise.race([
      client.stopThread(threadId).catch(() => false),
      new Promise<void>((resolve) => { timeout = setTimeout(resolve, 2_000); })
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

export async function sendWorkerMessage(access: WorkerClientAccess, threadId: string, input: string | CodexInputItem[]): Promise<{ threadId: string; turnId: string | null }> {
  assertCallbackReviewCurrent(threadId);
  const runtime = resolveThreadWorkerRuntime(access, threadId);
  const client = runtime === "pi-rpc" ? access.piRpcWorkerClient : access.codexClient;
  if (!client) throw new Error("Pi RPC worker runtime is not available");
  const send = client.sendMessage(threadId, input);
  const callbackMonitor = monitorCallbackReviewCurrent(threadId);
  let timeout: ReturnType<typeof setTimeout> | null = null;
  const timeoutFailure = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => {
      const error = new Error("Worker message dispatch timed out.");
      error.name = "WorkerSendTimeoutError";
      reject(error);
    }, 300_000);
  });
  let result: { threadId: string; turnId: string | null };
  try {
    result = await Promise.race([send, timeoutFailure, ...(callbackMonitor ? [callbackMonitor.promise] : [])]);
  } catch (error) {
    const interrupted = error instanceof Error && (error.name === "CallbackReviewSupersededError" || error.name === "WorkerSendTimeoutError");
    if (interrupted) {
      await stopWorkerMessageBounded(client, threadId);
    }
    throw error;
  } finally {
    if (timeout) clearTimeout(timeout);
    callbackMonitor?.dispose();
  }
  try {
    assertCallbackReviewCurrent(threadId);
  } catch (error) {
    await stopWorkerMessageBounded(client, result.threadId);
    throw error;
  }
  return result;
}

export async function updateWorkerThreadEffort(access: WorkerClientAccess, threadId: string, effort: ReasoningEffort): Promise<void> {
  const runtime = resolveThreadWorkerRuntime(access, threadId);
  if (runtime === "pi-rpc") {
    if (!access.piRpcWorkerClient) throw new Error("Pi RPC worker runtime is not available");
    await access.piRpcWorkerClient.updateThreadReasoningEffort(threadId, effort);
    return;
  }
  await access.codexClient.updateThreadReasoningEffort(threadId, effort);
}

export async function stopWorkerThread(access: WorkerClientAccess, threadId: string): Promise<boolean> {
  const runtime = resolveThreadWorkerRuntime(access, threadId);
  if (runtime === "pi-rpc") {
    if (!access.piRpcWorkerClient) throw new Error("Pi RPC worker runtime is not available");
    return access.piRpcWorkerClient.stopThread(threadId);
  }
  return access.codexClient.stopThread(threadId);
}

export async function deleteWorkerThread(access: WorkerClientAccess, threadId: string, options?: { waitForCleanup?: boolean }): Promise<unknown> {
  const baselineObjectDir = access.store.getThread(threadId)?.executionContract?.reviewBaselineObjectDir;
  const deletedAttribution = captureDeletedWorkerReviewAttribution(access.store, threadId);
  const runtime = resolveThreadWorkerRuntime(access, threadId);
  if (runtime === "pi-rpc" && !access.piRpcWorkerClient) throw new Error("Pi RPC worker runtime is not available");
  if (deletedAttribution) {
    preserveDeletedWorkerReviewAttribution(access.store, deletedAttribution);
    await access.store.flushSave();
  }
  let result: unknown;
  if (runtime === "pi-rpc") {
    result = { deleted: await access.piRpcWorkerClient!.deleteThread(threadId) };
  } else {
    result = await access.codexClient.deleteThread(threadId, options);
  }
  const cleanupFailed = result && typeof result === "object" && "cleanupFailed" in result && (result as { cleanupFailed?: unknown }).cleanupFailed === true;
  const cleanupError = result && typeof result === "object" && "cleanupError" in result ? (result as { cleanupError?: unknown }).cleanupError : null;
  if (cleanupFailed) {
    throw new Error(typeof cleanupError === "string" && cleanupError ? cleanupError : `Worker job ${threadId} deletion could not be persisted.`);
  }
  if (access.store.getThread(threadId)) {
    throw new Error(typeof cleanupError === "string" && cleanupError ? cleanupError : `Worker job ${threadId} could not be deleted.`);
  }
  if (!isWorkerReviewBaselineReferenced(access.store, baselineObjectDir)) {
    await (access.cleanupReviewBaseline ?? cleanupGitReviewBaseline)(baselineObjectDir).catch(() => undefined);
  }
  return result;
}

export async function deleteAllWorkerThreads(access: WorkerClientAccess): Promise<{ deletedThreadIds: string[]; deletedArtifacts: number }> {
  const threadIds = access.store.listThreads().map((thread) => thread.id);
  const baselineObjectDirs = new Map(threadIds.map((threadId) => [threadId, access.store.getThread(threadId)?.executionContract?.reviewBaselineObjectDir]));
  const deletedAttributions = new Map(threadIds.map((threadId) => [threadId, captureDeletedWorkerReviewAttribution(access.store, threadId)]));
  const piIds = threadIds.filter((threadId) => resolveThreadWorkerRuntime(access, threadId) === "pi-rpc");
  if (piIds.length > 0 && !access.piRpcWorkerClient) throw new Error("Pi RPC worker runtime is not available");
  for (const attribution of deletedAttributions.values()) if (attribution) preserveDeletedWorkerReviewAttribution(access.store, attribution);
  if ([...deletedAttributions.values()].some(Boolean)) await access.store.flushSave();
  const deletedPiIds: string[] = [];
  try {
    for (const threadId of piIds) {
      const deleted = await access.piRpcWorkerClient!.deleteThread(threadId);
      if (!deleted && access.store.getThread(threadId)) throw new Error(`Worker job ${threadId} could not be deleted.`);
      deletedPiIds.push(threadId);
    }
    const codexResult = await access.codexClient.deleteAllThreads();
    return {
      deletedThreadIds: Array.from(new Set([...codexResult.deletedThreadIds, ...deletedPiIds])),
      deletedArtifacts: codexResult.deletedArtifacts
    };
  } finally {
    const deletedIds = threadIds.filter((threadId) => !access.store.getThread(threadId));
    const cleanupDirs = [...new Set(deletedIds.map((threadId) => baselineObjectDirs.get(threadId)).filter((value): value is string => Boolean(value)))]
      .filter((objectDir) => !isWorkerReviewBaselineReferenced(access.store, objectDir));
    await Promise.allSettled(cleanupDirs.map((objectDir) => (access.cleanupReviewBaseline ?? cleanupGitReviewBaseline)(objectDir)));
  }
}
