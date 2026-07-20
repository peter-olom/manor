import { EventEmitter } from "node:events";
import { promises as fs } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

import initSqlJs from "sql.js";

import type {
  ManorSettings,
  ManorSettingsProvenance,
  SettingsGroupKey,
  SettingsProvenance,
  SettingsValidationKey,
  SettingsValidationMap,
  SettingsValidationResult
} from "../shared/settings.js";
import {
  DEFAULT_MANOR_SETTINGS,
  DEFAULT_SETTINGS_VALIDATION,
  SETTINGS_GROUP_KEYS,
  SETTINGS_VALIDATION_KEYS,
  applyGroupValue,
  buildManorSettingsFromEnv,
  cloneManorSettings,
  emptySettingsProvenance,
  groupValue,
  normalizeManorSettings
} from "./manor-settings-schema.js";

type SqlJsDatabase = {
  run(sql: string, params?: unknown[]): void;
  exec(sql: string, params?: unknown[]): { columns: string[]; values: unknown[][] }[];
  export(): Uint8Array;
  close(): void;
};

type SqlJsStatic = {
  Database: new (data?: Uint8Array) => SqlJsDatabase;
};

type SettingsRow = {
  group_key: string;
  value_json: string;
  provenance: string;
};

type ValidationRow = {
  check_key: string;
  status: string;
  message: string | null;
  last_checked_at: number | null;
};

const ACTIVE_PROFILE_ID = "active";
const require = createRequire(import.meta.url);
let sqlPromise: Promise<SqlJsStatic> | null = null;

function getSql(): Promise<SqlJsStatic> {
  sqlPromise ??= initSqlJs({
    locateFile: (file) => require.resolve(`sql.js/dist/${file}`)
  }) as Promise<SqlJsStatic>;
  return sqlPromise;
}

function isSqliteCorruptionError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /database disk image is malformed|file is not a database|invalid database|corrupt/i.test(message);
}

function safeCloseDb(db: SqlJsDatabase): void {
  try {
    db.close();
  } catch {
    // Ignore close errors while recovering settings state.
  }
}

async function quarantineCorruptDb(dbPath: string, error: unknown): Promise<void> {
  const suffix = new Date().toISOString().replace(/[:.]/g, "-");
  try {
    await fs.rename(dbPath, `${dbPath}.corrupt-${suffix}`);
    console.warn(`Quarantined corrupt Manor settings database: ${error instanceof Error ? error.message : String(error)}`);
  } catch {
    // Startup can rebuild settings if another process already moved it.
  }
}

async function openDb(dbPath: string): Promise<SqlJsDatabase> {
  const SQL = await getSql();
  try {
    const data = await fs.readFile(dbPath);
    const db = new SQL.Database(new Uint8Array(data));
    try {
      db.exec("PRAGMA quick_check;");
      return db;
    } catch (error) {
      safeCloseDb(db);
      if (isSqliteCorruptionError(error)) {
        await quarantineCorruptDb(dbPath, error);
        return new SQL.Database();
      }
      throw error;
    }
  } catch (error) {
    if (isSqliteCorruptionError(error)) {
      await quarantineCorruptDb(dbPath, error);
    }
    return new SQL.Database();
  }
}

