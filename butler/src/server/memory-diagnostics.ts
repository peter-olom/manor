import type { ButlerStateStore } from "./state-store.js";
import type {
  JobMemoryEntryKind,
  JobMemoryPromotionCandidateStatus,
  JobMemoryPromotionCandidateView,
  MemoryObservationSourceKind,
  MemoryObservationView,
  MemorySynthesisQueueEntryView,
  MemorySynthesisQueueStatus
} from "./types.js";

export type MemoryDiagnosticsInput = {
  projectId?: string | null;
  threadId?: string | null;
  from?: string | number | null;
  to?: string | number | null;
  includeSamples?: boolean;
  sampleLimit?: number | null;
  now?: number;
};

type CountMap = Record<string, number>;

type TimeWindow = {
  from: number | null;
  to: number | null;
  fromIso: string | null;
  toIso: string | null;
};

export type MemoryDiagnosticsView = {
  generatedAt: number;
  filters: {
    projectId: string | null;
    threadId: string | null;
    from: number | null;
    to: number | null;
    fromIso: string | null;
    toIso: string | null;
  };
  observations: {
    total: number;
    durable: number;
    bySourceKind: Record<MemoryObservationSourceKind, number>;
  };
  synthesis: {
    total: number;
    byStatus: Record<MemorySynthesisQueueStatus, number>;
    due: number;
    completedResults: number;
    failedWithError: number;
    oldestPendingAgeMs: number | null;
  };
  candidates: {
    total: number;
    byStatus: Record<JobMemoryPromotionCandidateStatus, number>;
    byKind: Record<JobMemoryEntryKind, number>;
    bySource: CountMap;
    resolvedInWindow: number;
    oldestPendingAgeMs: number | null;
  };
  jobMemoryEntries: {
    total: number;
    byKind: Record<JobMemoryEntryKind, number>;
  };
  projectMemory: {
    projects: number;
    acceptedEntries: number;
    byKind: Record<JobMemoryEntryKind, number>;
  };
  butlerMemory: {
    total: number;
    bySource: CountMap;
  };
  embeddings: {
    total: number;
    byModel: CountMap;
    stale: number;
  };
  graph: {
    entities: number;
    memoryNodes: number;
    relationships: number;
    byPredicate: CountMap;
    proposedSemanticEdges: number;
    confirmedSemanticEdges: number;
    modelReviewedPairs: number;
    contradicted: number;
    superseded: number;
    embeddingsMissingGraphNodes: number;
    graphNodesMissingEmbeddings: number;
    tasks: number;
    taskEvents: number;
  };
  samples?: {
    recentObservations: Array<{ id: string; sourceKind: string; summary: string; observedAt: number }>;
    recentSynthesis: Array<{ id: string; status: string; reason: string; updatedAt: number; lastError: string | null }>;
    recentCandidates: Array<{ id: string; status: string; kind: string; source: string; summary: string; updatedAt: number }>;
  };
  warnings: string[];
};

const ZERO_CANDIDATE_STATUS: Record<JobMemoryPromotionCandidateStatus, number> = { pending: 0, accepted: 0, rejected: 0 };
const ZERO_ENTRY_KIND: Record<JobMemoryEntryKind, number> = { checkpoint: 0, decision: 0, note: 0 };
const ZERO_SYNTHESIS_STATUS: Record<MemorySynthesisQueueStatus, number> = { pending: 0, running: 0, completed: 0, failed: 0, skipped: 0 };
const PENDING_WARNING_MS = 15 * 60 * 1_000;

function parseTimestamp(value: string | number | null | undefined): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  const raw = typeof value === "string" ? value.trim() : "";
  if (!raw) return null;
  const parsed = /^\d+$/.test(raw) ? Number(raw) : Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

function timeWindow(input: MemoryDiagnosticsInput): TimeWindow {
  const from = parseTimestamp(input.from);
  const to = parseTimestamp(input.to);
  return {
    from,
    to,
    fromIso: from === null ? null : new Date(from).toISOString(),
    toIso: to === null ? null : new Date(to).toISOString()
  };
}

function inWindow(timestamp: number | null | undefined, window: TimeWindow): boolean {
  if (typeof timestamp !== "number" || !Number.isFinite(timestamp)) return false;
  if (window.from !== null && timestamp < window.from) return false;
  return !(window.to !== null && timestamp > window.to);
}

