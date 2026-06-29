import type { ButlerStateStore } from "./state-store.js";
import type {
  JobMemoryPromotionCandidateView,
  MemoryEmbeddingView,
  MemoryEntityView,
  MemoryGraphView,
  MemoryRelationshipView,
  MemoryRetrievalCandidateView,
  ProjectMemoryEntryView
} from "./types.js";

export function memoryGraphNodeKey(sourceKind: MemoryEmbeddingView["sourceKind"], sourceId: string): string {
  return `memory:${sourceKind}:${sourceId}`;
}

function normalizeText(value: string | null | undefined): string {
  return (value ?? "").replace(/\s+/g, " ").trim();
}

function normalizePredicate(value: string): string {
  return normalizeText(value).toLowerCase().replace(/[\s-]+/g, "_");
}

function tokenize(value: string | null | undefined): string[] {
  return [...new Set(normalizeText(value).toLowerCase().match(/[a-z0-9_:-]+/g) ?? [])].filter((entry) => entry.length > 1);
}

function textScore(text: string, query: string | null, tokens: string[]): number {
  const normalized = normalizeText(text).toLowerCase();
  if (!normalized) return 0;
  let score = 0;
  const phrase = normalizeText(query).toLowerCase();
  if (phrase && normalized.includes(phrase)) score += 4;
  for (const token of tokens) if (normalized.includes(token)) score += 0.5;
  return Math.min(4, score);
}

function relationshipTextScore(
  predicate: string,
  outgoing: boolean,
  text: string,
  query: string | null,
  tokens: string[]
): number {
  const score = textScore(text, query, tokens);
  if (score === 0) return 0;
  if (predicate === "supersedes") return outgoing ? score : 0;
  if (predicate === "contradicts") return outgoing ? score * 0.5 : 0;
  if (predicate === "supports" || predicate === "supported_by") return score * (outgoing ? 0.25 : 0.15);
  if (predicate === "depends_on") return outgoing ? score * 0.25 : 0;
  if (predicate === "possible_supersedes" || predicate === "possible_contradicts") return outgoing ? score * 0.2 : 0;
  if (predicate === "part_of" || predicate === "about_project" || predicate === "about_thread") return 0;
  return score * 0.2;
}

function entityText(entity: MemoryEntityView | null | undefined): string {
  if (!entity) return "";
  return [entity.type, entity.name, entity.canonicalKey, entity.summary, ...entity.aliases].filter(Boolean).join("\n");
}

function relationshipTrust(relationship: MemoryRelationshipView, predicate: string): number {
  const confidence = Math.max(0, Math.min(1, relationship.confidence));
  if (predicate === "possible_supersedes" || predicate === "possible_contradicts") return confidence * 0.2;
  if ((predicate === "supersedes" || predicate === "contradicts" || predicate === "supports") && relationship.sourceObservationId.startsWith("fallback:semantic-edge:")) {
    return confidence * 0.75;
  }
  if ((predicate === "supersedes" || predicate === "contradicts") && relationship.sourceObservationId.startsWith("deterministic:")) {
    return confidence * 0.25;
  }
  return confidence;
}

export type MemoryGraphRankingIndex = {
  graph: MemoryGraphView;
  entitiesById: Map<string, MemoryEntityView>;
  memoryEntitiesByKey: Map<string, MemoryEntityView>;
  relationshipsByEntityId: Map<string, MemoryRelationshipView[]>;
  projectEntriesByProjectId: Map<string, ProjectMemoryEntryView[]>;
  promotionCandidatesById: Map<string, JobMemoryPromotionCandidateView>;
  query: string | null;
  tokens: string[];
};

function memorySource(entity: MemoryEntityView | null | undefined): { sourceKind: MemoryEmbeddingView["sourceKind"]; sourceId: string } | null {
  const match = entity?.canonicalKey.match(/^memory:([^:]+):(.+)$/);
  if (!match) return null;
  const sourceKind = match[1];
  if (sourceKind !== "butler_memory" && sourceKind !== "project_memory" && sourceKind !== "job_memory" && sourceKind !== "promotion_candidate" && sourceKind !== "memory_observation") return null;
  return { sourceKind, sourceId: match[2] };
}

function memoryReference(entity: MemoryEntityView | null | undefined): string {
  const source = memorySource(entity);
  return source ? `${source.sourceKind}:${source.sourceId}` : entity?.name ?? entity?.id ?? "unknown";
}

function resolvingProjectEntryId(index: MemoryGraphRankingIndex, source: MemoryEntityView | null | undefined, target: MemoryEntityView | null | undefined): string | null {
  const sourceMemory = memorySource(source);
  const targetMemory = memorySource(target);
  if (sourceMemory?.sourceKind !== "project_memory" || targetMemory?.sourceKind !== "promotion_candidate") return null;
  const entries = index.projectEntriesByProjectId.get(sourceMemory.sourceId) ?? [];
  if (entries.length === 0) return null;
  const candidate = index.promotionCandidatesById.get(targetMemory.sourceId);
  const byThread = candidate ? entries.filter((entry) => entry.sourceThreadId === candidate.threadId) : [];
  const candidates = byThread.length > 0 ? byThread : entries;
  return candidates.reduce((latest, entry) => entry.acceptedAt > latest.acceptedAt ? entry : latest, candidates[0]).id;
}

