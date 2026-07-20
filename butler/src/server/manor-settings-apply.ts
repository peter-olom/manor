import type { ButlerAgentService } from "./butler-agent.js";
import type { PiRpcWorkerClient } from "./pi-rpc-worker-client.js";
import type { PairSessionManager } from "./pair-session-manager.js";
import type { PairStore } from "./pair-store.js";
import type { ManorSessionTitleGenerator } from "./session-title-generator.js";
import type { ButlerSseHub } from "./server-runtime-helpers.js";
import type { ButlerStateStore } from "./state-store.js";
import { updateUnifiedWorkerCompose } from "./worker-client-router.js";
import { clearOllamaCloudModelsCache } from "./ollama-cloud-models.js";
import { clearOpencodeGoModelsCache } from "./opencode-go-models.js";
import type { ManorSettingsService } from "./manor-settings-service.js";

export function createManorSettingsApplyHandler(input: {
  settingsService: ManorSettingsService;
  applyBackgroundSettings: () => void;
  sessionTitleGenerator: ManorSessionTitleGenerator;
  piRpcWorkerClient: PiRpcWorkerClient;
  butlerAgent: ButlerAgentService;
  pairSessions?: Pick<PairSessionManager, "refreshModelSettings"> | null;
  pairStore?: PairStore | null;
  store: ButlerStateStore;
  getSseHub: () => ButlerSseHub | null | undefined;
  syncContentAdmissionPolicy?: () => Promise<void>;
  now?: () => number;
}): () => Promise<void> {
  return async () => {
    clearOllamaCloudModelsCache();
    clearOpencodeGoModelsCache();
    input.applyBackgroundSettings();
    input.sessionTitleGenerator.applySettings();
    // Move daily schedules before any awaited refresh can let the scheduler
    // observe new settings with an old next-run instant.
    input.pairStore?.recomputeAutomationSchedules(input.now?.() ?? Date.now());
    await input.syncContentAdmissionPolicy?.().catch((error) => console.warn("Content admission policy sync failed after settings update", error));
    await input.piRpcWorkerClient.refreshModels().catch((error) => console.warn("Pi RPC model refresh failed after settings update", error));
    await input.butlerAgent.refreshModelSettings().catch((error) => console.warn("Butler model refresh failed after settings update", error));
    await input.pairSessions?.refreshModelSettings().catch((error) => console.warn("Pair session model refresh failed after settings update", error));
    const worker = input.settingsService.getSettings().worker;
    await updateUnifiedWorkerCompose({
      store: input.store,
      piRpcWorkerClient: input.piRpcWorkerClient,
      getWorkerAffinity: () => input.butlerAgent.getWorkerAffinity()
    }, {
      model: worker.defaultModel,
      effort: worker.defaultEffort as never
    }).catch((error) => console.warn("Worker compose refresh failed after settings update", error));
    input.getSseHub()?.schedule();
  };
}
