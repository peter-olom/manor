import assert from "node:assert/strict";
import { access, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { runPiRpcAuthCheck } from "../../src/server/pi-rpc-auth-check.js";

test("Worker auth check uses an isolated ephemeral Pi session and removes it", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "manor-worker-auth-check-"));
  let clientOptions: Record<string, unknown> | undefined;
  let stopped = 0;
  try {
    const reply = await runPiRpcAuthCheck({
      piAuthPath: path.join(dir, "agent", "auth.json"),
      sessionRootDir: path.join(dir, "sessions"),
      cliPath: "/worker/pi-rpc-proxy.mjs",
      provider: "openai-codex",
      model: "gpt-5.4",
      timeoutMs: 12_345,
      createClient: (options) => {
        clientOptions = options as Record<string, unknown>;
        return {
          start: async () => undefined,
          stop: async () => { stopped += 1; },
          promptAndWait: async (prompt, images, timeout) => {
            assert.equal(prompt, "hi");
            assert.equal(images, undefined);
            assert.equal(timeout, 12_345);
            return [];
          },
          getMessages: async () => [
            { role: "user", content: [{ type: "text", text: "hi" }], timestamp: 1 },
            { role: "assistant", content: [{ type: "text", text: " Hello " }], stopReason: "stop", timestamp: 2, usage: {} }
          ]
        } as never;
      }
    });

    assert.equal(reply, "Hello");
    assert.equal(stopped, 1);
    assert.equal(clientOptions?.provider, "openai-codex");
    assert.equal(clientOptions?.model, "gpt-5.4");
    assert.equal(clientOptions?.cwd, "/repos");
    const args = clientOptions?.args as string[];
    for (const flag of ["--no-session", "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files", "--no-tools", "--system-prompt"]) {
      assert.equal(args.includes(flag), true, `missing ${flag}`);
    }
    const sessionDir = args[args.indexOf("--session-dir") + 1]!;
    assert.match(String((clientOptions?.env as Record<string, string>).MANOR_THREAD_ID), /^pi-auth-check-/);
    await assert.rejects(() => access(sessionDir), { code: "ENOENT" });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("Worker auth check rejects provider errors and still stops and cleans up", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "manor-worker-auth-failure-"));
  let sessionDir = "";
  let stopped = 0;
  try {
    await assert.rejects(() => runPiRpcAuthCheck({
      piAuthPath: path.join(dir, "agent", "auth.json"),
      sessionRootDir: path.join(dir, "sessions"),
      cliPath: "/worker/pi-rpc-proxy.mjs",
      provider: "openai-codex",
      model: "gpt-5.4",
      timeoutMs: 1_000,
      createClient: (options) => {
        const args = options?.args ?? [];
        sessionDir = args[args.indexOf("--session-dir") + 1]!;
        return {
          start: async () => undefined,
          stop: async () => { stopped += 1; },
          promptAndWait: async () => [],
          getMessages: async () => [{ role: "assistant", content: [], stopReason: "error", errorMessage: "401 unauthorized" }]
        } as never;
      }
    }), /401 unauthorized/);
    assert.equal(stopped, 1);
    await assert.rejects(() => access(sessionDir), { code: "ENOENT" });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
