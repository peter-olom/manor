import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { ButlerStateStore } from "../../src/server/state-store.js";

test("concurrent state flushes use distinct atomic temporary files", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "manor-state-flush-"));
  const statePath = path.join(dir, "state.json");
  const store = new ButlerStateStore(statePath);
  await store.load();
  store.upsertThreadSummary({
    id: "thread-1",
    status: "idle",
    cwd: "/workspace",
    turns: [{ id: "turn-1", status: "completed", items: [{ id: "user-1", type: "userMessage", text: "Run task" }] }]
  });
  const originalNow = Date.now;
  Date.now = () => 123_456;
  try {
    await Promise.all([store.flushSave(), store.flushSave()]);
  } finally {
    Date.now = originalNow;
  }

  const persisted = JSON.parse(await readFile(statePath, "utf8")) as { threads?: Array<{ id?: string }> };
  assert.equal(persisted.threads?.[0]?.id, "thread-1");
});
