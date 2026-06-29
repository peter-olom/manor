import type { ButlerStateStore } from "./state-store.js";
import type {
  ButlerMemoryEntryView,
  ButlerMemoryRetrievalView,
  JobMemoryView,
  JobMemoryPromotionCandidateView,
  MemoryEmbeddingView,
  MemoryRetrievalCandidateView,
  ProjectMemoryView
} from "./types.js";
import { cosineSimilarity, decodeFloat32Vector, hashEmbeddingText, OllamaMemoryEmbeddingProvider, readMemoryEmbeddingConfig, type MemoryEmbeddingConfig, type MemoryEmbeddingProvider } from "./memory-embedding-client.js";
import { butlerMemoryTextForEmbedding, jobMemoryTextForEmbedding, projectMemoryTextForEmbedding, promotionCandidateTextForEmbedding } from "./memory-embedding-text.js";
import { isAcceptedOperatorPreferenceMemory } from "./memory-metadata.js";

type RetrievalInput = {
  projectId?: string | null;
  threadId?: string | null;
  query?: string | null;
  limit?: number | null;
  includeGlobal?: boolean | null;
  includeProvenance?: boolean | null;
  queryVector?: number[] | null;
  embeddingModel?: string | null;
};

function normalizeText(value: string | null | undefined): string {
  return (value ?? "").replace(/\s+/g, " ").trim();
}

function queryTokens(query: string | null): string[] {
  return [...new Set(normalizeText(query).toLowerCase().split(/[^a-z0-9_-]+/).filter((token) => token.length >= 2))];
}

function scoreText(text: string, query: string | null, tokens: string[]): number {
  const normalized = normalizeText(text).toLowerCase();
  if (!normalized || (!query && tokens.length === 0)) {
    return 0;
  }
  let score = 0;
  const phrase = normalizeText(query).toLowerCase();
  if (phrase && normalized.includes(phrase)) {
    score += 8;
  }
  for (const token of tokens) {
    if (normalized.includes(token)) {
      score += 1;
    }
  }
  return score;
}

function jobMemoryText(memory: JobMemoryView): string {
  return jobMemoryTextForEmbedding(memory);
}

function jobMemoryActivityAt(memory: JobMemoryView): number {
  const timestamps = [
    memory.createdAt,
    ...memory.decisions.map((entry) => entry.at),
    ...memory.entries.map((entry) => entry.at),
    ...memory.promotionCandidates.flatMap((entry) => [entry.createdAt, entry.updatedAt, entry.resolvedAt].filter((value): value is number => typeof value === "number"))
  ].filter((value) => Number.isFinite(value));
  return timestamps.length > 0 ? Math.max(...timestamps) : memory.updatedAt;
}

function projectMemoryText(memory: ProjectMemoryView): string {
  return projectMemoryTextForEmbedding(memory);
}

function butlerMemoryText(memory: ButlerMemoryEntryView): string {
  return butlerMemoryTextForEmbedding(memory);
}

function freshnessScore(timestamp: number): number {
  if (!Number.isFinite(timestamp)) return 0;
  const ageDays = Math.max(0, (Date.now() - timestamp) / 86_400_000);
  return Math.max(0, 1 - Math.min(1, ageDays / 90));
}

function latestProjectEntryAt(memory: ProjectMemoryView): number {
  return memory.entries.length > 0 ? Math.max(...memory.entries.map((entry) => entry.acceptedAt)) : memory.updatedAt;
}

function latestJobEntryAt(memory: JobMemoryView): number {
  return jobMemoryActivityAt(memory);
}

function embeddingFor(
  embeddings: MemoryEmbeddingView[],
  sourceKind: MemoryEmbeddingView["sourceKind"],
  sourceId: string,
  text: string,
  model: string | null
): MemoryEmbeddingView | null {
  const hash = hashEmbeddingText(text);
  return embeddings.find((entry) =>
    entry.sourceKind === sourceKind &&
    entry.sourceId === sourceId &&
    entry.sourceTextHash === hash &&
    (!model || entry.model === model)
  ) ?? null;
}