function count<T extends string>(target: Record<T, number>, key: T): void {
  target[key] = (target[key] ?? 0) + 1;
}

function countLoose(target: CountMap, key: string): void {
  target[key] = (target[key] ?? 0) + 1;
}

function copyCounts<T extends string>(source: Record<T, number>): Record<T, number> {
  return { ...source };
}

function classifyCandidateSource(candidate: JobMemoryPromotionCandidateView): string {
  if (candidate.sourceEntryId.startsWith("worker-report:")) return "codex_report_review";
  if (candidate.sourceEntryId.startsWith("synthesis-fallback:")) return "synthesis_fallback";
  if (candidate.sourceEntryId.startsWith("synthesis:")) return "synthesis";
  if (candidate.sourceEntryId.startsWith("manual-")) return "manual";
  return "job_memory_entry";
}

function ageMs(timestamp: number | null | undefined, now: number): number | null {
  if (typeof timestamp !== "number" || !Number.isFinite(timestamp)) return null;
  return Math.max(0, now - timestamp);
}

function oldestAge(timestamps: number[], now: number): number | null {
  if (timestamps.length === 0) return null;
  return ageMs(Math.min(...timestamps), now);
}

function scopedProject(projectId: string | null, value: string): boolean {
  return !projectId || value === projectId;
}

function scopedThread(threadId: string | null, value: string | null): boolean {
  return !threadId || value === threadId;
}

function isDebugTraceObservation(observation: MemoryObservationView): boolean {
  return (observation.payload as { kind?: unknown }).kind === "memory_debug_trace";
}

function isSemanticEdgeReviewObservation(observation: MemoryObservationView): boolean {
  return (observation.payload as { kind?: unknown }).kind === "semantic_edge_review";
}

