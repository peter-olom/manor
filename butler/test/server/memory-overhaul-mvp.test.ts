import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { readMemorySynthesisConfig } from "../../src/server/memory-synthesis-config.js";
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
    provider: "codex_exec",
    model: "5.4 mini",
    effort: null,
    timeoutMs: 90_000,
    maxInputChars: 16_000,
    maxCandidatesPerRun: 6,
    autoPromoteHighConfidence: false,
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

test("memory synthesis config defaults to 5.4 mini and honors env overrides", () => {
  assert.equal(readMemorySynthesisConfig({}).model, "5.4 mini");
  assert.equal(readMemorySynthesisConfig({ MANOR_MEMORY_REVIEW_MODEL: "legacy-model" }).model, "legacy-model");
  const config = readMemorySynthesisConfig({ MANOR_MEMORY_SYNTHESIS_MODEL: "operator-model", MANOR_MEMORY_SYNTHESIS_ENABLED: "0", MANOR_MEMORY_SYNTHESIS_MAX_CANDIDATES: "12" });
  assert.equal(config.model, "operator-model");
  assert.equal(config.enabled, false);
  assert.equal(config.maxCandidatesPerRun, 12);
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

test("legacy memory retrieval remains compatible while graph search adds relationship-aware context", async () => {
  const { store, stateDir } = await createStore();
  const scheduler = new MemoryUpdateScheduler({ store, stateDir, codexHomeDir: stateDir, config: testConfig({ enabled: false }) });
  store.upsertThreadSummary({ id: "thread-legacy", cwd: "/workspace", createdAt: 1, status: "running" });
  store.setThreadExecutionContract("thread-legacy", contract("thread-legacy"));
  store.recordJobCheckpoint("thread-legacy", { summary: "Legacy checkpoint survived", details: "Existing retrieval should still work." });
  scheduler.observeHarnessMemory({ threadId: "thread-legacy", kind: "checkpoint", summary: "Graph checkpoint records Campaign.billingSummary dependency", details: "UI waits on API." });

  const legacy = retrieveButlerMemory(store, { threadId: "thread-legacy", query: "Legacy checkpoint" });
  assert.equal(legacy.jobMemories[0]?.latestCheckpoint, "Legacy checkpoint survived");
  const graph = store.searchMemoryGraph({ projectId: "project-1", query: "Campaign.billingSummary" });
  assert.equal(graph.observations.some((entry) => entry.summary.includes("Campaign.billingSummary")), true);
  assert.equal(graph.tasks.some((entry) => entry.threadId === "thread-legacy"), true);
});