function supersessionReference(index: MemoryGraphRankingIndex, source: MemoryEntityView | null | undefined, target: MemoryEntityView | null | undefined): string {
  const entryId = resolvingProjectEntryId(index, source, target);
  const sourceReference = memoryReference(source);
  const targetReference = memoryReference(target);
  return entryId ? `${sourceReference} entry:${entryId} supersedes ${targetReference}` : `${sourceReference} supersedes ${targetReference}`;
}

function relationshipLabel(relationship: MemoryRelationshipView, index: MemoryGraphRankingIndex): string {
  const source = index.entitiesById.get(relationship.sourceEntityId);
  const target = index.entitiesById.get(relationship.targetEntityId);
  if (normalizePredicate(relationship.predicate) === "supersedes") return supersessionReference(index, source, target);
  return `${memoryReference(source)} ${relationship.predicate} ${memoryReference(target)}`;
}

export function buildMemoryGraphRankingIndex(store: ButlerStateStore, query: string | null): MemoryGraphRankingIndex {
  const graph = store.listMemoryGraph();
  const entitiesById = new Map(graph.entities.map((entity) => [entity.id, entity]));
  const memoryEntitiesByKey = new Map(
    graph.entities
      .filter((entity) => entity.type === "memory" && entity.canonicalKey.startsWith("memory:"))
      .map((entity) => [entity.canonicalKey, entity])
  );
  const relationshipsByEntityId = new Map<string, MemoryRelationshipView[]>();
  for (const relationship of graph.relationships) {
    relationshipsByEntityId.set(relationship.sourceEntityId, [...(relationshipsByEntityId.get(relationship.sourceEntityId) ?? []), relationship]);
    relationshipsByEntityId.set(relationship.targetEntityId, [...(relationshipsByEntityId.get(relationship.targetEntityId) ?? []), relationship]);
  }
  const projectEntriesByProjectId = new Map(store.listProjectMemories().map((memory) => [memory.projectId, memory.entries]));
  const promotionCandidatesById = new Map(
    store.listJobMemories().flatMap((memory) => memory.promotionCandidates.map((candidate) => [candidate.id, candidate] as const))
  );
  return { graph, entitiesById, memoryEntitiesByKey, relationshipsByEntityId, projectEntriesByProjectId, promotionCandidatesById, query, tokens: tokenize(query) };
}

export function scoreMemoryGraphCandidate(
  index: MemoryGraphRankingIndex,
  candidate: Pick<MemoryRetrievalCandidateView, "sourceKind" | "sourceId">
): NonNullable<MemoryRetrievalCandidateView["graph"]> & { score: number } {
  const node = index.memoryEntitiesByKey.get(memoryGraphNodeKey(candidate.sourceKind as MemoryEmbeddingView["sourceKind"], candidate.sourceId)) ?? null;
  if (!node) return { nodeId: null, relations: [], contradictedBy: [], supersedes: [], supersededBy: [], score: 0 };

  let score = 0;
  const relations: string[] = [];
  const contradictedBy: string[] = [];
  const supersedes: string[] = [];
  const supersededBy: string[] = [];
  for (const relationship of index.relationshipsByEntityId.get(node.id) ?? []) {
    const predicate = normalizePredicate(relationship.predicate);
    const outgoing = relationship.sourceEntityId === node.id;
    const neighborId = outgoing ? relationship.targetEntityId : relationship.sourceEntityId;
    const neighbor = index.entitiesById.get(neighborId);
    const source = index.entitiesById.get(relationship.sourceEntityId);
    const target = index.entitiesById.get(relationship.targetEntityId);
    const label = relationshipLabel(relationship, index);
    const trust = relationshipTrust(relationship, predicate);
    relations.push(label);
    score += Math.min(1.5, trust) * 0.15;
    score += relationshipTextScore(predicate, outgoing, `${label}\n${entityText(neighbor)}`, index.query, index.tokens) * trust;
    if (predicate === "supports" || predicate === "supported_by") score += (outgoing ? 1.2 : 1.5) * trust;
    if (predicate === "depends_on" || predicate === "part_of" || predicate === "about_project" || predicate === "about_thread") score += 0.4 * trust;
    if (predicate === "possible_supersedes" || predicate === "possible_contradicts") score += 0.2 * trust;
    if (predicate === "supersedes") {
      if (outgoing) {
        score += 11 * trust;
        supersedes.push(supersessionReference(index, source, target));
      } else {
        score -= 18 * trust;
        supersededBy.push(supersessionReference(index, source, target));
      }
    }
    if (predicate === "contradicts") {
      if (outgoing) {
        score += 4 * trust;
      } else {
        score -= 10 * trust;
        contradictedBy.push(neighbor?.name ?? neighborId);
      }
    }
  }
  return { nodeId: node.id, relations: relations.slice(0, 12), contradictedBy, supersedes, supersededBy, score: Math.max(-14, Math.min(10, score)) };
}