export function buildMemoryDiagnostics(store: ButlerStateStore, input: MemoryDiagnosticsInput = {}): MemoryDiagnosticsView {
  const now = typeof input.now === "number" && Number.isFinite(input.now) ? input.now : Date.now();
  const projectId = typeof input.projectId === "string" && input.projectId.trim() ? input.projectId.trim() : null;
  const threadId = typeof input.threadId === "string" && input.threadId.trim() ? input.threadId.trim() : null;
  const window = timeWindow(input);
  const graph = store.listMemoryGraph();
  const observations = graph.observations.filter(
    (entry) => !isDebugTraceObservation(entry) && scopedProject(projectId, entry.projectId) && scopedThread(threadId, entry.threadId) && inWindow(entry.observedAt, window)
  );
  const synthesisQueue = graph.synthesisQueue.filter(
    (entry) => scopedProject(projectId, entry.projectId) && scopedThread(threadId, entry.threadId) && inWindow(entry.createdAt, window)
  );
  const allJobs = store.listJobMemories().filter((entry) => scopedThread(threadId, entry.threadId));
  const jobs = allJobs.filter((entry) => scopedProject(projectId, entry.projectId));
  const candidates = allJobs
    .flatMap((job) => job.promotionCandidates)
    .filter((entry) => scopedProject(projectId, entry.projectId) && scopedThread(threadId, entry.threadId) && inWindow(entry.createdAt, window));
  const jobEntries = jobs.flatMap((job) => job.entries).filter((entry) => inWindow(entry.at, window));
  const projects = store.listProjectMemories().filter((entry) => scopedProject(projectId, entry.projectId));
  const projectEntries = projects.flatMap((project) => project.entries).filter((entry) => inWindow(entry.acceptedAt, window));
  const butlerMemory = threadId || projectId ? [] : store.listButlerMemory().filter((entry) => inWindow(entry.createdAt, window));

  const observationSources = {} as Record<MemoryObservationSourceKind, number>;
  for (const observation of observations) count(observationSources, observation.sourceKind);

  const synthesisStatus = copyCounts(ZERO_SYNTHESIS_STATUS);
  for (const entry of synthesisQueue) count(synthesisStatus, entry.status);

  const candidateStatus = copyCounts(ZERO_CANDIDATE_STATUS);
  const candidateKind = copyCounts(ZERO_ENTRY_KIND);
  const candidateSource: CountMap = {};
  for (const candidate of candidates) {
    count(candidateStatus, candidate.status);
    count(candidateKind, candidate.kind);
    countLoose(candidateSource, classifyCandidateSource(candidate));
  }

  const jobEntryKind = copyCounts(ZERO_ENTRY_KIND);
  for (const entry of jobEntries) count(jobEntryKind, entry.kind);

  const projectEntryKind = copyCounts(ZERO_ENTRY_KIND);
  for (const entry of projectEntries) count(projectEntryKind, entry.kind);

  const butlerMemorySource: CountMap = {};
  for (const entry of butlerMemory) countLoose(butlerMemorySource, entry.source);
  const embeddings = store.listMemoryEmbeddings();
  const embeddingModels: CountMap = {};
  for (const embedding of embeddings) countLoose(embeddingModels, embedding.model);

  const pendingCandidateAges = candidates.filter((entry) => entry.status === "pending").map((entry) => entry.createdAt);
  const pendingSynthesisAges = synthesisQueue.filter((entry) => entry.status === "pending" || entry.status === "running").map((entry) => entry.createdAt);
  const warnings = buildWarnings({ candidates, synthesisQueue, now });

  return {
    generatedAt: now,
    filters: { projectId, threadId, from: window.from, to: window.to, fromIso: window.fromIso, toIso: window.toIso },
    observations: {
      total: observations.length,
      durable: observations.filter((entry) => entry.durable).length,
      bySourceKind: observationSources
    },
    synthesis: {
      total: synthesisQueue.length,
      byStatus: synthesisStatus,
      due: synthesisQueue.filter((entry) => entry.status === "pending" && entry.runAfter <= now).length,
      completedResults: observations.filter((entry) => entry.sourceKind === "synthesis_result").length,
      failedWithError: synthesisQueue.filter((entry) => entry.status === "failed" && Boolean(entry.lastError)).length,
      oldestPendingAgeMs: oldestAge(pendingSynthesisAges, now)
    },
    candidates: {
      total: candidates.length,
      byStatus: candidateStatus,
      byKind: candidateKind,
      bySource: candidateSource,
      resolvedInWindow: allJobs
        .flatMap((job) => job.promotionCandidates)
        .filter((entry) => scopedProject(projectId, entry.projectId) && scopedThread(threadId, entry.threadId) && inWindow(entry.resolvedAt, window)).length,
      oldestPendingAgeMs: oldestAge(pendingCandidateAges, now)
    },
    jobMemoryEntries: {
      total: jobEntries.length,
      byKind: jobEntryKind
    },
    projectMemory: {
      projects: projects.length,
      acceptedEntries: projectEntries.length,
      byKind: projectEntryKind
    },
    butlerMemory: {
      total: butlerMemory.length,
      bySource: butlerMemorySource
    },
    embeddings: {
      total: embeddings.length,
      byModel: embeddingModels,
      stale: countStaleEmbeddings(store, embeddings)
    },
    graph: buildGraphCounts(graph, embeddings, projectId, threadId, window),
    ...(input.includeSamples === true ? { samples: buildSamples(observations, synthesisQueue, candidates, input.sampleLimit) } : {}),
    warnings
  };
}

function countStaleEmbeddings(store: ButlerStateStore, embeddings: ReturnType<ButlerStateStore["listMemoryEmbeddings"]>): number {
  let stale = 0;
  for (const embedding of embeddings) {
    if (embedding.sourceKind === "butler_memory" && !store.listButlerMemory().some((entry) => entry.id === embedding.sourceId)) stale += 1;
    if (embedding.sourceKind === "project_memory" && !store.getProjectMemory(embedding.sourceId)) stale += 1;
    if (embedding.sourceKind === "job_memory" && !store.getJobMemory(embedding.sourceId)) stale += 1;
    if (embedding.sourceKind === "promotion_candidate" && !store.listJobMemories().some((memory) => memory.promotionCandidates.some((candidate) => candidate.id === embedding.sourceId))) stale += 1;
  }
  return stale;
}

