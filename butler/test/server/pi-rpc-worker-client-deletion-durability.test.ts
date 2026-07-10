import assert from "node:assert/strict";
import { mkdir, mkdtemp, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { PiRpcWorkerClient } from "../../src/server/pi-rpc-worker-client.js";
import { ButlerStateStore } from "../../src/server/state-store.js";
import { buildThreadExecutionContract } from "../../src/server/thread-contract.js";
import { deleteWorkerThread } from "../../src/server/worker-client-router.js";

function createClient(store: ButlerStateStore, dir: string, lifecycle: {
  onThreadDeleting?: (context: { threadId: string }) => Promise<unknown>;
  onThreadCapabilityReady?: (threadId: string, cwd: string) => Promise<unknown>;
  onThreadCapabilityRemoved?: (threadId: string) => Promise<unknown>;
} = {}): PiRpcWorkerClient {
  return new PiRpcWorkerClient({
    store,
    piAuthPath: path.join(dir, "agent", "auth.json"),
    sessionRootDir: path.join(dir, "sessions"),
    ...lifecycle
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

test("Pi deletion cleans runtime resources before revoking its harness capability", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "manor-pi-delete-lifecycle-"));
  const statePath = path.join(dir, "state.json");
  const threadId = "pi-delete-lifecycle";
  const sessionDir = path.join(dir, "sessions", threadId);
  const store = new ButlerStateStore(statePath);
  store.upsertThreadSummary({ id: threadId, source: "pi-rpc", cwd: "/workspace", status: "idle", turns: [] });
  await mkdir(sessionDir, { recursive: true });
  await writeFile(path.join(sessionDir, "session.jsonl"), "{}\n", "utf8");
  await store.flushSave();
  const events: string[] = [];

  const client = createClient(store, dir, {
    onThreadDeleting: async ({ threadId: deletingThreadId }) => {
      assert.equal(deletingThreadId, threadId);
      assert.ok(store.getThread(threadId));
      events.push("cleanup");
    },
    onThreadCapabilityRemoved: async (removedThreadId) => {
      assert.equal(removedThreadId, threadId);
      assert.ok(store.getThread(threadId));
      events.push("revoke");
    }
  });

  assert.equal(await client.deleteThread(threadId), true);
  assert.deepEqual(events, ["cleanup", "revoke"]);
  assert.equal(store.getThread(threadId), undefined);
  await assert.rejects(() => stat(sessionDir));
});

test("failed Pi capability revocation keeps the durable thread and loaded session live", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "manor-pi-delete-revoke-failure-"));
  const threadId = "pi-delete-revoke-failure";
  const store = new ButlerStateStore(path.join(dir, "state.json"));
  store.upsertThreadSummary({ id: threadId, source: "pi-rpc", cwd: "/workspace", status: "idle", turns: [] });
  await store.flushSave();
  let restoreCalls = 0;
  let stopCalls = 0;
  const client = createClient(store, dir, {
    onThreadCapabilityRemoved: async () => {
      throw new Error("capability save failed");
    },
    onThreadCapabilityReady: async (restoredThreadId, cwd) => {
      assert.equal(restoredThreadId, threadId);
      assert.equal(cwd, "/workspace");
      restoreCalls += 1;
    }
  });
  const session = {
    threadId,
    client: { stop: async () => { stopCalls += 1; } },
    mapper: {},
    unsubscribe: null,
    cwd: "/workspace",
    provider: "ollama-cloud",
    model: "glm-5.2",
    activityVersion: 0,
    acceptedEventVersion: null,
    eventStreamVersion: null,
    pendingPromptGenerations: []
  };
  const sessions = (client as unknown as { sessions: Map<string, unknown> }).sessions;
  sessions.set(threadId, session);

  await assert.rejects(() => client.deleteThread(threadId), /capability save failed/);

  assert.ok(store.getThread(threadId));
  assert.equal(sessions.get(threadId), session);
  assert.equal(stopCalls, 0);
  assert.equal(restoreCalls, 1);
});

test("failed Pi runtime cleanup keeps the worker and its capability live", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "manor-pi-delete-cleanup-failure-"));
  const threadId = "pi-delete-cleanup-failure";
  const store = new ButlerStateStore(path.join(dir, "state.json"));
  store.upsertThreadSummary({ id: threadId, source: "pi-rpc", cwd: "/workspace", status: "idle", turns: [] });
  await store.flushSave();
  let capabilityRemovalCalls = 0;
  const client = createClient(store, dir, {
    onThreadDeleting: async () => {
      throw new Error("runtime cleanup failed");
    },
    onThreadCapabilityRemoved: async () => {
      capabilityRemovalCalls += 1;
    }
  });

  await assert.rejects(() => client.deleteThread(threadId), /runtime cleanup failed/);
  assert.ok(store.getThread(threadId));
  assert.equal(capabilityRemovalCalls, 0);
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
  let capabilityRemovalCalls = 0;
  let capabilityRestoreCalls = 0;
  await assert.rejects(() => deleteWorkerThread({
    store,
    codexClient: {} as never,
    piRpcWorkerClient: createClient(store, dir, {
      onThreadCapabilityRemoved: async () => { capabilityRemovalCalls += 1; },
      onThreadCapabilityReady: async (restoredThreadId, cwd) => {
        assert.equal(restoredThreadId, threadId);
        assert.equal(cwd, "/workspace");
        capabilityRestoreCalls += 1;
      }
    }),
    cleanupReviewBaseline: async () => { cleanupCalls += 1; }
  }, threadId), /Pi Worker deletion could not be persisted: state save failed/);

  assert.ok(store.getThread(threadId));
  assert.ok(store.getOpenWindowIds().includes(threadId));
  assert.equal(cleanupCalls, 0);
  assert.equal(capabilityRemovalCalls, 1);
  assert.equal(capabilityRestoreCalls, 1);
  assert.equal(milestones.latestStartedTurnIds.get(threadId), "started-before-delete");
  assert.equal(milestones.latestCompletedTurnIds.get(threadId), "completed-before-delete");
  assert.equal(milestones.latestBlockedTurnIds.get(threadId), "blocked-before-delete");
  assert.ok(await stat(path.join(baselineObjectDir, "proof")));
  const restarted = new ButlerStateStore(statePath);
  await restarted.load();
  assert.ok(restarted.getThread(threadId));
});
