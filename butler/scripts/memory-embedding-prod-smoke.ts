import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { backfillMemoryEmbeddings } from "../src/server/memory-embedding-backfill.js";
import { OllamaMemoryEmbeddingProvider, readMemoryEmbeddingConfig } from "../src/server/memory-embedding-client.js";
import { retrieveButlerMemory } from "../src/server/memory-retrieval.js";
import { ButlerStateStore } from "../src/server/state-store.js";
import type { ButlerMemoryEntryView, JobMemoryView, PersistedUiState, ProjectMemoryView } from "../src/server/types.js";

const CORPUS_SIZE = Math.max(300, Number(process.env.MANOR_MEMORY_SMOKE_CORPUS_SIZE ?? "300"));
const QUERY_COUNT = Math.max(50, Number(process.env.MANOR_MEMORY_SMOKE_QUERY_COUNT ?? "50"));
const TOP_K = Math.max(1, Number(process.env.MANOR_MEMORY_SMOKE_TOP_K ?? "5"));

type QueryCase = {
  name: string;
  query: string;
  includeGlobal?: boolean;
  expectedSourceId: string;
  expectedSourceKind: "project_memory" | "job_memory" | "promotion_candidate" | "butler_memory";
};

const colors = ["amber", "cobalt", "cedar", "delta", "ember", "frost", "garnet", "harbor", "indigo", "jade"];
const nouns = ["ledger", "handoff", "retrieval", "checkpoint", "scheduler", "artifact", "contract", "rollup", "trace", "payload"];
const verbs = ["stabilize", "promote", "reconcile", "verify", "route", "summarize", "persist", "rank", "inspect", "restore"];

function topic(index: number): string {
  return `${colors[index % colors.length]} ${nouns[Math.floor(index / colors.length) % nouns.length]} ${verbs[index % verbs.length]} ${String(index).padStart(4, "0")}`;
}

function buildState(count: number): PersistedUiState {
  const now = Date.now();
  const projectMemoriesByProjectId: Record<string, ProjectMemoryView> = {};
  const jobMemoriesByThreadId: Record<string, JobMemoryView> = {};
  const butlerMemoryEntries: ButlerMemoryEntryView[] = [];
  for (let index = 0; index < count; index += 1) {
    const projectId = `project-${index}`;
    const threadId = `thread-${index}`;
    const item = topic(index);
    projectMemoriesByProjectId[projectId] = {
      projectId,
      projectLabel: `Project ${index}`,
      summary: `Durable project protocol ${item}.`,
      entries: [{
        id: `project-entry-${index}`,
        sourceThreadId: threadId,
        kind: "decision",
        summary: `Durable project protocol ${item}.`,
        details: `Accepted project memory for production relevance smoke ${index}.`,
        acceptedAt: now + index
      }],
      updatedAt: now + index
    };
    jobMemoriesByThreadId[threadId] = {
      threadId,
      projectId,
      projectLabel: `Project ${index}`,
      source: "prod-smoke",
      createdAt: now + index,
      operatorGoal: `Worker checkpoint next action ${item}.`,
      requestedTask: `Complete job-memory relevance scenario ${item}.`,
      currentPlan: [`Rank job memory for ${item}`],
      latestCheckpoint: `Worker checkpoint next action ${item}.`,
      nextAction: `Inspect job retrieval for ${item}.`,
      blockers: [],
      assumptions: [],
      proofRequirements: [],
      notes: [`Job memory note ${item}.`],
      decisions: [],
      entries: [{
        id: `job-entry-${index}`,
        kind: "note",
        summary: `Worker checkpoint next action ${item}.`,
        details: `Job memory embedding smoke row ${index}.`,
        nextAction: null,
        blockers: [],
        plan: [],
        assumptions: [],
        proofRequirements: [],
        promote: true,
        promotionCandidateId: `candidate-${index}`,
        at: now + index
      }],
      promotionCandidates: [{
        id: `candidate-${index}`,
        threadId,
        projectId,
        projectLabel: `Project ${index}`,
        kind: "note",
        sourceEntryId: `job-entry-${index}`,
        summary: `Pending promotion candidate ${item}.`,
        details: `Candidate memory remains queryable but gated ${index}.`,
        status: "pending",
        createdAt: now + index,
        updatedAt: now + index,
        resolvedAt: null
      }],
      updatedAt: now + index
    };
    butlerMemoryEntries.push({
      id: `operator-pref-${index}`,
      summary: `Operator preference prefer ${item}.`,
      details: `Accepted operator preference for retrieval smoke ${index}.`,
      source: "butler_tool",
      sourceMessageId: `operator-question-${index}`,
      tags: ["operator-taste", "operator-question"],
      createdAt: now + index,
      memoryType: "operator_preference",
      scopeKind: "global",
      reviewState: "accepted",
      confidence: 1,
      projectId: null,
      threadId: null,
      expiresAt: null,
      supersedesId: null,
      provenance: { smoke: true },
      contentVersion: 1
    });
  }
  return { windows: [], focusedWindowId: null, projectMemoriesByProjectId, jobMemoriesByThreadId, butlerMemoryEntries };
}

