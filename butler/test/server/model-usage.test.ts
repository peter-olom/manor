import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { getModels } from "@earendil-works/pi-ai/compat";

import { resolveModelCostEstimate } from "../../src/server/model-cost-estimates.js";
import { summarizeUsage, usageSamplesFromPiEntries } from "../../src/server/model-usage.js";
import { ModelUsageStore } from "../../src/server/model-usage-store.js";

function assistantEntry(input: { id?: string; provider: string; model: string; at?: number; input: number; output: number; cacheRead?: number }) {
  const at = input.at ?? Date.now();
  return {
    type: "message",
    id: input.id ?? "assistant-1",
    parentId: "user-1",
    timestamp: new Date(at).toISOString(),
    message: {
      role: "assistant",
      content: [{ type: "text", text: "done" }],
      api: "openai-completions",
      provider: input.provider,
      model: input.model,
      usage: {
        input: input.input,
        output: input.output,
        cacheRead: input.cacheRead ?? 0,
        cacheWrite: 0,
        totalTokens: input.input + input.output + (input.cacheRead ?? 0),
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
      },
      stopReason: "stop",
      timestamp: at
    }
  };
}

test("historical OpenCode Go usage is repriced from Pi model metadata", () => {
  const model = getModels("opencode-go" as never).find((entry) => entry.id === "glm-5.2")!;
  const samples = usageSamplesFromPiEntries([
    assistantEntry({ provider: "opencode-go", model: "glm-5.2", input: 1_000_000, output: 1_000_000, cacheRead: 1_000_000 }) as never
  ], "session-1", [model]);
  const usage = summarizeUsage(samples);

  assert.equal(usage.cost.basis, "usage");
  assert.equal(usage.cost.input, 1.4);
  assert.equal(usage.cost.output, 4.4);
  assert.equal(usage.cost.cacheRead, 0.26);
  assert.equal(usage.cost.total, 6.0600000000000005);
});

test("unknown Ollama Cloud usage stays included instead of borrowing token prices", () => {
  const samples = usageSamplesFromPiEntries([
    assistantEntry({ provider: "ollama-cloud", model: "unknown-cloud-model", input: 500, output: 100 }) as never
  ], "session-1", []);
  const usage = summarizeUsage(samples);

  assert.equal(usage.cost.basis, "included");
  assert.equal(usage.cost.total, 0);
  assert.equal(usage.unpricedModels, 1);
});

test("Ollama Cloud usage uses the model maker API rate as an estimate", () => {
  const samples = usageSamplesFromPiEntries([
    assistantEntry({ provider: "ollama-cloud", model: "deepseek-v4-pro", input: 1_000_000, output: 1_000_000, cacheRead: 1_000_000 }) as never
  ], "session-1", []);
  const usage = summarizeUsage(samples);

  assert.equal(usage.cost.basis, "estimated");
  assert.equal(usage.cost.input, 0.435);
  assert.equal(usage.cost.output, 0.87);
  assert.equal(usage.cost.cacheRead, 0.003625);
  assert.equal(usage.cost.total, 1.308625);
});

test("Ollama usage reuses an exact OpenCode model price as an estimate", () => {
  const pricingModel = {
    provider: "opencode-go",
    id: "shared-model",
    cost: { input: 2, output: 4, cacheRead: 1, cacheWrite: 2 }
  };
  const samples = usageSamplesFromPiEntries([
    assistantEntry({ provider: "ollama-cloud", model: "shared-model", input: 1_000_000, output: 1_000_000 }) as never
  ], "session-1", [pricingModel]);
  const usage = summarizeUsage(samples);

  assert.equal(usage.cost.basis, "estimated");
  assert.equal(usage.cost.input, 2);
  assert.equal(usage.cost.output, 4);
  assert.equal(usage.cost.total, 6);
});

test("maker estimate aliases resolve to the same published rate", () => {
  assert.deepEqual(resolveModelCostEstimate("google/gemma-4-31b-it"), resolveModelCostEstimate("gemma4:31b"));
  assert.equal(resolveModelCostEstimate("z-ai/glm-5")?.cost.input, 1);
  assert.equal(resolveModelCostEstimate("MiniMax-M2.1")?.cost.cacheRead, 0.03);
  assert.equal(resolveModelCostEstimate("devstral-small-2:24b")?.cachePolicy, "input-rate");
  assert.equal(resolveModelCostEstimate("not-a-real-model"), null);
});

