import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  formatMemoryDebugTrace,
  getMemoryDebugTrace,
  listMemoryDebugTraces,
  recordMemoryDebugTrace
} from "../../src/server/memory-debug-traces.js";
import { CodexExecMemoryReviewService } from "../../src/server/memory-review.js";
import { MemoryUpdateScheduler } from "../../src/server/memory-update-scheduler.js";
import { ButlerStateStore } from "../../src/server/state-store.js";
import type { CodexThreadExecutionContractView, CodexWorkerReportView, MemorySynthesisConfig } from "../../src/server/types.js";

async function createStore(): Promise<{ store: ButlerStateStore; stateDir: string }> {
  const stateDir = await mkdtemp(path.join(tmpdir(), "manor-memory-debug-traces-test-"));
  return { store: new ButlerStateStore(path.join(stateDir, "state.json")), stateDir };
}

function testConfig(): MemorySynthesisConfig {
  return {
    enabled: true,
    model: "trace-model",
    effort: null,
    timeoutMs: 90_000,
    maxInputChars: 16_000,
    maxCandidatesPerRun: 1,
    promotionAutoResolve: true,
    promotionBatchSize: 20,
    promotionMaxBatchesPerRun: 10,
    promotionIntervalMs: 10_000,
    semanticEdgeReviewEnabled: true,
    semanticEdgeReviewBatchSize: 12,
    semanticEdgeReviewIntervalMs: 60_000
  };
}

function contract(threadId = "thread-1"): CodexThreadExecutionContractView {
  return {
    threadId,
    workspaceCwd: "/workspace",
    projectId: "project-1",
    projectLabel: "Project One",
    branch: "main",
    requestedTask: "Debug memory",
    operatorGoal: "Expose memory internals",
    acceptancePoints: ["Capture trace"],
    proofExpectation: "none",
    proofExpectationLabel: "no explicit proof request",
    notes: []
  };
}

function seedReportedThread(store: ButlerStateStore): CodexWorkerReportView {
  const threadContract = contract();
  store.upsertThreadSummary({ id: threadContract.threadId, status: "idle", cwd: threadContract.workspaceCwd, turns: [{ id: "turn-1", status: "completed", items: [] }] });
  store.setThreadExecutionContract(threadContract.threadId, threadContract);
  return store.recordWorkerReport(threadContract.threadId, {
    turnId: "turn-1",
    status: "completed",
    summary: "Completed memory-sensitive work.",
    details: "Reusable decision: prefer trace-level debugging for memory quality regressions."
  });
}

test("memory synthesis writes trace with raw output, drops, and persisted IDs", async () => {
  const { store, stateDir } = await createStore();
  const scheduler = new MemoryUpdateScheduler({
    store,
    stateDir,
    codexHomeDir: stateDir,
    config: testConfig(),
    runner: async () => ({
      candidates: [
        { kind: "note", summary: "Keep this synthesized note.", details: "Useful later.", confidence: "high", reason: "Reusable." },
        { kind: "decision", summary: "Drop because max candidates is one.", details: null, confidence: "high", reason: "Over limit." }
      ],
      entities: [{ type: "feature", name: "Memory traces", canonicalKey: "feature:memory-traces" }, { type: "weird", name: "Odd entity" }],
      relationships: [{ sourceName: "Memory traces", predicate: "part_of", targetName: "Project One", confidence: 0.9 }, { sourceName: "Missing", predicate: "depends_on", targetName: "Project One", confidence: 0.2 }]
    })
  });
  store.upsertThreadSummary({ id: "thread-1", cwd: "/workspace", createdAt: 1, status: "running" });
  store.setThreadExecutionContract("thread-1", contract());
  scheduler.recordMemoryEvent({
    idempotencyKey: "trace-checkpoint",
    projectId: "project-1",
    projectLabel: "Project One",
    threadId: "thread-1",
    sourceKind: "harness_checkpoint",
    sourceId: "checkpoint",
    summary: "Trace checkpoint"
  }, { semanticReview: "normal" });

  await scheduler.processDueQueue();
  const trace = listMemoryDebugTraces(store, { kind: "synthesis", limit: 1 })[0];

  assert.ok(trace);
  assert.equal(trace.status, "completed");
  assert.match(trace.prompt ?? "", /bounded memory synthesis module/);
  assert.equal(trace.persisted.candidateIds.length, 1);
  assert.equal(trace.persisted.entityIds.length, 2);
  assert.equal(trace.decisions.some((entry) => entry.outcome === "dropped" && entry.reason === "max_candidates_exceeded"), true);
  assert.equal(trace.decisions.some((entry) => entry.outcome === "normalized" && entry.reason === "unsupported_entity_type"), true);
});

