import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { backfillMemoryEmbeddings } from "../../src/server/memory-embedding-backfill.js";
import { encodeFloat32Vector, hashEmbeddingText, type MemoryEmbeddingConfig, type MemoryEmbeddingProvider } from "../../src/server/memory-embedding-client.js";
import { butlerMemoryTextForEmbedding, projectMemoryTextForEmbedding } from "../../src/server/memory-embedding-text.js";
import { retrieveButlerMemory, retrieveButlerMemoryWithEmbeddings } from "../../src/server/memory-retrieval.js";
import { ButlerStateStore } from "../../src/server/state-store.js";
import type { PersistedUiState } from "../../src/server/types.js";

async function createStore(state: PersistedUiState): Promise<ButlerStateStore> {
  const dir = await mkdtemp(path.join(tmpdir(), "manor-memory-embedding-test-"));
  const statePath = path.join(dir, "state.json");
  await writeFile(statePath, JSON.stringify(state, null, 2));
  const store = new ButlerStateStore(statePath);
  await store.load();
  return store;
}

const fakeConfig: MemoryEmbeddingConfig = {
  enabled: true,
  provider: "ollama",
  host: "http://127.0.0.1:11434",
  model: "fake-local-embedding",
  timeoutMs: 1_000,
  backfillBatchSize: 8
};

const fakeProvider: MemoryEmbeddingProvider = {
  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((text) => {
      const normalized = text.toLowerCase();
      if (normalized.includes("quartz") || normalized.includes("handoff")) return [1, 0];
      if (normalized.includes("ask fewer")) return [0.7, 0.3];
      return [0, 1];
    });
  }
};

test("embedding ranking does not make legacy global memory eligible for injection", async () => {
  const store = await createStore({
    windows: [],
    focusedWindowId: null,
    projectMemoriesByProjectId: {
      manor: {
        projectId: "manor",
        projectLabel: "Manor",
        summary: "Memory retrieval uses scoped project facts.",
        entries: [
          {
            id: "project-entry",
            sourceThreadId: "thread-memory",
            kind: "decision",
            summary: "Scoped project memories must outrank unrelated globals.",
            details: "Vector ranking is allowed only after eligibility gates.",
            acceptedAt: 10
          }
        ],
        updatedAt: 10
      }
    },
    butlerMemoryEntries: [
      {
        id: "global-chatbox",
        summary: "Victor's last assignment was ChatBox, not Asiri.",
        details: "Old task correction that mentions questions and decisions.",
        source: "butler_tool",
        sourceMessageId: null,
        tags: ["question", "decision"],
        createdAt: 20
      },
      {
        id: "operator-pref",
        summary: "Operator preference: Ask fewer better questions",
        details: "Infer from state first.",
        source: "butler_tool",
        sourceMessageId: "operator-question-1",
        tags: ["operator-taste", "operator-question", "autonomy"],
        createdAt: 30,
        memoryType: "operator_preference",
        scopeKind: "global",
        reviewState: "accepted"
      }
    ]
  });

  const project = store.getProjectMemory("manor");
  assert.ok(project);
  const projectText = projectMemoryTextForEmbedding(project);
  const legacyText = butlerMemoryTextForEmbedding(store.listButlerMemory().find((entry) => entry.id === "global-chatbox")!);
  const prefText = butlerMemoryTextForEmbedding(store.listButlerMemory().find((entry) => entry.id === "operator-pref")!);
  store.upsertMemoryEmbedding({
    sourceKind: "project_memory",
    sourceId: "manor",
    sourceTextHash: hashEmbeddingText(projectText),
    model: "qwen3-embedding:0.6b",
    modelTag: "qwen3-embedding:0.6b",
    dimension: 2,
    vectorBase64: encodeFloat32Vector([0.2, 0.8]),
    memoryType: "project_fact",
    projectId: "manor",
    threadId: null,
    provenance: {},
    contentVersion: 10
  });
  store.upsertMemoryEmbedding({
    sourceKind: "butler_memory",
    sourceId: "global-chatbox",
    sourceTextHash: hashEmbeddingText(legacyText),
    model: "qwen3-embedding:0.6b",
    modelTag: "qwen3-embedding:0.6b",
    dimension: 2,
    vectorBase64: encodeFloat32Vector([1, 0]),
    memoryType: "legacy_global",
    projectId: null,
    threadId: null,
    provenance: {},
    contentVersion: 1
  });
  store.upsertMemoryEmbedding({
    sourceKind: "butler_memory",
    sourceId: "operator-pref",
    sourceTextHash: hashEmbeddingText(prefText),
    model: "qwen3-embedding:0.6b",
    modelTag: "qwen3-embedding:0.6b",
    dimension: 2,
    vectorBase64: encodeFloat32Vector([0.8, 0.2]),
    memoryType: "operator_preference",
    projectId: null,
    threadId: null,
    provenance: {},
    contentVersion: 1
  });

  const retrieval = retrieveButlerMemory(store, {
    projectId: "manor",
    query: "question",
    includeGlobal: true,
    queryVector: [1, 0],
    embeddingModel: "qwen3-embedding:0.6b"
  });
  const legacy = retrieval.candidates.find((entry) => entry.sourceId === "global-chatbox");
  const preference = retrieval.candidates.find((entry) => entry.sourceId === "operator-pref");

  assert.ok(legacy);
  assert.ok((legacy.score.vector ?? 0) > 0.99);
  assert.equal(legacy.eligibleForInjection, false);
  assert.equal(legacy.memoryType, "legacy_global");
  assert.ok(preference);
  assert.equal(preference.eligibleForInjection, true);
});

