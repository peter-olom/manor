import crypto from "node:crypto";

import {
  emitStateStoreChange,
  queueStateStoreSave,
  type StateStoreInternalAccess
} from "./state-store-internals.js";
import { normalizeButlerMemoryType } from "./memory-metadata.js";
import type { MemoryEmbeddingView } from "./types.js";

type UpsertMemoryEmbeddingInput = Omit<MemoryEmbeddingView, "id" | "createdAt" | "embeddedAt"> & {
  id?: string;
  createdAt?: number;
  embeddedAt?: number;
};

function clean(value: string | null | undefined): string {
  return (value ?? "").replace(/\s+/g, " ").trim();
}

function embeddingId(input: Pick<MemoryEmbeddingView, "sourceKind" | "sourceId" | "model" | "sourceTextHash">): string {
  return `emb-${crypto.createHash("sha256").update(`${input.sourceKind}:${input.sourceId}:${input.model}:${input.sourceTextHash}`).digest("hex").slice(0, 24)}`;
}

function normalizeEmbedding(input: UpsertMemoryEmbeddingInput): MemoryEmbeddingView {
  const sourceKind = input.sourceKind === "project_memory" || input.sourceKind === "job_memory" || input.sourceKind === "promotion_candidate" || input.sourceKind === "memory_observation"
    ? input.sourceKind
    : "butler_memory";
  const sourceId = clean(input.sourceId);
  const sourceTextHash = clean(input.sourceTextHash);
  const model = clean(input.model);
  const modelTag = clean(input.modelTag) || model;
  if (!sourceId || !sourceTextHash || !model || !modelTag) {
    throw new Error("memory embedding requires sourceId, sourceTextHash, model, and modelTag");
  }
  const now = Date.now();
  return {
    id: clean(input.id) || embeddingId({ sourceKind, sourceId, model, sourceTextHash }),
    sourceKind,
    sourceId,
    sourceTextHash,
    model,
    modelTag,
    dimension: Math.max(1, Math.trunc(input.dimension)),
    vectorBase64: clean(input.vectorBase64),
    memoryType: normalizeButlerMemoryType(input.memoryType),
    projectId: clean(input.projectId) || null,
    threadId: clean(input.threadId) || null,
    provenance: input.provenance && typeof input.provenance === "object" && !Array.isArray(input.provenance) ? { ...input.provenance } : {},
    contentVersion: Math.max(1, Math.trunc(input.contentVersion || 1)),
    createdAt: typeof input.createdAt === "number" && Number.isFinite(input.createdAt) ? input.createdAt : now,
    embeddedAt: typeof input.embeddedAt === "number" && Number.isFinite(input.embeddedAt) ? input.embeddedAt : now
  };
}

export function listStateStoreMemoryEmbeddings(access: StateStoreInternalAccess): MemoryEmbeddingView[] {
  return [...access.persistedMemoryEmbeddingsById.values()]
    .map((entry) => ({ ...entry, provenance: { ...entry.provenance } }))
    .sort((left, right) => right.embeddedAt - left.embeddedAt);
}

export function upsertStateStoreMemoryEmbedding(access: StateStoreInternalAccess, input: UpsertMemoryEmbeddingInput): MemoryEmbeddingView {
  const embedding = normalizeEmbedding(input);
  access.persistedMemoryEmbeddingsById.set(embedding.id, embedding);
  queueStateStoreSave(access);
  emitStateStoreChange(access);
  return { ...embedding, provenance: { ...embedding.provenance } };
}

export function deleteStateStoreMemoryEmbeddingsForSource(
  access: StateStoreInternalAccess,
  sourceKind: MemoryEmbeddingView["sourceKind"],
  sourceId: string
): number {
  let deleted = 0;
  for (const [id, embedding] of access.persistedMemoryEmbeddingsById.entries()) {
    if (embedding.sourceKind === sourceKind && embedding.sourceId === sourceId) {
      access.persistedMemoryEmbeddingsById.delete(id);
      deleted += 1;
    }
  }
  if (deleted > 0) {
    queueStateStoreSave(access);
    emitStateStoreChange(access);
  }
  return deleted;
}
