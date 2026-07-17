import crypto from "node:crypto";
import { promises as fs } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

import { getModels } from "@earendil-works/pi-ai/compat";
import initSqlJs from "sql.js";

import { modelCostEstimateCatalogFingerprint } from "./model-cost-estimates.js";
import { createUsageSample, summarizeUsage, usageSamplesFromPiEntries, type PricingModel, type UsageSample } from "./model-usage.js";
import type { ModelUsageRange, ModelUsageResponse } from "../shared/model-usage.js";

type SqlJsDatabase = {
  run(sql: string, params?: unknown[]): void;
  exec(sql: string, params?: unknown[]): { columns: string[]; values: unknown[][] }[];
  export(): Uint8Array;
};

type SqlJsStatic = { Database: new (data?: Uint8Array) => SqlJsDatabase };

type UsageEvent = UsageSample & { id: string; harness: "pi"; lane: "butler" | "worker" };

const require = createRequire(import.meta.url);
let sqlPromise: Promise<SqlJsStatic> | null = null;

function getSql(): Promise<SqlJsStatic> {
  sqlPromise ??= initSqlJs({ locateFile: (file) => require.resolve(`sql.js/dist/${file}`) }) as Promise<SqlJsStatic>;
  return sqlPromise;
}

function hash(value: unknown): string {
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function number(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

function time(value: unknown, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

async function listJsonlFiles(root: string): Promise<string[]> {
  const output: string[] = [];
  async function visit(directory: string): Promise<void> {
    const entries = await fs.readdir(directory, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(target);
      else if (entry.isFile() && entry.name.endsWith(".jsonl")) output.push(target);
    }
  }
  await visit(root);
  return output;
}

function modelKey(provider: string, model: string): string {
  return `${provider}/${model}`;
}

function parsePiEvents(content: string, filePath: string, lane: "butler" | "worker", models: PricingModel[], oauthKeys: Set<string>): UsageEvent[] {
  const parsed = content.split(/\r?\n/).flatMap((line) => {
    if (!line.trim()) return [];
    try { return [JSON.parse(line) as Record<string, unknown>]; } catch { return []; }
  });
  const header = parsed.find((entry) => entry.type === "session");
  const sessionId = typeof header?.id === "string" ? header.id : path.basename(filePath, ".jsonl");
  const assistantEntries = parsed.filter((entry) => entry.type === "message" && (entry.message as { role?: unknown } | undefined)?.role === "assistant");
  return assistantEntries.flatMap((entry) => {
    const sample = usageSamplesFromPiEntries([entry] as never[], sessionId, models, (model) => oauthKeys.has(modelKey(model.provider, model.id)))[0];
    if (!sample) return [];
    return {
      ...sample,
      id: hash({ source: "pi", entryId: entry?.id, at: sample.at, provider: sample.provider, model: sample.model, tokens: sample.tokens }),
      harness: "pi",
      lane
    };
  });
}

function rangeStart(range: ModelUsageRange, now: number): number | null {
  if (range === "all") return null;
  return now - (range === "7d" ? 7 : 30) * 24 * 60 * 60 * 1000;
}

export class ModelUsageStore {
  private db: SqlJsDatabase | null = null;
  private refreshPromise: Promise<void> | null = null;
  private persistPromise: Promise<void> = Promise.resolve();
  private pricingCache: { at: number; models: PricingModel[]; oauthKeys: Set<string> } | null = null;

  constructor(private readonly options: {
    dbPath: string;
    butlerPiRoots: string[];
    workerPiRoots: string[];
    loadPiPricing: () => Promise<{ models: PricingModel[]; oauthKeys: Set<string> }>;
  }) {}

  async load(): Promise<void> {
    if (this.db) return;
    const SQL = await getSql();
    const data = await fs.readFile(this.options.dbPath).catch(() => null);
    this.db = new SQL.Database(data ? new Uint8Array(data) : undefined);
    this.db.run(`
      CREATE TABLE IF NOT EXISTS usage_events (
        id TEXT PRIMARY KEY,
        at INTEGER NOT NULL,
        harness TEXT NOT NULL,
        lane TEXT NOT NULL,
        session_id TEXT NOT NULL,
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        input_tokens INTEGER NOT NULL,
        output_tokens INTEGER NOT NULL,
        cache_read_tokens INTEGER NOT NULL,
        cache_write_tokens INTEGER NOT NULL,
        input_cost REAL NOT NULL,
        output_cost REAL NOT NULL,
        cache_read_cost REAL NOT NULL,
        cache_write_cost REAL NOT NULL,
        cost_basis TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS usage_events_at_idx ON usage_events(at);
      CREATE INDEX IF NOT EXISTS usage_events_model_idx ON usage_events(provider, model);
      CREATE TABLE IF NOT EXISTS usage_files (path TEXT PRIMARY KEY, mtime REAL NOT NULL, size INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS usage_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    `);
    this.db.run("DELETE FROM usage_events WHERE harness <> 'pi'");
    await this.persist();
  }

  private async pricing(): Promise<{ models: PricingModel[]; oauthKeys: Set<string> }> {
    const now = Date.now();
    if (this.pricingCache && now - this.pricingCache.at < 5 * 60 * 1000) return this.pricingCache;
    const pi = await this.options.loadPiPricing();
    let openCode: PricingModel[] = [];
    let codex: PricingModel[] = [];
    try { openCode = getModels("opencode-go" as never); } catch { /* catalog unavailable */ }
    try { codex = getModels("openai-codex" as never); } catch { /* catalog unavailable */ }
    const models = [...openCode, ...pi.models, ...codex];
    const oauthKeys = new Set([...pi.oauthKeys, ...codex.map((model) => modelKey(model.provider, model.id))]);
    this.pricingCache = { at: now, models, oauthKeys };
    return this.pricingCache;
  }

  private fileState(filePath: string): { mtime: number; size: number } | null {
    const result = this.db!.exec("SELECT mtime, size FROM usage_files WHERE path = ?", [filePath])[0]?.values[0];
    return result ? { mtime: Number(result[0]), size: Number(result[1]) } : null;
  }

  private insert(event: UsageEvent): void {
    this.db!.run(`INSERT INTO usage_events VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        at = excluded.at, harness = excluded.harness, lane = excluded.lane, session_id = excluded.session_id,
        provider = excluded.provider, model = excluded.model, input_tokens = excluded.input_tokens,
        output_tokens = excluded.output_tokens, cache_read_tokens = excluded.cache_read_tokens,
        cache_write_tokens = excluded.cache_write_tokens, input_cost = excluded.input_cost,
        output_cost = excluded.output_cost, cache_read_cost = excluded.cache_read_cost,
        cache_write_cost = excluded.cache_write_cost, cost_basis = excluded.cost_basis`, [
      event.id, event.at, event.harness, event.lane, event.sessionId, event.provider, event.model,
      event.tokens.input, event.tokens.output, event.tokens.cacheRead, event.tokens.cacheWrite,
      event.cost.input, event.cost.output, event.cost.cacheRead, event.cost.cacheWrite, event.cost.basis
    ]);
  }

  private async importRoot(root: string, lane: "butler" | "worker", models: PricingModel[], oauthKeys: Set<string>): Promise<void> {
    for (const filePath of await listJsonlFiles(root)) {
      const stat = await fs.stat(filePath).catch(() => null);
      if (!stat) continue;
      const previous = this.fileState(filePath);
      if (previous?.mtime === stat.mtimeMs && previous.size === stat.size) continue;
      const content = await fs.readFile(filePath, "utf8").catch(() => null);
      if (content === null) continue;
      const events = parsePiEvents(content, filePath, lane, models, oauthKeys);
      for (const event of events) this.insert(event);
      this.db!.run("INSERT OR REPLACE INTO usage_files(path, mtime, size) VALUES (?, ?, ?)", [filePath, stat.mtimeMs, stat.size]);
    }
  }

  async refresh(): Promise<void> {
    await this.load();
    if (this.refreshPromise) return this.refreshPromise;
    this.refreshPromise = (async () => {
      const { models, oauthKeys } = await this.pricing();
      const pricingFingerprint = hash({
        estimateCatalog: modelCostEstimateCatalogFingerprint(),
        models: models
          .map((model) => ({ provider: model.provider, id: model.id, cost: model.cost }))
          .sort((left, right) => `${left.provider}/${left.id}`.localeCompare(`${right.provider}/${right.id}`))
      });
      const previousFingerprint = this.db!.exec("SELECT value FROM usage_meta WHERE key = 'pricing_fingerprint'")[0]?.values[0]?.[0];
      if (previousFingerprint !== pricingFingerprint) {
        this.db!.run("DELETE FROM usage_files");
        this.db!.run("INSERT OR REPLACE INTO usage_meta(key, value) VALUES ('pricing_fingerprint', ?)", [pricingFingerprint]);
      }
      for (const root of this.options.butlerPiRoots) await this.importRoot(root, "butler", models, oauthKeys);
      for (const root of this.options.workerPiRoots) await this.importRoot(root, "worker", models, oauthKeys);
      await this.persist();
    })().finally(() => { this.refreshPromise = null; });
    return this.refreshPromise;
  }

  private resetAt(): number | null {
    const value = this.db!.exec("SELECT value FROM usage_meta WHERE key = 'reset_at'")[0]?.values[0]?.[0];
    const parsed = typeof value === "string" ? Number(value) : NaN;
    return Number.isFinite(parsed) ? parsed : null;
  }

  async get(range: ModelUsageRange): Promise<ModelUsageResponse> {
    await this.refresh();
    const now = Date.now();
    const resetAt = this.resetAt();
    const requestedStart = rangeStart(range, now);
    const from = requestedStart === null ? resetAt : Math.max(requestedStart, resetAt ?? 0);
    const rows = this.db!.exec(`SELECT at, session_id, provider, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, input_cost, output_cost, cache_read_cost, cache_write_cost, cost_basis FROM usage_events WHERE at >= ? AND at <= ?`, [from ?? 0, now])[0]?.values ?? [];
    const samples: UsageSample[] = rows.map((row) => {
      const input = Number(row[4]);
      const output = Number(row[5]);
      const cacheRead = Number(row[6]);
      const cacheWrite = Number(row[7]);
      const inputCost = Number(row[8]);
      const outputCost = Number(row[9]);
      const cacheReadCost = Number(row[10]);
      const cacheWriteCost = Number(row[11]);
      return {
        at: Number(row[0]), sessionId: String(row[1]), provider: String(row[2]), model: String(row[3]),
        tokens: { input, output, cacheRead, cacheWrite, total: input + output + cacheRead + cacheWrite },
        cost: { input: inputCost, output: outputCost, cacheRead: cacheReadCost, cacheWrite: cacheWriteCost, total: inputCost + outputCost + cacheReadCost + cacheWriteCost, basis: String(row[12]) as never }
      };
    });
    return { range, from, to: now, resetAt, summary: summarizeUsage(samples) };
  }

  async reset(): Promise<number> {
    await this.load();
    const resetAt = Date.now();
    this.db!.run("INSERT OR REPLACE INTO usage_meta(key, value) VALUES ('reset_at', ?)", [String(resetAt)]);
    await this.persist();
    return resetAt;
  }

  private persist(): Promise<void> {
    if (!this.db) return Promise.resolve();
    const snapshot = this.db.export();
    const operation = this.persistPromise.catch(() => {}).then(async () => {
      await fs.mkdir(path.dirname(this.options.dbPath), { recursive: true });
      const temp = `${this.options.dbPath}.${process.pid}.${crypto.randomUUID()}.tmp`;
      await fs.writeFile(temp, snapshot);
      await fs.rename(temp, this.options.dbPath);
    });
    this.persistPromise = operation;
    return operation;
  }
}