function buildWarnings(input: {
  candidates: JobMemoryPromotionCandidateView[];
  synthesisQueue: MemorySynthesisQueueEntryView[];
  now: number;
}): string[] {
  const warnings: string[] = [];
  const failed = input.synthesisQueue.filter((entry) => entry.status === "failed");
  if (failed.length > 0) warnings.push(`${failed.length} synthesis queue entr${failed.length === 1 ? "y has" : "ies have"} failed.`);
  const stalePending = input.synthesisQueue.filter(
    (entry) => (entry.status === "pending" || entry.status === "running") && input.now - entry.createdAt > PENDING_WARNING_MS
  );
  if (stalePending.length > 0) warnings.push(`${stalePending.length} synthesis queue entr${stalePending.length === 1 ? "y is" : "ies are"} older than 15 minutes.`);
  const pendingCandidates = input.candidates.filter((entry) => entry.status === "pending" && input.now - entry.createdAt > PENDING_WARNING_MS);
  if (pendingCandidates.length > 0) warnings.push(`${pendingCandidates.length} promotion candidate${pendingCandidates.length === 1 ? " is" : "s are"} older than 15 minutes.`);
  return warnings;
}

function buildGraphCounts(
  graph: ReturnType<ButlerStateStore["listMemoryGraph"]>,
  embeddings: ReturnType<ButlerStateStore["listMemoryEmbeddings"]>,
  projectId: string | null,
  threadId: string | null,
  window: TimeWindow
): MemoryDiagnosticsView["graph"] {
  const tasks = graph.tasks.filter((entry) => scopedProject(projectId, entry.projectId) && scopedThread(threadId, entry.threadId) && inWindow(entry.createdAt, window));
  const taskIds = new Set(tasks.map((entry) => entry.id));
  const entities = graph.entities.filter((entry) => scopedProject(projectId, entry.projectId) && inWindow(entry.createdAt, window));
  const relationships = graph.relationships.filter((entry) => scopedProject(projectId, entry.projectId) && inWindow(entry.createdAt, window));
  const byPredicate: CountMap = {};
  for (const relationship of relationships) countLoose(byPredicate, relationship.predicate);
  const memoryNodes = entities.filter((entry) => entry.type === "memory");
  const memoryNodeKeys = new Set(memoryNodes.map((entry) => entry.canonicalKey));
  const embeddingKeys = new Set(embeddings.filter((entry) => scopedProject(projectId, entry.projectId ?? "global")).map((entry) => `memory:${entry.sourceKind}:${entry.sourceId}`));
  const proposedSemanticEdges = relationships.filter((entry) => entry.predicate === "possible_supersedes" || entry.predicate === "possible_contradicts").length;
  const confirmedSemanticEdges = relationships.filter(
    (entry) => ["supports", "supersedes", "contradicts"].includes(entry.predicate) && entry.sourceObservationId.startsWith("model:semantic-edge:")
  ).length;
  return {
    entities: entities.length,
    memoryNodes: memoryNodes.length,
    relationships: relationships.length,
    byPredicate,
    proposedSemanticEdges,
    confirmedSemanticEdges,
    modelReviewedPairs: graph.observations.filter((entry) =>
      scopedProject(projectId, entry.projectId) &&
      scopedThread(threadId, entry.threadId) &&
      inWindow(entry.observedAt, window) &&
      isSemanticEdgeReviewObservation(entry)
    ).length,
    contradicted: relationships.filter((entry) => entry.predicate === "contradicts").length,
    superseded: relationships.filter((entry) => entry.predicate === "supersedes").length,
    embeddingsMissingGraphNodes: [...embeddingKeys].filter((key) => !memoryNodeKeys.has(key)).length,
    graphNodesMissingEmbeddings: [...memoryNodeKeys].filter((key) => !embeddingKeys.has(key)).length,
    tasks: tasks.length,
    taskEvents: graph.taskEvents.filter((entry) => taskIds.has(entry.taskId) && inWindow(entry.at, window)).length
  };
}

function normalizedSampleLimit(limit?: number | null): number {
  return typeof limit === "number" && Number.isFinite(limit) ? Math.max(1, Math.min(50, Math.trunc(limit))) : 5;
}

