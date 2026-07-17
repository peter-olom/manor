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

test("thread timestamps accept provider seconds, internal milliseconds, and repair legacy microseconds", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "manor-state-timestamps-"));
  const statePath = path.join(dir, "state.json");
  const store = new ButlerStateStore(statePath);
  await store.load();

  store.upsertThreadSummary({ id: "seconds", createdAt: 1_784_152_675, updatedAt: 1_784_152_676, status: "idle" });
  store.upsertThreadSummary({ id: "milliseconds", createdAt: 1_784_152_675_073, updatedAt: 1_784_152_676_073, status: "idle" });
  store.upsertThreadSummary({ id: "microseconds", createdAt: 1_784_152_675_073_000, updatedAt: 1_784_152_676_073_000, status: "idle" });

  assert.equal(store.getThread("seconds")?.createdAt, 1_784_152_675_000);
  assert.equal(store.getThread("milliseconds")?.createdAt, 1_784_152_675_073);
  assert.equal(store.getThread("microseconds")?.createdAt, 1_784_152_675_073);
});

test("plausible provider millisecond timestamps far in the future are quarantined", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "manor-state-future-timestamp-"));
  const store = new ButlerStateStore(path.join(dir, "state.json"));
  await store.load();
  const before = Date.now();

  store.upsertThreadSummary({
    id: "future",
    createdAt: before + 24 * 60 * 60_000,
    updatedAt: before + 24 * 60 * 60_000,
    status: "active"
  });

  assert.ok((store.getThread("future")?.createdAt ?? Infinity) <= Date.now());
  assert.ok((store.getThread("future")?.updatedAt ?? Infinity) <= Date.now());
});
