import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { readMemorySynthesisConfig } from "../../src/server/memory-synthesis-config.js";
import { recordMemoryDebugTrace } from "../../src/server/memory-debug-traces.js";
import { MemoryUpdateScheduler } from "../../src/server/memory-update-scheduler.js";
import { retrieveButlerMemory } from "../../src/server/memory-retrieval.js";
import { ButlerStateStore } from "../../src/server/state-store.js";
import type { ButlerMessageView, CodexThreadExecutionContractView, MemorySynthesisConfig } from "../../src/server/types.js";

async function createStore(): Promise<{ store: ButlerStateStore; stateDir: string }> {
  const stateDir = await mkdtemp(path.join(tmpdir(), "manor-memory-overhaul-test-"));
  return { store: new ButlerStateStore(path.join(stateDir, "state.json")), stateDir };
}

function testConfig(overrides: Partial<MemorySynthesisConfig> = {}): MemorySynthesisConfig {
  return {
    enabled: true,
    model: null,
    effort: null,
    timeoutMs: 90_000,
    maxInputChars: 16_000,
    maxCandidatesPerRun: 6,
    promotionAutoResolve: true,
    promotionBatchSize: 20,
    promotionMaxBatchesPerRun: 10,
    promotionIntervalMs: 10_000,
    semanticEdgeReviewEnabled: true,
    semanticEdgeReviewBatchSize: 12,
    semanticEdgeReviewIntervalMs: 60_000,
    ...overrides
  };
}

function contract(threadId = "thread-1"): CodexThreadExecutionContractView {
  return {
    threadId,
    workspaceCwd: "/workspace",
    projectId: "project-1",
    projectLabel: "Project One",
    branch: "main",
    requestedTask: "Implement durable memory graph",
    operatorGoal: "Make Manor remember work progress",
    acceptancePoints: ["Add observations", "Add graph retrieval"],
    proofExpectation: "none",
    proofExpectationLabel: "no explicit proof request",
    notes: []
  };
}

function message(id: string, text: string, at: number): ButlerMessageView {
  return { id, role: "user", text, at, taskDurationMs: null, kind: "message" };
}

test("memory synthesis config normalizes model labels and honors env overrides", () => {
  assert.equal(readMemorySynthesisConfig({}).model, null);
  assert.equal(readMemorySynthesisConfig({ MANOR_MEMORY_SYNTHESIS_MODEL: "5.4 mini" }).model, "gpt-5.4-mini");
  assert.equal(readMemorySynthesisConfig({}).promotionAutoResolve, true);
  const config = readMemorySynthesisConfig({ MANOR_MEMORY_SYNTHESIS_MODEL: "gpt-5.4-mini", MANOR_MEMORY_SYNTHESIS_ENABLED: "0", MANOR_MEMORY_SYNTHESIS_MAX_CANDIDATES: "12", MANOR_MEMORY_PROMOTION_BATCH_SIZE: "7" });
  assert.equal(config.model, "gpt-5.4-mini");
  assert.equal(config.enabled, false);
  assert.equal(config.maxCandidatesPerRun, 12);
  assert.equal(config.promotionBatchSize, 7);
});
test("scheduler writes observations, task projection, queue entries, and dedupes by idempotency key", async () => {
  const { store, stateDir } = await createStore();
  const scheduler = new MemoryUpdateScheduler({
    store,
    stateDir,
    codexHomeDir: stateDir,
    config: testConfig(),
    runner: async () => ({
      candidates: [],
      entities: [{ type: "feature", name: "Memory graph", canonicalKey: "feature:memory-graph" }],
      relationships: [{ sourceName: "Memory graph", predicate: "part_of", targetName: "Project One", confidence: 0.8 }]
    })
  });
  store.setMemoryUpdateObserver(scheduler);
  store.upsertThreadSummary({ id: "thread-1", cwd: "/workspace", createdAt: 1, status: "running" });
  store.setThreadExecutionContract("thread-1", contract());
  scheduler.recordMemoryEvent({
    idempotencyKey: "checkpoint:thread-1:1",
    projectId: "project-1",
    projectLabel: "Project One",
    threadId: "thread-1",
    sourceKind: "harness_checkpoint",
    sourceId: "checkpoint",
    summary: "Memory graph checkpoint",
    payload: { nextAction: "Run tests" },
    task: { status: "in_progress", currentStep: "Run tests" }
  }, { semanticReview: "normal" });
  scheduler.recordMemoryEvent({
    idempotencyKey: "checkpoint:thread-1:1",
    projectId: "project-1",
    projectLabel: "Project One",
    threadId: "thread-1",
    sourceKind: "harness_checkpoint",
    sourceId: "checkpoint",
    summary: "Duplicate checkpoint"
  }, { semanticReview: "normal" });

  await scheduler.processDueQueue();
  const graph = store.listMemoryGraph();
  assert.equal(graph.observations.filter((entry) => entry.idempotencyKey === "checkpoint:thread-1:1").length, 1);
  assert.equal(graph.synthesisQueue.filter((entry) => entry.idempotencyKey === "synthesis:checkpoint:thread-1:1:normal").length, 1);
  assert.equal(graph.tasks.find((entry) => entry.threadId === "thread-1")?.currentStep, "Run tests");
  assert.ok(store.searchMemoryGraph({ projectId: "project-1", query: "Memory graph" }).entities.some((entry) => entry.name === "Memory graph"));
  assert.ok(store.searchMemoryGraph({ projectId: "project-1", query: "Memory graph Project One" }).relationships.some((entry) => entry.predicate === "part_of"));
  assert.ok(store.getJobMemory("thread-1")?.promotionCandidates.some((entry) => entry.sourceEntryId.startsWith("synthesis-fallback:")));
});

