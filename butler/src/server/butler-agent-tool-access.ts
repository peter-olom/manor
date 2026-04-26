import type { AgentSession, ModelRegistry } from "@mariozechner/pi-coding-agent";
import { defineTool } from "@mariozechner/pi-coding-agent";
import type { TSchema } from "@sinclair/typebox";

import type { FileReferenceStore } from "./file-store.js";
import type { ImageReferenceStore } from "./image-store.js";
import type { RuntimeBrokerClient } from "./runtime-broker-client.js";
import type { LoadedServiceTemplate, ServiceTemplateRegistry } from "./service-templates.js";
import type { ButlerStateStore } from "./state-store.js";
import type {
  AppSnapshot,
  ButlerAuthStatus,
  ButlerCompactionView,
  ButlerMessageView,
  ButlerNextWorkerReportAction,
  ButlerOnboardingView,
  ButlerThreadCallbackView,
  ButlerToolView,
  ButlerThinkingLevel,
  ButlerToolUiEffect,
  CodexThreadExecutionContractView,
  PreviewVerificationView
} from "./types.js";
import type { CodexAppServerClient } from "./codex-client.js";
import type { ButlerOperatorThreadGuard, ProofScreenshotReview, ResolvedPreviewProof, SupervisionSmokePlan } from "./butler-agent-helpers.js";

export type ButlerCustomTool = ReturnType<typeof defineTool>;

export type ButlerToolDefiner = <TParams extends Record<string, unknown>>(definition: {
  name: string;
  label: string;
  description: string;
  promptSnippet: string;
  parameters: TSchema;
  uiEffects: ButlerToolUiEffect[];
  execute: (
    toolCallId: string,
    params: TParams
  ) => Promise<{ content: Array<{ type: "text"; text: string }>; details?: Record<string, unknown> }>;
}) => ButlerCustomTool;

export type ButlerAgentToolAccess = {
  store: ButlerStateStore;
  codexClient: CodexAppServerClient;
  runtimeBroker: RuntimeBrokerClient;
  serviceTemplateRegistry: ServiceTemplateRegistry;
  imageStore: ImageReferenceStore;
  fileStore: FileReferenceStore;
  supervisionSmokePlans: Map<string, SupervisionSmokePlan>;
  defineButlerTool: ButlerToolDefiner;
  getToolUiEffects(name: string): ButlerToolUiEffect[];
  refreshRuntimeInventoryIfAvailable(): Promise<string | null>;
  prepareDelegationWorkspace(task: string, cwd?: string): Promise<{ cwd: string; branchName: string | null }>;
  describeStackStorage(stack: {
    storageMode: "ephemeral" | "job" | "base" | "custom";
    baseStorageKey: string | null;
    storageKey: string | null;
    cloneFromStorageKey: string | null;
    defaultPromoteTargetStorageKey: string | null;
    retainsVolumes: boolean;
    volumeNames: string[];
  }): string;
  normalizeStringArray(value: unknown): string[];
  normalizeServiceEnv(value: unknown): Record<string, string>;
  resolveWorkspaceProject(
    cwd: string | null | undefined,
    fallbackId: string,
    fallbackLabel: string
  ): { id: string; label: string };
  getValidatedStack(
    stackId: string | null,
    threadId: string | null
  ): {
    id: string;
    threadId: string | null;
    worktreePath: string | null;
    title: string;
    networkName: string;
    storageMode: "ephemeral" | "job" | "base" | "custom";
    baseStorageKey: string | null;
    storageKey: string | null;
    cloneFromStorageKey: string | null;
    defaultPromoteTargetStorageKey: string | null;
    retainsVolumes: boolean;
    volumeNames: string[];
    previewIds: string[];
    serviceIds: string[];
  } | null;
  removeStackArtifacts(stackId: string): void;
  requireValidatedPreview(
    leaseId: string,
    threadId: string | null
  ): {
    id: string;
    threadId: string | null;
    projectId: string;
    projectLabel: string;
    title: string;
    stackId: string | null;
    operatorUrl: string;
    bootstrap: {
      phase: string;
      hint: string | null;
    };
    egressProfile: string;
    egressDomains: string[];
    targetHost: string;
    targetPort: number;
  };
  requireValidatedService(
    serviceId: string,
    threadId: string | null
  ): {
    id: string;
    title: string;
    runtimeKind: "container" | "embedded";
    connection: { host: string; port: number; uri: string | null };
    worktreePath: string | null;
  };
  listServiceTemplates(): LoadedServiceTemplate[];
  getServiceTemplate(templateId: string): LoadedServiceTemplate;
  resolvePreviewProof(input: {
    leaseId?: string;
    threadId?: string;
    runId?: string;
  }): ResolvedPreviewProof;
  reviewProofScreenshot(
    proof: ResolvedPreviewProof,
    options?: {
      expectedOutcome?: string;
    }
  ): Promise<ProofScreenshotReview>;
  getThreadBudgetLimitMessage(threadId: string): string | null;
  buildSupervisionSmokeTask(totalFollowUps: number): string;
  buildDelegationDeveloperInstructions(workspace: { cwd: string; branchName: string | null }, task: string): Promise<string>;
  getActiveOperatorThreadGuard(): ButlerOperatorThreadGuard | null;
  noteThreadFocus(threadId: string, reason?: string): void;
  buildDelegationContract(options: {
    threadId: string;
    task: string;
    goal?: string;
    workspace: { cwd: string; branchName: string | null };
    extraNotes?: string[];
  }): Promise<{ text: string; contract: CodexThreadExecutionContractView }>;
  queueDelegationAcknowledgement(threadId: string, text: string): void;
  registerPendingChatCallback(
    threadId: string,
    options?: { privateSteerText?: string | null; nextWorkerReportAction?: ButlerNextWorkerReportAction }
  ): void;
  postOperatorJobReply(threadId: string, text: string): Promise<void>;
  getCodexAuthStatus(): ButlerAuthStatus;
  getSnapshot(): AppSnapshot["butler"];
};

export type ButlerAgentSessionAccess = {
  modelRegistry: ModelRegistry | null;
  session: AgentSession | null;
  auth: ButlerAuthStatus;
  codexAuth: ButlerAuthStatus;
  compaction: Omit<ButlerCompactionView, "autoEnabled" | "active" | "count">;
  ready: boolean;
  pending: boolean;
  lastError: string | null;
  promptQueue: Promise<void>;
  store: ButlerStateStore;
  codexClient: CodexAppServerClient;
  imageStore: ImageReferenceStore;
  fileStore: FileReferenceStore;
  piAuthPath: string;
  codexAuthPath: string;
  codexConfigDir: string;
  sessionDir: string;
  operatorMessages: ButlerMessageView[];
  pendingChatCallbacks: Map<string, ButlerThreadCallbackView>;
  onboarding: ButlerOnboardingView;
  toolCatalog: ButlerToolView[];
  unsubscribeSession: (() => void) | null;
  createOrRefreshSession(): Promise<void>;
  reconcilePendingChatCallbacks(): Promise<void>;
  refreshExternalStatus(): Promise<void>;
  sanitizeSessionMessages(): void;
  describePendingCallbacks(): string;
  buildCustomTools(): ButlerCustomTool[];
  listServiceTemplates(): LoadedServiceTemplate[];
  emit(event: "change"): boolean;
};
