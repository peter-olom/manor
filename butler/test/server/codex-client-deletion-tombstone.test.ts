import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { CodexAppServerClient } from "../../src/server/codex-client.js";
import { ButlerStateStore } from "../../src/server/state-store.js";

async function createStore(statePath: string): Promise<ButlerStateStore> {
  const store = new ButlerStateStore(statePath);
  await store.load();
  return store;
}

test("deleted Codex threads stay hidden when provider inventory is seeded after restart", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "manor-codex-deletion-tombstone-"));
  try {
    const statePath = path.join(dir, "state.json");
    const deletedThreadId = "deleted-thread";
    const survivingThreadId = "surviving-thread";
    const firstStore = await createStore(statePath);
    firstStore.upsertThreadSummary({ id: deletedThreadId, source: "appServer", cwd: dir, status: "idle", turns: [] });
    const deletingClient = new CodexAppServerClient("ws://127.0.0.1:1", firstStore, dir) as unknown as {
      codexProviderAdapter: { unsubscribeThread: (threadId: string) => Promise<void> };
      deleteThreadArtifacts: () => Promise<number>;
      deleteThread: (threadId: string, options: { waitForCleanup: boolean }) => Promise<unknown>;
    };
    deletingClient.codexProviderAdapter = { unsubscribeThread: async () => undefined };
    deletingClient.deleteThreadArtifacts = async () => 0;
    await deletingClient.deleteThread(deletedThreadId, { waitForCleanup: true });

    const restartedStore = await createStore(statePath);
    assert.equal(restartedStore.isCodexThreadDeleted(deletedThreadId), true);
    assert.equal(restartedStore.getThread(deletedThreadId), undefined);

    const resumed: string[] = [];
    const restartedClient = new CodexAppServerClient("ws://127.0.0.1:1", restartedStore, dir) as unknown as {
      codexProviderAdapter: {
        listThreads: () => Promise<{ data: Record<string, unknown>[]; nextCursor: null }>;
        listLoadedThreads: () => Promise<string[]>;
        resumeThread: (threadId: string) => Promise<{ threadId: string }>;
      };
      seedThreads: () => Promise<void>;
    };
    restartedClient.codexProviderAdapter = {
      listThreads: async () => ({
        data: [
          { id: deletedThreadId, source: "appServer", cwd: dir, status: "idle", turns: [] },
          { id: survivingThreadId, source: "appServer", cwd: dir, status: "idle", turns: [] }
        ],
        nextCursor: null
      }),
      listLoadedThreads: async () => [deletedThreadId, survivingThreadId],
      resumeThread: async (threadId) => {
        resumed.push(threadId);
        return { threadId };
      }
    };

    await restartedClient.seedThreads();

    assert.equal(restartedStore.getThread(deletedThreadId), undefined);
    assert.ok(restartedStore.getThread(survivingThreadId));
    assert.deepEqual(resumed, [survivingThreadId]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("an explicit restore can deliberately re-import a deleted provider thread", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "manor-codex-deletion-restore-"));
  try {
    const statePath = path.join(dir, "state.json");
    const threadId = "restored-thread";
    const firstStore = await createStore(statePath);
    firstStore.markCodexThreadDeleted(threadId);
    await firstStore.flushSave();

    const restartedStore = await createStore(statePath);
    const client = new CodexAppServerClient("ws://127.0.0.1:1", restartedStore, dir) as unknown as {
      codexProviderAdapter: {
        loadThread: (threadId: string) => Promise<{ threadId: string; thread: Record<string, unknown>; turns: [] }>;
        resumeThread: (threadId: string) => Promise<{ threadId: string }>;
      };
      loadThread: (threadId: string, options?: { restoreDeleted?: boolean }) => Promise<void>;
    };
    client.codexProviderAdapter = {
      loadThread: async (id) => ({
        threadId: id,
        thread: { id, source: "appServer", cwd: dir, status: "idle", turns: [] },
        turns: []
      }),
      resumeThread: async (id) => ({ threadId: id })
    };

    await assert.rejects(() => client.loadThread(threadId), /deleted in Manor/);
    await client.loadThread(threadId, { restoreDeleted: true });

    assert.ok(restartedStore.getThread(threadId));
    assert.equal(restartedStore.isCodexThreadDeleted(threadId), false);
    await restartedStore.flushSave();
    const reloadedStore = await createStore(statePath);
    assert.equal(reloadedStore.isCodexThreadDeleted(threadId), false);
    assert.ok(reloadedStore.getThread(threadId));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("an absent provider thread retires its tombstone only after queued cleanup completes", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "manor-codex-deletion-retirement-"));
  try {
    const statePath = path.join(dir, "state.json");
    const threadId = "retired-thread";
    const store = await createStore(statePath);
    store.markCodexThreadDeleted(threadId);
    const cleanup = store.enqueueRuntimeCleanupTask({
      threadId,
      cwd: dir,
      stacks: [],
      previews: [],
      services: []
    });
    await store.flushSave();

    const client = new CodexAppServerClient("ws://127.0.0.1:1", store, dir) as unknown as {
      codexProviderAdapter: {
        listThreads: () => Promise<{ data: []; nextCursor: null }>;
        listLoadedThreads: () => Promise<string[]>;
      };
      seedThreads: () => Promise<void>;
    };
    client.codexProviderAdapter = {
      listThreads: async () => ({ data: [], nextCursor: null }),
      listLoadedThreads: async () => []
    };

    await client.seedThreads();
    assert.equal(store.isCodexThreadDeleted(threadId), true);
    await assert.rejects(
      () => (client as unknown as { loadThread: (id: string, options: { restoreDeleted: boolean }) => Promise<void> }).loadThread(threadId, { restoreDeleted: true }),
      /cleanup is still running/
    );

    store.completeRuntimeCleanupTask(cleanup.id);
    await client.seedThreads();
    assert.equal(store.isCodexThreadDeleted(threadId), false);

    const reloadedStore = await createStore(statePath);
    assert.equal(reloadedStore.isCodexThreadDeleted(threadId), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a tombstone flush failure is returned as a failed deletion", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "manor-codex-deletion-save-failure-"));
  try {
    const store = await createStore(path.join(dir, "state.json"));
    const threadId = "save-failure-thread";
    store.upsertThreadSummary({ id: threadId, source: "appServer", cwd: dir, status: "idle", turns: [] });
    const mutableStore = store as unknown as { flushSave: () => Promise<void> };
    mutableStore.flushSave = async () => { throw new Error("tombstone save failed"); };
    const client = new CodexAppServerClient("ws://127.0.0.1:1", store, dir) as unknown as {
      codexProviderAdapter: { unsubscribeThread: (threadId: string) => Promise<void> };
      deleteThreadArtifacts: () => Promise<number>;
      deleteThread: (threadId: string, options: { waitForCleanup: boolean }) => Promise<{ cleanupFailed?: boolean; cleanupError?: string | null }>;
    };
    client.codexProviderAdapter = { unsubscribeThread: async () => undefined };
    client.deleteThreadArtifacts = async () => 0;

    const result = await client.deleteThread(threadId, { waitForCleanup: true });

    assert.equal(result.cleanupFailed, true);
    assert.match(result.cleanupError ?? "", /tombstone save failed/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
