import type { ButlerStateStore } from "./state-store.js";
import {
  encodeFloat32Vector,
  hashEmbeddingText,
  type MemoryEmbeddingConfig,
  type MemoryEmbeddingProvider
} from "./memory-embedding-client.js";
import { butlerMemoryTextForEmbedding, jobMemoryTextForEmbedding, projectMemoryTextForEmbedding, promotionCandidateTextForEmbedding } from "./memory-embedding-text.js";
import { ensureDeterministicMemoryGraphEdges, ensureMemoryGraphNode } from "./memory-graph-nodes.js";
import { isAcceptedOperatorPreferenceMemory } from "./memory-metadata.js";
import type { ButlerMemoryType, MemoryEmbeddingView } from "./types.js";

type EmbeddableMemory = {
  sourceKind: MemoryEmbeddingView["sourceKind"];
  sourceId: string;
  text: string;
  memoryType: ButlerMemoryType;
  projectId: string | null;
  threadId: string | null;
  provenance: Record<string, unknown>;
  contentVersion: number;
};

export type MemoryEmbeddingBackfillResult = {
  considered: number;
  embedded: number;
  skippedFresh: number;
  failed: number;
  warnings: string[];
};

export function collectEmbeddableMemories(store: ButlerStateStore): EmbeddableMemory[] {
  const projectMemories = store.listProjectMemories()
    .filter((memory) => memory.entries.length > 0 || Boolean(memory.summary))
    .map((memory): EmbeddableMemory => ({
      sourceKind: "project_memory",
      sourceId: memory.projectId,
      text: projectMemoryTextForEmbedding(memory),
      memoryType: "project_fact",
      projectId: memory.projectId,
      threadId: null,
      provenance: { projectLabel: memory.projectLabel, entryCount: memory.entries.length },
      contentVersion: memory.updatedAt
    }));
  const operatorPreferences = store.listButlerMemory()
    .filter((entry) => isAcceptedOperatorPreferenceMemory(entry))
    .map((entry): EmbeddableMemory => ({
      sourceKind: "butler_memory",
      sourceId: entry.id,
      text: butlerMemoryTextForEmbedding(entry),
      memoryType: "operator_preference",
      projectId: entry.projectId ?? null,
      threadId: entry.threadId ?? null,
      provenance: { source: entry.source, sourceMessageId: entry.sourceMessageId },
      contentVersion: entry.contentVersion ?? 1
    }));
  const jobMemories = store.listJobMemories()
    .filter((memory) => memory.entries.length > 0 || memory.promotionCandidates.length > 0 || Boolean(memory.latestCheckpoint))
    .map((memory): EmbeddableMemory => ({
      sourceKind: "job_memory",
      sourceId: memory.threadId,
      text: jobMemoryTextForEmbedding(memory),
      memoryType: "thread_fact",
      projectId: memory.projectId,
      threadId: memory.threadId,
      provenance: { projectLabel: memory.projectLabel, entryCount: memory.entries.length, promotionCandidateCount: memory.promotionCandidates.length },
      contentVersion: memory.updatedAt
    }));
  const promotionCandidates = store.listJobMemories()
    .flatMap((memory) => memory.promotionCandidates.map((candidate): EmbeddableMemory => ({
      sourceKind: "promotion_candidate",
      sourceId: candidate.id,
      text: promotionCandidateTextForEmbedding(candidate),
      memoryType: "project_fact",
      projectId: candidate.projectId,
      threadId: candidate.threadId,
      provenance: { status: candidate.status, kind: candidate.kind, sourceEntryId: candidate.sourceEntryId },
      contentVersion: candidate.updatedAt
    })));
  return [...projectMemories, ...jobMemories, ...promotionCandidates, ...operatorPreferences].filter((entry) => entry.text.trim());
}

export async function backfillMemoryEmbeddings(input: {
  store: ButlerStateStore;
  config: MemoryEmbeddingConfig;
  provider: MemoryEmbeddingProvider;
  batchSize?: number;
}): Promise<MemoryEmbeddingBackfillResult> {
  const result: MemoryEmbeddingBackfillResult = { considered: 0, embedded: 0, skippedFresh: 0, failed: 0, warnings: [] };
  if (!input.config.enabled) {
    result.warnings.push("memory embeddings disabled");
    return result;
  }
  const existing = input.store.listMemoryEmbeddings();
  const memories = collectEmbeddableMemories(input.store);
  result.considered = memories.length;
  for (const memory of memories) {
    ensureMemoryGraphNode(input.store, {
      sourceKind: memory.sourceKind,
      sourceId: memory.sourceId,
      text: memory.text,
      memoryType: memory.memoryType,
      projectId: memory.projectId,
      threadId: memory.threadId
    });
  }
  ensureDeterministicMemoryGraphEdges(input.store);
  const stale = memories.filter((memory) => {
    const hash = hashEmbeddingText(memory.text);
    const fresh = existing.some((entry) =>
      entry.sourceKind === memory.sourceKind &&
      entry.sourceId === memory.sourceId &&
      entry.sourceTextHash === hash &&
      entry.model === input.config.model
    );
    if (fresh) result.skippedFresh += 1;
    return !fresh;
  });
  const batchSize = Math.max(1, Math.min(32, Math.trunc(input.batchSize ?? 12)));
  for (let index = 0; index < stale.length; index += batchSize) {
    const batch = stale.slice(index, index + batchSize);
    try {
      const vectors = await input.provider.embed(batch.map((entry) => entry.text));
      for (const [offset, memory] of batch.entries()) {
        const vector = vectors[offset] ?? [];
        if (vector.length === 0) {
          result.failed += 1;
          result.warnings.push(`empty embedding for ${memory.sourceKind}:${memory.sourceId}`);
          continue;
        }
        input.store.upsertMemoryEmbedding({
          sourceKind: memory.sourceKind,
          sourceId: memory.sourceId,
          sourceTextHash: hashEmbeddingText(memory.text),
          model: input.config.model,
          modelTag: input.config.model,
          dimension: vector.length,
          vectorBase64: encodeFloat32Vector(vector),
          memoryType: memory.memoryType,
          projectId: memory.projectId,
          threadId: memory.threadId,
          provenance: memory.provenance,
          contentVersion: memory.contentVersion
        });
        result.embedded += 1;
      }
    } catch (error) {
      result.failed += batch.length;
      result.warnings.push(error instanceof Error ? error.message : String(error));
    }
  }
  return result;
}
