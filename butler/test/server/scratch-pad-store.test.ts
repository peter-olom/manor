import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { ScratchPadStore } from "../../src/server/scratch-pad-store.js";
import type { CodexThreadRecord } from "../../src/server/types.js";

test("scratch pad items persist, launch, derive ready state, and review", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "manor-scratch-pad-"));
  try {
    const statePath = path.join(dir, "scratch-pad.json");
    const store = new ScratchPadStore(statePath);
    await store.load();

    const created = store.create({
      text: "Explore async scratch items deeply.",
      depth: "prototype",
      resultKind: "prototype"
    });
    assert.equal(created.status, "captured");
    assert.equal(created.title, "Explore async scratch items deeply.");

    const started = store.start(created.id, { threadId: "thread-1" });
    assert.equal(started.status, "exploring");
    assert.equal(started.threadId, "thread-1");

    const ready = store.getSnapshot((threadId) =>
      threadId === "thread-1"
        ? ({
            workerReport: {
              threadId,
              turnId: "turn-1",
              status: "completed",
              summary: "Done",
              details: null,
              createdAt: started.updatedAt + 1,
              updatedAt: started.updatedAt + 1
            }
          } as CodexThreadRecord)
        : null
    );
    assert.equal(ready.items[0]?.status, "ready_for_review");
    assert.equal(ready.counts.ready_for_review, 1);

    const reviewed = store.review(created.id, "accepted");
    assert.equal(reviewed.status, "accepted");
    await store.flushSave();

    const restored = new ScratchPadStore(statePath);
    await restored.load();
    assert.equal(restored.getSnapshot().items[0]?.status, "accepted");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("scratch pad removal drops the item from snapshots and persisted state", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "manor-scratch-pad-remove-"));
  try {
    const statePath = path.join(dir, "scratch-pad.json");
    const store = new ScratchPadStore(statePath);
    await store.load();

    const keep = store.create({ text: "Keep this scratch item." });
    const remove = store.create({ text: "Delete this scratch item." });

    const removed = store.remove(remove.id);
    assert.equal(removed?.id, remove.id);
    assert.deepEqual(store.getSnapshot().items.map((item) => item.id), [keep.id]);

    await store.flushSave();
    const restored = new ScratchPadStore(statePath);
    await restored.load();
    assert.deepEqual(restored.getSnapshot().items.map((item) => item.id), [keep.id]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
