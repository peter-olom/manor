import crypto from "node:crypto";
import { promises as fs } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

import initSqlJs from "sql.js";

import { normalizeJobMemoryEntryKind, normalizeStringList } from "./state-store-helpers.js";
import type { StateStoreInternalAccess } from "./state-store-internals.js";
import type {
  ButlerMemoryEntryView,
  JobMemoryDecisionView,
  JobMemoryEntryView,
  JobMemoryPromotionCandidateView,
  JobMemoryView,
  MemoryEntityView,
  MemoryObservationView,
  MemoryRelationshipView,
  MemorySynthesisQueueEntryView,
  MemoryTaskEventView,
  MemoryTaskView,
  ProjectArtifactKind,
  ProjectArtifactSourceKind,
  ProjectArtifactView,
  ProjectMemoryEntryView,
  ProjectMemoryView
} from "./types.js";

type SqlJsDatabase = {
  run(sql: string, params?: unknown[]): void;
  exec(sql: string, params?: unknown[]): { columns: string[]; values: unknown[][] }[];
  export(): Uint8Array;
  close(): void;
};

type SqlJsStatic = {
  Database: new (data?: Uint8Array) => SqlJsDatabase;
};

const require = createRequire(import.meta.url);
let sqlPromise: Promise<SqlJsStatic> | null = null;

function sqlitePath(access: StateStoreInternalAccess): string {
  return process.env.MANOR_MEMORY_SQLITE_PATH || path.join(path.dirname(access.uiStatePath), "butler-memory.sqlite");
}

function getSql(): Promise<SqlJsStatic> {
  sqlPromise ??= initSqlJs({
    locateFile: (file) => require.resolve(`sql.js/dist/${file}`)
  }) as Promise<SqlJsStatic>;
  return sqlPromise;
}

async function openDb(dbPath: string): Promise<SqlJsDatabase> {
  const SQL = await getSql();
  try {
    const data = await fs.readFile(dbPath);
    return new SQL.Database(new Uint8Array(data));
  } catch {
    return new SQL.Database();
  }
}

async function saveDb(dbPath: string, db: SqlJsDatabase): Promise<void> {
  await fs.mkdir(path.dirname(dbPath), { recursive: true });
  await fs.writeFile(dbPath, Buffer.from(db.export()));
}

