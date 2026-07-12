import type { CodexAppServerClient } from "./codex-client.js";
import type { PiRpcWorkerClient } from "./pi-rpc-worker-client.js";
import type { FileReferenceStore } from "./file-store.js";
import type { HostControllerClient } from "./host-controller-client.js";
import type { ImageReferenceStore } from "./image-store.js";
import type { MemoryUpdateScheduler } from "./memory-update-scheduler.js";
import type { WorkerProviderAffinity } from "./pair-store.js";
import type { RuntimeBrokerClient } from "./runtime-broker-client.js";
import type { ServiceTemplateRegistry } from "./service-templates.js";
import type { ButlerStateStore } from "./state-store.js";

export type ButlerDelegationAttachmentAcknowledgement = {
  attached: boolean;
  rollback?: () => boolean;
  flush?: () => Promise<void>;
};

export type ButlerOperatorSink = {
  onDelegationAcknowledgement?: (input: {
    threadId: string;
    text: string;
    at: number;
    runtime?: "openai" | "pi-rpc" | null;
    harness?: string | null;
    provider?: string | null;
    model?: string | null;
    effort?: string | null;
    replacesThreadId?: string | null;
  }) => ButlerDelegationAttachmentAcknowledgement | void;
  onOperatorReply?: (input: { threadId: string; text: string; at: number }) => void;
};

export type ButlerAgentDefaults = {
  model: string | null;
  thinkingLevel: string | null;
};

export type ButlerWorkerDefaults = {
  runtime: "auto" | "openai" | "pi-rpc" | null;
  threadId?: string | null;
  runtimeOwnerThreadIds?: string[];
  harness?: string | null;
  model?: string | null;
  effort?: string | null;
};

export type ButlerAgentServiceOptions = {
  store: ButlerStateStore;
  codexClient: CodexAppServerClient;
  piRpcWorkerClient?: PiRpcWorkerClient | null;
  hostController: HostControllerClient;
  runtimeBroker: RuntimeBrokerClient;
  serviceTemplateRegistry: ServiceTemplateRegistry;
  imageStore: ImageReferenceStore;
  fileStore: FileReferenceStore;
  piAuthPath: string;
  codexAuthPath: string;
  codexConfigDir: string;
  sessionDir: string;
  artifactsDir: string;
  runtimeThreadId?: string;
  refreshRuntimeInventory?: () => Promise<void>;
  memoryScheduler?: MemoryUpdateScheduler | null;
  systemPromptSuffix?: string | null;
  operatorSink?: ButlerOperatorSink | null;
  getButlerDefaults?: () => ButlerAgentDefaults | null;
  getWorkerDefaults?: () => ButlerWorkerDefaults | null;
  getWorkerAffinity?: () => WorkerProviderAffinity | null;
  recordSuccessfulWorkerSelection?: (input: { harness: string; provider: string; model: string; effort?: string | null }) => unknown;
};
