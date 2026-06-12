import crypto from "node:crypto";

import {
  emitStateStoreChange,
  queueStateStoreSave,
  type StateStoreInternalAccess
} from "./state-store-internals.js";
import type {
  MemoryEntityType,
  MemoryEntityView,
  MemoryGraphRetrievalView,
  MemoryGraphView,
  MemoryObservationSourceKind,
  MemoryObservationView,
  MemoryRelationshipView,
  MemorySynthesisPriority,
  MemorySynthesisQueueEntryView,
  MemoryTaskStatus,
  MemoryTaskEventView,
  MemoryTaskView
} from "./types.js";

type ObservationInput = {
  idempotencyKey: string;
  projectId?: string | null;
  projectLabel?: string | null;
  threadId?: string | null;
  sourceKind: MemoryObservationSourceKind;
  sourceId: string;
  summary: string;
  details?: string | null;
  payload?: Record<string, unknown>;
  observedAt?: number | null;
  durable?: boolean;
};

type TaskProjectionInput = {
  status?: MemoryTaskStatus | null;
  title?: string | null;
  currentStep?: string | null;
  blocker?: string | null;
  eventType?: string | null;
};

type EnqueueInput = {
  idempotencyKey: string;
  projectId: string;
  threadId?: string | null;
  sourceObservationId: string;
  reason: string;
  priority?: MemorySynthesisPriority;
  runAfter?: number | null;
};

type UpsertEntityInput = {
  projectId: string;
  type: MemoryEntityType;
  name: string;
  canonicalKey?: string | null;
  aliases?: string[];
  summary?: string | null;
  sourceObservationId: string;
};

type UpsertRelationshipInput = {
  projectId: string;
  sourceEntityId: string;
  predicate: string;
  targetEntityId: string;
  sourceObservationId: string;
  confidence?: number;
  validFrom?: number | null;
  validTo?: number | null;
};

const MAX_OBSERVATIONS = 2_000;
const MAX_TASK_EVENTS = 2_000;
const MAX_QUEUE_ENTRIES = 500;
const SEARCH_STOP_WORDS = new Set(["and", "are", "but", "for", "from", "not", "the", "this", "that", "with", "you", "your"]);

function now(): number {
  return Date.now();
}

function normalizeText(value: string | null | undefined, fallback = ""): string {
  return (value ?? fallback).replace(/\s+/g, " ").trim();
}

function normalizeIdPart(value: string): string {
  return normalizeText(value).toLowerCase().replace(/[^a-z0-9:_-]+/g, "-").replace(/^-+|-+$/g, "") || "unknown";
}

function hashText(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex").slice(0, 16);
}

function clampConfidence(value: number | undefined): number {
  return Number.isFinite(value) ? Math.max(0, Math.min(1, Number(value))) : 1;
}

function normalizePayload(payload: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return {};
  return Object.fromEntries(Object.entries(payload).filter(([key]) => key.trim().length > 0));
}

function observationText(observation: MemoryObservationView): string {
  return [observation.sourceKind, observation.sourceId, observation.summary, observation.details, JSON.stringify(observation.payload)]
    .filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
    .join("\n");
}

function entityText(entity: MemoryEntityView): string {
  return [entity.type, entity.name, entity.canonicalKey, entity.summary, ...entity.aliases].filter(Boolean).join("\n");
}

function relationshipText(rel: MemoryRelationshipView, graph: MemoryGraphView): string {
  const source = graph.entities.find((entity) => entity.id === rel.sourceEntityId)?.name ?? rel.sourceEntityId;
  const target = graph.entities.find((entity) => entity.id === rel.targetEntityId)?.name ?? rel.targetEntityId;
  return [source, rel.predicate, target].join("\n");
}

function taskText(task: MemoryTaskView): string {
  return [task.title, task.status, task.currentStep, task.blocker, task.threadId, task.projectLabel].filter(Boolean).join("\n");
}

