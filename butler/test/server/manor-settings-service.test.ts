import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { buildManorSettingsFromEnv } from "../../src/server/manor-settings-schema.js";
import { ManorSettingsService } from "../../src/server/manor-settings-service.js";

test("buildManorSettingsFromEnv parses and clamps seed values", () => {
  const { settings, provenance } = buildManorSettingsFromEnv({
    MANOR_OLLAMA_CLOUD_MODELS: "glm-5.2,kimi-k2.6",
    MANOR_OLLAMA_WEB_SEARCH_MAX_RESULTS: "99",
    MANOR_WORKER_RUNTIME: "pi-rpc",
    MANOR_WORKER_EFFORT: "xhigh",
    MANOR_MEMORY_SYNTHESIS_MAX_CANDIDATES: "99",
    OLLAMA_API_KEY_FILE: "/run/secrets/ollama"
  } as NodeJS.ProcessEnv);

  assert.deepEqual(settings.providers.ollamaCloud.models, ["glm-5.2", "kimi-k2.6"]);
  assert.equal(settings.providers.ollamaCloud.webTools.maxResults, 10);
  assert.equal(settings.worker.runtime, "pi-rpc");
  assert.equal(settings.worker.defaultEffort, "xhigh");
  assert.equal(settings.memory.synthesisMaxCandidatesPerRun, 50);
  assert.deepEqual(settings.providers.ollamaCloud.apiKeySource, { type: "file", pathEnv: "OLLAMA_API_KEY_FILE" });
  assert.equal(provenance["providers.ollamaCloud"], "env_seed");
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

test("ManorSettingsService records validation status", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "manor-settings-"));
  const dbPath = path.join(dir, "settings.sqlite");
  try {
    const service = new ManorSettingsService(dbPath, {} as NodeJS.ProcessEnv);
    await service.load();
    await service.setValidation("codex", { status: "ok", message: "ready", lastCheckedAt: 123 });
    assert.deepEqual(service.getValidation().codex, { status: "ok", message: "ready", lastCheckedAt: 123 });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