test("provider aggregation deduplicates sessions across models", () => {
  const samples = usageSamplesFromPiEntries([
    assistantEntry({ id: "one", provider: "ollama-cloud", model: "glm-5.2", input: 500, output: 100 }) as never,
    assistantEntry({ id: "two", provider: "ollama-cloud", model: "minimax-m2.5", input: 300, output: 50 }) as never
  ], "session-1", []);
  const usage = summarizeUsage(samples);

  assert.equal(usage.providers.length, 1);
  assert.equal(usage.providers[0]?.sessions, 1);
  assert.equal(usage.providers[0]?.modelCount, 2);
  assert.equal(usage.providers[0]?.requests, 2);
  assert.equal(usage.providers[0]?.cost.basis, "estimated");
});

test("recorded cost survives when a model is no longer in the current catalog", () => {
  const entry = assistantEntry({ provider: "retired-provider", model: "retired-model", input: 500, output: 100 });
  entry.message.usage.cost = { input: 0.5, output: 0.2, cacheRead: 0, cacheWrite: 0, total: 0.7 };
  const usage = summarizeUsage(usageSamplesFromPiEntries([entry], "session-1", []));

  assert.equal(usage.cost.basis, "metered");
  assert.equal(usage.cost.total, 0.7);
});

test("usage store deduplicates copied Pi history and keeps reset as a durable baseline", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "manor-usage-"));
  const piRoot = path.join(root, "pi");
  await fs.mkdir(path.join(piRoot, "one"), { recursive: true });
  await fs.mkdir(path.join(piRoot, "two"), { recursive: true });
  const event = assistantEntry({ id: "copied-entry", provider: "opencode-go", model: "glm-5.2", at: Date.now() - 10_000, input: 1_000, output: 100 });
  const writeSession = async (directory: string, id: string) => fs.writeFile(path.join(directory, `${id}.jsonl`), [
    JSON.stringify({ type: "session", id, timestamp: new Date().toISOString(), cwd: "/repos" }),
    JSON.stringify(event)
  ].join("\n"));
  await writeSession(path.join(piRoot, "one"), "one");
  await writeSession(path.join(piRoot, "two"), "two");
  const model = getModels("opencode-go" as never).find((entry) => entry.id === "glm-5.2")!;
  const options = {
    dbPath: path.join(root, "usage.sqlite"),
    butlerPiRoots: [piRoot],
    workerPiRoots: [],
    codexRoots: [],
    loadPiPricing: async () => ({ models: [model], oauthKeys: new Set<string>() })
  };
  const store = new ModelUsageStore(options);
  const before = await store.get("all");
  assert.equal(before.summary.requests, 1);
  assert.equal(before.summary.tokens.total, 1_100);

  const resetAt = await store.reset();
  const reloaded = new ModelUsageStore(options);
  const after = await reloaded.get("all");
  assert.equal(after.resetAt, resetAt);
  assert.equal(after.summary.requests, 0);
  await fs.rm(root, { recursive: true, force: true });
});

test("usage store imports Codex input, cache, and output as estimated list cost", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "manor-codex-usage-"));
  const codexRoot = path.join(root, "codex");
  await fs.mkdir(codexRoot, { recursive: true });
  const file = path.join(codexRoot, "rollout.jsonl");
  await fs.writeFile(file, [
    JSON.stringify({ timestamp: new Date().toISOString(), type: "session_meta", payload: { id: "codex-session" } }),
    JSON.stringify({ timestamp: new Date().toISOString(), type: "turn_context", payload: { model: "gpt-5.4-mini" } }),
    JSON.stringify({ timestamp: new Date().toISOString(), type: "event_msg", payload: { type: "token_count", info: {
      total_token_usage: { input_tokens: 1_000, cached_input_tokens: 200, output_tokens: 100, total_tokens: 1_100 },
      last_token_usage: { input_tokens: 1_000, cached_input_tokens: 200, output_tokens: 100, total_tokens: 1_100 }
    } } })
  ].join("\n"));
  const store = new ModelUsageStore({
    dbPath: path.join(root, "usage.sqlite"),
    butlerPiRoots: [], workerPiRoots: [], codexRoots: [codexRoot],
    loadPiPricing: async () => ({ models: [], oauthKeys: new Set<string>() })
  });
  const usage = await store.get("all");
  assert.equal(usage.summary.tokens.input, 800);
  assert.equal(usage.summary.tokens.cacheRead, 200);
  assert.equal(usage.summary.tokens.output, 100);
  assert.equal(usage.summary.cost.basis, "estimated");
  assert.ok(usage.summary.cost.total > 0);
  await fs.rm(root, { recursive: true, force: true });
});
