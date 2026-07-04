import type { CodexInputItem } from "./image-store.js";
import { isCodexPreferredModelRef } from "./model-provider-config.js";
import { getActiveManorSettings } from "./manor-settings-runtime.js";
import type { CodexAppServerClient } from "./codex-client.js";
import type { PiRpcWorkerClient } from "./pi-rpc-worker-client.js";
import type { ButlerStateStore } from "./state-store.js";
import type { ModelOption, ReasoningEffort } from "./types.js";

export type WorkerRuntime = "openai" | "pi-rpc";
export type WorkerRuntimePreference = WorkerRuntime | "auto";

export type WorkerClientAccess = {
  store: ButlerStateStore;
  codexClient: CodexAppServerClient;
  piRpcWorkerClient?: PiRpcWorkerClient | null;
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
};

export type UnifiedWorkerCompose = {
  runtime: WorkerRuntimePreference;
  provider: string | null;
  model: string | null;
  effort: ReasoningEffort | null;
  availableModels: ModelOption[];
  availableEfforts: ReasoningEffort[];
};

function configuredWorkerRuntime(): WorkerRuntimePreference {
  return getActiveManorSettings().worker.runtime;
}

function configuredWorkerModel(): string | null {
  return getActiveManorSettings().worker.defaultModel;
}