function ensureSchema(db: SqlJsDatabase): void {
  db.run([
    "CREATE TABLE IF NOT EXISTS job_memories (thread_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, project_label TEXT NOT NULL, source TEXT, created_at INTEGER, operator_goal TEXT, requested_task TEXT, current_plan_json TEXT NOT NULL, latest_checkpoint TEXT, next_action TEXT, blockers_json TEXT NOT NULL, assumptions_json TEXT NOT NULL, proof_requirements_json TEXT NOT NULL, notes_json TEXT NOT NULL, decisions_json TEXT NOT NULL, entries_json TEXT NOT NULL, promotion_candidates_json TEXT NOT NULL, updated_at INTEGER NOT NULL);",
    "CREATE INDEX IF NOT EXISTS idx_job_memories_project_updated ON job_memories(project_id, updated_at DESC);",
    "CREATE TABLE IF NOT EXISTS project_memories (project_id TEXT PRIMARY KEY, project_label TEXT NOT NULL, summary TEXT, updated_at INTEGER NOT NULL);",
    "CREATE TABLE IF NOT EXISTS project_memory_entries (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, source_thread_id TEXT NOT NULL, kind TEXT NOT NULL, summary TEXT NOT NULL, details TEXT, accepted_at INTEGER NOT NULL);",
    "CREATE INDEX IF NOT EXISTS idx_project_memory_entries_project ON project_memory_entries(project_id, accepted_at DESC);",
    "CREATE TABLE IF NOT EXISTS butler_memory_entries (id TEXT PRIMARY KEY, summary TEXT NOT NULL, details TEXT, source TEXT NOT NULL, source_message_id TEXT, tags_json TEXT NOT NULL, created_at INTEGER NOT NULL);",
    "CREATE INDEX IF NOT EXISTS idx_butler_memory_created ON butler_memory_entries(created_at DESC);",
    "CREATE TABLE IF NOT EXISTS memory_observations (id TEXT PRIMARY KEY, idempotency_key TEXT NOT NULL UNIQUE, project_id TEXT NOT NULL, project_label TEXT NOT NULL, thread_id TEXT, source_kind TEXT NOT NULL, source_id TEXT NOT NULL, summary TEXT NOT NULL, details TEXT, payload_json TEXT NOT NULL, observed_at INTEGER NOT NULL, created_at INTEGER NOT NULL, durable INTEGER NOT NULL);",
    "CREATE INDEX IF NOT EXISTS idx_memory_observations_project_observed ON memory_observations(project_id, observed_at DESC);",
    "CREATE INDEX IF NOT EXISTS idx_memory_observations_thread_observed ON memory_observations(thread_id, observed_at DESC);",
    "CREATE TABLE IF NOT EXISTS memory_entities (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, type TEXT NOT NULL, name TEXT NOT NULL, canonical_key TEXT NOT NULL, aliases_json TEXT NOT NULL, summary TEXT, source_observation_id TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, UNIQUE(project_id, canonical_key));",
    "CREATE INDEX IF NOT EXISTS idx_memory_entities_project_type ON memory_entities(project_id, type);",
    "CREATE TABLE IF NOT EXISTS memory_relationships (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, source_entity_id TEXT NOT NULL, predicate TEXT NOT NULL, target_entity_id TEXT NOT NULL, source_observation_id TEXT NOT NULL, confidence REAL NOT NULL, valid_from INTEGER, valid_to INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);",
    "CREATE INDEX IF NOT EXISTS idx_memory_relationships_project_predicate ON memory_relationships(project_id, predicate);",
    "CREATE TABLE IF NOT EXISTS memory_tasks (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, project_label TEXT NOT NULL, thread_id TEXT, title TEXT NOT NULL, status TEXT NOT NULL, current_step TEXT, blocker TEXT, source_observation_id TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);",
    "CREATE INDEX IF NOT EXISTS idx_memory_tasks_project_status ON memory_tasks(project_id, status, updated_at DESC);",
    "CREATE TABLE IF NOT EXISTS memory_task_events (id TEXT PRIMARY KEY, task_id TEXT NOT NULL, event_type TEXT NOT NULL, summary TEXT NOT NULL, observation_id TEXT NOT NULL, at INTEGER NOT NULL);",
    "CREATE INDEX IF NOT EXISTS idx_memory_task_events_task_at ON memory_task_events(task_id, at DESC);",
    "CREATE TABLE IF NOT EXISTS memory_synthesis_queue (id TEXT PRIMARY KEY, idempotency_key TEXT NOT NULL UNIQUE, project_id TEXT NOT NULL, thread_id TEXT, source_observation_id TEXT NOT NULL, reason TEXT NOT NULL, priority TEXT NOT NULL, status TEXT NOT NULL, attempts INTEGER NOT NULL, last_error TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, run_after INTEGER NOT NULL, completed_at INTEGER);",
    "CREATE INDEX IF NOT EXISTS idx_memory_synthesis_due ON memory_synthesis_queue(status, run_after, priority);",
    "CREATE TABLE IF NOT EXISTS project_artifacts (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, project_label TEXT NOT NULL, kind TEXT NOT NULL, title TEXT NOT NULL, description TEXT, file_name TEXT NOT NULL, file_path TEXT NOT NULL, content_type TEXT NOT NULL, size_bytes INTEGER NOT NULL, tags_json TEXT NOT NULL, metadata_json TEXT NOT NULL, source_kind TEXT NOT NULL, source_url TEXT, source_thread_id TEXT, checksum_sha256 TEXT, text_preview TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);",
    "CREATE INDEX IF NOT EXISTS idx_project_artifacts_project_updated ON project_artifacts(project_id, updated_at DESC);",
    "CREATE INDEX IF NOT EXISTS idx_project_artifacts_kind_updated ON project_artifacts(kind, updated_at DESC);",
    "CREATE INDEX IF NOT EXISTS idx_project_artifacts_checksum ON project_artifacts(checksum_sha256);",
    "CREATE TABLE IF NOT EXISTS project_artifact_terms (term TEXT NOT NULL, artifact_id TEXT NOT NULL, project_id TEXT NOT NULL, weight INTEGER NOT NULL, PRIMARY KEY(term, artifact_id));",
    "CREATE INDEX IF NOT EXISTS idx_project_artifact_terms_project_term ON project_artifact_terms(project_id, term);",
    "CREATE INDEX IF NOT EXISTS idx_project_artifact_terms_artifact ON project_artifact_terms(artifact_id);"
  ].join("\n"));
  ensureColumn(db, "job_memories", "source", "TEXT");
  ensureColumn(db, "job_memories", "created_at", "INTEGER");
}

