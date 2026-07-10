import { getActiveManorSettings } from "./manor-settings-runtime.js";
import { readMemoryEmbeddingConfig } from "./memory-embedding-client.js";
import { MemoryEmbeddingService } from "./memory-embedding-service.js";
import { MemorySemanticEdgeReviewService, SEMANTIC_EDGE_REVIEW_OUTPUT_SCHEMA } from "./memory-semantic-edge-review.js";
import { CodexExecMemoryPromotionService, MEMORY_PROMOTION_OUTPUT_SCHEMA } from "./memory-promotion.js";
import { CodexExecMemoryReviewService, MEMORY_REVIEW_OUTPUT_SCHEMA } from "./memory-review.js";
import { readMemorySynthesisConfig, resolveMemoryServiceModel } from "./memory-synthesis-config.js";
import { MemoryUpdateScheduler, MEMORY_SYNTHESIS_OUTPUT_SCHEMA } from "./memory-update-scheduler.js";
import { ManorModelTaskRunner } from "./model-task-runner.js";
import type { ButlerStateStore } from "./state-store.js";

export function createBackgroundModelServices(input: {
  store: ButlerStateStore;
  stateDir: string;
  codexHomeDir: string;
  piAuthPath: string;
}) {
  const { store, stateDir, codexHomeDir, piAuthPath } = input;
  const modelTasks = new ManorModelTaskRunner({ stateDir, codexHomeDir, piAuthPath });
  const serviceModels = () => {
    const settings = getActiveManorSettings();
    const config = readMemorySynthesisConfig();
    return {
      config,
      memoryReviewModel: config.model ?? null,
      memoryPromotionModel: resolveMemoryServiceModel(settings.modelTasks.memoryPromotionModel, config.model)
    };
  };
  const initial = serviceModels();

  const memoryReview = new CodexExecMemoryReviewService({
    store,
    stateDir,
    codexHomeDir,
    enabled: initial.config.enabled,
    model: initial.memoryReviewModel ?? undefined,
    timeoutMs: initial.config.timeoutMs,
    runner: async (runnerInput) => await modelTasks.runJson({ purpose: "memory review", ...runnerInput, model: serviceModels().memoryReviewModel, schema: MEMORY_REVIEW_OUTPUT_SCHEMA }) as never
  });
  const memoryScheduler = new MemoryUpdateScheduler({
    store,
    config: initial.config,
    stateDir,
    codexHomeDir,
    runner: async (runnerInput) => await modelTasks.runJson({ purpose: "memory synthesis", ...runnerInput, model: serviceModels().config.model, schema: MEMORY_SYNTHESIS_OUTPUT_SCHEMA }) as never
  });
  const memoryPromotion = new CodexExecMemoryPromotionService({
    store,
    memoryScheduler,
    config: initial.config,
    stateDir,
    codexHomeDir,
    runner: async (runnerInput) => await modelTasks.runJson({ purpose: "memory promotion", ...runnerInput, model: serviceModels().memoryPromotionModel, schema: MEMORY_PROMOTION_OUTPUT_SCHEMA }) as never
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
    config: initial.config,
    stateDir,
    codexHomeDir,
    runner: async (runnerInput) => await modelTasks.runJson({ purpose: "memory semantic edge review", ...runnerInput, model: serviceModels().config.model, schema: SEMANTIC_EDGE_REVIEW_OUTPUT_SCHEMA }) as never,
    onResult: (result, reason) => {
      if (result.reviewed > 0 || result.relationships > 0) {
        console.log(`Memory semantic edge review ${reason}: reviewed=${result.reviewed} relationships=${result.relationships}`);
      }
    },
    onError: (error, reason) => console.warn(`Memory semantic edge review ${reason} failed`, error)
  });
  const applySettings = () => {
    const current = serviceModels();
    modelTasks.applySettings();
    memoryReview.applyConfig({ enabled: current.config.enabled, timeoutMs: current.config.timeoutMs, model: current.memoryReviewModel });
    memoryScheduler.applyConfig(current.config);
    memoryPromotion.applyConfig(current.config, current.memoryPromotionModel);
    memoryEmbeddings.applyConfig(readMemoryEmbeddingConfig());
    memorySemanticEdges.applyConfig(current.config);
  };

  return {
    memoryReview,
    memoryScheduler,
    memoryPromotion,
    memoryEmbeddings,
    memorySemanticEdges,
    applySettings
  };
}
