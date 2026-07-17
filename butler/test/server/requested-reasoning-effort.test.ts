import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { displayThinkingLevelForModelOption, displayThinkingLevelForPiLevel, piThinkingLevelForButlerLevel, piThinkingLevelForEffort, piThinkingLevelForModelOption } from "../../src/server/pi-thinking-levels.js";
import { ButlerStateStore } from "../../src/server/state-store.js";
import type { ModelOption } from "../../src/server/types.js";

test("requested xhigh reasoning effort is persisted and restored", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "manor-reasoning-effort-test-"));
  const statePath = path.join(dir, "state.json");
  const store = new ButlerStateStore(statePath);
  store.upsertThreadSummary({ id: "pi-thread", status: "active", source: "pi-rpc", cwd: "/workspace", turns: [{ id: "turn", status: "in_progress", items: [] }] });
  store.setThreadRequestedReasoningEffort("pi-thread", "xhigh", "turn");
  await store.flushSave();
  const restored = new ButlerStateStore(statePath);
  await restored.load();
  assert.equal(restored.getThreadDetail("pi-thread")?.requestedReasoningEffort, "xhigh");
  assert.equal(restored.getThreadDetail("pi-thread")?.turns[0]?.requestedReasoningEffort, "xhigh");
});

test("Pi RPC maps unsupported efforts to the closest Pi thinking level", () => {
  assert.equal(piThinkingLevelForEffort("minimal"), "low");
  assert.equal(piThinkingLevelForEffort("none"), "low");
  assert.equal(piThinkingLevelForEffort("max"), "xhigh");
  assert.equal(piThinkingLevelForEffort("high"), "high");
});

test("Pi thinking translation preserves provider-facing max display", () => {
  assert.equal(piThinkingLevelForButlerLevel("max"), "xhigh");
  assert.equal(piThinkingLevelForButlerLevel("none"), "off");
  assert.equal(displayThinkingLevelForPiLevel("xhigh", ["high", "max"]), "max");
  assert.equal(displayThinkingLevelForPiLevel("xhigh", ["high", "xhigh"]), "xhigh");
});

test("Pi thinking translation preserves provider-native variants", () => {
  const model: ModelOption = {
    id: "minimax-m3",
    label: "MiniMax M3",
    provider: "opencode-go",
    supportsReasoning: true,
    supportedThinkingLevels: ["default", "none", "thinking"],
    supportedReasoningEfforts: [],
    defaultReasoningEffort: null,
    thinkingLevelTransports: { default: "off", none: "minimal", thinking: "xhigh" }
  };
  assert.equal(piThinkingLevelForModelOption("default", model), "off");
  assert.equal(piThinkingLevelForModelOption("none", model), "minimal");
  assert.equal(piThinkingLevelForModelOption("thinking", model), "xhigh");
  assert.equal(displayThinkingLevelForModelOption("off", model), "default");
  assert.equal(displayThinkingLevelForModelOption("minimal", model), "none");
  assert.equal(displayThinkingLevelForModelOption("xhigh", model), "thinking");
});
