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

  assert.equal(diagnostics.observations.total, 2);
  assert.equal(diagnostics.observations.bySourceKind.harness_checkpoint, 1);
  assert.equal(diagnostics.synthesis.byStatus.completed, 1);
  assert.equal(diagnostics.synthesis.completedResults, 1);
  assert.equal(diagnostics.candidates.total, 2);
  assert.equal(diagnostics.candidates.byStatus.pending, 1);
  assert.equal(diagnostics.candidates.byStatus.accepted, 1);
  assert.equal(diagnostics.candidates.bySource.codex_report_review, 1);
  assert.equal(diagnostics.candidates.bySource.synthesis, 1);
  assert.equal(diagnostics.candidates.resolvedInWindow, 1);
  assert.equal(diagnostics.projectMemory.acceptedEntries, 1);
  assert.equal(diagnostics.butlerMemory.total, 0);
  assert.equal(diagnostics.samples?.recentCandidates.length, 2);
  assert.match(formatMemoryDiagnostics(diagnostics), /Candidates: total=2/);
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
