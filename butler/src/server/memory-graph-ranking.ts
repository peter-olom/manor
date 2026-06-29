import type { ButlerStateStore } from "./state-store.js";
import type {
  MemoryEmbeddingView,
  MemoryEntityView,
  MemoryGraphView,
  MemoryRelationshipView,
  MemoryRetrievalCandidateView
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

function relationshipLabel(relationship: MemoryRelationshipView, entitiesById: Map<string, MemoryEntityView>): string {
  const source = entitiesById.get(relationship.sourceEntityId)?.name ?? relationship.sourceEntityId;
  const target = entitiesById.get(relationship.targetEntityId)?.name ?? relationship.targetEntityId;
  return `${source} ${relationship.predicate} ${target}`;
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
  query: string | null;
  tokens: string[];
};

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
  return { graph, entitiesById, memoryEntitiesByKey, relationshipsByEntityId, query, tokens: tokenize(query) };
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
    const label = relationshipLabel(relationship, index.entitiesById);
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
        supersedes.push(neighbor?.name ?? neighborId);
      } else {
        score -= 18 * trust;
        supersededBy.push(neighbor?.name ?? neighborId);
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