function tokenize(value: string | null | undefined): string[] {
  const matches = normalizeText(value).toLowerCase().match(/[a-z0-9_:-]+/g) ?? [];
  return [...new Set(matches.filter((term) => term.length > 1 && !SEARCH_STOP_WORDS.has(term)))];
}

function scoreText(text: string, query: string | null, tokens: string[]): number {
  const normalized = normalizeText(text).toLowerCase();
  if (!normalized) return 0;
  let score = 0;
  const phrase = normalizeText(query).toLowerCase();
  if (phrase && normalized.includes(phrase)) score += 8;
  for (const token of tokens) if (normalized.includes(token)) score += 1;
  return score;
}

function graph(access: StateStoreInternalAccess): MemoryGraphView {
  return {
    observations: access.persistedMemoryObservations,
    entities: [...access.persistedMemoryEntitiesById.values()],
    relationships: [...access.persistedMemoryRelationshipsById.values()],
    tasks: [...access.persistedMemoryTasksById.values()],
    taskEvents: access.persistedMemoryTaskEvents,
    synthesisQueue: [...access.persistedMemorySynthesisQueueById.values()]
  };
}

export function listStateStoreMemoryGraph(access: StateStoreInternalAccess): MemoryGraphView {
  const current = graph(access);
  return {
    observations: current.observations.map((entry) => ({ ...entry, payload: { ...entry.payload } })),
    entities: current.entities.map((entry) => ({ ...entry, aliases: [...entry.aliases] })),
    relationships: current.relationships.map((entry) => ({ ...entry })),
    tasks: current.tasks.map((entry) => ({ ...entry })),
    taskEvents: current.taskEvents.map((entry) => ({ ...entry })),
    synthesisQueue: current.synthesisQueue.map((entry) => ({ ...entry }))
  };
}

export function recordStateStoreMemoryObservation(
  access: StateStoreInternalAccess,
  input: ObservationInput,
  taskProjection?: TaskProjectionInput | null,
  options: { save?: boolean; emit?: boolean } = {}
): MemoryObservationView {
  const key = normalizeText(input.idempotencyKey);
  if (!key) throw new Error("memory observation requires idempotencyKey");
  const existingId = access.persistedMemoryObservationIdsByKey.get(key);
  if (existingId) {
    const existing = access.persistedMemoryObservations.find((entry) => entry.id === existingId);
    if (existing) return { ...existing, payload: { ...existing.payload } };
  }

  const at = typeof input.observedAt === "number" && Number.isFinite(input.observedAt) ? input.observedAt : now();
  const projectId = normalizeText(input.projectId, "unknown") || "unknown";
  const projectLabel = normalizeText(input.projectLabel, projectId) || projectId;
  const sourceId = normalizeText(input.sourceId, key) || key;
  const summary = normalizeText(input.summary);
  if (!summary) throw new Error("memory observation requires summary");

  const observation: MemoryObservationView = {
    id: `obs-${hashText(`${key}:${at}`)}`,
    idempotencyKey: key,
    projectId,
    projectLabel,
    threadId: normalizeText(input.threadId) || null,
    sourceKind: input.sourceKind,
    sourceId,
    summary,
    details: normalizeText(input.details) || null,
    payload: normalizePayload(input.payload),
    observedAt: at,
    createdAt: now(),
    durable: input.durable !== false
  };

  access.persistedMemoryObservations.push(observation);
  access.persistedMemoryObservationIdsByKey.set(key, observation.id);
  if (access.persistedMemoryObservations.length > MAX_OBSERVATIONS) {
    const removed = access.persistedMemoryObservations.splice(0, access.persistedMemoryObservations.length - MAX_OBSERVATIONS);
    for (const entry of removed) access.persistedMemoryObservationIdsByKey.delete(entry.idempotencyKey);
  }

  applyDeterministicProjection(access, observation, taskProjection ?? null);
  if (options.save !== false) queueStateStoreSave(access);
  if (options.emit !== false) emitStateStoreChange(access);
  return { ...observation, payload: { ...observation.payload } };
}