test("smoke: backfill embeds existing entries and embedding-aware query returns vector-ranked candidates", async () => {
  const store = await createStore({
    windows: [],
    focusedWindowId: null,
    projectMemoriesByProjectId: {
      manor: {
        projectId: "manor",
        projectLabel: "Manor",
        summary: "Quartz retrieval is the durable Manor memory search plan.",
        entries: [
          {
            id: "project-quartz",
            sourceThreadId: "thread-quartz",
            kind: "decision",
            summary: "Use local embeddings for quartz memory lookups.",
            details: "This accepted project memory supersedes the quartz handoff candidate.",
            acceptedAt: 100
          }
        ],
        updatedAt: 100
      }
    },
    jobMemoriesByThreadId: {
      "thread-quartz": {
        threadId: "thread-quartz",
        projectId: "manor",
        projectLabel: "Manor",
        source: "codex",
        createdAt: 90,
        operatorGoal: "Improve Manor memory.",
        requestedTask: "Implement quartz embedding retrieval smoke.",
        currentPlan: ["Backfill existing memories", "Query with vectors"],
        latestCheckpoint: "Quartz embedding ingestion path exists.",
        nextAction: "Run query smoke.",
        blockers: [],
        assumptions: [],
        proofRequirements: [],
        notes: ["Handoff notes need semantic lookup."],
        decisions: [],
        entries: [
          {
            id: "entry-quartz",
            kind: "note",
            summary: "Quartz memory smoke note.",
            details: "The smoke test should prove ingestion and querying.",
            nextAction: null,
            blockers: [],
            plan: [],
            assumptions: [],
            proofRequirements: [],
            promote: true,
            promotionCandidateId: "candidate-quartz",
            at: 110
          }
        ],
        promotionCandidates: [
          {
            id: "candidate-quartz",
            threadId: "thread-quartz",
            projectId: "manor",
            projectLabel: "Manor",
            kind: "note",
            sourceEntryId: "entry-quartz",
            summary: "Quartz handoff candidate should be backfilled.",
            details: "Pending candidates remain queryable but gated from injection.",
            status: "pending",
            createdAt: 120,
            updatedAt: 120,
            resolvedAt: null
          }
        ],
        updatedAt: 120
      }
    },
    butlerMemoryEntries: [
      {
        id: "operator-pref-quartz",
        summary: "Operator preference: ask fewer better questions",
        details: "Infer from Manor state before interrupting.",
        source: "butler_tool",
        sourceMessageId: "operator-question-quartz",
        tags: ["operator-taste", "operator-question"],
        createdAt: 130,
        memoryType: "operator_preference",
        scopeKind: "global",
        reviewState: "accepted"
      }
    ]
  });

  const backfill = await backfillMemoryEmbeddings({ store, config: fakeConfig, provider: fakeProvider });
  assert.equal(backfill.failed, 0);
  assert.equal(backfill.embedded, 4);
  assert.deepEqual(new Set(store.listMemoryEmbeddings().map((entry) => entry.sourceKind)), new Set(["project_memory", "job_memory", "promotion_candidate", "butler_memory"]));
  const predicates = new Set(store.listMemoryGraph().relationships.map((entry) => entry.predicate));
  assert.ok(predicates.has("supports"));
  assert.ok(predicates.has("depends_on"));
  assert.ok(predicates.has("supersedes"));
  assert.ok(predicates.has("contradicts"));

  const retrieval = await retrieveButlerMemoryWithEmbeddings(store, {
    projectId: "manor",
    query: "quartz handoff lookup",
    includeGlobal: true
  }, { config: fakeConfig, provider: fakeProvider });
  const project = retrieval.candidates.find((entry) => entry.sourceKind === "project_memory");
  const candidate = retrieval.candidates.find((entry) => entry.sourceKind === "promotion_candidate" && entry.sourceId === "candidate-quartz");

  assert.ok(project);
  assert.ok((project.score.vector ?? 0) > 0.99);
  assert.ok(candidate);
  assert.ok((candidate.score.vector ?? 0) > 0.99);
  assert.equal(candidate.eligibleForInjection, false);
  assert.ok((project.graph?.supersedes.length ?? 0) > 0);
  assert.ok(project.score.total > candidate.score.total);
  assert.ok(candidate.score.graph < 0);
});
