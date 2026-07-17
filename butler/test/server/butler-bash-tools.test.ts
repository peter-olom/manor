import assert from "node:assert/strict";
import test from "node:test";

import { buildButlerBashTools } from "../../src/server/butler-agent-bash-tools.js";
import type { ButlerAgentToolAccess } from "../../src/server/butler-agent-tool-access.js";

function tool() {
  const tools = buildButlerBashTools({
    defineButlerTool: (definition) => definition,
    getToolUiEffects: () => []
  } as unknown as ButlerAgentToolAccess);
  return tools[0] as unknown as {
    execute: (toolCallId: string, params: { script: string }, signal?: AbortSignal) => Promise<{
      content: Array<{ text: string }>;
      details: { stdout: string; stderr: string; exitCode: number; timezone: string };
    }>;
  };
}

test("Butler bash returns the live clock in the configured timezone", async () => {
  const before = Date.now();
  const result = await tool().execute("clock", { script: "date +%s" });
  const after = Date.now();
  const epochMs = Number(result.details.stdout.trim()) * 1_000;
  assert.ok(epochMs >= before - 1_000 && epochMs <= after);
  assert.equal(result.details.exitCode, 0);
  assert.match(result.content[0]?.text ?? "", /exitCode: 0/);
});

test("Butler bash exposes only date and starts with a fresh in-memory filesystem", async () => {
  const unavailable = await tool().execute("blocked", { script: "echo nope" });
  assert.notEqual(unavailable.details.exitCode, 0);
  assert.match(unavailable.details.stderr, /command not found/);

  const write = await tool().execute("write", { script: "date > /tmp/clock" });
  assert.equal(write.details.exitCode, 0);
  const read = await tool().execute("read", { script: "date -r /tmp/clock" });
  assert.notEqual(read.details.exitCode, 0);
});
