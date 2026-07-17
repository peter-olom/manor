import assert from "node:assert/strict";
import test from "node:test";

import { ManorModelTaskRunner, modelTaskTransport, selectAuthenticatedPiModel, withinDeadline } from "../../src/server/model-task-runner.js";

test("model tasks always use Pi for every provider", () => {
  assert.equal(modelTaskTransport("openai-codex/gpt-5.5", true), "pi");
  assert.equal(modelTaskTransport("openai/gpt-5.5", true), "pi");
  assert.equal(modelTaskTransport("opencode-go/deepseek-v4-flash", true), "pi");
  assert.equal(modelTaskTransport("ollama-cloud/qwen3.5:397b", true), "pi");
  assert.equal(modelTaskTransport("ollama-local/qwen3.5:0.8b", true), "pi");
});

test("automatic model tasks use Pi", () => {
  assert.equal(modelTaskTransport(null, true), "pi");
  assert.equal(modelTaskTransport(null, false), "pi");
});

test("model task runner invokes Pi for OpenAI and other providers", async () => {
  const calls: string[] = [];
  const runner = new ManorModelTaskRunner({
    stateDir: "/tmp/model-tasks",
    piAuthPath: "/tmp/pi-auth.json",
    piExecutor: async (input) => { calls.push(`pi:${input.model.provider}/${input.model.model}`); return "pi"; }
  });

  assert.equal(await runner.runText({ purpose: "test", prompt: "test", timeoutMs: 100, model: "openai-codex/gpt-5.5" }), "pi");
  assert.equal(await runner.runText({ purpose: "test", prompt: "test", timeoutMs: 100, model: "opencode-go/glm-5.2" }), "pi");
  assert.deepEqual(calls, ["pi:openai-codex/gpt-5.5", "pi:opencode-go/glm-5.2"]);
});

test("automatic Pi selection can select authenticated OpenAI models", async () => {
  const codexModel = { id: "gpt-5.5", provider: "openai-codex" } as never;
  const unavailable = { id: "first", provider: "ollama-cloud" } as never;
  const authenticated = { id: "second", provider: "opencode-go" } as never;
  const selected = await selectAuthenticatedPiModel(
    [codexModel, unavailable, authenticated],
    { provider: null, model: null },
    async (model) => model === authenticated || model === codexModel
      ? { ok: true, apiKey: "test-key" }
      : { ok: false, error: "missing key" }
  );
  assert.equal(selected.model, codexModel);
});

test("explicit Pi authentication failures include remediation", async () => {
  const selected = { id: "glm-5.2", provider: "opencode-go" } as never;
  await assert.rejects(
    selectAuthenticatedPiModel(
      [selected],
      { provider: "opencode-go", model: "glm-5.2" },
      async () => ({ ok: false, error: "expired key" })
    ),
    /Open Settings → Providers/
  );
});

test("model task deadline covers supporting work between completion rounds", async () => {
  await assert.rejects(
    withinDeadline(new Promise((resolve) => setTimeout(resolve, 30)), Date.now() + 5, "session title"),
    /session title timed out/
  );
});

test("model task deadline includes Pi execution", async () => {
  const runner = new ManorModelTaskRunner({
    stateDir: "/tmp/model-tasks",
    piAuthPath: "/tmp/pi-auth.json",
    piExecutor: async () => new Promise((resolve) => setTimeout(() => resolve("late"), 30))
  });
  await assert.rejects(
    runner.runText({ purpose: "session title", prompt: "test", timeoutMs: 5, model: null }),
    /session title timed out/
  );
});

test("expired OpenAI credentials from Pi surface provider remediation", async () => {
  const runner = new ManorModelTaskRunner({
    stateDir: "/tmp/model-tasks",
    piAuthPath: "/tmp/pi-auth.json",
    piExecutor: async () => { throw new Error("401 expired token"); }
  });
  await assert.rejects(
    runner.runText({ purpose: "session title", prompt: "test", timeoutMs: 100, model: "openai-codex/gpt-5.5" }),
    /Open Settings → Providers/
  );
});
