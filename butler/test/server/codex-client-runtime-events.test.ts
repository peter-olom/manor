import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { CodexAppServerClient } from "../../src/server/codex-client.js";
import { ButlerStateStore } from "../../src/server/state-store.js";
import type { CodexThreadPatchView } from "../../src/server/types.js";

async function waitFor(predicate: () => boolean, timeoutMs = 500): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(predicate(), true);
}

test("updateThreadReasoningEffort issues a thread/settings/update JSON-RPC call", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "manor-codex-runtime-events-"));
  const store = new ButlerStateStore(path.join(dir, "state.json"));
  await store.load();

  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  const client = new CodexAppServerClient("ws://127.0.0.1:1", store, dir) as unknown as {
    updateThreadReasoningEffort: (threadId: string, effort: string) => Promise<void>;
  };
  (client as unknown as { codexProviderAdapter: { call: (method: string, params: Record<string, unknown>) => Promise<Record<string, unknown>> } }).codexProviderAdapter = {
    call: async (method, params) => {
      calls.push({ method, params });
      return {};
    }
  };

  await client.updateThreadReasoningEffort("thread-7", "high");

  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.method, "thread/settings/update");
  assert.deepEqual(calls[0]?.params, { threadId: "thread-7", effort: "high" });
});

test("thread/settings/updated notification refreshes the per-thread effort", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "manor-codex-runtime-events-"));
  const store = new ButlerStateStore(path.join(dir, "state.json"));
  await store.load();

  const client = new CodexAppServerClient("ws://127.0.0.1:1", store, dir) as unknown as {
    handleMessage: (message: unknown) => void;
    on: (event: "change" | "threadPatch", listener: (payload?: unknown) => void) => void;
  };

  client.handleMessage({
    method: "thread/settings/updated",
    params: {
      threadId: "thread-9",
      threadSettings: { effort: "xhigh", model: "gpt-5.4" }
    }
  });

  await waitFor(() => store.getThread("thread-9")?.requestedReasoningEffort === "xhigh");
  assert.equal(store.getThread("thread-9")?.requestedReasoningEffort, "xhigh");
});
