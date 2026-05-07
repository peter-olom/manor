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
    "CREATE TABLE IF NOT EXISTS job_memories (thread_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, project_label TEXT NOT NULL, operator_goal TEXT, requested_task TEXT, current_plan_json TEXT NOT NULL, latest_checkpoint TEXT, next_action TEXT, blockers_json TEXT NOT NULL, assumptions_json TEXT NOT NULL, proof_requirements_json TEXT NOT NULL, notes_json TEXT NOT NULL, decisions_json TEXT NOT NULL, entries_json TEXT NOT NULL, promotion_candidates_json TEXT NOT NULL, updated_at INTEGER NOT NULL);",
    "CREATE INDEX IF NOT EXISTS idx_job_memories_project_updated ON job_memories(project_id, updated_at DESC);",
    "CREATE TABLE IF NOT EXISTS project_memories (project_id TEXT PRIMARY KEY, project_label TEXT NOT NULL, summary TEXT, updated_at INTEGER NOT NULL);",
    "CREATE TABLE IF NOT EXISTS project_memory_entries (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, source_thread_id TEXT NOT NULL, kind TEXT NOT NULL, summary TEXT NOT NULL, details TEXT, accepted_at INTEGER NOT NULL);",
    "CREATE INDEX IF NOT EXISTS idx_project_memory_entries_project ON project_memory_entries(project_id, accepted_at DESC);",
    "CREATE TABLE IF NOT EXISTS butler_memory_entries (id TEXT PRIMARY KEY, summary TEXT NOT NULL, details TEXT, source TEXT NOT NULL, source_message_id TEXT, tags_json TEXT NOT NULL, created_at INTEGER NOT NULL);",
    "CREATE INDEX IF NOT EXISTS idx_butler_memory_created ON butler_memory_entries(created_at DESC);"
  ].join("\n"));
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

export async function loadStateStoreSqliteMemory(access: StateStoreInternalAccess): Promise<boolean> {
  const dbPath = sqlitePath(access);
  const db = await openDb(dbPath);
  try {
    ensureSchema(db);
    const jobRows = queryRows(db, "SELECT * FROM job_memories;");
    const projectRows = queryRows(db, "SELECT * FROM project_memories;");
    const projectEntryRows = queryRows(db, "SELECT * FROM project_memory_entries;");
    const butlerRows = queryRows(db, "SELECT * FROM butler_memory_entries;");
    if (jobRows.length === 0 && projectRows.length === 0 && projectEntryRows.length === 0 && butlerRows.length === 0) {
      await saveDb(dbPath, db);
      return false;
    }

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
    for (const memory of access.persistedJobMemoriesByThreadId.values()) {
      db.run("INSERT INTO job_memories VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);", [
        memory.threadId,
        memory.projectId,
        memory.projectLabel,
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
