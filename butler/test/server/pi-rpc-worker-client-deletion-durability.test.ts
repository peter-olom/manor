import assert from "node:assert/strict";
import { mkdir, mkdtemp, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { PiRpcWorkerClient } from "../../src/server/pi-rpc-worker-client.js";
import { ButlerStateStore } from "../../src/server/state-store.js";
import { buildThreadExecutionContract } from "../../src/server/thread-contract.js";
import { deleteWorkerThread } from "../../src/server/worker-client-router.js";

function createClient(store: ButlerStateStore, dir: string): PiRpcWorkerClient {
  return new PiRpcWorkerClient({
    store,
    piAuthPath: path.join(dir, "agent", "auth.json"),
    sessionRootDir: path.join(dir, "sessions")
  });
}

test("Pi thread deletion is durable before it reports success", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "manor-pi-delete-durable-"));
  const statePath = path.join(dir, "state.json");
  const threadId = "pi-durable-delete";
  const store = new ButlerStateStore(statePath);
  store.upsertThreadSummary({ id: threadId, source: "pi-rpc", cwd: "/workspace", status: "idle", turns: [] });
  await store.flushSave();

  assert.equal(await createClient(store, dir).deleteThread(threadId), true);
  const restarted = new ButlerStateStore(statePath);
  await restarted.load();
  assert.equal(restarted.getThread(threadId), undefined);
});

test("failed Pi deletion persistence restores the live thread and preserves its baseline", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "manor-pi-delete-rollback-"));
  const statePath = path.join(dir, "state.json");
  const threadId = "pi-delete-rollback";
  const baselineObjectDir = path.join(dir, "baseline", "objects");
  await mkdir(baselineObjectDir, { recursive: true });
  await writeFile(path.join(baselineObjectDir, "proof"), "baseline", "utf8");
  const store = new ButlerStateStore(statePath);
  store.upsertThreadSummary({ id: threadId, source: "pi-rpc", cwd: "/workspace", status: "idle", turns: [] });
  store.setThreadExecutionContract(threadId, {
    ...buildThreadExecutionContract({ threadId, workspaceCwd: "/workspace", projectId: "project", projectLabel: "Project", branch: null, taskText: "Work", taskCategory: "generic_code", inferredWorkDepth: "standard", notes: [] }),
    reviewBaselineCwd: "/workspace",
    reviewBaselineObjectDir: baselineObjectDir
  });
  store.openWindow(threadId);
  await store.flushSave();
  const milestones = store as unknown as {
    latestStartedTurnIds: Map<string, string>;
    latestCompletedTurnIds: Map<string, string>;
    latestBlockedTurnIds: Map<string, string>;
  };
  milestones.latestStartedTurnIds.set(threadId, "started-before-delete");
  milestones.latestCompletedTurnIds.set(threadId, "completed-before-delete");
  milestones.latestBlockedTurnIds.set(threadId, "blocked-before-delete");

  const originalFlush = store.flushSave.bind(store);
  let flushCount = 0;
  (store as unknown as { flushSave(): Promise<void> }).flushSave = async () => {
    flushCount += 1;
    if (flushCount === 2) throw new Error("state save failed");
    await originalFlush();
  };
  let cleanupCalls = 0;
  await assert.rejects(() => deleteWorkerThread({
    store,
    codexClient: {} as never,
    piRpcWorkerClient: createClient(store, dir),
    cleanupReviewBaseline: async () => { cleanupCalls += 1; }
  }, threadId), /Pi Worker deletion could not be persisted: state save failed/);

  assert.ok(store.getThread(threadId));
  assert.ok(store.getOpenWindowIds().includes(threadId));
  assert.equal(cleanupCalls, 0);
  assert.equal(milestones.latestStartedTurnIds.get(threadId), "started-before-delete");
  assert.equal(milestones.latestCompletedTurnIds.get(threadId), "completed-before-delete");
  assert.equal(milestones.latestBlockedTurnIds.get(threadId), "blocked-before-delete");
  assert.ok(await stat(path.join(baselineObjectDir, "proof")));
  const restarted = new ButlerStateStore(statePath);
  await restarted.load();
  assert.ok(restarted.getThread(threadId));
});