export function upsertStateStoreMemoryEntity(access: StateStoreInternalAccess, input: UpsertEntityInput): MemoryEntityView {
  const name = normalizeText(input.name);
  if (!name) throw new Error("memory entity requires name");
  const projectId = normalizeText(input.projectId, "unknown") || "unknown";
  const canonicalKey = normalizeText(input.canonicalKey) || `${input.type}:${normalizeIdPart(name)}`;
  const existingId = access.persistedMemoryEntityIdsByKey.get(`${projectId}:${canonicalKey}`);
  const timestamp = now();
  if (existingId) {
    const existing = access.persistedMemoryEntitiesById.get(existingId);
    if (existing) {
      const next = {
        ...existing,
        name: existing.name || name,
        aliases: [...new Set([...existing.aliases, ...(input.aliases ?? []).map((alias) => normalizeText(alias)).filter(Boolean)])].slice(-20),
        summary: normalizeText(input.summary) || existing.summary,
        updatedAt: timestamp
      };
      access.persistedMemoryEntitiesById.set(existingId, next);
      return { ...next, aliases: [...next.aliases] };
    }
  }

  const entity: MemoryEntityView = {
    id: `ent-${hashText(`${projectId}:${canonicalKey}`)}`,
    projectId,
    type: input.type,
    name,
    canonicalKey,
    aliases: [...new Set((input.aliases ?? []).map((alias) => normalizeText(alias)).filter(Boolean))].slice(-20),
    summary: normalizeText(input.summary) || null,
    sourceObservationId: input.sourceObservationId,
    createdAt: timestamp,
    updatedAt: timestamp
  };
  access.persistedMemoryEntitiesById.set(entity.id, entity);
  access.persistedMemoryEntityIdsByKey.set(`${projectId}:${canonicalKey}`, entity.id);
  return { ...entity, aliases: [...entity.aliases] };
}

export function upsertStateStoreMemoryRelationship(access: StateStoreInternalAccess, input: UpsertRelationshipInput): MemoryRelationshipView {
  const projectId = normalizeText(input.projectId, "unknown") || "unknown";
  const predicate = normalizeText(input.predicate);
  if (!predicate) throw new Error("memory relationship requires predicate");
  const id = `rel-${hashText(`${projectId}:${input.sourceEntityId}:${predicate}:${input.targetEntityId}:${input.sourceObservationId}`)}`;
  const existing = access.persistedMemoryRelationshipsById.get(id);
  const timestamp = now();
  if (existing) {
    const next = { ...existing, confidence: clampConfidence(input.confidence), validTo: input.validTo ?? existing.validTo, updatedAt: timestamp };
    access.persistedMemoryRelationshipsById.set(id, next);
    return { ...next };
  }
  const relationship: MemoryRelationshipView = {
    id,
    projectId,
    sourceEntityId: input.sourceEntityId,
    predicate,
    targetEntityId: input.targetEntityId,
    sourceObservationId: input.sourceObservationId,
    confidence: clampConfidence(input.confidence),
    validFrom: input.validFrom ?? timestamp,
    validTo: input.validTo ?? null,
    createdAt: timestamp,
    updatedAt: timestamp
  };
  access.persistedMemoryRelationshipsById.set(id, relationship);
  return { ...relationship };
}