function configuredWorkerEffort(): ReasoningEffort | null {
  return getActiveManorSettings().worker.defaultEffort as ReasoningEffort | null;
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

function codexModelId(modelRef: string): string {
  const trimmed = modelRef.trim();
  return trimmed.includes("/") ? trimmed.split("/").slice(1).join("/") : trimmed;
}

function resolveAvailableModelId(modelRef: string | null | undefined, availableModels: ModelOption[]): string | null {
  const trimmed = modelRef?.trim() || null;
  if (!trimmed) return null;
  if (availableModels.some((entry) => entry.id === trimmed)) return trimmed;
  if (isCodexPreferredModelRef(trimmed)) {
    const unqualified = codexModelId(trimmed);
    if (availableModels.some((entry) => entry.id === unqualified)) return unqualified;
  }
  return null;
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
  if (preference === "openai") return "openai";
  const selectedModel = input.model?.trim() || configuredWorkerModel();
  if (selectedModel && !isCodexPreferredModelRef(selectedModel)) {
    if (!access.piRpcWorkerClient) throw new Error(`Model ${selectedModel} requires Pi RPC, but Pi RPC worker runtime is not available`);
    return "pi-rpc";
  }
  return "openai";
}

export function getUnifiedWorkerCompose(access: WorkerClientAccess, overrideModel?: string | null, overrideEffort?: string | null): UnifiedWorkerCompose {
  const codexCompose = access.codexClient.getConnectionState().compose;
  const piCompose = access.piRpcWorkerClient?.getConnectionState().compose ?? null;
  const codexModels = codexCompose.availableModels.map(qualifyModelOption).filter((model) => model.provider !== "opencode");
  const piModels = piCompose?.availableModels.map(qualifyModelOption).filter((model) => model.provider !== "opencode") ?? [];
  const seen = new Set<string>();
  const availableModels = [...codexModels, ...piModels].filter((model) => {
    if (seen.has(model.id)) return false;
    seen.add(model.id);
    return true;
  });
  const configuredModel = overrideModel?.trim() || configuredWorkerModel();
  const runtimePreference = configuredWorkerRuntime();
  const defaultModel = runtimePreference === "pi-rpc"
    ? piModels[0]?.id ?? codexModels[0]?.id ?? null
    : resolveAvailableModelId(codexCompose.model, availableModels) ?? codexModels[0]?.id ?? piModels[0]?.id ?? null;
  const model = resolveAvailableModelId(configuredModel, availableModels) ?? defaultModel;
  const selected = availableModels.find((entry) => entry.id === model) ?? null;
  const effort = (overrideEffort as ReasoningEffort | null) ?? configuredWorkerEffort() ?? codexCompose.effort ?? piCompose?.effort ?? selected?.defaultReasoningEffort ?? null;
  const availableEfforts = Array.from(new Set((selected ? selected.supportedReasoningEfforts : availableModels.flatMap((entry) => entry.supportedReasoningEfforts)) as ReasoningEffort[]));
  return {
    runtime: runtimePreference,
    provider: selected?.provider ?? null,
    model,
    effort,
    availableModels,
    availableEfforts
  };
}

export async function updateUnifiedWorkerCompose(access: WorkerClientAccess, input: { model?: string | null; effort?: ReasoningEffort | null }): Promise<{ model: string | null; effort: ReasoningEffort | null; runtime: WorkerRuntime }> {
  const compose = getUnifiedWorkerCompose(access, input.model ?? null, input.effort ?? null);
  const model = resolveAvailableModelId(input.model, compose.availableModels) ?? compose.model;
  const effort = input.effort ?? compose.effort;
  const runtime = resolveNewWorkerRuntime(access, { model, runtime: "auto" });
  if (runtime === "pi-rpc") {
    if (!access.piRpcWorkerClient) throw new Error("Pi RPC worker runtime is not available");
    if (model) await access.piRpcWorkerClient.updateComposeSettings(model, effort);
  } else if (model) {
    await access.codexClient.updateComposeSettings(codexModelId(model), effort ?? null);
  } else if (effort) {
    const current = access.codexClient.getConnectionState().compose.model;
    if (!current) throw new Error("No Codex worker model is selected");
    await access.codexClient.updateComposeSettings(current, effort);
  }
  return { model, effort, runtime };
}

export async function startWorkerThread(access: WorkerClientAccess, options: WorkerStartOptions): Promise<{ threadId: string; turnId: string | null; runtime: WorkerRuntime }> {
  const requestedModel = options.model?.trim() || configuredWorkerModel();
  const runtime = resolveNewWorkerRuntime(access, { ...options, model: requestedModel });
  if (requestedModel) {
    await updateUnifiedWorkerCompose(access, { model: requestedModel, effort: options.effort ?? null });
  }
  const client = runtime === "pi-rpc" ? access.piRpcWorkerClient : access.codexClient;
  if (!client) throw new Error("Pi RPC worker runtime is not available");
  const result = await client.startThread(options);
  return { ...result, runtime };
}

export async function loadWorkerThread(access: WorkerClientAccess, threadId: string): Promise<void> {
  const runtime = resolveThreadWorkerRuntime(access, threadId);
  if (runtime === "pi-rpc") {
    if (!access.piRpcWorkerClient) throw new Error("Pi RPC worker runtime is not available");
    await access.piRpcWorkerClient.loadThread(threadId);
    return;
  }
  await access.codexClient.loadThread(threadId);
}

export async function sendWorkerMessage(access: WorkerClientAccess, threadId: string, input: string | CodexInputItem[]): Promise<{ threadId: string; turnId: string | null }> {
  const runtime = resolveThreadWorkerRuntime(access, threadId);
  if (runtime === "pi-rpc") {
    if (!access.piRpcWorkerClient) throw new Error("Pi RPC worker runtime is not available");
    return access.piRpcWorkerClient.sendMessage(threadId, input);
  }
  return access.codexClient.sendMessage(threadId, input);
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
  const runtime = resolveThreadWorkerRuntime(access, threadId);
  if (runtime === "pi-rpc") {
    if (!access.piRpcWorkerClient) throw new Error("Pi RPC worker runtime is not available");
    return { deleted: await access.piRpcWorkerClient.deleteThread(threadId) };
  }
  return access.codexClient.deleteThread(threadId, options);
}

export async function deleteAllWorkerThreads(access: WorkerClientAccess): Promise<{ deletedThreadIds: string[]; deletedArtifacts: number }> {
  const threadIds = access.store.listThreads().map((thread) => thread.id);
  const piIds = threadIds.filter((threadId) => resolveThreadWorkerRuntime(access, threadId) === "pi-rpc");
  if (piIds.length > 0 && !access.piRpcWorkerClient) throw new Error("Pi RPC worker runtime is not available");
  for (const threadId of piIds) {
    await access.piRpcWorkerClient!.deleteThread(threadId);
  }
  const codexResult = await access.codexClient.deleteAllThreads();
  return {
    deletedThreadIds: Array.from(new Set([...codexResult.deletedThreadIds, ...piIds])),
    deletedArtifacts: codexResult.deletedArtifacts
  };
}
