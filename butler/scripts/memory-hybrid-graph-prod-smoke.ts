import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { backfillMemoryEmbeddings } from "../src/server/memory-embedding-backfill.js";
import { OllamaMemoryEmbeddingProvider, readMemoryEmbeddingConfig } from "../src/server/memory-embedding-client.js";
import { readMemorySynthesisConfig } from "../src/server/memory-synthesis-config.js";
import { MemorySemanticEdgeReviewService } from "../src/server/memory-semantic-edge-review.js";
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

function buildQueries(count: number, corpusSize: number): QueryCase[] {
  return Array.from({ length: count }, (_, index) => {
    const sourceIndex = Math.max(0, corpusSize - 1 - index);
    const relationQuery = index % 2 === 1;
    const item = topic(sourceIndex);
    return relationQuery
      ? {
          name: `support-${sourceIndex}`,
          query: `worker checkpoint next action ${item}`,
          expectedSourceKind: "job_memory" as const,
          expectedSourceId: `thread-${sourceIndex}`,
          relationRequired: "supports" as const
        }
      : {
          name: `contradiction-${sourceIndex}`,
          query: `outdated pending promotion candidate ${item}`,
          expectedSourceKind: "project_memory" as const,
          expectedSourceId: `project-${sourceIndex}`,
          relationRequired: "supersedes" as const,
          rejectedSourceId: `candidate-${sourceIndex}`
        };
  });
}

const configuredStatePath = process.env.MANOR_MEMORY_SMOKE_STATE_PATH;
if (configuredStatePath) await mkdir(path.dirname(configuredStatePath), { recursive: true });
const statePath = configuredStatePath ?? path.join(await mkdtemp(path.join(tmpdir(), "manor-memory-hybrid-prod-smoke-")), "state.json");
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
console.error(`[memory-hybrid-smoke] embedded=${embeddings.length}`);
const graphBeforeEdges = store.listMemoryGraph();
assert.ok(graphBeforeEdges.entities.filter((entry) => entry.type === "memory").length >= 1_000, "expected at least 1000 memory graph nodes");
const possibleEdges = graphBeforeEdges.relationships.filter((entry) => ["possible_supersedes", "possible_contradicts", "supports", "depends_on"].includes(entry.predicate)).length;
assert.ok(possibleEdges >= QUERY_COUNT * 4, `expected deterministic graph proposals, got ${possibleEdges}`);
console.error(`[memory-hybrid-smoke] graph_nodes=${graphBeforeEdges.entities.filter((entry) => entry.type === "memory").length} proposals=${possibleEdges}`);

const synthesisConfig = {
  ...readMemorySynthesisConfig(),
  semanticEdgeReviewEnabled: true
};
assert.equal(synthesisConfig.enabled, true, "MANOR_MEMORY_SYNTHESIS_ENABLED must be enabled for semantic edge smoke");
const semanticErrors: string[] = [];
const semanticReview = new MemorySemanticEdgeReviewService({
  store,
  config: synthesisConfig,
  stateDir: path.dirname(statePath),
  codexHomeDir: process.env.MANOR_STATE_DIR ?? path.join(process.env.HOME ?? "/tmp", ".local", "state", "manor"),
  onError: (error) => semanticErrors.push(error instanceof Error ? error.message : String(error))
});
let semanticReviewed = 0;
let semanticRelationships = 0;
for (let batch = 0; batch < 10 && semanticReviewed < QUERY_COUNT * 2; batch += 1) {
  const result = await semanticReview.reviewNextBatch(`hybrid-smoke-${batch}`);
  semanticReviewed += result.reviewed;
  semanticRelationships += result.relationships;
  console.error(`[memory-hybrid-smoke] semantic_batch=${batch + 1} reviewed=${semanticReviewed} relationships=${semanticRelationships}`);
  if (result.reviewed === 0) break;
}
const semanticEdges = store.listMemoryGraph().relationships.filter((entry) => ["supersedes", "contradicts", "supports"].includes(entry.predicate) && entry.sourceObservationId.startsWith("model:semantic-edge:")).length;
assert.ok(semanticReviewed >= QUERY_COUNT * 2, `expected at least ${QUERY_COUNT * 2} model-reviewed semantic pairs, got ${semanticReviewed}; errors=${semanticErrors.join(" | ") || "none"}`);
assert.ok(semanticEdges >= Math.floor(QUERY_COUNT / 2), `expected a material set of model-confirmed semantic graph edges, got ${semanticEdges}`);

const queries = buildQueries(QUERY_COUNT, CORPUS_SIZE);
const queryVectors = await provider.embed(queries.map((entry) => entry.query));
console.error(`[memory-hybrid-smoke] query_vectors=${queryVectors.length}`);
let hitAt1 = 0;
let hitAtK = 0;
let contradictionResolved = 0;
let relationTraced = 0;
let reciprocalRankTotal = 0;
const failures: Array<Record<string, unknown>> = [];
let sampleQueryResult: Record<string, unknown> | null = null;

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
  if (!sampleQueryResult && query.rejectedSourceId && expected) {
    sampleQueryResult = {
      query: query.query,
      expected: `${query.expectedSourceKind}:${query.expectedSourceId}`,
      rank,
      top: retrieval.candidates.slice(0, TOP_K).map((candidate) => ({
        source: `${candidate.sourceKind}:${candidate.sourceId}`,
        total: Number(candidate.score.total.toFixed(3)),
        graph: Number(candidate.score.graph.toFixed(3)),
        supersedes: candidate.graph?.supersedes.slice(0, 3) ?? [],
        supersededBy: candidate.graph?.supersededBy.slice(0, 3) ?? [],
        contradictedBy: candidate.graph?.contradictedBy.slice(0, 3) ?? []
      })),
      rejected: rejected ? {
        source: `${rejected.sourceKind}:${rejected.sourceId}`,
        total: Number(rejected.score.total.toFixed(3)),
        graph: Number(rejected.score.graph.toFixed(3)),
        supersededBy: rejected.graph?.supersededBy.slice(0, 3) ?? [],
        contradictedBy: rejected.graph?.contradictedBy.slice(0, 3) ?? []
      } : null
    };
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
  possibleEdges,
  semanticReviewed,
  semanticRelationships,
  semanticEdges,
  queries: queries.length,
  topK: TOP_K,
  hitAt1,
  hitAtK,
  mrr: Number((reciprocalRankTotal / queries.length).toFixed(4)),
  contradictionResolved,
  relationTraced,
  sampleQueryResult,
  durationMs: Date.now() - startedAt
}, null, 2));