export function enqueueStateStoreMemorySynthesis(access: StateStoreInternalAccess, input: EnqueueInput): MemorySynthesisQueueEntryView {
  const key = normalizeText(input.idempotencyKey);
  if (!key) throw new Error("memory synthesis queue requires idempotencyKey");
  const existingId = access.persistedMemorySynthesisQueueIdsByKey.get(key);
  if (existingId) {
    const existing = access.persistedMemorySynthesisQueueById.get(existingId);
    if (existing) return { ...existing };
  }

  const timestamp = now();
  const entry: MemorySynthesisQueueEntryView = {
    id: `syn-${hashText(`${key}:${timestamp}`)}`,
    idempotencyKey: key,
    projectId: input.projectId,
    threadId: normalizeText(input.threadId) || null,
    sourceObservationId: input.sourceObservationId,
    reason: normalizeText(input.reason) || "memory synthesis",
    priority: input.priority ?? "normal",
    status: "pending",
    attempts: 0,
    lastError: null,
    createdAt: timestamp,
    updatedAt: timestamp,
    runAfter: typeof input.runAfter === "number" ? input.runAfter : timestamp,
    completedAt: null
  };
  access.persistedMemorySynthesisQueueById.set(entry.id, entry);
  access.persistedMemorySynthesisQueueIdsByKey.set(key, entry.id);
  if (access.persistedMemorySynthesisQueueById.size > MAX_QUEUE_ENTRIES) {
    const removable = [...access.persistedMemorySynthesisQueueById.values()]
      .filter((item) => item.status === "completed" || item.status === "skipped")
      .sort((left, right) => left.updatedAt - right.updatedAt)
      .slice(0, access.persistedMemorySynthesisQueueById.size - MAX_QUEUE_ENTRIES);
    for (const item of removable) {
      access.persistedMemorySynthesisQueueById.delete(item.id);
      access.persistedMemorySynthesisQueueIdsByKey.delete(item.idempotencyKey);
    }
  }
  queueStateStoreSave(access);
  emitStateStoreChange(access);
  return { ...entry };
}

export function listDueStateStoreMemorySynthesis(access: StateStoreInternalAccess, limit = 3, timestamp = now()): MemorySynthesisQueueEntryView[] {
  return [...access.persistedMemorySynthesisQueueById.values()]
    .filter((entry) => entry.status === "pending" && entry.runAfter <= timestamp)
    .sort((left, right) => {
      const priority = { high: 0, normal: 1, low: 2 } as const;
      return priority[left.priority] - priority[right.priority] || left.createdAt - right.createdAt;
    })
    .slice(0, Math.max(1, limit))
    .map((entry) => ({ ...entry }));
}

export function updateStateStoreMemorySynthesisQueueEntry(
  access: StateStoreInternalAccess,
  id: string,
  patch: Partial<Pick<MemorySynthesisQueueEntryView, "status" | "attempts" | "lastError" | "runAfter" | "completedAt">>
): MemorySynthesisQueueEntryView | null {
  const existing = access.persistedMemorySynthesisQueueById.get(id);
  if (!existing) return null;
  const next = { ...existing, ...patch, updatedAt: now() };
  access.persistedMemorySynthesisQueueById.set(id, next);
  queueStateStoreSave(access);
  emitStateStoreChange(access);
  return { ...next };
}

