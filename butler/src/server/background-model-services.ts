import { ButlerRoutingClassifier, ROUTING_CLASSIFIER_OUTPUT_SCHEMA } from "./butler-routing-classifier.js";
import { MemoryEmbeddingService } from "./memory-embedding-service.js";
import { MemorySemanticEdgeReviewService, SEMANTIC_EDGE_REVIEW_OUTPUT_SCHEMA } from "./memory-semantic-edge-review.js";
import { CodexExecMemoryPromotionService, MEMORY_PROMOTION_OUTPUT_SCHEMA } from "./memory-promotion.js";
import { CodexExecMemoryReviewService, MEMORY_REVIEW_OUTPUT_SCHEMA } from "./memory-review.js";
import { readMemorySynthesisConfig, resolveMemoryServiceModel } from "./memory-synthesis-config.js";
import { MemoryUpdateScheduler, MEMORY_SYNTHESIS_OUTPUT_SCHEMA } from "./memory-update-scheduler.js";
import { ManorModelTaskRunner } from "./model-task-runner.js";
import type { ButlerStateStore } from "./state-store.js";
import { CodexWorkerReviewService, WORKER_REVIEW_OUTPUT_SCHEMA } from "./worker-codex-review.js";

export function createBackgroundModelServices(input: {
  store: ButlerStateStore;
  stateDir: string;
  codexHomeDir: string;
  piAuthPath: string;
}) {
  const { store, stateDir, codexHomeDir, piAuthPath } = input;
  const memorySynthesisConfig = readMemorySynthesisConfig();
  const modelTasks = new ManorModelTaskRunner({ stateDir, codexHomeDir, piAuthPath });
  const memoryReviewModel = memorySynthesisConfig.model ?? null;
  const routingClassifierModel = resolveMemoryServiceModel(process.env.MANOR_ROUTING_CLASSIFIER_MODEL, memorySynthesisConfig.model);
  const workerReviewModel = resolveMemoryServiceModel(process.env.MANOR_WORKER_REVIEW_MODEL, memorySynthesisConfig.model);
  const memoryPromotionModel = resolveMemoryServiceModel(process.env.MANOR_MEMORY_PROMOTION_MODEL, memorySynthesisConfig.model);

  const memoryReview = new CodexExecMemoryReviewService({
    store,
    stateDir,
    codexHomeDir,
    enabled: memorySynthesisConfig.enabled,
    model: memoryReviewModel ?? undefined,
    timeoutMs: memorySynthesisConfig.timeoutMs,
    runner: async (runnerInput) => await modelTasks.runJson({ purpose: "memory review", ...runnerInput, model: memoryReviewModel, schema: MEMORY_REVIEW_OUTPUT_SCHEMA }) as never
  });
  const routingClassifier = new ButlerRoutingClassifier({
    stateDir,
    codexHomeDir,
    enabled: true,
    model: routingClassifierModel ?? undefined,
    timeoutMs: memorySynthesisConfig.timeoutMs,
    runner: async (runnerInput) => await modelTasks.runJson({ purpose: "routing classifier", ...runnerInput, model: routingClassifierModel, schema: ROUTING_CLASSIFIER_OUTPUT_SCHEMA })
  });
  const workerReview = new CodexWorkerReviewService({
    store,
    stateDir,
    codexHomeDir,
    enabled: true,
    model: workerReviewModel ?? undefined,
    timeoutMs: memorySynthesisConfig.timeoutMs,
    runner: async (runnerInput) => await modelTasks.runJson({ purpose: "worker review", ...runnerInput, model: workerReviewModel, schema: WORKER_REVIEW_OUTPUT_SCHEMA })
  });
  const memoryScheduler = new MemoryUpdateScheduler({
    store,
    config: memorySynthesisConfig,
    stateDir,
    codexHomeDir,
    runner: async (runnerInput) => await modelTasks.runJson({ purpose: "memory synthesis", ...runnerInput, model: memorySynthesisConfig.model, schema: MEMORY_SYNTHESIS_OUTPUT_SCHEMA }) as never
  });
  const memoryPromotion = new CodexExecMemoryPromotionService({
    store,
    memoryScheduler,
    config: memorySynthesisConfig,
    stateDir,
    codexHomeDir,
    runner: async (runnerInput) => await modelTasks.runJson({ purpose: "memory promotion", ...runnerInput, model: memoryPromotionModel, schema: MEMORY_PROMOTION_OUTPUT_SCHEMA }) as never
  });
  const memoryEmbeddings = new MemoryEmbeddingService({
    store,
    onResult: (result, reason) => {
      if (result.embedded > 0 || result.failed > 0) {
        console.log(`Memory embedding ${reason}: embedded=${result.embedded} skipped=${result.skippedFresh} failed=${result.failed}`);
      }
    },
    onError: (error, reason) => console.warn(`Memory embedding ${reason} failed`, error)
  });
  const memorySemanticEdges = new MemorySemanticEdgeReviewService({
    store,
    config: memorySynthesisConfig,
    stateDir,
    codexHomeDir,
    runner: async (runnerInput) => await modelTasks.runJson({ purpose: "memory semantic edge review", ...runnerInput, model: memorySynthesisConfig.model, schema: SEMANTIC_EDGE_REVIEW_OUTPUT_SCHEMA }) as never,
    onResult: (result, reason) => {
      if (result.reviewed > 0 || result.relationships > 0) {
        console.log(`Memory semantic edge review ${reason}: reviewed=${result.reviewed} relationships=${result.relationships}`);
      }
    },
    onError: (error, reason) => console.warn(`Memory semantic edge review ${reason} failed`, error)
  });

  return {
    memoryReview,
    routingClassifier,
    workerReview,
    memoryScheduler,
    memoryPromotion,
    memoryEmbeddings,
    memorySemanticEdges
  };
}