test("pre-delete and pre-clear hooks capture bounded idempotent synthesis preflight", async () => {
  const { store, stateDir } = await createStore();
  const scheduler = new MemoryUpdateScheduler({ store, stateDir, codexHomeDir: stateDir, config: testConfig({ enabled: false }) });
  store.upsertThreadSummary({ id: "thread-delete", cwd: "/workspace", createdAt: 1, status: "running" });
  store.setThreadExecutionContract("thread-delete", contract("thread-delete"));

  await scheduler.beforeThreadDelete({ threadId: "thread-delete", cwd: "/workspace", threadCreatedAt: 1, stacks: [], previews: [], services: [], proofArtifactPaths: ["proof.png"] });
  await scheduler.beforeThreadDelete({ threadId: "thread-delete", cwd: "/workspace", threadCreatedAt: 1, stacks: [], previews: [], services: [], proofArtifactPaths: ["proof.png"] });
  await scheduler.beforeButlerChatClear([message("message-0", "Remember the deployment ordering decision.", 10), message("message-1", "Secret token abc should not be kept verbatim.", 20)]);
  await scheduler.beforeButlerChatDeleteFrom({ messageId: "message-1", deleteFromTimestamp: 20, messages: [message("message-0", "Keep prefix", 10), message("message-1", "Deleted suffix decision", 20)] });

  const graph = store.listMemoryGraph();
  assert.equal(graph.observations.filter((entry) => entry.sourceKind === "pre_delete_thread").length, 1);
  assert.equal(graph.tasks.find((entry) => entry.threadId === "thread-delete")?.status, "deleted");
  assert.equal(graph.observations.some((entry) => entry.sourceKind === "pre_clear_chat"), true);
  const suffix = graph.observations.find((entry) => entry.sourceKind === "pre_delete_chat_suffix");
  assert.equal((suffix?.payload.messages as unknown[]).length, 1);
});

test("memory retrieval returns job checkpoints while graph search adds relationship-aware context", async () => {
  const { store, stateDir } = await createStore();
  const scheduler = new MemoryUpdateScheduler({ store, stateDir, codexHomeDir: stateDir, config: testConfig({ enabled: false }) });
  store.upsertThreadSummary({ id: "thread-current", cwd: "/workspace", createdAt: 1, status: "running" });
  store.setThreadExecutionContract("thread-current", contract("thread-current"));
  store.recordJobCheckpoint("thread-current", { summary: "Current checkpoint saved", details: "Existing retrieval should still work." });
  scheduler.observeHarnessMemory({ threadId: "thread-current", kind: "checkpoint", summary: "Graph checkpoint records Campaign.billingSummary dependency", details: "UI waits on API." });

  const retrieval = retrieveButlerMemory(store, { threadId: "thread-current", query: "Current checkpoint" });
  assert.equal(retrieval.jobMemories[0]?.latestCheckpoint, "Current checkpoint saved");
  const graph = store.searchMemoryGraph({ projectId: "project-1", query: "Campaign.billingSummary" });
  assert.equal(graph.observations.some((entry) => entry.summary.includes("Campaign.billingSummary")), true);
  assert.equal(graph.tasks.some((entry) => entry.threadId === "thread-current"), true);
});

