import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { buildJobPayload, jobPayloadsRoot, persistJobPayload, updateJobPayload } from "../../src/server/job-instruction-artifacts.js";
import { restoreDurableJobPayloads } from "../../src/server/job-payload-recovery.js";
import { ButlerStateStore } from "../../src/server/state-store.js";

async function createStore(root: string, threadId: string): Promise<ButlerStateStore> {
  const store = new ButlerStateStore(path.join(root, "state.json"));
  await store.load();
  store.upsertThreadSummary({
    id: threadId,
    source: "pi-rpc",
    cwd: "/workspace",
    status: "idle",
    turns: []
  });
  return store;
}

test("restores a durable payload for an existing thread after restart", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "manor-job-recovery-"));
  const artifactsDir = path.join(root, "artifacts");
  const threadId = "pi-existing";
  const store = await createStore(root, threadId);
  const payload = buildJobPayload({ threadId, kind: "delegation", instruction: "Keep this task visible" });
  await persistJobPayload(jobPayloadsRoot(artifactsDir), payload);

  assert.equal(await restoreDurableJobPayloads({ artifactsDir, store }), 1);
  assert.equal(store.getThreadJobPayload(threadId)?.payloadId, payload.payloadId);
});

test("does not resurrect payloads for deleted threads", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "manor-job-recovery-orphan-"));
  const artifactsDir = path.join(root, "artifacts");
  const store = new ButlerStateStore(path.join(root, "state.json"));
  await store.load();
  const payload = buildJobPayload({ threadId: "pi-deleted", kind: "delegation", instruction: "Deleted task" });
  await persistJobPayload(jobPayloadsRoot(artifactsDir), payload);

  assert.equal(await restoreDurableJobPayloads({ artifactsDir, store }), 0);
  assert.equal(store.getThread("pi-deleted"), undefined);
});

test("keeps a newer in-memory payload when durable state is stale", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "manor-job-recovery-newer-"));
  const artifactsDir = path.join(root, "artifacts");
  const threadId = "pi-newer";
  const store = await createStore(root, threadId);
  const durable = buildJobPayload({ threadId, kind: "delegation", instruction: "Initial task", createdAt: 10 });
  const current = updateJobPayload(durable, { kind: "steering", instruction: "Newer task", createdAt: 20 });
  await persistJobPayload(jobPayloadsRoot(artifactsDir), durable);
  store.setThreadJobPayload(current);

  assert.equal(await restoreDurableJobPayloads({ artifactsDir, store }), 0);
  assert.equal(store.getThreadJobPayload(threadId)?.revision, current.revision);
});