function vectorScore(embedding: MemoryEmbeddingView | null, queryVector: number[] | null): number | null {
  if (!embedding || !queryVector || queryVector.length === 0) return null;
  return cosineSimilarity(queryVector, decodeFloat32Vector(embedding.vectorBase64, embedding.dimension));
}

function totalScore(input: { lexical: number; vector: number | null; freshness: number }): number {
  return input.lexical + (input.vector === null ? 0 : input.vector * 5) + input.freshness;
}

function buildCandidates(
  store: ButlerStateStore,
  input: {
    projectRollups: ProjectMemoryView[];
    jobMemories: JobMemoryView[];
    butlerMemories: ButlerMemoryEntryView[];
    pendingPromotionCandidates: JobMemoryPromotionCandidateView[];
    query: string | null;
    tokens: string[];
    queryVector: number[] | null;
    embeddingModel: string | null;
  }
): MemoryRetrievalCandidateView[] {
  const embeddings = typeof store.listMemoryEmbeddings === "function" ? store.listMemoryEmbeddings() : [];
  const candidates: MemoryRetrievalCandidateView[] = [];
  for (const memory of input.projectRollups) {
    const text = projectMemoryText(memory);
    const embedding = embeddingFor(embeddings, "project_memory", memory.projectId, text, input.embeddingModel);
    const score = {
      lexical: scoreText(text, input.query, input.tokens),
      vector: vectorScore(embedding, input.queryVector),
      freshness: freshnessScore(latestProjectEntryAt(memory))
    };
    candidates.push({
      id: `project:${memory.projectId}`,
      sourceKind: "project_memory",
      sourceId: memory.projectId,
      text,
      memoryType: "project_fact",
      scopeKind: "project",
      projectId: memory.projectId,
      threadId: null,
      eligibleForInjection: false,
      reason: "accepted project memory is retrievable but not injected into worker payloads in shadow mode",
      score: { ...score, total: totalScore(score) }
    });
  }
  for (const memory of input.jobMemories) {
    const text = jobMemoryText(memory);
    const embedding = embeddingFor(embeddings, "job_memory", memory.threadId, text, input.embeddingModel);
    const score = {
      lexical: scoreText(text, input.query, input.tokens),
      vector: vectorScore(embedding, input.queryVector),
      freshness: freshnessScore(latestJobEntryAt(memory))
    };
    candidates.push({
      id: `job:${memory.threadId}`,
      sourceKind: "job_memory",
      sourceId: memory.threadId,
      text,
      memoryType: "thread_fact",
      scopeKind: "thread",
      projectId: memory.projectId,
      threadId: memory.threadId,
      eligibleForInjection: false,
      reason: "job memory is retrievable but not injected by embedding shadow retrieval",
      score: { ...score, total: totalScore(score) }
    });
  }
  for (const memory of input.butlerMemories) {
    const text = butlerMemoryText(memory);
    const embedding = embeddingFor(embeddings, "butler_memory", memory.id, text, input.embeddingModel);
    const score = {
      lexical: scoreText(text, input.query, input.tokens),
      vector: vectorScore(embedding, input.queryVector),
      freshness: freshnessScore(memory.createdAt)
    };
    const eligible = isAcceptedOperatorPreferenceMemory(memory);
    candidates.push({
      id: `butler:${memory.id}`,
      sourceKind: "butler_memory",
      sourceId: memory.id,
      text,
      memoryType: memory.memoryType ?? "legacy_global",
      scopeKind: memory.scopeKind ?? "global",
      projectId: memory.projectId ?? null,
      threadId: memory.threadId ?? null,
      eligibleForInjection: eligible,
      reason: eligible ? "accepted global operator preference" : "global or legacy Butler memory is not eligible for worker injection",
      score: { ...score, total: totalScore(score) }
    });
  }
  for (const candidate of input.pendingPromotionCandidates) {
    const text = promotionCandidateTextForEmbedding(candidate);
    const embedding = embeddingFor(embeddings, "promotion_candidate", candidate.id, text, input.embeddingModel);
    const score = {
      lexical: scoreText(text, input.query, input.tokens),
      vector: vectorScore(embedding, input.queryVector),
      freshness: freshnessScore(candidate.updatedAt)
    };
    candidates.push({
      id: `promotion:${candidate.id}`,
      sourceKind: "promotion_candidate",
      sourceId: candidate.id,
      text,
      memoryType: "project_fact",
      scopeKind: "project",
      projectId: candidate.projectId,
      threadId: candidate.threadId,
      eligibleForInjection: false,
      reason: `promotion candidate is ${candidate.status} and requires explicit resolution before project memory injection`,
      score: { ...score, total: totalScore(score) }
    });
  }
  return candidates.sort((left, right) => right.score.total - left.score.total).slice(0, Math.max(50, (input.queryVector ? 100 : 50)));
}