test("graph search excludes memory debug trace observations", async () => {
  const { store } = await createStore();
  store.recordMemoryObservation({
    idempotencyKey: "real-observation",
    projectId: "project-1",
    projectLabel: "Project One",
    threadId: "thread-real",
    sourceKind: "harness_note",
    sourceId: "note",
    summary: "Real project memory mentions checkout callback verification."
  });
  recordMemoryDebugTrace(store, {
    kind: "synthesis",
    status: "completed",
    projectId: "project-1",
    projectLabel: "Project One",
    threadId: "thread-debug",
    sourceId: "debug-source",
    reason: "debug-only marker",
    promptVersion: "test",
    model: null,
    createdAt: 1,
    completedAt: 2,
    durationMs: 1,
    prompt: "debug-only marker",
    input: { marker: "debug-only marker" },
    rawOutput: null,
    normalizedOutput: null,
    decisions: [],
    persisted: { observationIds: [], candidateIds: [], entityIds: [], relationshipIds: [], jobEntryIds: [] },
    error: null,
    warnings: []
  });

  assert.equal(store.searchMemoryGraph({ projectId: "project-1", query: "debug-only marker" }).observations.length, 0);
  assert.equal(store.searchMemoryGraph({ projectId: "project-1", query: "checkout callback" }).observations[0]?.summary, "Real project memory mentions checkout callback verification.");
});

test("accepted promotion resolution persists project memory without creating another synthesis candidate", async () => {
  const { store, stateDir } = await createStore();
  let synthesisRuns = 0;
  const scheduler = new MemoryUpdateScheduler({
    store,
    stateDir,
    codexHomeDir: stateDir,
    config: testConfig(),
    runner: async () => {
      synthesisRuns += 1;
      return { candidates: [{ kind: "decision", summary: "Loop candidate", details: null, confidence: "high", reason: "Should not run for promotion resolution." }], entities: [], relationships: [] };
    }
  });
  store.upsertThreadSummary({ id: "thread-promotion", cwd: "/workspace", createdAt: 1, status: "running" });
  store.setThreadExecutionContract("thread-promotion", contract("thread-promotion"));
  const candidate = store.submitJobMemoryPromotionCandidate("thread-promotion", {
    kind: "decision",
    summary: "PR 17 fixed memory synthesis schema handling.",
    sourceEntryId: "synthesis:syn-test:candidate:0",
    context: { projectId: "project-1", projectLabel: "Project One" }
  });
  const resolved = store.resolvePromotionCandidate(candidate.id, true);
  assert.equal(resolved?.status, "accepted");

  scheduler.observePromotionResolved({
    candidateId: candidate.id,
    accepted: true,
    projectId: "project-1",
    projectLabel: "Project One",
    threadId: "thread-promotion",
    summary: candidate.summary,
    details: candidate.details
  });
  await scheduler.processDueQueue();

  assert.equal(synthesisRuns, 0);
  assert.equal(store.getProjectMemory("project-1")?.entries[0]?.summary, "PR 17 fixed memory synthesis schema handling.");
  assert.equal(store.listMemoryGraph().synthesisQueue.some((entry) => entry.reason === "promotion resolved"), false);
  assert.equal(store.getJobMemory("thread-promotion")?.promotionCandidates.filter((entry) => entry.status === "pending").length, 0);
});

test("memory synthesis completion persists Codex candidates without forcing a model", async () => {
  const { store, stateDir } = await createStore();
  let invokedModel: string | null = "not-invoked";
  const scheduler = new MemoryUpdateScheduler({
    store,
    stateDir,
    codexHomeDir: stateDir,
    config: testConfig({ model: null }),
    runner: async ({ config }) => {
      invokedModel = config.model;
      return {
        candidates: [{ kind: "decision", summary: "Keep strict memory synthesis schemas.", details: null, confidence: "high", reason: "Prevents Codex response_format 400s." }],
        entities: [],
        relationships: []
      };
    }
  });
  store.upsertThreadSummary({ id: "thread-synthesis", cwd: "/workspace", createdAt: 1, status: "running" });
  store.setThreadExecutionContract("thread-synthesis", contract("thread-synthesis"));
  scheduler.recordMemoryEvent({
    idempotencyKey: "strict-schema-checkpoint",
    projectId: "project-1",
    projectLabel: "Project One",
    threadId: "thread-synthesis",
    sourceKind: "harness_checkpoint",
    sourceId: "checkpoint",
    summary: "Strict schema checkpoint"
  }, { semanticReview: "high", reason: "strict schema regression" });

  await scheduler.processDueQueue();

  const graph = store.listMemoryGraph();
  const completed = graph.synthesisQueue.find((entry) => entry.idempotencyKey === "synthesis:strict-schema-checkpoint:high");
  assert.equal(completed?.status, "completed");
  assert.equal(invokedModel, null);
  assert.equal(store.getJobMemory("thread-synthesis")?.promotionCandidates.some((entry) => entry.summary === "Keep strict memory synthesis schemas."), true);
  assert.equal(graph.observations.some((entry) => entry.sourceKind === "synthesis_result" && entry.sourceId === completed?.id), true);
});
