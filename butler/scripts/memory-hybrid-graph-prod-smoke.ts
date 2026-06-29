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
      summary: `Current canonical memory says use graph-backed protocol ${item}.`,
      entries: [{
        id: `project-entry-${index}`,
        sourceThreadId: threadId,
        kind: "decision",
        summary: `Current canonical memory says use graph-backed protocol ${item}.`,
        details: `This accepted memory supersedes an older pending candidate for ${item}.`,
        acceptedAt: now + index
      }],
      updatedAt: now + index
    };
    jobMemoriesByThreadId[threadId] = {
      threadId,
      projectId,
      projectLabel: `Project ${index}`,
      source: "hybrid-prod-smoke",
      createdAt: now + index,
      operatorGoal: `Worker checkpoint next action ${item}.`,
      requestedTask: `Complete hybrid graph relevance scenario ${item}.`,
      currentPlan: [`Rank related graph memory for ${item}`],
      latestCheckpoint: `Worker checkpoint next action ${item}.`,
      nextAction: `Inspect graph retrieval for ${item}.`,
      blockers: [],
      assumptions: [],
      proofRequirements: [],
      notes: [`Job memory note ${item}.`],
      decisions: [],
      entries: [{
        id: `job-entry-${index}`,
        kind: "note",
        summary: `Worker checkpoint next action ${item}.`,
        details: `Job memory graph smoke row ${index}.`,
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
        summary: `Outdated pending promotion candidate ${item}.`,
        details: `This older candidate is contradicted and superseded by accepted project memory ${index}.`,
        status: "pending",
        createdAt: now + index,
        updatedAt: now + index,
        resolvedAt: null
      }],
      updatedAt: now + index
    };
    butlerMemoryEntries.push({
      id: `operator-pref-${index}`,
      summary: `Operator preference prefer graph relation ${item}.`,
      details: `Accepted operator preference for hybrid graph smoke ${index}.`,
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

type QueryCase = {
  name: string;
  query: string;
  expectedSourceKind: "project_memory" | "job_memory";
  expectedSourceId: string;
  relationRequired: "supersedes" | "supports";
  rejectedSourceId?: string;
};

function buildQueries(count: number): QueryCase[] {
  return Array.from({ length: count }, (_, index) => {
    const relationQuery = index % 2 === 1;
    const item = topic(index);
    return relationQuery
      ? {
          name: `support-${index}`,
          query: `worker checkpoint next action ${item}`,
          expectedSourceKind: "job_memory" as const,
          expectedSourceId: `thread-${index}`,
          relationRequired: "supports" as const
        }
      : {
          name: `contradiction-${index}`,
          query: `outdated pending promotion candidate ${item}`,
          expectedSourceKind: "project_memory" as const,
          expectedSourceId: `project-${index}`,
          relationRequired: "supersedes" as const,
          rejectedSourceId: `candidate-${index}`
        };
  });
}

const statePath = path.join(await mkdtemp(path.join(tmpdir(), "manor-memory-hybrid-prod-smoke-")), "state.json");
await writeFile(statePath, JSON.stringify(buildState(CORPUS_SIZE), null, 2));

const store = new ButlerStateStore(statePath);
await store.load();
const config = readMemoryEmbeddingConfig();
assert.equal(config.enabled, true, "MANOR_MEMORY_EMBEDDINGS_ENABLED must be enabled for hybrid smoke");
const provider = new OllamaMemoryEmbeddingProvider(config);
const startedAt = Date.now();

const backfill = await backfillMemoryEmbeddings({ store, config, provider, batchSize: config.backfillBatchSize });
assert.equal(backfill.failed, 0, JSON.stringify(backfill));
const embeddings = store.listMemoryEmbeddings();
assert.ok(embeddings.length >= 1_000, `expected at least 1000 embeddings, got ${embeddings.length}`);
const graphBeforeEdges = store.listMemoryGraph();
assert.ok(graphBeforeEdges.entities.filter((entry) => entry.type === "memory").length >= 1_000, "expected at least 1000 memory graph nodes");
const semanticEdges = graphBeforeEdges.relationships.filter((entry) => ["supersedes", "contradicts", "supports", "depends_on"].includes(entry.predicate)).length;
assert.ok(semanticEdges >= QUERY_COUNT * 4, `expected production semantic graph edges, got ${semanticEdges}`);

const queries = buildQueries(QUERY_COUNT);
const queryVectors = await provider.embed(queries.map((entry) => entry.query));
let hitAt1 = 0;
let hitAtK = 0;
let contradictionResolved = 0;
let relationTraced = 0;
let reciprocalRankTotal = 0;
const failures: Array<Record<string, unknown>> = [];

for (const [index, query] of queries.entries()) {
  const retrieval = retrieveButlerMemory(store, {
    query: query.query,
    includeGlobal: false,
    queryVector: queryVectors[index] ?? null,
    embeddingModel: config.model,
    limit: 20
  });
  const rank = retrieval.candidates.findIndex((candidate) => candidate.sourceKind === query.expectedSourceKind && candidate.sourceId === query.expectedSourceId) + 1;
  const expected = rank > 0 ? retrieval.candidates[rank - 1] : null;
  const rejected = query.rejectedSourceId ? retrieval.candidates.find((candidate) => candidate.sourceId === query.rejectedSourceId) : null;
  if (rank === 1) hitAt1 += 1;
  if (rank > 0 && rank <= TOP_K) hitAtK += 1;
  if (rank > 0) reciprocalRankTotal += 1 / rank;
  const relationMatched = expected?.graph?.relations.some((entry) => entry.toLowerCase().includes(query.relationRequired)) === true;
  const expectedSupersedes = query.rejectedSourceId ? (expected?.graph?.supersedes.length ?? 0) > 0 : true;
  if (relationMatched) relationTraced += 1;
  if (query.rejectedSourceId && expected?.sourceKind === "project_memory" && expectedSupersedes && (!rejected || (rejected.score.graph < 0 && expected.score.total > rejected.score.total))) {
    contradictionResolved += 1;
  }
  if (rank === 0 || rank > TOP_K || !relationMatched || (query.rejectedSourceId && (!expectedSupersedes || (rejected && (rejected.score.graph >= 0 || expected!.score.total <= rejected.score.total))))) {
    failures.push({
      name: query.name,
      expected: `${query.expectedSourceKind}:${query.expectedSourceId}`,
      rank: rank || null,
      expectedGraph: expected?.score.graph ?? null,
      rejected: rejected ? `${rejected.sourceKind}:${rejected.sourceId}:${rejected.score.graph.toFixed(3)}:${rejected.score.total.toFixed(3)}` : null,
      top: retrieval.candidates.slice(0, TOP_K).map((candidate) => `${candidate.sourceKind}:${candidate.sourceId}:total=${candidate.score.total.toFixed(3)}:graph=${candidate.score.graph.toFixed(3)}`)
    });
  }
}

assert.equal(failures.length, 0, JSON.stringify(failures.slice(0, 10), null, 2));

console.log(JSON.stringify({
  model: config.model,
  host: config.host,
  corpusSize: CORPUS_SIZE,
  embeddings: embeddings.length,
  memoryGraphNodes: store.listMemoryGraph().entities.filter((entry) => entry.type === "memory").length,
  semanticEdges,
  queries: queries.length,
  topK: TOP_K,
  hitAt1,
  hitAtK,
  mrr: Number((reciprocalRankTotal / queries.length).toFixed(4)),
  contradictionResolved,
  relationTraced,
  durationMs: Date.now() - startedAt
}, null, 2));
