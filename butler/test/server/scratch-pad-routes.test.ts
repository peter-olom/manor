import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import test from "node:test";

import express from "express";

import { registerScratchPadRoutes } from "../../src/server/scratch-pad-routes.js";
import { ScratchPadStore } from "../../src/server/scratch-pad-store.js";

type DeleteThreadCall = {
  threadId: string;
  waitForCleanup: boolean | undefined;
};

async function closeServer(server: ReturnType<express.Express["listen"]>): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

async function createServer(deleteThread: (threadId: string, options?: { waitForCleanup?: boolean }) => Promise<unknown>) {
  const dir = await mkdtemp(path.join(tmpdir(), "manor-scratch-pad-routes-"));
  const scratchPadStore = new ScratchPadStore(path.join(dir, "scratch-pad.json"));
  await scratchPadStore.load();

  const app = express();
  app.use(express.json());
  registerScratchPadRoutes({
    app,
    scratchPadStore,
    store: {
      getThread: () => null,
      addEvent: () => undefined,
      setThreadExecutionContract: () => undefined
    } as never,
    codexClient: {
      startThread: async () => ({ threadId: "thread-started" }),
      deleteThread
    } as never,
    butlerAgent: {
      trackScratchPadDelegation: () => undefined
    } as never,
    imageStore: {} as never,
    fileStore: {} as never
  });

  const server = app.listen(0);
  const address = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    scratchPadStore,
    async cleanup() {
      await closeServer(server);
      await rm(dir, { recursive: true, force: true });
    }
  };
}

test("scratch pad cleanup deletes linked thread and artifacts before removing the item", async () => {
  const calls: DeleteThreadCall[] = [];
  const server = await createServer(async (threadId, options) => {
    calls.push({ threadId, waitForCleanup: options?.waitForCleanup });
    return { deletedArtifacts: 3, cleanupFailed: false, cleanupError: null };
  });

  try {
    const created = server.scratchPadStore.create({ text: "Clean up linked work." });
    server.scratchPadStore.start(created.id, { threadId: "thread-cleanup-1" });

    const response = await fetch(`${server.baseUrl}/api/scratch-pad/items/${created.id}/delete`, { method: "POST" });
    const body = (await response.json()) as { deletedArtifacts?: number; threadDeleted?: boolean };

    assert.equal(response.status, 200);
    assert.deepEqual(calls, [{ threadId: "thread-cleanup-1", waitForCleanup: true }]);
    assert.equal(body.threadDeleted, true);
    assert.equal(body.deletedArtifacts, 3);
    assert.equal(server.scratchPadStore.get(created.id), null);
  } finally {
    await server.cleanup();
  }
});

test("scratch pad cleanup keeps item when linked thread cleanup fails", async () => {
  const server = await createServer(async () => ({ deletedArtifacts: 0, cleanupFailed: true, cleanupError: "cleanup failed" }));

  try {
    const created = server.scratchPadStore.create({ text: "Keep this if cleanup fails." });
    server.scratchPadStore.start(created.id, { threadId: "thread-cleanup-fails" });

    const response = await fetch(`${server.baseUrl}/api/scratch-pad/items/${created.id}/delete`, { method: "POST" });
    const body = (await response.json()) as { error?: string };

    assert.equal(response.status, 500);
    assert.equal(body.error, "cleanup failed");
    assert.equal(server.scratchPadStore.get(created.id)?.threadId, "thread-cleanup-fails");
  } finally {
    await server.cleanup();
  }
});
