import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { CodexExecMemoryPromotionService } from "../../src/server/memory-promotion.js";
import { MemoryUpdateScheduler } from "../../src/server/memory-update-scheduler.js";
import { ButlerStateStore } from "../../src/server/state-store.js";
import type { CodexThreadExecutionContractView, MemorySynthesisConfig } from "../../src/server/types.js";

async function createStore(): Promise<{ store: ButlerStateStore; stateDir: string }> {
  const stateDir = await mkdtemp(path.join(tmpdir(), "manor-memory-promotion-test-"));
  return { store: new ButlerStateStore(path.join(stateDir, "state.json")), stateDir };
}

function testConfig(overrides: Partial<MemorySynthesisConfig> = {}): MemorySynthesisConfig {
  return {
    enabled: true,
    model: null,
    effort: null,
    timeoutMs: 90_000,
    maxInputChars: 16_000,
    maxCandidatesPerRun: 6,
    promotionAutoResolve: true,
    promotionBatchSize: 20,
    promotionMaxBatchesPerRun: 10,
    promotionIntervalMs: 10_000,
    ...overrides
  };
}

function contract(threadId = "thread-1"): CodexThreadExecutionContractView {
  return {
    threadId,
    workspaceCwd: "/workspace",
    projectId: "project-1",
    projectLabel: "Project One",
    branch: "main",
    requestedTask: "Review memory candidates",
    operatorGoal: "Accept useful memory without operator review",
    acceptancePoints: ["Resolve memory candidates"],
    proofExpectation: "none",
    proofExpectationLabel: "no explicit proof request",
    notes: []
  };
}

test("memory promotion resolver auto accepts and rejects pending candidates", async () => {
  const { store, stateDir } = await createStore();
  const scheduler = new MemoryUpdateScheduler({ store, stateDir, codexHomeDir: stateDir, config: testConfig() });
  store.upsertThreadSummary({ id: "thread-1", cwd: "/workspace", createdAt: 1, status: "running" });
  store.setThreadExecutionContract("thread-1", contract());
  const durable = store.submitJobMemoryPromotionCandidate("thread-1", {
    kind: "decision",
    summary: "PR #18 changed the memory promotion queue to auto resolve.",
    details: "This is durable repo state.",
    sourceEntryId: "worker-report:turn-1:candidate:durable",
    context: { projectId: "project-1", projectLabel: "Project One" }
  });
  const noisy = store.submitJobMemoryPromotionCandidate("thread-1", {
    kind: "checkpoint",
    summary: "Finish by committing and opening a draft PR.",
    details: "This is one-off job process noise.",
    sourceEntryId: "worker-report:turn-1:candidate:noisy",
    context: { projectId: "project-1", projectLabel: "Project One" }
  });
  let prompt = "";
  const resolver = new CodexExecMemoryPromotionService({
    store,
    memoryScheduler: scheduler,
    stateDir,
    codexHomeDir: stateDir,
    config: testConfig(),
    runner: async (input) => {
      prompt = input.prompt;
      return {
        decisions: [
          { candidateId: durable.id, accepted: true, confidence: "high", reason: "Durable repo state." },
          { candidateId: noisy.id, accepted: false, confidence: "high", reason: "Temporary job instruction." }
        ]
      };
    }
  });

  const stats = await resolver.drainPendingCandidates();

  assert.equal(stats.resolved, 2);
  assert.equal(stats.accepted, 1);
  assert.equal(stats.rejected, 1);
  assert.match(prompt, new RegExp(durable.id));
  assert.match(prompt, /existingProjectMemory/);
  assert.equal(store.listPendingPromotionCandidates("project-1").length, 0);
  assert.equal(store.getProjectMemory("project-1")?.entries[0]?.summary, durable.summary);
  assert.equal(store.getJobMemory("thread-1")?.promotionCandidates.find((entry) => entry.id === noisy.id)?.status, "rejected");
  assert.equal(store.listMemoryGraph().synthesisQueue.some((entry) => entry.reason === "promotion resolved"), false);
});