export function searchStateStoreMemoryGraph(
  access: StateStoreInternalAccess,
  input: { projectId?: string | null; threadId?: string | null; query?: string | null; limit?: number | null } = {}
): MemoryGraphRetrievalView {
  const projectId = normalizeText(input.projectId) || null;
  const threadId = normalizeText(input.threadId) || null;
  const query = normalizeText(input.query) || null;
  const limit = Math.max(1, Math.min(50, Math.trunc(input.limit ?? 10)));
  const current = graph(access);
  const tokens = tokenize(query);
  const warnings: string[] = [];

  const scopedObservations = current.observations.filter((entry) => (!projectId || entry.projectId === projectId) && (!threadId || entry.threadId === threadId));
  const scopedEntities = current.entities.filter((entry) => !projectId || entry.projectId === projectId);
  const scopedRelationships = current.relationships.filter((entry) => !projectId || entry.projectId === projectId);
  const scopedTasks = current.tasks.filter((entry) => (!projectId || entry.projectId === projectId) && (!threadId || entry.threadId === threadId));
  const scopedTaskIds = new Set(scopedTasks.map((task) => task.id));

  function rank<T>(items: T[], textFor: (item: T) => string, timeFor: (item: T) => number): T[] {
    if (!query && tokens.length === 0) return [...items].sort((left, right) => timeFor(right) - timeFor(left)).slice(0, limit);
    return items
      .map((item) => ({ item, score: scoreText(textFor(item), query, tokens), time: timeFor(item) }))
      .filter((entry) => entry.score > 0)
      .sort((left, right) => right.score - left.score || right.time - left.time)
      .slice(0, limit)
      .map((entry) => entry.item);
  }

  const observations = rank(scopedObservations, observationText, (entry) => entry.observedAt);
  const entities = rank(scopedEntities, entityText, (entry) => entry.updatedAt);
  const relationships = rank(scopedRelationships, (entry) => relationshipText(entry, current), (entry) => entry.updatedAt);
  const tasks = rank(scopedTasks, taskText, (entry) => entry.updatedAt);
  const taskEvents = current.taskEvents
    .filter((entry) => scopedTaskIds.has(entry.taskId) && (!query || scoreText(entry.summary, query, tokens) > 0))
    .sort((left, right) => right.at - left.at)
    .slice(0, limit);

  if (projectId && observations.length === 0 && entities.length === 0 && tasks.length === 0) warnings.push("No memory graph entries matched the requested project.");
  if (threadId && observations.length === 0 && tasks.length === 0) warnings.push("No memory graph entries matched the requested thread.");
  return { query, projectId, threadId, observations, entities, relationships, tasks, taskEvents, warnings, retrievedAt: now() };
}

function applyDeterministicProjection(access: StateStoreInternalAccess, observation: MemoryObservationView, taskProjection: TaskProjectionInput | null): void {
  const project = upsertStateStoreMemoryEntity(access, {
    projectId: observation.projectId,
    type: "project",
    name: observation.projectLabel || observation.projectId,
    canonicalKey: `project:${normalizeIdPart(observation.projectId)}`,
    sourceObservationId: observation.id
  });

  if (observation.threadId) {
    const thread = upsertStateStoreMemoryEntity(access, {
      projectId: observation.projectId,
      type: "thread",
      name: `Thread ${observation.threadId.slice(0, 8)}`,
      canonicalKey: `thread:${observation.threadId}`,
      sourceObservationId: observation.id
    });
    upsertStateStoreMemoryRelationship(access, {
      projectId: observation.projectId,
      sourceEntityId: thread.id,
      predicate: "part_of",
      targetEntityId: project.id,
      sourceObservationId: observation.id
    });
    projectTask(access, observation, taskProjection);
  }

  if (observation.sourceKind === "harness_decision" || observation.sourceKind === "promotion_resolved") {
    const decision = upsertStateStoreMemoryEntity(access, {
      projectId: observation.projectId,
      type: "decision",
      name: observation.summary.slice(0, 120),
      canonicalKey: `decision:${hashText(observation.summary)}`,
      summary: observation.details ?? observation.summary,
      sourceObservationId: observation.id
    });
    upsertStateStoreMemoryRelationship(access, {
      projectId: observation.projectId,
      sourceEntityId: decision.id,
      predicate: "part_of",
      targetEntityId: project.id,
      sourceObservationId: observation.id
    });
  }
}