async function saveDb(dbPath: string, db: SqlJsDatabase): Promise<void> {
  await fs.mkdir(path.dirname(dbPath), { recursive: true });
  const tmpPath = `${dbPath}.${process.pid}.${Date.now()}.tmp`;
  try {
    await fs.writeFile(tmpPath, Buffer.from(db.export()));
    await fs.rename(tmpPath, dbPath);
  } catch (error) {
    await fs.rm(tmpPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

function queryRows<T extends Record<string, unknown>>(db: SqlJsDatabase, sql: string, params: unknown[] = []): T[] {
  const result = db.exec(sql, params)[0];
  if (!result) return [];
  return result.values.map((values) => Object.fromEntries(result.columns.map((column, index) => [column, values[index]])) as T);
}

function ensureSchema(db: SqlJsDatabase): void {
  db.run([
    "CREATE TABLE IF NOT EXISTS settings_groups (profile_id TEXT NOT NULL, group_key TEXT NOT NULL, value_json TEXT NOT NULL, provenance TEXT NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY(profile_id, group_key));",
    "CREATE TABLE IF NOT EXISTS settings_validation (profile_id TEXT NOT NULL, check_key TEXT NOT NULL, status TEXT NOT NULL, message TEXT, last_checked_at INTEGER, PRIMARY KEY(profile_id, check_key));"
  ].join("\n"));
}

function normalizeProvenance(value: unknown): SettingsProvenance {
  return value === "env_seed" || value === "ui" ? value : "default";
}

function normalizeValidation(value: unknown): SettingsValidationResult {
  const row = value && typeof value === "object" ? value as Partial<SettingsValidationResult> : {};
  return {
    status: row.status === "ok" || row.status === "failed" ? row.status : "not_configured",
    lastCheckedAt: typeof row.lastCheckedAt === "number" && Number.isFinite(row.lastCheckedAt) ? row.lastCheckedAt : null,
    message: typeof row.message === "string" && row.message.trim() ? row.message.trim().slice(0, 1_000) : null
  };
}

function rowValidation(row: ValidationRow): SettingsValidationResult {
  return normalizeValidation({
    status: row.status,
    lastCheckedAt: typeof row.last_checked_at === "number" ? row.last_checked_at : null,
    message: typeof row.message === "string" ? row.message : null
  });
}

function parseJsonObject(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return {};
  }
}

function patchGroupKeys(patch: Partial<ManorSettings>): SettingsGroupKey[] {
  const keys: SettingsGroupKey[] = [];
  if (patch.overview) keys.push("overview");
  if (patch.providers?.ollamaLocal) keys.push("providers.ollamaLocal");
  if (patch.providers?.ollamaCloud) keys.push("providers.ollamaCloud");
  if (patch.providers?.opencodeGo) keys.push("providers.opencodeGo");
  if (patch.worker) keys.push("worker");
  if (patch.butler) keys.push("butler");
  if (patch.security) keys.push("security");
  if (patch.vision) keys.push("vision");
  if (patch.modelTasks) keys.push("modelTasks");
  if (patch.memory) keys.push("memory");
  if (patch.embeddings) keys.push("embeddings");
  return keys;
}

function patchGroupValue(patch: Partial<ManorSettings>, key: SettingsGroupKey): unknown {
  switch (key) {
    case "overview": return patch.overview;
    case "providers.ollamaLocal": return patch.providers?.ollamaLocal;
    case "providers.ollamaCloud": return patch.providers?.ollamaCloud;
    case "providers.opencodeGo": return patch.providers?.opencodeGo;
    case "worker": return patch.worker;
    case "butler": return patch.butler;
    case "security": return patch.security;
    case "vision": return patch.vision;
    case "modelTasks": return patch.modelTasks;
    case "memory": return patch.memory;
    case "embeddings": return patch.embeddings;
  }
}

export class ManorSettingsService extends EventEmitter<{ change: [ManorSettings] }> {
  private settings = normalizeManorSettings({});
  private provenance = emptySettingsProvenance();
  private validation: SettingsValidationMap = { ...DEFAULT_SETTINGS_VALIDATION };
  private loaded = false;

  constructor(private readonly dbPath: string, private readonly env: NodeJS.ProcessEnv = process.env) {
    super();
  }

  get dbFilePath(): string {
    return this.dbPath;
  }

  getSettings(): ManorSettings {
    return cloneManorSettings(this.settings);
  }

  getProvenance(): ManorSettingsProvenance {
    return { ...this.provenance };
  }

  getValidation(): SettingsValidationMap {
    return JSON.parse(JSON.stringify(this.validation)) as SettingsValidationMap;
  }

  async load(): Promise<void> {
    const db = await openDb(this.dbPath);
    try {
      ensureSchema(db);
      const rows = queryRows<SettingsRow>(db, "SELECT group_key, value_json, provenance FROM settings_groups WHERE profile_id = ?;", [ACTIVE_PROFILE_ID]);
      const rowByGroup = new Map(rows.map((row) => [row.group_key, row]));
      const envSeed = buildManorSettingsFromEnv(this.env);
      let nextSettings = normalizeManorSettings({});
      const nextProvenance = emptySettingsProvenance();
      const now = Date.now();
      let changed = false;
      const reseed = this.env.MANOR_SETTINGS_RESEED === "1";

      for (const key of SETTINGS_GROUP_KEYS) {
        const row = rowByGroup.get(key);
        const shouldUseEnv = !row || (reseed && normalizeProvenance(row.provenance) !== "ui");
        const value = shouldUseEnv ? groupValue(envSeed.settings, key) : parseJsonObject(row.value_json);
        nextSettings = applyGroupValue(nextSettings, key, value);
        nextProvenance[key] = shouldUseEnv ? envSeed.provenance[key] : normalizeProvenance(row.provenance);
        if (shouldUseEnv) {
          changed = true;
          this.writeGroup(db, key, groupValue(nextSettings, key), nextProvenance[key], now);
        } else {
          const normalizedValue = groupValue(nextSettings, key);
          if (JSON.stringify(normalizedValue) !== JSON.stringify(value)) {
            changed = true;
            this.writeGroup(db, key, normalizedValue, nextProvenance[key], now);
          }
        }
      }

      this.settings = normalizeManorSettings(nextSettings);
      this.provenance = nextProvenance;
      this.validation = this.readValidation(db);
      if (changed) await saveDb(this.dbPath, db);
      this.loaded = true;
    } finally {
      safeCloseDb(db);
    }
  }

  async patch(patch: Partial<ManorSettings>): Promise<ManorSettings> {
    this.assertLoaded();
    const keys = patchGroupKeys(patch);
    if (keys.length === 0) return this.getSettings();
    let next = this.settings;
    for (const key of keys) {
      next = applyGroupValue(next, key, patchGroupValue(patch, key));
    }
    await this.persistGroups(next, keys, "ui");
    this.settings = next;
    for (const key of keys) this.provenance[key] = "ui";
    this.emit("change", this.getSettings());
    return this.getSettings();
  }

  async reseedUnset(): Promise<ManorSettings> {
    this.assertLoaded();
    const envSeed = buildManorSettingsFromEnv(this.env);
    const keys = SETTINGS_GROUP_KEYS.filter((key) => this.provenance[key] !== "ui" && this.provenance[key] !== "env_seed");
    if (keys.length === 0) return this.getSettings();
    let next = this.settings;
    for (const key of keys) {
      next = applyGroupValue(next, key, groupValue(envSeed.settings, key));
    }
    await this.persistGroups(next, keys, "env_seed");
    this.settings = next;
    for (const key of keys) this.provenance[key] = envSeed.provenance[key];
    this.emit("change", this.getSettings());
    return this.getSettings();
  }

  async restoreGroup(key: SettingsGroupKey): Promise<ManorSettings> {
    this.assertLoaded();
    const next = applyGroupValue(this.settings, key, groupValue(DEFAULT_MANOR_SETTINGS, key));
    await this.persistGroups(next, [key], "default");
    this.settings = next;
    this.provenance[key] = "default";
    this.emit("change", this.getSettings());
    return this.getSettings();
  }

  async setValidation(key: SettingsValidationKey, result: SettingsValidationResult): Promise<SettingsValidationMap> {
    this.assertLoaded();
    const normalized = normalizeValidation(result);
    const db = await openDb(this.dbPath);
    try {
      ensureSchema(db);
      db.run(
        "INSERT OR REPLACE INTO settings_validation (profile_id, check_key, status, message, last_checked_at) VALUES (?, ?, ?, ?, ?);",
        [ACTIVE_PROFILE_ID, key, normalized.status, normalized.message, normalized.lastCheckedAt]
      );
      await saveDb(this.dbPath, db);
      this.validation[key] = normalized;
      return this.getValidation();
    } finally {
      safeCloseDb(db);
    }
  }

  private assertLoaded(): void {
    if (!this.loaded) throw new Error("Manor settings service is not loaded.");
  }

  private async persistGroups(settings: ManorSettings, keys: SettingsGroupKey[], provenance: SettingsProvenance): Promise<void> {
    const db = await openDb(this.dbPath);
    try {
      ensureSchema(db);
      const now = Date.now();
      for (const key of keys) {
        this.writeGroup(db, key, groupValue(settings, key), provenance, now);
      }
      await saveDb(this.dbPath, db);
    } finally {
      safeCloseDb(db);
    }
  }

  private writeGroup(db: SqlJsDatabase, key: SettingsGroupKey, value: unknown, provenance: SettingsProvenance, now: number): void {
    db.run(
      "INSERT OR REPLACE INTO settings_groups (profile_id, group_key, value_json, provenance, updated_at) VALUES (?, ?, ?, ?, ?);",
      [ACTIVE_PROFILE_ID, key, JSON.stringify(value), provenance, now]
    );
  }

  private readValidation(db: SqlJsDatabase): SettingsValidationMap {
    const validation = JSON.parse(JSON.stringify(DEFAULT_SETTINGS_VALIDATION)) as SettingsValidationMap;
    const rows = queryRows<ValidationRow>(db, "SELECT check_key, status, message, last_checked_at FROM settings_validation WHERE profile_id = ?;", [ACTIVE_PROFILE_ID]);
    for (const row of rows) {
      if ((SETTINGS_VALIDATION_KEYS as string[]).includes(row.check_key)) {
        validation[row.check_key as SettingsValidationKey] = rowValidation(row);
      }
    }
    return validation;
  }
}

export function defaultManorSettingsPath(stateDir: string, env: NodeJS.ProcessEnv = process.env): string {
  return env.MANOR_SETTINGS_SQLITE_PATH || path.join(stateDir, "manor-settings.sqlite");
}
