import type { AgentSession, ModelRegistry } from "@earendil-works/pi-coding-agent";
import { defineTool } from "@earendil-works/pi-coding-agent";
import type { TSchema } from "@sinclair/typebox";

import type { FileReferenceStore } from "./file-store.js";
import type { HostControllerClient } from "./host-controller-client.js";
import type { ImageReferenceStore } from "./image-store.js";
import type { RuntimeBrokerClient } from "./runtime-broker-client.js";
import type { LoadedServiceTemplate, ServiceTemplateRegistry } from "./service-templates.js";
import type { ButlerStateStore } from "./state-store.js";
import type { JobPayloadView } from "./job-payload-types.js";
import type { JobPayloadKind } from "./job-instruction-artifacts.js";
import type { ButlerDelegationAttachmentAcknowledgement } from "./butler-agent-options.js";
import type {
  AppSnapshot,
  ButlerActivityTurnView,
  ButlerAuthStatus,
  ButlerCompactionView,
  ButlerMessageView,
  ButlerNextWorkerReportAction,
  ButlerOnboardingView,
  ButlerOperatorQuestionView,
  ButlerRoutingDecisionView,
  ButlerThreadCallbackView,
  ButlerToolView,
  ButlerThinkingLevel,
  ButlerToolUiEffect,
  CodexThreadExecutionContractView,
  JobMemoryPromotionCandidateView,
  ManorRestartRequestView,
  PreviewVerificationView,
  ProjectMemoryView
} from "./types.js";
import type { CodexAppServerClient } from "./codex-client.js";
import type { PiRpcWorkerClient } from "./pi-rpc-worker-client.js";
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
    params: TParams,
    signal?: AbortSignal
  ) => Promise<{ content: Array<{ type: "text"; text: string }>; details?: Record<string, unknown> }>;
}) => ButlerCustomTool;

export type ButlerAgentToolAccess = {
  runtimeThreadId: string;
  store: ButlerStateStore;
  codexClient: CodexAppServerClient;
  piRpcWorkerClient: PiRpcWorkerClient | null;
  hostController: HostControllerClient;
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
    projectId: string;
    projectLabel: string;
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
    threadId: string | null;
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
      signal?: AbortSignal;
    }
  ): Promise<ProofScreenshotReview>;
  getThreadBudgetLimitMessage(threadId: string): string | null;
  getOperatorCloseoutBlocker(threadId: string): string | null;
  requestManorRestartAuthorization(input: {
    target?: unknown;
    gitRef?: unknown;
    includeDesktop?: unknown;
    build?: unknown;
    update?: unknown;
    reason?: unknown;
    details?: unknown;
  }): ManorRestartRequestView;
  resolveMemoryPromotion(candidateId: string, accepted: boolean): { candidate: JobMemoryPromotionCandidateView; projectMemory: ProjectMemoryView | null } | null;
  buildSupervisionSmokeTask(totalFollowUps: number): string;
  buildDelegationDeveloperInstructions(workspace: { cwd: string; branchName: string | null }, task: string): Promise<string>;
  getActiveOperatorThreadGuard(): ButlerOperatorThreadGuard | null;
  getActiveOperatorReferences(): { imageReferenceIds: string[]; fileReferenceIds: string[] } | null;
  noteThreadFocus(threadId: string, reason?: string): void;
  buildDelegationContract(options: {
    threadId: string;
    task: string;
    goal?: string;
    workspace: { cwd: string; branchName: string | null };
    extraNotes?: string[];
    orchestration?: ButlerRoutingDecisionView | null;
  }): Promise<{ text: string; contract: CodexThreadExecutionContractView }>;
  createOrUpdateJobPayload(input: {
    threadId: string;
    kind: JobPayloadKind;
    instruction: string;
    imageReferenceIds?: string[];
    fileReferenceIds?: string[];
  }): Promise<JobPayloadView>;
  bindJobPayloadDelivery(threadId: string, delivery: { turnId?: string | null; messageId?: string | null }): Promise<JobPayloadView | null>;
  queueDelegationAcknowledgement(threadId: string, text: string, selection?: {
    runtime?: "openai" | "pi-rpc" | null;
    harness?: string | null;
    provider?: string | null;
    model?: string | null;
    effort?: string | null;
    replacesThreadId?: string | null;
  }): ButlerDelegationAttachmentAcknowledgement | void;
  registerPendingChatCallback(
    threadId: string,
    options?: { privateSteerText?: string | null; preservePrivateSteer?: boolean; nextWorkerReportAction?: ButlerNextWorkerReportAction; requestedAt?: number | null }
  ): Promise<void>;
  removeExternalWorkerDelegation?(threadId: string): Promise<void>;
  postOperatorJobReply(threadId: string, text: string): Promise<void>;
  postOperatorQuestion(input: {
    prompt?: string;
    context?: string | null;
    options?: Array<{ id?: string | null; label: string; description?: string | null }>;
    allowFreeform?: boolean;
    questions?: Array<{
      prompt: string;
      context?: string | null;
      options: Array<{ id?: string | null; label: string; description?: string | null }>;
      allowFreeform?: boolean;
    }>;
  }): Promise<ButlerMessageView & { question: ButlerOperatorQuestionView }>;
  getCodexAuthStatus(): ButlerAuthStatus;
  getWorkerDefaults?: () => {
    runtime: "auto" | "openai" | "pi-rpc" | null;
    threadId?: string | null;
    runtimeOwnerThreadIds?: string[];
    harness?: string | null;
    model?: string | null;
    effort?: string | null;
  } | null;
  getSnapshot(): AppSnapshot["butler"];
};

export type ButlerAgentSessionAccess = {
  modelRegistry: ModelRegistry | null;
  session: AgentSession | null;
  systemPromptSuffix: string | null;
  auth: ButlerAuthStatus;
  codexAuth: ButlerAuthStatus;
  compaction: Omit<ButlerCompactionView, "autoEnabled" | "active" | "count">;
  ready: boolean;
  pending: boolean;
  stopRequestedAt: number | null;
  activityTurns: ButlerActivityTurnView[];
  activitySummaryTurns: ButlerActivityTurnView[];
  activeActivityTurnId: string | null;
  activitySequence: number;
  lastError: string | null;
  promptQueue: Promise<void>;
  activeOperatorReferences: { imageReferenceIds: string[]; fileReferenceIds: string[] } | null;
  stopRequestSequence: number;
  store: ButlerStateStore;
  codexClient: CodexAppServerClient;
  imageStore: ImageReferenceStore;
  fileStore: FileReferenceStore;
  piAuthPath: string;
  codexAuthPath: string;
  codexConfigDir: string;
  sessionDir: string;
  runtimeThreadId: string;
  operatorMessages: ButlerMessageView[];
  pendingOperatorMessages: ButlerMessageView[];
  pendingOperatorMessageSequence: number;
  pendingOperatorMessageRevision: number;
  pendingChatCallbacks: Map<string, ButlerThreadCallbackView>;
  pendingManorRestartRequest: ManorRestartRequestView | null;
  authorizedManorRestartRequest: ManorRestartRequestView | null;
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
  saveOperatorMessageState(): Promise<void>;
  getButlerDefaults?: () => { model: string | null; thinkingLevel: string | null } | null;
  emit(event: "change"): boolean;
  emit(event: "butlerPatch", payload: import("./types.js").ButlerLivePatchView): boolean;
  persistActivitySummaryTurn(turn: ButlerActivityTurnView): void;
  traceBuffer: import("./butler-trace-buffer.js").ButlerTraceBuffer;
};
