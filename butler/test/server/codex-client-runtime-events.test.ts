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

test("Codex notifications flow through runtime ingestion without broad delta changes", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "manor-codex-runtime-events-"));
  const store = new ButlerStateStore(path.join(dir, "state.json"));
  await store.load();

  const client = new CodexAppServerClient("ws://127.0.0.1:1", store, dir) as unknown as {
    handleMessage: (message: unknown) => void;
    on: (event: "change" | "threadPatch", listener: (payload?: unknown) => void) => void;
  };
  let clientChanges = 0;
  let storeChanges = 0;
  const patches: CodexThreadPatchView[] = [];
  client.on("change", () => {
    clientChanges += 1;
  });
  client.on("threadPatch", (payload) => {
    patches.push(payload as CodexThreadPatchView);
  });
  store.on("change", () => {
    storeChanges += 1;
  });

  client.handleMessage({
    method: "item/agentMessage/delta",
    params: {
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "item-1",
      delta: "Fast"
    }
  });

  await waitFor(() => patches.length === 1);

  assert.equal(clientChanges, 0);
  assert.equal(storeChanges, 0);
  assert.equal(store.getThreadDetail("thread-1")?.turns[0]?.items[0]?.text, "Fast");
  assert.deepEqual(patches[0], {
    kind: "content-delta",
    threadId: "thread-1",
    turnId: "turn-1",
    itemId: "item-1",
    itemType: "assistant_message",
    streamKind: "assistant_text",
    delta: "Fast",
    itemTextLength: 4,
    at: patches[0]?.at
  });
});
