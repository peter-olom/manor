import type { ButlerStateStore } from "./state-store.js";
import type {
  ButlerMemoryEntryView,
  ButlerMemoryRetrievalView,
  JobMemoryView,
  ProjectMemoryView
} from "./types.js";

type RetrievalInput = {
  projectId?: string | null;
  threadId?: string | null;
  query?: string | null;
  limit?: number | null;
  includeGlobal?: boolean | null;
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
  return [
    memory.operatorGoal,
    memory.requestedTask,
    memory.latestCheckpoint,
    memory.nextAction,
    ...memory.currentPlan,
    ...memory.blockers,
    ...memory.assumptions,
    ...memory.proofRequirements,
    ...memory.notes,
    ...memory.decisions.flatMap((entry) => [entry.summary, entry.details]),
    ...memory.entries.flatMap((entry) => [
      entry.summary,
      entry.details,
      entry.nextAction,
      ...entry.blockers,
      ...entry.plan,
      ...entry.assumptions,
      ...entry.proofRequirements
    ]),
    ...memory.promotionCandidates.flatMap((entry) => [entry.summary, entry.details, entry.status])
  ]
    .filter((entry): entry is string => typeof entry === "string" && Boolean(entry.trim()))
    .join("\n");
}

function projectMemoryText(memory: ProjectMemoryView): string {
  return [
    memory.summary,
    ...memory.entries.flatMap((entry) => [entry.kind, entry.summary, entry.details])
  ]
    .filter((entry): entry is string => typeof entry === "string" && Boolean(entry.trim()))
    .join("\n");
}

function butlerMemoryText(memory: ButlerMemoryEntryView): string {
  return [memory.summary, memory.details, ...memory.tags].filter((entry): entry is string => typeof entry === "string" && Boolean(entry.trim())).join("\n");
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
  const jobMemories = rankByQuery(jobCandidates, query, jobMemoryText, (memory) => memory.updatedAt).slice(0, limit);

  const butlerMemories = input.includeGlobal
    ? rankByQuery(store.listButlerMemory(), query, butlerMemoryText, (memory) => memory.createdAt).slice(0, limit)
    : [];
  const pendingPromotionCandidates = store.listPendingPromotionCandidates(projectId).slice(0, limit);

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
    projectRollups,
    jobMemories,
    butlerMemories,
    pendingPromotionCandidates,
    warnings,
    retrievedAt: Date.now()
  };
}

export function formatButlerMemoryRetrieval(view: ButlerMemoryRetrievalView): string {
  const lines = [
    `Memory retrieval | project=${view.projectId ?? "any"} | job=${view.threadId ?? "any"} | query=${view.query ?? "none"}`
  ];
  if (view.projectRollups.length > 0) {
    lines.push(
      "Project rollups:",
      ...view.projectRollups.map((memory, index) => {
        const recentEntries = memory.entries.slice(-3).map((entry) => `${entry.kind}: ${entry.summary}`).join(" | ");
        return `${index + 1}. ${memory.projectLabel} | ${memory.summary ?? "No summary"}${recentEntries ? ` | recent=${recentEntries}` : ""}`;
      })
    );
  }
  if (view.jobMemories.length > 0) {
    lines.push(
      "Job memories:",
      ...view.jobMemories.map((memory, index) =>
        `${index + 1}. ${memory.projectLabel} | job=${memory.threadId} | checkpoint=${memory.latestCheckpoint ?? "none"} | next=${memory.nextAction ?? "none"} | blockers=${memory.blockers.join(" | ") || "none"}`
      )
    );
  }
  if (view.butlerMemories.length > 0) {
    lines.push("Global Butler memories:", ...view.butlerMemories.map((memory, index) => `${index + 1}. ${memory.summary}${memory.details ? ` | ${memory.details}` : ""}`));
  }
  if (view.pendingPromotionCandidates.length > 0) {
    lines.push(
      "Pending memory outcomes:",
      ...view.pendingPromotionCandidates.map((candidate, index) => `${index + 1}. ${candidate.projectLabel} | ${candidate.kind} | ${candidate.summary}`)
    );
  }
  if (view.warnings.length > 0) {
    lines.push("Warnings:", ...view.warnings.map((warning) => `- ${warning}`));
  }
  return lines.join("\n");
}
