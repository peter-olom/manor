import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import initSqlJs from "sql.js";

import { buildManorSettingsFromEnv } from "../../src/server/manor-settings-schema.js";
import { normalizeManorSettings } from "../../src/server/manor-settings-schema.js";
import { ManorSettingsService } from "../../src/server/manor-settings-service.js";

const require = createRequire(import.meta.url);

test("buildManorSettingsFromEnv parses and clamps seed values", () => {
  const { settings, provenance } = buildManorSettingsFromEnv({
    MANOR_OLLAMA_LOCAL_MODELS: "qwen3:8b",
    MANOR_OLLAMA_LOCAL_NATIVE_BASE_URL: "http://localhost:11434",
    MANOR_OLLAMA_CLOUD_MODELS: "glm-5.2,kimi-k2.6",
    MANOR_OLLAMA_WEB_SEARCH_MAX_RESULTS: "99",
    MANOR_WORKER_EFFORT: "xhigh",
    MANOR_MEMORY_SYNTHESIS_MAX_CANDIDATES: "99",
    OLLAMA_API_KEY_FILE: "/run/secrets/ollama",
    OLLAMA_LOCAL_API_KEY_FILE: "/run/secrets/local-ollama"
  } as NodeJS.ProcessEnv);

  assert.deepEqual(settings.providers.ollamaLocal.models, ["qwen3:8b"]);
  assert.equal(settings.providers.ollamaLocal.nativeBaseUrl, "http://localhost:11434");
  assert.deepEqual(settings.providers.ollamaLocal.apiKeySource, { type: "file", pathEnv: "OLLAMA_LOCAL_API_KEY_FILE" });
  assert.deepEqual(settings.providers.ollamaCloud.models, ["glm-5.2", "kimi-k2.6"]);
  assert.equal(settings.providers.ollamaCloud.webTools.maxResults, 10);
  assert.equal(settings.worker.defaultEffort, "xhigh");
  assert.equal(settings.memory.synthesisMaxCandidatesPerRun, 50);
  assert.deepEqual(settings.providers.ollamaCloud.apiKeySource, { type: "file", pathEnv: "OLLAMA_API_KEY_FILE" });
  assert.equal(provenance["providers.ollamaLocal"], "env_seed");
  assert.equal(provenance["providers.ollamaCloud"], "env_seed");
});

test("blank Worker compose seeds do not mark worker settings as env seeded", () => {
  const { settings, provenance } = buildManorSettingsFromEnv({
    MANOR_WORKER_MODEL: "",
    MANOR_WORKER_EFFORT: ""
  } as NodeJS.ProcessEnv);

  assert.equal(settings.worker.defaultModel, null);
  assert.equal(settings.worker.defaultEffort, null);
  assert.equal(provenance.worker, "default");
});

test("legacy Worker provider seed is ignored", () => {
  const legacy = buildManorSettingsFromEnv({
    MANOR_WORKER_PROVIDER: "",
    MANOR_CODEX_PROVIDER: "ollama-cloud"
  } as NodeJS.ProcessEnv);
  const current = buildManorSettingsFromEnv({
    MANOR_WORKER_PROVIDER: "opencode-go",
    MANOR_CODEX_PROVIDER: "ollama-cloud"
  } as NodeJS.ProcessEnv);

  assert.equal(legacy.settings.overview.workerProvider, "openai-codex");
  assert.equal(legacy.provenance.overview, "default");
  assert.equal(current.settings.overview.workerProvider, "opencode-go");
});

test("blank provider seeds do not mark overview settings as env seeded", () => {
  const { settings, provenance } = buildManorSettingsFromEnv({
    MANOR_BUTLER_PROVIDER: "",
    MANOR_WORKER_PROVIDER: "",
    MANOR_CODEX_PROVIDER: ""
  } as NodeJS.ProcessEnv);

  assert.equal(settings.overview.butlerProvider, "openai-codex");
  assert.equal(settings.overview.workerProvider, "openai-codex");
  assert.equal(provenance.overview, "default");
});

test("Ollama Local defaults to disabled without a secret source outside env seed", () => {
  const { settings, provenance } = buildManorSettingsFromEnv({} as NodeJS.ProcessEnv);
  assert.equal(settings.providers.ollamaLocal.enabled, false);
  assert.equal(settings.providers.ollamaLocal.apiKeySource, null);
  assert.equal(provenance["providers.ollamaLocal"], "default");
});