function formatTime(value: number | null | undefined): string {
  return typeof value === "number" && Number.isFinite(value) ? new Date(value).toISOString() : "unknown";
}

function formatSource(value: string | null | undefined): string {
  return value && value.trim() && value !== "unknown" ? value.trim() : "unknown";
}

function rankByQuery<T>(items: T[], query: string | null, textFor: (item: T) => string, timeFor: (item: T) => number): T[] {
  const tokens = queryTokens(query);
  if (!query && tokens.length === 0) {
    return [...items].sort((left, right) => timeFor(right) - timeFor(left));
  }
  return items
    .map((item) => ({ item, score: scoreText(textFor(item), query, tokens), time: timeFor(item) }))
    .filter((entry) => entry.score > 0)
    .sort((left, right) => right.score - left.score || right.time - left.time)
    .map((entry) => entry.item);
}

export function retrieveButlerMemory(store: ButlerStateStore, input: RetrievalInput = {}): ButlerMemoryRetrievalView {
  const limit = Math.max(1, Math.min(20, Math.trunc(input.limit ?? 6)));
  const projectId = normalizeText(input.projectId) || null;
  const threadId = normalizeText(input.threadId) || null;
  const query = normalizeText(input.query) || null;
  const includeProvenance = input.includeProvenance === true;
  const tokens = queryTokens(query);
  const warnings: string[] = [];

  const projectRollups = rankByQuery(
    projectId ? [store.getProjectMemory(projectId)].filter((entry): entry is ProjectMemoryView => Boolean(entry)) : store.listProjectMemories(),
    query,
    projectMemoryText,
    (memory) => memory.updatedAt
  ).slice(0, limit);

  const jobCandidates = threadId
    ? [store.getJobMemory(threadId)].filter((entry): entry is JobMemoryView => Boolean(entry))
    : store.listJobMemories(projectId);
  const jobMemories = rankByQuery(jobCandidates, query, jobMemoryText, jobMemoryActivityAt).slice(0, limit);

  const butlerMemories = input.includeGlobal
    ? rankByQuery(store.listButlerMemory(), query, butlerMemoryText, (memory) => memory.createdAt).slice(0, limit)
    : [];
  const pendingPromotionCandidates = store.listPendingPromotionCandidates(projectId).slice(0, limit);
  const useVectorPool = Array.isArray(input.queryVector) && input.queryVector.length > 0;
  const vectorProjectRollups = projectId
    ? [store.getProjectMemory(projectId)].filter((entry): entry is ProjectMemoryView => Boolean(entry))
    : store.listProjectMemories();
  const vectorButlerMemories = input.includeGlobal ? store.listButlerMemory() : [];
  const candidates = buildCandidates(store, {
    projectRollups: useVectorPool ? vectorProjectRollups : projectRollups,
    jobMemories: useVectorPool ? jobCandidates : jobMemories,
    butlerMemories: useVectorPool ? vectorButlerMemories : butlerMemories,
    pendingPromotionCandidates: useVectorPool ? store.listPendingPromotionCandidates(projectId) : pendingPromotionCandidates,
    query,
    tokens,
    queryVector: Array.isArray(input.queryVector) ? input.queryVector : null,
    embeddingModel: normalizeText(input.embeddingModel) || null
  });

  if (projectId && projectRollups.length === 0) {
    warnings.push("No project rollup matched the requested project.");
  }
  if (threadId && jobMemories.length === 0) {
    warnings.push("No job memory matched the requested job.");
  }
  if (!query && !projectId && !threadId) {
    warnings.push("No scope or query was provided; returned recent rollups and pending outcomes only.");
  }

  return {
    query,
    projectId,
    threadId,
    includeProvenance,
    candidates,
    shadowTraceId: candidates.length > 0 ? `shadow-${Date.now()}` : null,
    projectRollups,
    jobMemories,
    butlerMemories,
    pendingPromotionCandidates,
    warnings,
    retrievedAt: Date.now()
  };
}