test("accepted duplicate candidates do not append duplicate project memory entries", async () => {
  const { store } = await createStore();
  store.submitJobMemoryPromotionCandidate("thread-1", {
    kind: "checkpoint",
    summary: "PR #17 merged: memory synthesis JSON schema fix is now on main.",
    sourceEntryId: "synthesis:syn-1:candidate:one",
    context: { projectId: "project-1", projectLabel: "Project One" }
  });
  store.submitJobMemoryPromotionCandidate("thread-1", {
    kind: "checkpoint",
    summary: "PR #17 merged: memory synthesis JSON schema fix is now on main.",
    sourceEntryId: "synthesis:syn-2:candidate:two",
    context: { projectId: "project-1", projectLabel: "Project One" }
  });
  const candidates = store.listPendingPromotionCandidates("project-1");

  store.resolvePromotionCandidate(candidates[0]!.id, true);
  store.resolvePromotionCandidate(candidates[1]!.id, true);

  assert.equal(store.getProjectMemory("project-1")?.entries.length, 1);
  assert.equal(store.getProjectMemory("project-1")?.summary, "PR #17 merged: memory synthesis JSON schema fix is now on main.");
});

test("memory promotion model env overrides the global synthesis model", async () => {
  const { store, stateDir } = await createStore();
  const scheduler = new MemoryUpdateScheduler({ store, stateDir, codexHomeDir: stateDir, config: testConfig({ model: "gpt-5.4-mini" }) });
  store.upsertThreadSummary({ id: "thread-1", cwd: "/workspace", createdAt: 1, status: "running" });
  store.setThreadExecutionContract("thread-1", contract());
  const candidate = store.submitJobMemoryPromotionCandidate("thread-1", {
    kind: "decision",
    summary: "Promotion-specific model should win.",
    sourceEntryId: "worker-report:turn-1:candidate:model",
    context: { projectId: "project-1", projectLabel: "Project One" }
  });
  const binDir = await mkdtemp(path.join(tmpdir(), "manor-memory-promotion-model-bin-"));
  const fakeCodexPath = path.join(binDir, "codex");
  const invocationsPath = path.join(binDir, "invocations.jsonl");
  await writeFile(
    fakeCodexPath,
    [
      "#!/usr/bin/env node",
      'const fs = require("node:fs");',
      "const args = process.argv.slice(2);",
      `fs.appendFileSync(${JSON.stringify(invocationsPath)}, JSON.stringify(args) + "\\n");`,
      'const outputIndex = args.indexOf("--output-last-message");',
      "if (outputIndex === -1 || !args[outputIndex + 1]) process.exit(2);",
      "fs.writeFileSync(",
      "  args[outputIndex + 1],",
      `  JSON.stringify({ decisions: [{ candidateId: ${JSON.stringify(candidate.id)}, accepted: false, confidence: "high", reason: "Regression test." }] })`,
      ");"
    ].join("\n"),
    "utf8"
  );
  await chmod(fakeCodexPath, 0o755);
  const originalPath = process.env.PATH;
  const originalModel = process.env.MANOR_MEMORY_PROMOTION_MODEL;
  process.env.PATH = `${binDir}${path.delimiter}${originalPath ?? ""}`;
  process.env.MANOR_MEMORY_PROMOTION_MODEL = "gpt-5.5";
  try {
    const resolver = new CodexExecMemoryPromotionService({
      store,
      memoryScheduler: scheduler,
      stateDir,
      codexHomeDir: stateDir,
      config: testConfig({ model: "gpt-5.4-mini", timeoutMs: 5_000 })
    });

    await resolver.drainPendingCandidates();
    const invocations = (await readFile(invocationsPath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as string[]);
    const modelIndex = invocations[0]?.indexOf("--model") ?? -1;

    assert.deepEqual(invocations[0]?.slice(modelIndex, modelIndex + 2), ["--model", "gpt-5.5"]);
  } finally {
    process.env.PATH = originalPath;
    if (originalModel === undefined) {
      delete process.env.MANOR_MEMORY_PROMOTION_MODEL;
    } else {
      process.env.MANOR_MEMORY_PROMOTION_MODEL = originalModel;
    }
  }
});
