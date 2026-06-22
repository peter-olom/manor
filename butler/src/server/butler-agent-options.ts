import type { CodexAppServerClient } from "./codex-client.js";
import type { FileReferenceStore } from "./file-store.js";
import type { HostControllerClient } from "./host-controller-client.js";
import type { ImageReferenceStore } from "./image-store.js";
import type { MemoryUpdateScheduler } from "./memory-update-scheduler.js";
import type { RuntimeBrokerClient } from "./runtime-broker-client.js";
import type { ServiceTemplateRegistry } from "./service-templates.js";
import type { ButlerStateStore } from "./state-store.js";

export type ButlerOperatorSink = {
  onDelegationAcknowledgement?: (input: { threadId: string; text: string; at: number }) => void;
  onOperatorReply?: (input: { threadId: string; text: string; at: number }) => void;
};

export type ButlerAgentServiceOptions = {
  store: ButlerStateStore;
  codexClient: CodexAppServerClient;
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
  refreshRuntimeInventory?: () => Promise<void>;
  memoryScheduler?: MemoryUpdateScheduler | null;
  systemPromptSuffix?: string | null;
  operatorSink?: ButlerOperatorSink | null;
};
