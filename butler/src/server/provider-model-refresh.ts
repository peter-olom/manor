import type { ButlerAgentService } from "./butler-agent.js";
import { getCachedOllamaCloudModels, onOllamaCloudModelsDiscovered } from "./ollama-cloud-models.js";
import type { PairSessionManager } from "./pair-session-manager.js";
import type { PiRpcWorkerClient } from "./pi-rpc-worker-client.js";

export class ProviderModelRefreshCoordinator {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private requested = false;
  private disposed = false;
  private failedAttempts = 0;

  constructor(private readonly options: {
    isIdle: () => boolean;
    refresh: () => Promise<boolean | void>;
    onError?: (error: unknown) => void;
    retryMs?: number;
    maxAttempts?: number;
  }) {}

  request(): void {
    if (this.disposed) return;
    this.requested = true;
    this.failedAttempts = 0;
    this.schedule(0);
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private schedule(delayMs: number): void {
    if (this.disposed || this.running || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.run();
    }, delayMs);
    this.timer.unref?.();
  }

  private async run(): Promise<void> {
    if (this.disposed || this.running || !this.requested) return;
    if (!this.options.isIdle()) {
      this.schedule(this.options.retryMs ?? 1_000);
      return;
    }
    this.running = true;
    this.requested = false;
    try {
      const refreshed = await this.options.refresh();
      if (refreshed === false) this.requested = true;
    } catch (error) {
      this.options.onError?.(error);
      this.failedAttempts += 1;
      this.requested = this.failedAttempts < (this.options.maxAttempts ?? 3);
    } finally {
      this.running = false;
      if (this.requested) this.schedule(this.options.retryMs ?? 1_000);
    }
  }
}

export function createProviderModelRefreshCoordinator(input: {
  butlerAgent: ButlerAgentService;
  pairSessions: PairSessionManager;
  piRpcWorkerClient: PiRpcWorkerClient;
  scheduleSse: () => void;
}): ProviderModelRefreshCoordinator {
  return new ProviderModelRefreshCoordinator({
    isIdle: () => {
      const shell = input.butlerAgent.getShellSnapshot();
      return !shell.pending && !shell.isStreaming && input.pairSessions.canRefreshModelSettings();
    },
    refresh: async () => {
      if (!await input.butlerAgent.refreshModelSettings()) return false;
      if (!await input.pairSessions.refreshModelSettings()) return false;
      await input.piRpcWorkerClient.refreshModels();
      input.scheduleSse();
      return true;
    },
    onError: (error) => console.warn("Provider model inventory refresh deferred", error instanceof Error ? error.message : String(error)),
    retryMs: 5_000
  });
}

export function startOllamaCloudModelRecovery(coordinator: ProviderModelRefreshCoordinator): () => void {
  const unsubscribe = onOllamaCloudModelsDiscovered(() => coordinator.request());
  if (getCachedOllamaCloudModels().length > 0) coordinator.request();
  return unsubscribe;
}