function ensureColumn(db: SqlJsDatabase, tableName: string, columnName: string, definition: string): void {
  const columns = queryRows<{ name: string }>(db, `PRAGMA table_info(${tableName});`);
  if (columns.some((column) => column.name === columnName)) {
    return;
  }
  db.run(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${definition};`);
}

function queryRows<T extends Record<string, unknown>>(db: SqlJsDatabase, sql: string, params: unknown[] = []): T[] {
  const result = db.exec(sql, params)[0];
  if (!result) {
    return [];
  }
  return result.values.map((values) => Object.fromEntries(result.columns.map((column, index) => [column, values[index]])) as T);
}

function jsonList(value: unknown): string[] {
  if (typeof value !== "string" || !value.trim()) {
    return [];
  }
  try {
    return normalizeStringList(JSON.parse(value), 60);
  } catch {
    return [];
  }
}

function jsonRecord(value: unknown): Record<string, string> {
  if (typeof value !== "string" || !value.trim()) {
    return {};
  }
  try {
    const parsed = JSON.parse(value);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }
    return Object.fromEntries(
      Object.entries(parsed as Record<string, unknown>)
        .filter((entry): entry is [string, string] => typeof entry[0] === "string" && typeof entry[1] === "string")
        .map(([key, entryValue]) => [key.trim(), entryValue.trim()])
        .filter(([key]) => key.length > 0)
    );
  } catch {
    return {};
  }
}

function jsonObject(value: unknown): Record<string, unknown> {
  if (typeof value !== "string" || !value.trim()) {
    return {};
  }
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function nullableString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function normalizeArtifactKind(value: unknown): ProjectArtifactKind {
  return value === "seed" ||
    value === "reference" ||
    value === "download" ||
    value === "research" ||
    value === "report" ||
    value === "other"
    ? value
    : "other";
}

function normalizeArtifactSourceKind(value: unknown): ProjectArtifactSourceKind {
  return value === "inline" || value === "url" || value === "generated" ? value : "generated";
}

function rowToProjectArtifact(row: Record<string, unknown>): ProjectArtifactView {
  return {
    id: String(row.id ?? "").trim(),
    projectId: String(row.project_id ?? "project").trim() || "project",
    projectLabel: String(row.project_label ?? row.project_id ?? "Project").trim() || "Project",
    kind: normalizeArtifactKind(row.kind),
    title: String(row.title ?? "").trim(),
    description: nullableString(row.description),
    fileName: String(row.file_name ?? "artifact.bin").trim() || "artifact.bin",
    filePath: String(row.file_path ?? "").trim(),
    contentType: String(row.content_type ?? "application/octet-stream").trim() || "application/octet-stream",
    sizeBytes: typeof row.size_bytes === "number" && Number.isFinite(row.size_bytes) ? Math.max(0, Math.trunc(row.size_bytes)) : 0,
    tags: jsonList(row.tags_json),
    metadata: jsonRecord(row.metadata_json),
    source: {
      kind: normalizeArtifactSourceKind(row.source_kind),
      url: nullableString(row.source_url),
      createdByThreadId: nullableString(row.source_thread_id),
      checksumSha256: nullableString(row.checksum_sha256)
    },
    textPreview: nullableString(row.text_preview),
    createdAt: typeof row.created_at === "number" ? row.created_at : Date.now(),
    updatedAt: typeof row.updated_at === "number" ? row.updated_at : Date.now()
  };
}

const MAX_SEARCH_TERMS_PER_ARTIFACT = 500;
const SEARCH_STOP_WORDS = new Set(["and", "are", "but", "for", "from", "not", "the", "this", "that", "with", "you", "your"]);

function tokenizeSearchText(value: string): string[] {
  const matches = value.toLowerCase().match(/[a-z0-9]+/g) ?? [];
  return [...new Set(matches.filter((term) => term.length > 1 && !SEARCH_STOP_WORDS.has(term)).slice(0, 80))];
}

function tokenIndexTerms(token: string): string[] {
  if (token.length < 3) {
    return [token];
  }
  const terms = new Set<string>();
  for (let length = 3; length <= Math.min(20, token.length); length += 1) {
    terms.add(token.slice(0, length));
  }
  terms.add(token);
  return [...terms];
}

function addArtifactSearchTerms(target: Map<string, number>, value: string | null | undefined, weight: number): void {
  if (!value) {
    return;
  }
  for (const token of tokenizeSearchText(value)) {
    for (const term of tokenIndexTerms(token)) {
      target.set(term, Math.min(100, (target.get(term) ?? 0) + weight));
    }
  }
}

function buildArtifactSearchTerms(artifact: ProjectArtifactView): Array<{ term: string; weight: number }> {
  const weighted = new Map<string, number>();
  addArtifactSearchTerms(weighted, artifact.title, 10);
  addArtifactSearchTerms(weighted, artifact.fileName, 8);
  addArtifactSearchTerms(weighted, artifact.tags.join(" "), 7);
  addArtifactSearchTerms(weighted, artifact.description, 5);
  addArtifactSearchTerms(weighted, Object.entries(artifact.metadata).flatMap(([key, value]) => [key, value]).join(" "), 4);
  addArtifactSearchTerms(weighted, artifact.source.url, 3);
  addArtifactSearchTerms(weighted, artifact.projectLabel, 2);
  addArtifactSearchTerms(weighted, artifact.kind, 2);
  addArtifactSearchTerms(weighted, artifact.contentType, 2);
  addArtifactSearchTerms(weighted, artifact.textPreview, 1);
  return [...weighted.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, MAX_SEARCH_TERMS_PER_ARTIFACT)
    .map(([term, weight]) => ({ term, weight }));
}

function jsonArray<T>(value: unknown, normalize: (entry: T) => T): T[] {
  if (typeof value !== "string" || !value.trim()) {
    return [];
  }
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.map((entry) => normalize(entry as T)) : [];
  } catch {
    return [];
  }
}

function normalizeDecision(entry: JobMemoryDecisionView): JobMemoryDecisionView {
  return {
    id: typeof entry.id === "string" && entry.id.trim() ? entry.id.trim() : crypto.randomUUID(),
    summary: typeof entry.summary === "string" ? entry.summary.trim() : "",
    details: typeof entry.details === "string" && entry.details.trim() ? entry.details.trim() : null,
    at: typeof entry.at === "number" ? entry.at : Date.now()
  };
}

function normalizeEntry(entry: JobMemoryEntryView): JobMemoryEntryView {
  return {
    id: typeof entry.id === "string" && entry.id.trim() ? entry.id.trim() : crypto.randomUUID(),
    kind: normalizeJobMemoryEntryKind(entry.kind),
    summary: typeof entry.summary === "string" ? entry.summary.trim() : "",
    details: typeof entry.details === "string" && entry.details.trim() ? entry.details.trim() : null,
    nextAction: typeof entry.nextAction === "string" && entry.nextAction.trim() ? entry.nextAction.trim() : null,
    blockers: normalizeStringList(entry.blockers),
    plan: normalizeStringList(entry.plan),
    assumptions: normalizeStringList(entry.assumptions),
    proofRequirements: normalizeStringList(entry.proofRequirements),
    promote: Boolean(entry.promote),
    promotionCandidateId: typeof entry.promotionCandidateId === "string" && entry.promotionCandidateId.trim() ? entry.promotionCandidateId.trim() : null,
    at: typeof entry.at === "number" ? entry.at : Date.now()
  };
}

function normalizeCandidate(entry: JobMemoryPromotionCandidateView, memory: { threadId: string; projectId: string; projectLabel: string }): JobMemoryPromotionCandidateView {
  return {
    id: typeof entry.id === "string" && entry.id.trim() ? entry.id.trim() : crypto.randomUUID(),
    threadId: memory.threadId,
    projectId: typeof entry.projectId === "string" && entry.projectId.trim() ? entry.projectId.trim() : memory.projectId,
    projectLabel: typeof entry.projectLabel === "string" && entry.projectLabel.trim() ? entry.projectLabel.trim() : memory.projectLabel,
    kind: normalizeJobMemoryEntryKind(entry.kind),
    sourceEntryId: typeof entry.sourceEntryId === "string" && entry.sourceEntryId.trim() ? entry.sourceEntryId.trim() : "",
    summary: typeof entry.summary === "string" ? entry.summary.trim() : "",
    details: typeof entry.details === "string" && entry.details.trim() ? entry.details.trim() : null,
    status: entry.status === "accepted" || entry.status === "rejected" ? entry.status : "pending",
    createdAt: typeof entry.createdAt === "number" ? entry.createdAt : Date.now(),
    updatedAt: typeof entry.updatedAt === "number" ? entry.updatedAt : Date.now(),
    resolvedAt: typeof entry.resolvedAt === "number" ? entry.resolvedAt : null
  };
}

function normalizeObservationSourceKind(value: unknown): MemoryObservationView["sourceKind"] {
  return value === "operator_message" ||
    value === "thread_created" ||
    value === "thread_contract" ||
    value === "harness_checkpoint" ||
    value === "harness_decision" ||
    value === "harness_note" ||
    value === "harness_report" ||
    value === "promotion_resolved" ||
    value === "pre_delete_thread" ||
    value === "pre_delete_threads" ||
    value === "pre_clear_chat" ||
    value === "pre_delete_chat_suffix" ||
    value === "artifact_saved" ||
    value === "proof_saved" ||
    value === "policy_saved" ||
    value === "synthesis_result"
    ? value
    : "system";
}

function normalizeMemoryEntityType(value: unknown): MemoryEntityView["type"] {
  return value === "agent" ||
    value === "artifact" ||
    value === "branch" ||
    value === "component" ||
    value === "decision" ||
    value === "environment" ||
    value === "feature" ||
    value === "person" ||
    value === "policy" ||
    value === "project" ||
    value === "repo" ||
    value === "service" ||
    value === "task" ||
    value === "thread"
    ? value
    : "unknown";
}

function normalizeMemoryTaskStatus(value: unknown): MemoryTaskView["status"] {
  return value === "queued" ||
    value === "in_progress" ||
    value === "blocked" ||
    value === "completed_pending_review" ||
    value === "completed" ||
    value === "archived" ||
    value === "deleted" ||
    value === "stale"
    ? value
    : "unknown";
}

function normalizeMemoryQueueStatus(value: unknown): MemorySynthesisQueueEntryView["status"] {
  return value === "running" || value === "completed" || value === "failed" || value === "skipped" ? value : "pending";
}

export async function loadStateStoreSqliteMemory(access: StateStoreInternalAccess): Promise<boolean> {
  const dbPath = sqlitePath(access);
  const db = await openDb(dbPath);
  try {
    ensureSchema(db);
    const jobRows = queryRows(db, "SELECT * FROM job_memories;");
    const projectRows = queryRows(db, "SELECT * FROM project_memories;");
    const projectEntryRows = queryRows(db, "SELECT * FROM project_memory_entries;");
    const butlerRows = queryRows(db, "SELECT * FROM butler_memory_entries;");
    const observationRows = queryRows(db, "SELECT * FROM memory_observations;");
    const entityRows = queryRows(db, "SELECT * FROM memory_entities;");
    const relationshipRows = queryRows(db, "SELECT * FROM memory_relationships;");
    const taskRows = queryRows(db, "SELECT * FROM memory_tasks;");
    const taskEventRows = queryRows(db, "SELECT * FROM memory_task_events;");
    const synthesisQueueRows = queryRows(db, "SELECT * FROM memory_synthesis_queue;");
    const artifactRows = queryRows(db, "SELECT * FROM project_artifacts;");
    const hasGraphRows = observationRows.length > 0 || entityRows.length > 0 || relationshipRows.length > 0 || taskRows.length > 0 || taskEventRows.length > 0 || synthesisQueueRows.length > 0;
    const hasMemoryRows = jobRows.length > 0 || projectRows.length > 0 || projectEntryRows.length > 0 || butlerRows.length > 0 || hasGraphRows;
    const hasArtifactRows = artifactRows.length > 0;
    if (!hasMemoryRows && !hasArtifactRows) {
      await saveDb(dbPath, db);
      return false;
    }

    if (hasMemoryRows) {
      access.persistedJobMemoriesByThreadId.clear();
      for (const row of jobRows) {
        const threadId = String(row.thread_id ?? "");
        const projectId = String(row.project_id ?? "unknown");
        const projectLabel = String(row.project_label ?? "Unknown");
        const memoryInfo = { threadId, projectId, projectLabel };
        access.persistedJobMemoriesByThreadId.set(threadId, {
          threadId,
          projectId,
          projectLabel,
          source: nullableString(row.source),
          createdAt: typeof row.created_at === "number" ? row.created_at : Date.now(),
          operatorGoal: typeof row.operator_goal === "string" && row.operator_goal ? row.operator_goal : null,
          requestedTask: typeof row.requested_task === "string" && row.requested_task ? row.requested_task : null,
          currentPlan: jsonList(row.current_plan_json),
          latestCheckpoint: typeof row.latest_checkpoint === "string" && row.latest_checkpoint ? row.latest_checkpoint : null,
          nextAction: typeof row.next_action === "string" && row.next_action ? row.next_action : null,
          blockers: jsonList(row.blockers_json),
          assumptions: jsonList(row.assumptions_json),
          proofRequirements: jsonList(row.proof_requirements_json),
          notes: jsonList(row.notes_json),
          decisions: jsonArray<JobMemoryDecisionView>(row.decisions_json, normalizeDecision).filter((entry) => entry.summary),
          entries: jsonArray<JobMemoryEntryView>(row.entries_json, normalizeEntry).filter((entry) => entry.summary),
          promotionCandidates: jsonArray<JobMemoryPromotionCandidateView>(row.promotion_candidates_json, (entry) => normalizeCandidate(entry, memoryInfo)).filter((entry) => entry.summary),
          updatedAt: typeof row.updated_at === "number" ? row.updated_at : Date.now()
        });
      }

      const entriesByProjectId = new Map<string, ProjectMemoryEntryView[]>();
      for (const row of projectEntryRows) {
        const projectId = String(row.project_id ?? "");
        const entry: ProjectMemoryEntryView = {
          id: String(row.id ?? crypto.randomUUID()),
          sourceThreadId: String(row.source_thread_id ?? ""),
          kind: normalizeJobMemoryEntryKind(row.kind),
          summary: String(row.summary ?? ""),
          details: typeof row.details === "string" && row.details ? row.details : null,
          acceptedAt: typeof row.accepted_at === "number" ? row.accepted_at : Date.now()
        };
        entriesByProjectId.set(projectId, [...(entriesByProjectId.get(projectId) ?? []), entry]);
      }

      access.persistedProjectMemoriesByProjectId.clear();
      for (const row of projectRows) {
        const projectId = String(row.project_id ?? "");
        access.persistedProjectMemoriesByProjectId.set(projectId, {
          projectId,
          projectLabel: String(row.project_label ?? (projectId || "Unknown")),
          summary: typeof row.summary === "string" && row.summary ? row.summary : null,
          entries: (entriesByProjectId.get(projectId) ?? []).sort((left, right) => left.acceptedAt - right.acceptedAt).slice(-60),
          updatedAt: typeof row.updated_at === "number" ? row.updated_at : Date.now()
        });
      }

      access.persistedButlerMemoryEntries.splice(0, access.persistedButlerMemoryEntries.length, ...butlerRows.map((row): ButlerMemoryEntryView => ({
        id: String(row.id ?? crypto.randomUUID()),
        summary: String(row.summary ?? ""),
        details: typeof row.details === "string" && row.details ? row.details : null,
        source: row.source === "manual_chat_save" ? "manual_chat_save" : "butler_tool",
        sourceMessageId: typeof row.source_message_id === "string" && row.source_message_id ? row.source_message_id : null,
        tags: jsonList(row.tags_json),
        createdAt: typeof row.created_at === "number" ? row.created_at : Date.now()
      })).sort((left, right) => left.createdAt - right.createdAt).slice(-100));

      access.persistedMemoryObservations.splice(0, access.persistedMemoryObservations.length);
      access.persistedMemoryObservationIdsByKey.clear();
      for (const row of observationRows) {
        const observation: MemoryObservationView = {
          id: String(row.id ?? crypto.randomUUID()),
          idempotencyKey: String(row.idempotency_key ?? row.id ?? crypto.randomUUID()),
          projectId: String(row.project_id ?? "unknown"),
          projectLabel: String(row.project_label ?? row.project_id ?? "Unknown"),
          threadId: nullableString(row.thread_id),
          sourceKind: normalizeObservationSourceKind(row.source_kind),
          sourceId: String(row.source_id ?? ""),
          summary: String(row.summary ?? ""),
          details: nullableString(row.details),
          payload: jsonObject(row.payload_json),
          observedAt: typeof row.observed_at === "number" ? row.observed_at : Date.now(),
          createdAt: typeof row.created_at === "number" ? row.created_at : Date.now(),
          durable: row.durable !== 0
        };
        access.persistedMemoryObservations.push(observation);
        access.persistedMemoryObservationIdsByKey.set(observation.idempotencyKey, observation.id);
      }
      access.persistedMemoryEntitiesById.clear();
      access.persistedMemoryEntityIdsByKey.clear();
      for (const row of entityRows) {
        const entity: MemoryEntityView = {
          id: String(row.id ?? crypto.randomUUID()),
          projectId: String(row.project_id ?? "unknown"),
          type: normalizeMemoryEntityType(row.type),
          name: String(row.name ?? ""),
          canonicalKey: String(row.canonical_key ?? ""),
          aliases: jsonList(row.aliases_json),
          summary: nullableString(row.summary),
          sourceObservationId: String(row.source_observation_id ?? ""),
          createdAt: typeof row.created_at === "number" ? row.created_at : Date.now(),
          updatedAt: typeof row.updated_at === "number" ? row.updated_at : Date.now()
        };
        access.persistedMemoryEntitiesById.set(entity.id, entity);
        access.persistedMemoryEntityIdsByKey.set(`${entity.projectId}:${entity.canonicalKey}`, entity.id);
      }
      access.persistedMemoryRelationshipsById.clear();
      for (const row of relationshipRows) {
        const relationship: MemoryRelationshipView = {
          id: String(row.id ?? crypto.randomUUID()),
          projectId: String(row.project_id ?? "unknown"),
          sourceEntityId: String(row.source_entity_id ?? ""),
          predicate: String(row.predicate ?? ""),
          targetEntityId: String(row.target_entity_id ?? ""),
          sourceObservationId: String(row.source_observation_id ?? ""),
          confidence: typeof row.confidence === "number" ? row.confidence : 1,
          validFrom: typeof row.valid_from === "number" ? row.valid_from : null,
          validTo: typeof row.valid_to === "number" ? row.valid_to : null,
          createdAt: typeof row.created_at === "number" ? row.created_at : Date.now(),
          updatedAt: typeof row.updated_at === "number" ? row.updated_at : Date.now()
        };
        access.persistedMemoryRelationshipsById.set(relationship.id, relationship);
      }
      access.persistedMemoryTasksById.clear();
      for (const row of taskRows) {
        const task: MemoryTaskView = {
          id: String(row.id ?? crypto.randomUUID()),
          projectId: String(row.project_id ?? "unknown"),
          projectLabel: String(row.project_label ?? row.project_id ?? "Unknown"),
          threadId: nullableString(row.thread_id),
          title: String(row.title ?? ""),
          status: normalizeMemoryTaskStatus(row.status),
          currentStep: nullableString(row.current_step),
          blocker: nullableString(row.blocker),
          sourceObservationId: String(row.source_observation_id ?? ""),
          createdAt: typeof row.created_at === "number" ? row.created_at : Date.now(),
          updatedAt: typeof row.updated_at === "number" ? row.updated_at : Date.now()
        };
        access.persistedMemoryTasksById.set(task.id, task);
      }
      access.persistedMemoryTaskEvents.splice(0, access.persistedMemoryTaskEvents.length, ...taskEventRows.map((row): MemoryTaskEventView => ({
        id: String(row.id ?? crypto.randomUUID()),
        taskId: String(row.task_id ?? ""),
        eventType: String(row.event_type ?? "event"),
        summary: String(row.summary ?? ""),
        observationId: String(row.observation_id ?? ""),
        at: typeof row.at === "number" ? row.at : Date.now()
      })));
      access.persistedMemorySynthesisQueueById.clear();
      access.persistedMemorySynthesisQueueIdsByKey.clear();
      for (const row of synthesisQueueRows) {
        const entry: MemorySynthesisQueueEntryView = {
          id: String(row.id ?? crypto.randomUUID()),
          idempotencyKey: String(row.idempotency_key ?? row.id ?? crypto.randomUUID()),
          projectId: String(row.project_id ?? "unknown"),
          threadId: nullableString(row.thread_id),
          sourceObservationId: String(row.source_observation_id ?? ""),
          reason: String(row.reason ?? "memory synthesis"),
          priority: row.priority === "high" || row.priority === "low" ? row.priority : "normal",
          status: normalizeMemoryQueueStatus(row.status),
          attempts: typeof row.attempts === "number" ? row.attempts : 0,
          lastError: nullableString(row.last_error),
          createdAt: typeof row.created_at === "number" ? row.created_at : Date.now(),
          updatedAt: typeof row.updated_at === "number" ? row.updated_at : Date.now(),
          runAfter: typeof row.run_after === "number" ? row.run_after : Date.now(),
          completedAt: typeof row.completed_at === "number" ? row.completed_at : null
        };
        access.persistedMemorySynthesisQueueById.set(entry.id, entry);
        access.persistedMemorySynthesisQueueIdsByKey.set(entry.idempotencyKey, entry.id);
      }
    }

    if (hasArtifactRows && access.persistedProjectArtifactsByProjectId.size === 0) {
      access.persistedProjectArtifactsByProjectId.clear();
      const artifactsByProjectId = new Map<string, ProjectArtifactView[]>();
      for (const row of artifactRows) {
        const artifact = rowToProjectArtifact(row);
        if (!artifact.id || !artifact.title || !artifact.filePath) {
          continue;
        }
        artifactsByProjectId.set(artifact.projectId, [...(artifactsByProjectId.get(artifact.projectId) ?? []), artifact]);
      }
      for (const [projectId, artifacts] of artifactsByProjectId.entries()) {
        access.persistedProjectArtifactsByProjectId.set(
          projectId,
          artifacts.sort((left, right) => right.updatedAt - left.updatedAt)
        );
      }
    }
    return true;
  } finally {
    db.close();
  }
}

export async function persistStateStoreSqliteMemory(access: StateStoreInternalAccess): Promise<boolean> {
  const dbPath = sqlitePath(access);
  const db = await openDb(dbPath);
  try {
    ensureSchema(db);
    db.run("BEGIN IMMEDIATE;");
    db.run("DELETE FROM project_memory_entries;");
    db.run("DELETE FROM project_memories;");
    db.run("DELETE FROM job_memories;");
    db.run("DELETE FROM butler_memory_entries;");
    db.run("DELETE FROM memory_synthesis_queue;");
    db.run("DELETE FROM memory_task_events;");
    db.run("DELETE FROM memory_tasks;");
    db.run("DELETE FROM memory_relationships;");
    db.run("DELETE FROM memory_entities;");
    db.run("DELETE FROM memory_observations;");
    db.run("DELETE FROM project_artifact_terms;");
    db.run("DELETE FROM project_artifacts;");
    for (const memory of access.persistedJobMemoriesByThreadId.values()) {
      db.run("INSERT INTO job_memories (thread_id, project_id, project_label, source, created_at, operator_goal, requested_task, current_plan_json, latest_checkpoint, next_action, blockers_json, assumptions_json, proof_requirements_json, notes_json, decisions_json, entries_json, promotion_candidates_json, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);", [
        memory.threadId,
        memory.projectId,
        memory.projectLabel,
        memory.source,
        memory.createdAt,
        memory.operatorGoal,
        memory.requestedTask,
        JSON.stringify(memory.currentPlan),
        memory.latestCheckpoint,
        memory.nextAction,
        JSON.stringify(memory.blockers),
        JSON.stringify(memory.assumptions),
        JSON.stringify(memory.proofRequirements),
        JSON.stringify(memory.notes),
        JSON.stringify(memory.decisions),
        JSON.stringify(memory.entries),
        JSON.stringify(memory.promotionCandidates),
        memory.updatedAt
      ]);
    }
    for (const memory of access.persistedProjectMemoriesByProjectId.values()) {
      db.run("INSERT INTO project_memories VALUES (?, ?, ?, ?);", [memory.projectId, memory.projectLabel, memory.summary, memory.updatedAt]);
      for (const entry of memory.entries) {
        db.run("INSERT INTO project_memory_entries VALUES (?, ?, ?, ?, ?, ?, ?);", [
          entry.id,
          memory.projectId,
          entry.sourceThreadId,
          entry.kind,
          entry.summary,
          entry.details,
          entry.acceptedAt
        ]);
      }
    }
    for (const entry of access.persistedButlerMemoryEntries) {
      db.run("INSERT INTO butler_memory_entries VALUES (?, ?, ?, ?, ?, ?, ?);", [
        entry.id,
        entry.summary,
        entry.details,
        entry.source,
        entry.sourceMessageId,
        JSON.stringify(entry.tags),
        entry.createdAt
      ]);
    }
    for (const observation of access.persistedMemoryObservations) {
      db.run("INSERT INTO memory_observations VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);", [
        observation.id,
        observation.idempotencyKey,
        observation.projectId,
        observation.projectLabel,
        observation.threadId,
        observation.sourceKind,
        observation.sourceId,
        observation.summary,
        observation.details,
        JSON.stringify(observation.payload),
        observation.observedAt,
        observation.createdAt,
        observation.durable ? 1 : 0
      ]);
    }
    for (const entity of access.persistedMemoryEntitiesById.values()) {
      db.run("INSERT INTO memory_entities VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?);", [
        entity.id,
        entity.projectId,
        entity.type,
        entity.name,
        entity.canonicalKey,
        JSON.stringify(entity.aliases),
        entity.summary,
        entity.sourceObservationId,
        entity.createdAt,
        entity.updatedAt
      ]);
    }
    for (const relationship of access.persistedMemoryRelationshipsById.values()) {
      db.run("INSERT INTO memory_relationships VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);", [
        relationship.id,
        relationship.projectId,
        relationship.sourceEntityId,
        relationship.predicate,
        relationship.targetEntityId,
        relationship.sourceObservationId,
        relationship.confidence,
        relationship.validFrom,
        relationship.validTo,
        relationship.createdAt,
        relationship.updatedAt
      ]);
    }
    for (const task of access.persistedMemoryTasksById.values()) {
      db.run("INSERT INTO memory_tasks VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);", [
        task.id,
        task.projectId,
        task.projectLabel,
        task.threadId,
        task.title,
        task.status,
        task.currentStep,
        task.blocker,
        task.sourceObservationId,
        task.createdAt,
        task.updatedAt
      ]);
    }
    for (const event of access.persistedMemoryTaskEvents) {
      db.run("INSERT INTO memory_task_events VALUES (?, ?, ?, ?, ?, ?);", [
        event.id,
        event.taskId,
        event.eventType,
        event.summary,
        event.observationId,
        event.at
      ]);
    }
    for (const entry of access.persistedMemorySynthesisQueueById.values()) {
      db.run("INSERT INTO memory_synthesis_queue VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);", [
        entry.id,
        entry.idempotencyKey,
        entry.projectId,
        entry.threadId,
        entry.sourceObservationId,
        entry.reason,
        entry.priority,
        entry.status,
        entry.attempts,
        entry.lastError,
        entry.createdAt,
        entry.updatedAt,
        entry.runAfter,
        entry.completedAt
      ]);
    }
    for (const artifact of [...access.persistedProjectArtifactsByProjectId.values()].flat()) {
      db.run("INSERT INTO project_artifacts VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);", [
        artifact.id,
        artifact.projectId,
        artifact.projectLabel,
        artifact.kind,
        artifact.title,
        artifact.description,
        artifact.fileName,
        artifact.filePath,
        artifact.contentType,
        artifact.sizeBytes,
        JSON.stringify(artifact.tags),
        JSON.stringify(artifact.metadata),
        artifact.source.kind,
        artifact.source.url,
        artifact.source.createdByThreadId,
        artifact.source.checksumSha256,
        artifact.textPreview,
        artifact.createdAt,
        artifact.updatedAt
      ]);
      for (const term of buildArtifactSearchTerms(artifact)) {
        db.run("INSERT INTO project_artifact_terms VALUES (?, ?, ?, ?);", [
          term.term,
          artifact.id,
          artifact.projectId,
          term.weight
        ]);
      }
    }
    db.run("COMMIT;");
    await saveDb(dbPath, db);
    return true;
  } catch (error) {
    try {
      db.run("ROLLBACK;");
    } catch {
      // Ignore rollback failures; the original error is more useful.
    }
    throw error;
  } finally {
    db.close();
  }
}

export async function searchStateStoreSqliteProjectArtifacts(
  access: StateStoreInternalAccess,
  input: {
    projectId?: string | null;
    query?: string | null;
    kind?: ProjectArtifactKind | null;
    limit?: number | null;
  } = {}
): Promise<ProjectArtifactView[]> {
  const dbPath = sqlitePath(access);
  const db = await openDb(dbPath);
  const projectId = input.projectId?.trim() || null;
  const queryTerms = tokenizeSearchText(input.query ?? "");
  const limit = Math.min(100, Math.max(1, Math.trunc(input.limit ?? 20)));
  try {
    ensureSchema(db);
    if (queryTerms.length === 0) {
      const where: string[] = [];
      const params: unknown[] = [];
      if (projectId) {
        where.push("project_id = ?");
        params.push(projectId);
      }
      if (input.kind) {
        where.push("kind = ?");
        params.push(input.kind);
      }
      params.push(limit);
      return queryRows(
        db,
        `SELECT * FROM project_artifacts${where.length > 0 ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY updated_at DESC LIMIT ?;`,
        params
      ).map(rowToProjectArtifact);
    }

    const where = [`t.term IN (${queryTerms.map(() => "?").join(", ")})`];
    const params: unknown[] = [...queryTerms];
    if (projectId) {
      where.push("a.project_id = ?");
      params.push(projectId);
    }
    if (input.kind) {
      where.push("a.kind = ?");
      params.push(input.kind);
    }
    params.push(queryTerms.length);
    params.push(Math.min(200, limit * 5));
    return queryRows(
      db,
      [
        "SELECT a.*, SUM(t.weight) AS search_score, COUNT(DISTINCT t.term) AS matched_terms",
        "FROM project_artifact_terms t",
        "JOIN project_artifacts a ON a.id = t.artifact_id",
        `WHERE ${where.join(" AND ")}`,
        "GROUP BY a.id",
        "HAVING COUNT(DISTINCT t.term) = ?",
        "ORDER BY matched_terms DESC, search_score DESC, a.updated_at DESC",
        "LIMIT ?;"
      ].join("\n"),
      params
    ).map(rowToProjectArtifact);
  } finally {
    db.close();
  }
}
