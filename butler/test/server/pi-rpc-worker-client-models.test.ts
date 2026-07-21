import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { PiRpcWorkerClient, selectOpenAiAuthCheckModel } from "../../src/server/pi-rpc-worker-client.js";
import type { ModelOption } from "../../src/server/types.js";

function jwt(payload: Record<string, unknown>): string {
  return `header.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.signature`;
}

function model(id: string, provider: string): ModelOption {
  return { id, label: id, provider, supportsReasoning: false, supportedThinkingLevels: [], supportedReasoningEfforts: [], defaultReasoningEffort: null };
}

test("Worker auth check validates the authentication mode shown in settings", () => {
  const api = model("gpt-5.4", "openai");
  const chatGpt = model("gpt-5.4", "openai-codex");
  const models = [api, chatGpt];

  assert.equal(selectOpenAiAuthCheckModel(models, api.provider, api.id, "chatgpt"), chatGpt);
  assert.equal(selectOpenAiAuthCheckModel(models, chatGpt.provider, chatGpt.id, "api"), api);
  assert.equal(selectOpenAiAuthCheckModel(models, api.provider, api.id, "none"), api);
});

test("Worker Pi exposes OpenAI models only from its own authenticated provider", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "manor-worker-models-"));
  const piAuthPath = path.join(root, "auth.json");
  const previous = {
    local: process.env.MANOR_OLLAMA_LOCAL_ENABLED,
    cloud: process.env.MANOR_OLLAMA_CLOUD_ENABLED,
    go: process.env.MANOR_OPENCODE_GO_ENABLED
  };
  process.env.MANOR_OLLAMA_LOCAL_ENABLED = "0";
  process.env.MANOR_OLLAMA_CLOUD_ENABLED = "0";
  process.env.MANOR_OPENCODE_GO_ENABLED = "0";
  t.after(() => {
    if (previous.local === undefined) delete process.env.MANOR_OLLAMA_LOCAL_ENABLED; else process.env.MANOR_OLLAMA_LOCAL_ENABLED = previous.local;
    if (previous.cloud === undefined) delete process.env.MANOR_OLLAMA_CLOUD_ENABLED; else process.env.MANOR_OLLAMA_CLOUD_ENABLED = previous.cloud;
    if (previous.go === undefined) delete process.env.MANOR_OPENCODE_GO_ENABLED; else process.env.MANOR_OPENCODE_GO_ENABLED = previous.go;
  });

  await writeFile(piAuthPath, "{}", "utf8");
  const client = new PiRpcWorkerClient({
    store: {} as never,
    piAuthPath,
    sessionRootDir: path.join(root, "sessions")
  });
  await client.start();
  assert.equal(client.getConnectionState().compose.availableModels.some((model) => model.provider === "openai" || model.provider === "openai-codex"), false);

  await writeFile(piAuthPath, JSON.stringify({ openai: { type: "api_key", key: "sk-worker-test" } }), "utf8");
  await client.refreshModels();
  assert.equal(client.getConnectionState().compose.availableModels.some((model) => model.provider === "openai"), true);
  assert.equal(client.getConnectionState().compose.availableModels.some((model) => model.provider === "openai-codex"), false);

  const access = jwt({
    exp: Math.floor(Date.now() / 1000) + 3600,
    "https://api.openai.com/auth": { chatgpt_account_id: "account-1" }
  });
  await writeFile(piAuthPath, JSON.stringify({
    "openai-codex": {
      type: "oauth",
      access,
      refresh: "worker-refresh-token",
      expires: Date.now() + 3600000,
      accountId: "account-1"
    }
  }), "utf8");
  await client.refreshModels();
  const models = client.getConnectionState().compose.availableModels;
  assert.equal(models.some((model) => model.provider === "openai"), false);
  assert.equal(models.some((model) => model.provider === "openai-codex" && model.id === "gpt-5.4"), true);
  assert.deepEqual(
    { mode: (await client.getAuthStatus()).mode, loggedIn: (await client.getAuthStatus()).loggedIn },
    { mode: "chatgpt", loggedIn: true }
  );
});
