import assert from "node:assert/strict";
import test from "node:test";

import { buildButlerBashTools } from "../../src/server/butler-agent-bash-tools.js";
import type { ButlerAgentToolAccess } from "../../src/server/butler-agent-tool-access.js";

function tool(execute = async () => ({
  stdout: "ok\n",
  stderr: "",
  exitCode: 0,
  signal: null,
  timedOut: false,
  truncated: false
})) {
  const tools = buildButlerBashTools({
    runtimeThreadId: "butler-test",
    defineButlerTool: (definition) => definition,
    getToolUiEffects: () => [],
    butlerExecutorClient: { execute }
  } as unknown as ButlerAgentToolAccess);
  return tools[0] as unknown as {
    execute: (toolCallId: string, params: { script: string }, signal?: AbortSignal) => Promise<{
      content: Array<{ text: string }>;
      details: { stdout: string; stderr: string; exitCode: number; timezone: string; timedOut: boolean; truncated: boolean };
    }>;
  };
}

test("Butler bash delegates to the bounded executor", async () => {
  let received: Record<string, unknown> | null = null;
  const result = await tool(async (input) => {
    received = input;
    return { stdout: "1721476800\n", stderr: "", exitCode: 0, signal: null, timedOut: false, truncated: false };
  }).execute("clock", { script: "date +%s", timeoutMs: 5_000 });
  assert.equal(received?.script, "date +%s");
  assert.equal(received?.threadId, "butler-test");
  assert.equal(received?.timeoutMs, 5_000);
  assert.equal(typeof received?.timezone, "string");
  assert.equal(result.details.exitCode, 0);
  assert.match(result.content[0]?.text ?? "", /exitCode: 0/);
});

test("Butler bash reports executor bounds in its result", async () => {
  const result = await tool(async () => ({
    stdout: "partial",
    stderr: "deadline reached",
    exitCode: 1,
    signal: "SIGTERM",
    timedOut: true,
    truncated: true
  })).execute("bounded", { script: "long-command" });
  assert.match(result.content[0]?.text ?? "", /timedOut: true/);
  assert.match(result.content[0]?.text ?? "", /outputTruncated: true/);
});

test("Butler bash fails clearly when the executor is unavailable", async () => {
  const tools = buildButlerBashTools({
    runtimeThreadId: "butler-test",
    defineButlerTool: (definition) => definition,
    getToolUiEffects: () => [],
    butlerExecutorClient: null
  } as unknown as ButlerAgentToolAccess);
  const execute = (tools[0] as unknown as { execute: (id: string, params: { script: string }) => Promise<unknown> }).execute;
  await assert.rejects(() => execute("missing", { script: "date" }), /executor is unavailable/i);
});
