import { memoryGraphNodeKey } from "./memory-graph-ranking.js";
import type { ButlerStateStore } from "./state-store.js";
import type { JobMemoryPromotionCandidateView, MemoryEmbeddingView, MemoryEntityView, ProjectMemoryEntryView } from "./types.js";

export type MemoryGraphNodeInput = {
  sourceKind: MemoryEmbeddingView["sourceKind"];
  sourceId: string;
  text: string;
  memoryType: string;
  projectId: string | null;
  threadId: string | null;
  sourceObservationId?: string | null;
};

function titleFromText(text: string, fallback: string): string {
  return text.split(/\r?\n/).map((entry) => entry.trim()).find(Boolean)?.slice(0, 160) || fallback;
}

export function ensureMemoryGraphNode(store: ButlerStateStore, input: MemoryGraphNodeInput): string {
  const projectId = input.projectId ?? "global";
  const sourceObservationId = input.sourceObservationId || memoryGraphNodeKey(input.sourceKind, input.sourceId);
  const memory = store.upsertMemoryEntity({
    projectId,
    type: "memory",
    name: titleFromText(input.text, `${input.sourceKind}:${input.sourceId}`),
    canonicalKey: memoryGraphNodeKey(input.sourceKind, input.sourceId),
    aliases: [input.sourceId, input.sourceKind, input.memoryType],
    summary: input.text.slice(0, 500),
    sourceObservationId
  });
  if (input.projectId) {
    const project = store.upsertMemoryEntity({
      projectId,
      type: "project",
      name: input.projectId,
      canonicalKey: `project:${input.projectId}`,
      sourceObservationId
    });
    store.upsertMemoryRelationship({
      projectId,
      sourceEntityId: memory.id,
      predicate: "about_project",
      targetEntityId: project.id,
      sourceObservationId,
      confidence: 1
    });
  }
  if (input.threadId) {
    const thread = store.upsertMemoryEntity({
      projectId,
      type: "thread",
      name: `Thread ${input.threadId}`,
      canonicalKey: `thread:${input.threadId}`,
      sourceObservationId
    });
    store.upsertMemoryRelationship({
      projectId,
      sourceEntityId: memory.id,
      predicate: "about_thread",
      targetEntityId: thread.id,
      sourceObservationId,
      confidence: 1
    });
  }
  return memory.id;
}

function memoryNode(entities: MemoryEntityView[], sourceKind: MemoryEmbeddingView["sourceKind"], sourceId: string): MemoryEntityView | null {
  return entities.find((entry) => entry.type === "memory" && entry.canonicalKey === memoryGraphNodeKey(sourceKind, sourceId)) ?? null;
}

function tokenize(value: string | null | undefined): string[] {
  return [...new Set((value ?? "").toLowerCase().match(/[a-z0-9_:-]+/g) ?? [])].filter((entry) => entry.length > 2);
}

function relatedEnough(entry: ProjectMemoryEntryView, candidate: JobMemoryPromotionCandidateView): boolean {
  const accepted = tokenize([entry.summary, entry.details].filter(Boolean).join(" "));
  const proposed = new Set(tokenize([candidate.summary, candidate.details].filter(Boolean).join(" ")));
  if (accepted.length === 0 || proposed.size === 0) return true;
  const overlap = accepted.filter((token) => proposed.has(token)).length;
  const threshold = entry.kind === candidate.kind ? 0.25 : 0.2;
  return overlap / Math.min(accepted.length, proposed.size) >= threshold;
}

export function ensureDeterministicMemoryGraphEdges(store: ButlerStateStore): number {
  let created = 0;
  const entities = () => store.listMemoryGraph().entities;
  for (const job of store.listJobMemories()) {
    const jobNode = memoryNode(entities(), "job_memory", job.threadId);
    if (!jobNode) continue;
    for (const candidate of job.promotionCandidates) {
      const candidateNode = memoryNode(entities(), "promotion_candidate", candidate.id);
      if (!candidateNode) continue;
      store.upsertMemoryRelationship({
        projectId: candidate.projectId,
        sourceEntityId: candidateNode.id,
        predicate: "depends_on",
        targetEntityId: jobNode.id,
        sourceObservationId: `deterministic:candidate:${candidate.id}:depends_on:${job.threadId}`,
        confidence: 0.9
      });
      created += 1;
    }
  }

  for (const project of store.listProjectMemories()) {
    const projectNode = memoryNode(entities(), "project_memory", project.projectId);
    if (!projectNode) continue;
    for (const entry of project.entries) {
      const job = store.getJobMemory(entry.sourceThreadId);
      const jobNode = job ? memoryNode(entities(), "job_memory", job.threadId) : null;
      if (jobNode) {
        store.upsertMemoryRelationship({
          projectId: project.projectId,
          sourceEntityId: jobNode.id,
          predicate: "supports",
          targetEntityId: projectNode.id,
          sourceObservationId: `deterministic:project:${project.projectId}:supports:${entry.id}`,
          confidence: 0.95
        });
        created += 1;
      }
      for (const candidate of job?.promotionCandidates ?? []) {
        if (candidate.projectId !== project.projectId || candidate.status === "accepted" || !relatedEnough(entry, candidate)) continue;
        const candidateNode = memoryNode(entities(), "promotion_candidate", candidate.id);
        if (!candidateNode) continue;
        const sourceObservationId = `deterministic:project:${project.projectId}:supersedes:${candidate.id}:${entry.id}`;
        store.upsertMemoryRelationship({
          projectId: project.projectId,
          sourceEntityId: projectNode.id,
          predicate: "supersedes",
          targetEntityId: candidateNode.id,
          sourceObservationId,
          confidence: 1
        });
        store.upsertMemoryRelationship({
          projectId: project.projectId,
          sourceEntityId: projectNode.id,
          predicate: "contradicts",
          targetEntityId: candidateNode.id,
          sourceObservationId,
          confidence: 1
        });
        created += 2;
      }
    }
  }
  return created;
}
