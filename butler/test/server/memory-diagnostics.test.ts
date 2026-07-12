import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { handleHarnessMemoryAction } from "../../src/server/codex-harness-memory.js";
import { buildMemoryDiagnostics, formatMemoryDiagnostics } from "../../src/server/memory-diagnostics.js";
import { ButlerStateStore } from "../../src/server/state-store.js";
import type { CodexThreadExecutionContractView } from "../../src/server/types.js";

async function createStore(): Promise<ButlerStateStore> {
  const stateDir = await mkdtemp(path.join(tmpdir(), "manor-memory-diagnostics-test-"));
  return new ButlerStateStore(path.join(stateDir, "state.json"));
}

function contract(threadId = "thread-1"): CodexThreadExecutionContractView {
  return {
    threadId,
    workspaceCwd: "/workspace",
    projectId: "project-1",
    projectLabel: "Project One",
    branch: "main",
    requestedTask: "Diagnose memory",
    operatorGoal: "Make memory observable",
    acceptancePoints: ["Count memory pipeline records"],
    proofExpectation: "none",
    proofExpectationLabel: "no explicit proof request",
    notes: []
  };
}

async function seedDiagnosticStore(): Promise<{ store: ButlerStateStore; from: number; to: number }> {
  const store = await createStore();
  const from = Date.now() - 10_000;
  store.upsertThreadSummary({ id: "thread-1", cwd: "/workspace", createdAt: from, status: "running" });
  store.setThreadExecutionContract("thread-1", contract());
  store.recordMemoryObservation({
    idempotencyKey: "old-observation",
    projectId: "project-1",
    projectLabel: "Project One",
    threadId: "thread-1",
    sourceKind: "harness_note",
    sourceId: "old",
    summary: "Old observation",
    observedAt: from - 1
  });
  const observation = store.recordMemoryObservation({
    idempotencyKey: "checkpoint-observation",
    projectId: "project-1",
    projectLabel: "Project One",
    threadId: "thread-1",
    sourceKind: "harness_checkpoint",
    sourceId: "checkpoint",
    summary: "Checkpoint observation",
    observedAt: from + 1
  });
  const synthesis = store.enqueueMemorySynthesis({
    idempotencyKey: "synthesis-checkpoint-observation",
    projectId: "project-1",
    threadId: "thread-1",
    sourceObservationId: observation.id,
    reason: "checkpoint synthesis"
  });
  store.updateMemorySynthesisQueueEntry(synthesis.id, { status: "completed", completedAt: Date.now() });
  const failedSynthesis = store.enqueueMemorySynthesis({
    idempotencyKey: "synthesis-failed-observation",
    projectId: "project-1",
    threadId: "thread-1",
    sourceObservationId: observation.id,
    reason: "failed synthesis"
  });
  store.updateMemorySynthesisQueueEntry(failedSynthesis.id, { status: "failed", lastError: "schema error", runAfter: from + 2 });
  store.enqueueMemorySynthesis({
    idempotencyKey: "synthesis-pending-observation",
    projectId: "project-1",
    threadId: "thread-1",
    sourceObservationId: observation.id,
    reason: "pending synthesis",
    runAfter: from + 3
  });
  store.recordMemoryObservation({
    idempotencyKey: "synthesis-result",
    projectId: "project-1",
    projectLabel: "Project One",
    threadId: "thread-1",
    sourceKind: "synthesis_result",
    sourceId: synthesis.id,
    summary: "Memory synthesis completed",
    observedAt: from + 2
  });
  store.recordMemoryObservation({
    idempotencyKey: "semantic-edge-review:pair-1",
    projectId: "project-1",
    projectLabel: "Project One",
    threadId: "thread-1",
    sourceKind: "synthesis_result",
    sourceId: "pair-1",
    summary: "Semantic edge review completed",
    payload: { kind: "semantic_edge_review", pairId: "pair-1" },
    observedAt: from + 3
  });
  const currentMemory = store.upsertMemoryEntity({
    projectId: "project-1",
    type: "memory",
    name: "Current memory",
    canonicalKey: "memory:project_memory:project-1",
    sourceObservationId: observation.id
  });
  const staleMemory = store.upsertMemoryEntity({
    projectId: "project-1",
    type: "memory",
    name: "Stale candidate",
    canonicalKey: "memory:promotion_candidate:candidate-1",
    sourceObservationId: observation.id
  });
  store.upsertMemoryRelationship({
    projectId: "project-1",
    sourceEntityId: currentMemory.id,
    predicate: "possible_supersedes",
    targetEntityId: staleMemory.id,
    sourceObservationId: "deterministic:project-1:supersedes:candidate-1",
    confidence: 0.35
  });
  store.upsertMemoryRelationship({
    projectId: "project-1",
    sourceEntityId: currentMemory.id,
    predicate: "supersedes",
    targetEntityId: staleMemory.id,
    sourceObservationId: "model:semantic-edge:pair-1:supersedes:left",
    confidence: 0.91
  });
  store.submitJobMemoryPromotionCandidate("thread-1", {
    kind: "note",
    summary: "Pending review candidate",
    sourceEntryId: "worker-report:turn-1:1:candidate:abc",
    context: { projectId: "project-1", projectLabel: "Project One" }
  });
  const accepted = store.submitJobMemoryPromotionCandidate("thread-1", {
    kind: "decision",
    summary: "Accepted synthesis candidate",
    sourceEntryId: `synthesis:${synthesis.id}:abc`,
    context: { projectId: "project-1", projectLabel: "Project One" }
  });
  store.resolvePromotionCandidate(accepted.id, true);
  store.recordJobNote("thread-1", { summary: "Job memory note", sourceEntryId: "note-entry", context: { projectId: "project-1", projectLabel: "Project One" } });
  store.recordButlerMemory({ summary: "Global memory", source: "butler_tool" });
  return { store, from, to: Date.now() + 10_000 };
}

