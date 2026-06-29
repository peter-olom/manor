import type { ButlerMemoryEntryView, JobMemoryPromotionCandidateView, JobMemoryView, ProjectMemoryView } from "./types.js";

export function projectMemoryTextForEmbedding(memory: ProjectMemoryView): string {
  return [
    memory.summary,
    ...memory.entries.flatMap((entry) => [entry.kind, entry.summary, entry.details])
  ]
    .filter((entry): entry is string => typeof entry === "string" && Boolean(entry.trim()))
    .join("\n");
}

export function butlerMemoryTextForEmbedding(memory: ButlerMemoryEntryView): string {
  return [memory.summary, memory.details, ...memory.tags]
    .filter((entry): entry is string => typeof entry === "string" && Boolean(entry.trim()))
    .join("\n");
}

export function jobMemoryTextForEmbedding(memory: JobMemoryView): string {
  return [
    memory.operatorGoal,
    memory.requestedTask,
    memory.latestCheckpoint,
    memory.nextAction,
    ...memory.blockers,
    ...memory.assumptions,
    ...memory.proofRequirements,
    ...memory.notes,
    ...memory.decisions.flatMap((entry) => [entry.summary, entry.details]),
    ...memory.entries.flatMap((entry) => [entry.kind, entry.summary, entry.details, entry.nextAction, ...entry.blockers, ...entry.plan]),
    ...memory.promotionCandidates.flatMap((entry) => [entry.kind, entry.summary, entry.details, entry.status])
  ]
    .filter((entry): entry is string => typeof entry === "string" && Boolean(entry.trim()))
    .join("\n");
}

export function promotionCandidateTextForEmbedding(candidate: JobMemoryPromotionCandidateView): string {
  return [candidate.kind, candidate.summary, candidate.details, candidate.status]
    .filter((entry): entry is string => typeof entry === "string" && Boolean(entry.trim()))
    .join("\n");
}
