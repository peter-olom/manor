import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { listMemoryDebugTraces } from "../../src/server/memory-debug-traces.js";
import { collectSemanticEdgeReviewPairs, MemorySemanticEdgeReviewService } from "../../src/server/memory-semantic-edge-review.js";
import { ButlerStateStore } from "../../src/server/state-store.js";
import type { MemorySynthesisConfig } from "../../src/server/types.js";

const config: MemorySynthesisConfig = {
  enabled: true,
  model: "ollama-cloud/glm-5.2",
  effort: null,
  timeoutMs: 1_000,
  maxInputChars: 16_000,
  maxCandidatesPerRun: 6,
  promotionAutoResolve: true,
  promotionBatchSize: 20,
  promotionMaxBatchesPerRun: 10,
  promotionIntervalMs: 10_000,
  semanticEdgeReviewEnabled: true,
  semanticEdgeReviewBatchSize: 12,
  semanticEdgeReviewIntervalMs: 60_000
};

async function createStoreWithReviewPair(): Promise<{ store: ButlerStateStore; stateDir: string }> {
  const stateDir = await mkdtemp(path.join(tmpdir(), "manor-semantic-edge-output-test-"));
  const store = new ButlerStateStore(path.join(stateDir, "state.json"));
  store.recordJobNote("thread-1", {
    summary: "The Worker established the durable memory decision.",
    context: { projectId: "project-1", projectLabel: "Project One" }
  });
  const candidate = store.submitJobMemoryPromotionCandidate("thread-1", {
    kind: "decision",
    summary: "Use structured semantic edge output.",
    details: "This accepted decision should be connected to its source job memory.",
    sourceEntryId: "semantic-edge-source",
    context: { projectId: "project-1", projectLabel: "Project One" }
  });
  store.resolvePromotionCandidate(candidate.id, true);
  assert.equal(collectSemanticEdgeReviewPairs(store).length, 1);
  return { store, stateDir };
}

test("semantic edge review validates model output and preserves failed diagnostics for retry", async () => {
  const { store, stateDir } = await createStoreWithReviewPair();
  const errors: Error[] = [];
  let attempt = 0;
  const malformedDecisions = { decisions: { pairId: "unexpected-object" } };
  const malformedConfidence = {
    decisions: [{ pairId: "pair-1", predicate: "supports", sourceSide: "left", confidence: "high", rationale: "Invalid confidence shape." }]
  };
  const service = new MemorySemanticEdgeReviewService({
    store,
    config,
    stateDir,
    codexHomeDir: stateDir,
    runner: async () => {
      attempt += 1;
      if (attempt === 1) return malformedDecisions;
      if (attempt === 2) return malformedConfidence;
      return { decisions: [] };
    },
    onError: (error) => errors.push(error instanceof Error ? error : new Error(String(error)))
  });

  assert.deepEqual(await service.reviewNextBatch("malformed-decisions"), { reviewed: 0, relationships: 0 });
  assert.match(errors[0]?.message ?? "", /output\.decisions must be an array; received object \(output keys: decisions\)/);
  assert.equal(collectSemanticEdgeReviewPairs(store).length, 1, "invalid output must leave the pair eligible for retry");

  assert.deepEqual(await service.reviewNextBatch("malformed-confidence"), { reviewed: 1, relationships: 1 });
  assert.equal(errors.length, 1);
  assert.equal(collectSemanticEdgeReviewPairs(store).length, 0);

  const failedTraces = listMemoryDebugTraces(store, { status: "failed", limit: 10 });
  assert.equal(failedTraces.length, 1);
  assert.ok(failedTraces.some((trace) => JSON.stringify(trace.rawOutput) === JSON.stringify(malformedDecisions)));
  assert.ok(failedTraces.every((trace) => trace.error?.startsWith("Invalid semantic edge review output:")));

  const completedTrace = listMemoryDebugTraces(store, { status: "completed", limit: 10 })
    .find((trace) => JSON.stringify(trace.rawOutput) === JSON.stringify(malformedConfidence));
  assert.ok(completedTrace);
  assert.ok(completedTrace.warnings.some((warning) => warning.includes("output.decisions[0].confidence")));
  assert.ok(completedTrace.warnings.some((warning) => warning.includes("used output.decisions[0].rationale")));
});