test("memory diagnostics summarizes pipeline counts and date filtering", async () => {
  const { store, from, to } = await seedDiagnosticStore();
  const diagnostics = buildMemoryDiagnostics(store, {
    projectId: "project-1",
    from,
    to,
    includeSamples: true,
    sampleLimit: 2,
    now: to + 20 * 60_000
  });

  assert.equal(diagnostics.observations.total, 3);
  assert.equal(diagnostics.observations.bySourceKind.harness_checkpoint, 1);
  assert.equal(diagnostics.synthesis.byStatus.completed, 1);
  assert.equal(diagnostics.synthesis.byStatus.failed, 1);
  assert.equal(diagnostics.synthesis.byStatus.pending, 1);
  assert.equal(diagnostics.synthesis.due, 1);
  assert.equal(diagnostics.synthesis.completedResults, 2);
  assert.equal(diagnostics.synthesis.failedWithError, 1);
  assert.equal(diagnostics.candidates.total, 2);
  assert.equal(diagnostics.candidates.byStatus.pending, 1);
  assert.equal(diagnostics.candidates.byStatus.accepted, 1);
  assert.equal(diagnostics.candidates.bySource.codex_report_review, 1);
  assert.equal(diagnostics.candidates.bySource.synthesis, 1);
  assert.equal(diagnostics.candidates.resolvedInWindow, 1);
  assert.equal(diagnostics.projectMemory.acceptedEntries, 1);
  assert.equal(diagnostics.butlerMemory.total, 0);
  assert.equal(diagnostics.graph.proposedSemanticEdges, 1);
  assert.equal(diagnostics.graph.confirmedSemanticEdges, 1);
  assert.equal(diagnostics.graph.modelReviewedPairs, 1);
  assert.equal(diagnostics.samples?.recentCandidates.length, 2);
  const formatted = formatMemoryDiagnostics(diagnostics);
  assert.match(formatted, /Candidates: total=2/);
  assert.match(formatted, /confirmed_semantic_edges=1/);
  assert.match(formatted, /Samples:/);
  assert.match(formatted, /Recent observations:/);
  assert.match(formatted, /failed synthesis/);
  assert.match(formatted, /Pending review candidate/);
});

test("harness memory diagnostics returns the shared structured report", async () => {
  const { store, from, to } = await seedDiagnosticStore();
  const result = handleHarnessMemoryAction({
    action: "memory.diagnostics",
    threadId: "thread-1",
    projectId: "project-1",
    store,
    params: { scope: "job", from, to, includeSamples: true }
  });

  assert.ok(result);
  assert.match(result.text, /Memory diagnostics/);
  assert.equal(result.data?.diagnostics && typeof result.data.diagnostics === "object", true);
  assert.equal((result.data?.diagnostics as { filters: { threadId: string | null } }).filters.threadId, "thread-1");
  assert.equal((result.data?.diagnostics as { jobMemoryEntries: { byKind: { note: number } } }).jobMemoryEntries.byKind.note, 1);
});
