import { backfillMemoryEmbeddings, type MemoryEmbeddingBackfillResult } from "./memory-embedding-backfill.js";
import {
  OllamaMemoryEmbeddingProvider,
  readMemoryEmbeddingConfig,
  type MemoryEmbeddingConfig,
  type MemoryEmbeddingProvider
} from "./memory-embedding-client.js";
import type { ButlerStateStore } from "./state-store.js";

export type MemoryEmbeddingServiceOptions = {
  store: ButlerStateStore;
  config?: MemoryEmbeddingConfig;
  provider?: MemoryEmbeddingProvider;
  debounceMs?: number;
  onResult?: (result: MemoryEmbeddingBackfillResult, reason: string) => void;
  onError?: (error: unknown, reason: string) => void;
};

export class MemoryEmbeddingService {
  private readonly store: ButlerStateStore;
  private readonly config: MemoryEmbeddingConfig;
  private readonly provider: MemoryEmbeddingProvider;
  private readonly debounceMs: number;
  private readonly onResult: MemoryEmbeddingServiceOptions["onResult"];
  private readonly onError: MemoryEmbeddingServiceOptions["onError"];
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private queuedReason: string | null = null;
  private started = false;
  private readonly changeHandler = () => this.schedule("store_change");

  constructor(options: MemoryEmbeddingServiceOptions) {
    this.store = options.store;
    this.config = options.config ?? readMemoryEmbeddingConfig();
    this.provider = options.provider ?? new OllamaMemoryEmbeddingProvider(this.config);
    this.debounceMs = Math.max(100, options.debounceMs ?? 2_000);
    this.onResult = options.onResult;
    this.onError = options.onError;
  }

  start(): void {
    if (this.started || !this.config.enabled) return;
    this.started = true;
    this.store.on("change", this.changeHandler);
    this.schedule("startup", 0);
  }

  dispose(): void {
    this.started = false;
    this.store.off("change", this.changeHandler);
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  schedule(reason: string, delayMs = this.debounceMs): void {
    if (!this.config.enabled || !this.started) return;
    this.queuedReason = this.queuedReason ? `${this.queuedReason}+${reason}` : reason;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.run(this.queuedReason ?? reason);
      this.queuedReason = null;
    }, Math.max(0, delayMs));
  }

  async run(reason = "manual"): Promise<MemoryEmbeddingBackfillResult | null> {
    if (!this.config.enabled) return null;
    if (this.running) {
      this.schedule(reason);
      return null;
    }
    this.running = true;
    try {
      const result = await backfillMemoryEmbeddings({
        store: this.store,
        config: this.config,
        provider: this.provider,
        batchSize: this.config.backfillBatchSize
      });
      this.onResult?.(result, reason);
      return result;
    } catch (error) {
      this.onError?.(error, reason);
      return null;
    } finally {
      this.running = false;
    }
  }
}