test("legacy model task runner settings are ignored", () => {
  const settings = normalizeManorSettings({
    modelTasks: {
      runnerMode: "codex",
      sessionTitleModel: "ollama-local/qwen3.5:0.8b"
    }
  });
  assert.equal("runnerMode" in settings.modelTasks, false);
  assert.equal(settings.modelTasks.sessionTitleModel, "ollama-local/qwen3.5:0.8b");

  const seeded = buildManorSettingsFromEnv({ MANOR_MODEL_TASK_RUNNER: "pi" } as NodeJS.ProcessEnv);
  assert.equal("runnerMode" in seeded.settings.modelTasks, false);
});

test("ManorSettingsService removes legacy runner mode from persisted settings", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "manor-settings-migration-"));
  const dbPath = path.join(dir, "settings.sqlite");
  try {
    const original = new ManorSettingsService(dbPath, {} as NodeJS.ProcessEnv);
    await original.load();
    const SQL = await initSqlJs({ locateFile: (file) => require.resolve(`sql.js/dist/${file}`) });
    const db = new SQL.Database(new Uint8Array(await readFile(dbPath)));
    const legacy = { ...original.getSettings().modelTasks, runnerMode: "codex" };
    db.run(
      "UPDATE settings_groups SET value_json = ? WHERE profile_id = ? AND group_key = ?;",
      [JSON.stringify(legacy), "active", "modelTasks"]
    );
    await writeFile(dbPath, Buffer.from(db.export()));
    db.close();

    const migrated = new ManorSettingsService(dbPath, {} as NodeJS.ProcessEnv);
    await migrated.load();
    assert.equal("runnerMode" in migrated.getSettings().modelTasks, false);
    const migratedDb = new SQL.Database(new Uint8Array(await readFile(dbPath)));
    const persisted = migratedDb.exec("SELECT value_json FROM settings_groups WHERE profile_id = 'active' AND group_key = 'modelTasks';")[0]?.values[0]?.[0];
    migratedDb.close();
    assert.equal(typeof persisted === "string" && persisted.includes("runnerMode"), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("ManorSettingsService seeds env once and preserves UI edits", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "manor-settings-"));
  const dbPath = path.join(dir, "settings.sqlite");
  try {
    const first = new ManorSettingsService(dbPath, {
      MANOR_OLLAMA_CLOUD_BASE_URL: "https://first.example/v1",
      OLLAMA_API_KEY: "super-secret-value"
    } as NodeJS.ProcessEnv);
    await first.load();
    assert.equal(first.getSettings().providers.ollamaCloud.baseUrl, "https://first.example/v1");
    assert.equal(first.getProvenance()["providers.ollamaCloud"], "env_seed");

    await first.patch({ providers: { ollamaCloud: { baseUrl: "https://ui.example/v1" } } } as never);
    assert.equal(first.getProvenance()["providers.ollamaCloud"], "ui");

    const second = new ManorSettingsService(dbPath, {
      MANOR_OLLAMA_CLOUD_BASE_URL: "https://second.example/v1",
      OLLAMA_API_KEY: "another-secret"
    } as NodeJS.ProcessEnv);
    await second.load();
    assert.equal(second.getSettings().providers.ollamaCloud.baseUrl, "https://ui.example/v1");
    assert.equal(second.getProvenance()["providers.ollamaCloud"], "ui");

    const bytes = await readFile(dbPath);
    assert.equal(bytes.includes(Buffer.from("super-secret-value")), false);
    assert.equal(bytes.includes(Buffer.from("another-secret")), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("content admission settings support defaults, env seeds, and UI persistence", async () => {
  assert.equal(normalizeManorSettings({}).security.contentAdmissionMode, "review");
  assert.equal(normalizeManorSettings({}).security.contentAdmissionModel, null);
  assert.equal(normalizeManorSettings({ security: { contentAdmissionMode: "invalid" } }).security.contentAdmissionMode, "review");
  const dbPath = path.join(await mkdtemp(path.join(os.tmpdir(), "manor-settings-car-")), "settings.sqlite");
  const seeded = new ManorSettingsService(dbPath, {
    MANOR_CONTENT_ADMISSION_MODE: "enforce",
    MANOR_CONTENT_ADMISSION_MODEL: "ollama-cloud/reviewer"
  } as NodeJS.ProcessEnv);
  await seeded.load();
  assert.equal(seeded.getSettings().security.contentAdmissionMode, "enforce");
  assert.equal(seeded.getSettings().security.contentAdmissionModel, "ollama-cloud/reviewer");
  await seeded.patch({ security: { contentAdmissionMode: "off", contentAdmissionModel: "openai-codex/reviewer" } });
  const reloaded = new ManorSettingsService(dbPath, { MANOR_CONTENT_ADMISSION_MODE: "review" } as NodeJS.ProcessEnv);
  await reloaded.load();
  assert.equal(reloaded.getSettings().security.contentAdmissionMode, "off");
  assert.equal(reloaded.getSettings().security.contentAdmissionModel, "openai-codex/reviewer");
  assert.equal(reloaded.getProvenance().security, "ui");
});

test("ManorSettingsService ignores retired provider patches", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "manor-settings-provider-patch-"));
  const dbPath = path.join(dir, "settings.sqlite");
  try {
    const service = new ManorSettingsService(dbPath, {} as NodeJS.ProcessEnv);
    await service.load();

    await service.patch({ overview: { codexProvider: "ollama-cloud" } } as never);
    assert.equal(service.getSettings().overview.workerProvider, "openai-codex");

    await service.patch({ overview: { workerProvider: "opencode-go", codexProvider: "ollama-local" } } as never);
    assert.equal(service.getSettings().overview.workerProvider, "opencode-go");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("ManorSettingsService records validation status", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "manor-settings-"));
  const dbPath = path.join(dir, "settings.sqlite");
  try {
    const service = new ManorSettingsService(dbPath, {} as NodeJS.ProcessEnv);
    await service.load();
    await service.setValidation("piRpc", { status: "ok", message: "ready", lastCheckedAt: 123 });
    assert.deepEqual(service.getValidation().piRpc, { status: "ok", message: "ready", lastCheckedAt: 123 });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("operator timezone defaults to UTC and validates IANA names", () => {
  assert.equal(normalizeManorSettings({}).overview.operatorTimezone, "UTC");
  assert.equal(normalizeManorSettings({ overview: { operatorTimezone: "Europe/Berlin" } }).overview.operatorTimezone, "Europe/Berlin");
  assert.equal(normalizeManorSettings({ overview: { operatorTimezone: "  America/New_York  " } }).overview.operatorTimezone, "America/New_York");
  assert.equal(normalizeManorSettings({ overview: { operatorTimezone: "Mars/Olympus" } }).overview.operatorTimezone, "UTC");
  assert.equal(normalizeManorSettings({ overview: { operatorTimezone: "" } }).overview.operatorTimezone, "UTC");
});

test("MANOR_OPERATOR_TIMEZONE seeds the overview group when set", () => {
  const seeded = buildManorSettingsFromEnv({ MANOR_OPERATOR_TIMEZONE: "Europe/Berlin" } as NodeJS.ProcessEnv);
  assert.equal(seeded.settings.overview.operatorTimezone, "Europe/Berlin");
  assert.equal(seeded.provenance.overview, "env_seed");
  const blank = buildManorSettingsFromEnv({ MANOR_OPERATOR_TIMEZONE: "" } as NodeJS.ProcessEnv);
  assert.equal(blank.settings.overview.operatorTimezone, "UTC");
  assert.equal(blank.provenance.overview, "default");
  const invalid = buildManorSettingsFromEnv({ MANOR_OPERATOR_TIMEZONE: "Not/A_Zone" } as NodeJS.ProcessEnv);
  assert.equal(invalid.settings.overview.operatorTimezone, "UTC");
  assert.equal(invalid.provenance.overview, "env_seed");
});

test("operator timezone persists and round-trips through the settings service", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "manor-settings-tz-"));
  const dbPath = path.join(dir, "settings.sqlite");
  try {
    const service = new ManorSettingsService(dbPath, {} as NodeJS.ProcessEnv);
    await service.load();
    await service.patch({ overview: { operatorTimezone: "Europe/Berlin" } } as never);
    assert.equal(service.getSettings().overview.operatorTimezone, "Europe/Berlin");
    assert.equal(service.getProvenance().overview, "ui");
    const reloaded = new ManorSettingsService(dbPath, {} as NodeJS.ProcessEnv);
    await reloaded.load();
    assert.equal(reloaded.getSettings().overview.operatorTimezone, "Europe/Berlin");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