export async function retrieveButlerMemoryWithEmbeddings(
  store: ButlerStateStore,
  input: RetrievalInput = {},
  options: { config?: MemoryEmbeddingConfig; provider?: MemoryEmbeddingProvider } = {}
): Promise<ButlerMemoryRetrievalView> {
  const config = options.config ?? readMemoryEmbeddingConfig();
  const query = normalizeText(input.query) || null;
  if (!config.enabled || !query || Array.isArray(input.queryVector)) return retrieveButlerMemory(store, input);
  try {
    const provider = options.provider ?? new OllamaMemoryEmbeddingProvider(config);
    const [queryVector] = await provider.embed([query]);
    return retrieveButlerMemory(store, { ...input, queryVector: queryVector ?? null, embeddingModel: config.model });
  } catch (error) {
    const retrieval = retrieveButlerMemory(store, input);
    retrieval.warnings.push(`Embedding query failed: ${error instanceof Error ? error.message : String(error)}`);
    return retrieval;
  }
}

export function formatButlerMemoryRetrieval(view: ButlerMemoryRetrievalView): string {
  const includeProvenance = view.includeProvenance === true;
  const header = `Memory retrieval | project=${view.projectId ?? "any"} | job=${view.threadId ?? "any"} | query=${view.query ?? "none"}`;
  const lines = [includeProvenance ? `${header} | retrieved=${formatTime(view.retrievedAt)}` : header];
  if (view.projectRollups.length > 0) {
    lines.push(
      "Project rollups:",
      ...view.projectRollups.map((memory, index) => {
        const recentEntries = memory.entries.slice(-3).map((entry) => {
          const kind = includeProvenance ? `${entry.kind}@${formatTime(entry.acceptedAt)}` : entry.kind;
          return `${kind}: ${entry.summary}`;
        }).join(" | ");
        const provenance = includeProvenance ? ` | updated=${formatTime(memory.updatedAt)}` : "";
        return `${index + 1}. ${memory.projectLabel}${provenance} | ${memory.summary ?? "No summary"}${recentEntries ? ` | recent=${recentEntries}` : ""}`;
      })
    );
  }
  if (view.jobMemories.length > 0) {
    lines.push(
      "Job memories:",
      ...view.jobMemories.map((memory, index) => {
        const provenance = includeProvenance
          ? ` | source=${formatSource(memory.source)} | created=${formatTime(memory.createdAt)} | activity=${formatTime(jobMemoryActivityAt(memory))} | recordUpdated=${formatTime(memory.updatedAt)}`
          : "";
        return `${index + 1}. ${memory.projectLabel} | job=${memory.threadId}${provenance} | checkpoint=${memory.latestCheckpoint ?? "none"} | next=${memory.nextAction ?? "none"} | blockers=${memory.blockers.join(" | ") || "none"}`;
      })
    );
  }
  if (view.butlerMemories.length > 0) {
    lines.push(
      "Global Butler memories:",
      ...view.butlerMemories.map((memory, index) => {
        const provenance = includeProvenance ? `created=${formatTime(memory.createdAt)} | source=${memory.source} | ` : "";
        return `${index + 1}. ${provenance}${memory.summary}${memory.details ? ` | ${memory.details}` : ""}`;
      })
    );
  }
  if (view.pendingPromotionCandidates.length > 0) {
    lines.push(
      "Pending memory outcomes:",
      ...view.pendingPromotionCandidates.map((candidate, index) => {
        const provenance = includeProvenance ? ` | id=${candidate.id} | created=${formatTime(candidate.createdAt)} | updated=${formatTime(candidate.updatedAt)}` : "";
        return `${index + 1}. ${candidate.projectLabel} | ${candidate.kind}${provenance} | ${candidate.summary}`;
      })
    );
  }
  if (view.warnings.length > 0) {
    lines.push("Warnings:", ...view.warnings.map((warning) => `- ${warning}`));
  }
  return lines.join("\n");
}