test("memory review writes trace with raw output, low-confidence drop, and submitted candidate", async () => {
  const { store, stateDir } = await createStore();
  const report = seedReportedThread(store);
  const service = new CodexExecMemoryReviewService({
    store,
    stateDir,
    codexHomeDir: stateDir,
    model: "trace-review-model",
    runner: async () => ({
      candidates: [
        { kind: "decision", summary: "Keep trace-level memory debugging.", details: "It explains quality regressions.", confidence: "high", reason: "Reusable debugging policy." },
        { kind: "note", summary: "Routine checks passed.", details: null, confidence: "low", reason: "Execution noise." }
      ],
      rawOutput: { candidates: [{ summary: "raw candidate" }] }
    })
  });

  const submitted = await service.reviewWorkerReport(report);
  const trace = listMemoryDebugTraces(store, { kind: "review", threadId: report.threadId, limit: 1 })[0];

  assert.equal(submitted.length, 1);
  assert.ok(trace);
  assert.equal(trace.model, "trace-review-model");
  assert.match(trace.prompt ?? "", /memory-review agent/);
  assert.equal(trace.persisted.candidateIds.length, 1);
  assert.equal(trace.persisted.jobEntryIds.some((entry) => entry.includes("review-state")), true);
  assert.equal(trace.decisions.some((entry) => entry.outcome === "dropped" && entry.reason === "low_confidence:low"), true);
  assert.deepEqual(trace.rawOutput, { parsed: { candidates: [{ summary: "raw candidate" }] }, text: null });
});

test("memory debug traces expose bounded diagnostics with nested secrets redacted", async () => {
  const stateDir = await mkdtemp(path.join(tmpdir(), "manor-memory-debug-trace-"));
  const store = new ButlerStateStore(path.join(stateDir, "state.json"));
  const recorded = recordMemoryDebugTrace(store, {
    kind: "review",
    status: "failed",
    projectId: "project-1",
    projectLabel: "Project One",
    threadId: "thread-1",
    sourceId: "source-1",
    reason: "Inspect failed review output",
    promptVersion: "v1",
    model: "test-model",
    createdAt: 1,
    completedAt: 2,
    durationMs: 1,
    prompt: `${"A".repeat(10_000)}\napi_key=prompt-secret`,
    input: { nested: { api_key: "input-secret" }, ordinary: "visible input" },
    rawOutput: { Authorization: "Bearer opaque-token-123456", result: "visible raw output" },
    normalizedOutput: { password: "normalized-secret", result: "visible normalized output" },
    decisions: [{
      stage: "normalize",
      outcome: "dropped",
      summary: "Dropped malformed candidate",
      reason: "password=decision-secret",
      inputIndex: 0
    }],
    persisted: { observationIds: [], candidateIds: [], entityIds: [], relationshipIds: [], jobEntryIds: [] },
    error: "Authorization: Bearer error-token-123456",
    warnings: ["client_secret=warning-secret"]
  });

  const trace = getMemoryDebugTrace(store, recorded.id);
  assert.ok(trace);
  const serialized = JSON.stringify(trace);
  assert.doesNotMatch(serialized, /prompt-secret|input-secret|opaque-token|normalized-secret|decision-secret|error-token|warning-secret/);

  const formatted = formatMemoryDebugTrace(trace);
  assert.match(formatted, /Prompt:/);
  assert.match(formatted, /Input:/);
  assert.match(formatted, /visible input/);
  assert.match(formatted, /Raw output:/);
  assert.match(formatted, /visible raw output/);
  assert.match(formatted, /Normalized output:/);
  assert.match(formatted, /visible normalized output/);
  assert.match(formatted, /Decision details:/);
  assert.match(formatted, /Dropped malformed candidate/);
  assert.match(formatted, /\[REDACTED\]/);
  assert.match(formatted, /\.\.\.\[truncated\]/);
  assert.ok(formatted.length < 45_000);
});
