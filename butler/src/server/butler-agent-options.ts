import type { PiRpcWorkerClient } from "./pi-rpc-worker-client.js";
import type { FileReferenceStore } from "./file-store.js";
import type { HostControllerClient } from "./host-controller-client.js";
import type { ImageReferenceStore } from "./image-store.js";
import type { MemoryUpdateScheduler } from "./memory-update-scheduler.js";
import type { WorkerProviderAffinity } from "./pair-store.js";
import type { RuntimeBrokerClient } from "./runtime-broker-client.js";
import type { ServiceTemplateRegistry } from "./service-templates.js";
import type { ButlerStateStore } from "./state-store.js";
import type { VisionInspectionService } from "./vision-inspection.js";
import type { ExtensionUiBroker } from "./extension-ui-broker.js";
import type { SkillsService } from "./skills-service.js";
import type { PairAutomation } from "../shared/pairing.js";
import type { ButlerExecutorClient } from "./butler-executor-client.js";

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
    runtime?: "pi-rpc" | null;
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
  runtime: "auto" | "pi-rpc" | null;
  cwd?: string | null;
  threadId?: string | null;
  runtimeOwnerThreadIds?: string[];
  harness?: string | null;
  model?: string | null;
  effort?: string | null;
};

export type ButlerAutomationAccess = {
  get: () => PairAutomation | null;
  configure: (input: { instruction: string; dailyTimes: string[]; endDate?: string }) => Promise<PairAutomation>;
  configureOnce: (input: { instruction: string; on: string; time: string }) => Promise<PairAutomation>;
  configureWeekly: (input: { instruction: string; weekdays: string[]; times: string[]; endDate?: string }) => Promise<PairAutomation>;
  configureWindow: (input: { instruction: string; everyMinutes: number; startTime: string; endTime: string; endDate?: string }) => Promise<PairAutomation>;
  configureInterval: (input: { instruction: string; everyMinutes: number; durationMinutes: number }) => Promise<PairAutomation>;
  setEnabled: (enabled: boolean) => Promise<PairAutomation>;
  delete: () => Promise<boolean>;
};

export type ButlerAgentServiceOptions = {
  store: ButlerStateStore;
  piRpcWorkerClient?: PiRpcWorkerClient | null;
  butlerExecutorClient?: ButlerExecutorClient | null;
  hostController: HostControllerClient;
  runtimeBroker: RuntimeBrokerClient;
  serviceTemplateRegistry: ServiceTemplateRegistry;
  imageStore: ImageReferenceStore;
  fileStore: FileReferenceStore;
  visionInspection: VisionInspectionService;
  piAuthPath: string;
  workerAuthPath: string;
  workerConfigDir: string;
  sessionDir: string;
  artifactsDir: string;
  runtimeThreadId?: string;
  refreshRuntimeInventory?: () => Promise<void>;
  memoryScheduler?: MemoryUpdateScheduler | null;
  systemPromptSuffix?: string | null;
  operatorSink?: ButlerOperatorSink | null;
  automationAccess?: ButlerAutomationAccess | null;
  getButlerDefaults?: () => ButlerAgentDefaults | null;
  getWorkerDefaults?: () => ButlerWorkerDefaults | null;
  getWorkerAffinity?: () => WorkerProviderAffinity | null;
  recordSuccessfulWorkerSelection?: (input: { harness: string; provider: string; model: string; effort?: string | null }) => unknown;
  extensionUiBroker?: ExtensionUiBroker | null;
  skillsService?: SkillsService | null;
};