function projectTask(access: StateStoreInternalAccess, observation: MemoryObservationView, projection: TaskProjectionInput | null): void {
  if (!observation.threadId) return;
  const taskId = `task-thread-${observation.threadId}`;
  const existing = access.persistedMemoryTasksById.get(taskId);
  const timestamp = observation.observedAt;
  const payloadTitle = typeof observation.payload.requestedTask === "string" ? observation.payload.requestedTask : null;
  const title = normalizeText(projection?.title) || normalizeText(payloadTitle) || existing?.title || observation.summary.slice(0, 160);
  const status = projection?.status ?? statusFromObservation(observation, existing?.status ?? "unknown");
  const blocker = normalizeText(projection?.blocker) || blockerFromObservation(observation) || (status === "blocked" ? existing?.blocker ?? null : existing?.blocker ?? null);
  const currentStep = normalizeText(projection?.currentStep) || currentStepFromObservation(observation) || (existing?.currentStep ?? null);
  const task: MemoryTaskView = {
    id: taskId,
    projectId: observation.projectId,
    projectLabel: observation.projectLabel,
    threadId: observation.threadId,
    title,
    status,
    currentStep,
    blocker,
    sourceObservationId: observation.id,
    createdAt: existing?.createdAt ?? timestamp,
    updatedAt: timestamp
  };
  access.persistedMemoryTasksById.set(taskId, task);

  const taskEntity = upsertStateStoreMemoryEntity(access, {
    projectId: observation.projectId,
    type: "task",
    name: title,
    canonicalKey: `task:${taskId}`,
    summary: [status, currentStep, blocker].filter(Boolean).join(" | ") || null,
    sourceObservationId: observation.id
  });
  const threadEntityId = access.persistedMemoryEntityIdsByKey.get(`${observation.projectId}:thread:${observation.threadId}`);
  if (threadEntityId) {
    upsertStateStoreMemoryRelationship(access, {
      projectId: observation.projectId,
      sourceEntityId: threadEntityId,
      predicate: "has_task",
      targetEntityId: taskEntity.id,
      sourceObservationId: observation.id
    });
  }

  const event: MemoryTaskEventView = {
    id: `tev-${hashText(`${taskId}:${observation.id}:${projection?.eventType ?? observation.sourceKind}`)}`,
    taskId,
    eventType: normalizeText(projection?.eventType) || observation.sourceKind,
    summary: observation.summary,
    observationId: observation.id,
    at: timestamp
  };
  if (!access.persistedMemoryTaskEvents.some((entry) => entry.id === event.id)) {
    access.persistedMemoryTaskEvents.push(event);
    if (access.persistedMemoryTaskEvents.length > MAX_TASK_EVENTS) access.persistedMemoryTaskEvents.splice(0, access.persistedMemoryTaskEvents.length - MAX_TASK_EVENTS);
  }
}

function statusFromObservation(observation: MemoryObservationView, fallback: MemoryTaskStatus): MemoryTaskStatus {
  if (observation.sourceKind === "thread_created" || observation.sourceKind === "thread_contract") return fallback === "unknown" ? "queued" : fallback;
  if (observation.sourceKind === "harness_report" && observation.payload.status === "blocked") return "blocked";
  if (observation.sourceKind === "harness_report" && observation.payload.status === "completed") return "completed_pending_review";
  if (observation.sourceKind === "pre_delete_thread" || observation.sourceKind === "pre_delete_threads") return "deleted";
  if (observation.sourceKind === "pre_clear_chat" || observation.sourceKind === "pre_delete_chat_suffix") return fallback;
  if (observation.sourceKind === "harness_checkpoint" || observation.sourceKind === "harness_decision" || observation.sourceKind === "harness_note") return fallback === "unknown" ? "in_progress" : fallback;
  return fallback;
}

function blockerFromObservation(observation: MemoryObservationView): string | null {
  if (Array.isArray(observation.payload.blockers) && observation.payload.blockers.length > 0) {
    return observation.payload.blockers.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0).join(" | ") || null;
  }
  if (typeof observation.payload.blocker === "string") return normalizeText(observation.payload.blocker) || null;
  if (observation.payload.status === "blocked" && observation.details) return observation.details;
  return null;
}

function currentStepFromObservation(observation: MemoryObservationView): string | null {
  if (typeof observation.payload.nextAction === "string") return normalizeText(observation.payload.nextAction) || null;
  if (Array.isArray(observation.payload.plan) && observation.payload.plan.length > 0) {
    const first = observation.payload.plan.find((entry) => typeof entry === "string" && entry.trim().length > 0);
    return typeof first === "string" ? normalizeText(first) : null;
  }
  return null;
}