function buildSamples(
  observations: MemoryObservationView[],
  synthesisQueue: MemorySynthesisQueueEntryView[],
  candidates: JobMemoryPromotionCandidateView[],
  limit?: number | null
): NonNullable<MemoryDiagnosticsView["samples"]> {
  const sampleLimit = normalizedSampleLimit(limit);
  return {
    recentObservations: [...observations]
      .sort((left, right) => right.observedAt - left.observedAt)
      .slice(0, sampleLimit)
      .map((entry) => ({ id: entry.id, sourceKind: entry.sourceKind, summary: entry.summary, observedAt: entry.observedAt })),
    recentSynthesis: [...synthesisQueue]
      .sort((left, right) => right.updatedAt - left.updatedAt)
      .slice(0, sampleLimit)
      .map((entry) => ({ id: entry.id, status: entry.status, reason: entry.reason, updatedAt: entry.updatedAt, lastError: entry.lastError })),
    recentCandidates: [...candidates]
      .sort((left, right) => right.updatedAt - left.updatedAt)
      .slice(0, sampleLimit)
      .map((entry) => ({
        id: entry.id,
        status: entry.status,
        kind: entry.kind,
        source: classifyCandidateSource(entry),
        summary: entry.summary,
        updatedAt: entry.updatedAt
      }))
  };
}

function formatCounts(counts: CountMap): string {
  const entries = Object.entries(counts)
    .filter(([, value]) => value > 0)
    .sort(([left], [right]) => left.localeCompare(right));
  return entries.length === 0 ? "none" : entries.map(([key, value]) => `${key}=${value}`).join(", ");
}

function formatAge(ms: number | null): string {
  if (ms === null) return "none";
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

export function formatMemoryDiagnostics(view: MemoryDiagnosticsView): string {
  const scope = [
    view.filters.projectId ? `project=${view.filters.projectId}` : null,
    view.filters.threadId ? `thread=${view.filters.threadId}` : null,
    view.filters.fromIso ? `from=${view.filters.fromIso}` : null,
    view.filters.toIso ? `to=${view.filters.toIso}` : null
  ]
    .filter(Boolean)
    .join(" | ");
  return [
    `Memory diagnostics${scope ? ` (${scope})` : ""}`,
    `Observations: total=${view.observations.total}, durable=${view.observations.durable}, sources=${formatCounts(view.observations.bySourceKind)}`,
    `Synthesis: total=${view.synthesis.total}, statuses=${formatCounts(view.synthesis.byStatus)}, due=${view.synthesis.due}, completed_results=${view.synthesis.completedResults}, failed_with_error=${view.synthesis.failedWithError}, oldest_pending=${formatAge(view.synthesis.oldestPendingAgeMs)}`,
    `Candidates: total=${view.candidates.total}, statuses=${formatCounts(view.candidates.byStatus)}, kinds=${formatCounts(view.candidates.byKind)}, sources=${formatCounts(view.candidates.bySource)}, resolved_in_window=${view.candidates.resolvedInWindow}, oldest_pending=${formatAge(view.candidates.oldestPendingAgeMs)}`,
    `Job entries: total=${view.jobMemoryEntries.total}, kinds=${formatCounts(view.jobMemoryEntries.byKind)}`,
    `Project memory: projects=${view.projectMemory.projects}, accepted_entries=${view.projectMemory.acceptedEntries}, kinds=${formatCounts(view.projectMemory.byKind)}`,
    `Butler memory: total=${view.butlerMemory.total}, sources=${formatCounts(view.butlerMemory.bySource)}`,
    `Embeddings: total=${view.embeddings.total}, models=${formatCounts(view.embeddings.byModel)}, stale=${view.embeddings.stale}`,
    `Graph: entities=${view.graph.entities}, memory_nodes=${view.graph.memoryNodes}, relationships=${view.graph.relationships}, predicates=${formatCounts(view.graph.byPredicate)}, proposed_semantic_edges=${view.graph.proposedSemanticEdges}, confirmed_semantic_edges=${view.graph.confirmedSemanticEdges}, model_reviewed_pairs=${view.graph.modelReviewedPairs}, contradicted=${view.graph.contradicted}, superseded=${view.graph.superseded}, embeddings_missing_graph_nodes=${view.graph.embeddingsMissingGraphNodes}, graph_nodes_missing_embeddings=${view.graph.graphNodesMissingEmbeddings}, tasks=${view.graph.tasks}, task_events=${view.graph.taskEvents}`,
    view.warnings.length > 0 ? `Warnings: ${view.warnings.join(" ")}` : "Warnings: none"
  ].join("\n");
}