function buildQueries(queryCount: number, corpusSize: number): QueryCase[] {
  const queries: QueryCase[] = [];
  const retainedPreferenceStart = Math.max(0, corpusSize - 100);
  for (let i = 0; i < queryCount; i += 1) {
    const item = topic(i);
    const mode = i % 5;
    if (mode === 0) queries.push({ name: `project-${i}`, query: `durable project protocol ${item}`, expectedSourceKind: "project_memory", expectedSourceId: `project-${i}` });
    if (mode === 1) queries.push({ name: `job-${i}`, query: `worker checkpoint next action ${item}`, expectedSourceKind: "job_memory", expectedSourceId: `thread-${i}` });
    if (mode === 2) queries.push({ name: `candidate-${i}`, query: `pending promotion candidate ${item}`, expectedSourceKind: "promotion_candidate", expectedSourceId: `candidate-${i}` });
    if (mode === 3) {
      const preferenceIndex = retainedPreferenceStart + i;
      queries.push({
        name: `preference-${preferenceIndex}`,
        query: `operator preference prefer ${topic(preferenceIndex)}`,
        includeGlobal: true,
        expectedSourceKind: "butler_memory",
        expectedSourceId: `operator-pref-${preferenceIndex}`
      });
    }
    if (mode === 4) queries.push({ name: `project-repeat-${i}`, query: `durable project protocol ${item}`, includeGlobal: true, expectedSourceKind: "project_memory", expectedSourceId: `project-${i}` });
  }
  return queries.slice(0, QUERY_COUNT);
}

const statePath = path.join(await mkdtemp(path.join(tmpdir(), "manor-memory-prod-smoke-")), "state.json");
await writeFile(statePath, JSON.stringify(buildState(CORPUS_SIZE), null, 2));

const store = new ButlerStateStore(statePath);
await store.load();
const config = readMemoryEmbeddingConfig();
assert.equal(config.enabled, true, "MANOR_MEMORY_EMBEDDINGS_ENABLED must be enabled for prod smoke");
const provider = new OllamaMemoryEmbeddingProvider(config);

const startedAt = Date.now();
const backfill = await backfillMemoryEmbeddings({ store, config, provider, batchSize: config.backfillBatchSize });
const embeddings = store.listMemoryEmbeddings();
assert.equal(backfill.failed, 0, JSON.stringify(backfill));
assert.ok(embeddings.length >= 1_000, `expected at least 1000 embeddings, got ${embeddings.length}`);

const queries = buildQueries(QUERY_COUNT, CORPUS_SIZE);
assert.ok(queries.length >= 50, `expected at least 50 queries, got ${queries.length}`);
const queryVectors = await provider.embed(queries.map((entry) => entry.query));
let hitAt1 = 0;
let hitAtK = 0;
let reciprocalRankTotal = 0;
const failures: Array<Record<string, unknown>> = [];

for (const [index, query] of queries.entries()) {
  const retrieval = retrieveButlerMemory(store, {
    query: query.query,
    includeGlobal: query.includeGlobal === true,
    queryVector: queryVectors[index] ?? null,
    embeddingModel: config.model,
    limit: 20
  });
  const rank = retrieval.candidates.findIndex((candidate) => candidate.sourceKind === query.expectedSourceKind && candidate.sourceId === query.expectedSourceId) + 1;
  const expected = rank > 0 ? retrieval.candidates[rank - 1] : null;
  if (rank === 1) hitAt1 += 1;
  if (rank > 0 && rank <= TOP_K) hitAtK += 1;
  if (rank > 0) reciprocalRankTotal += 1 / rank;
  if (rank === 0 || rank > TOP_K || typeof expected?.score.vector !== "number" || expected.score.vector <= 0) {
    failures.push({
      name: query.name,
      query: query.query,
      expected: `${query.expectedSourceKind}:${query.expectedSourceId}`,
      rank: rank || null,
      vector: expected?.score.vector ?? null,
      top: retrieval.candidates.slice(0, TOP_K).map((candidate) => `${candidate.sourceKind}:${candidate.sourceId}:${candidate.score.total.toFixed(3)}`)
    });
  }
}

assert.equal(failures.length, 0, JSON.stringify(failures.slice(0, 10), null, 2));

const summary = {
  model: config.model,
  host: config.host,
  corpusSize: CORPUS_SIZE,
  embeddings: embeddings.length,
  embedded: backfill.embedded,
  skippedFresh: backfill.skippedFresh,
  queries: queries.length,
  topK: TOP_K,
  hitAt1,
  hitAtK,
  mrr: Number((reciprocalRankTotal / queries.length).toFixed(4)),
  durationMs: Date.now() - startedAt
};

console.log(JSON.stringify(summary, null, 2));
