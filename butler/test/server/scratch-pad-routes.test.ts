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

type StartThreadCall = {
  cwd: string;
  developerInstructions: string;
};

type PreparedWorkspace = {
  cwd: string;
  workspaceMode: "managed_worktree" | "existing";
  branchName: string | null;
  created: boolean;
};

async function closeServer(server: ReturnType<express.Express["listen"]>): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

async function createServer(
  deleteThread: (threadId: string, options?: { waitForCleanup?: boolean }) => Promise<unknown>,
  options: {
    startThread?: (input: { cwd: string; developerInstructions: string }) => Promise<{ threadId: string }>;
    prepareScratchWorkspace?: (item: unknown, task: string, baseCwd: string) => Promise<PreparedWorkspace>;
    cleanupScratchWorkspace?: (cwd: string) => Promise<number>;
    focusedCwd?: string | null;
  } = {}
) {
  const dir = await mkdtemp(path.join(tmpdir(), "manor-scratch-pad-routes-"));
  const scratchPadStore = new ScratchPadStore(path.join(dir, "scratch-pad.json"));
  await scratchPadStore.load();

  const app = express();
  app.use(express.json());
  registerScratchPadRoutes({
    app,
    scratchPadStore,
    store: {
      getThread: (threadId: string) => threadId === "focused-thread" && options.focusedCwd ? ({ cwd: options.focusedCwd } as never) : null,
      getOpenWindowIds: () => options.focusedCwd ? ["focused-thread"] : [],
      addEvent: () => undefined,
      setThreadExecutionContract: () => undefined
    } as never,
    codexClient: {
      startThread: options.startThread ?? (async () => ({ threadId: "thread-started" })),
      deleteThread
    } as never,
    butlerAgent: {
      trackScratchPadDelegation: () => undefined
    } as never,
    imageStore: {} as never,
    fileStore: {} as never,
    prepareScratchWorkspace: options.prepareScratchWorkspace as never,
    cleanupScratchWorkspace: options.cleanupScratchWorkspace
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

test("scratch pad start defaults to a managed workspace", async () => {
  const startCalls: StartThreadCall[] = [];
  const prepareCalls: Array<{ task: string; baseCwd: string }> = [];
  const server = await createServer(
    async () => ({ deletedArtifacts: 0, cleanupFailed: false, cleanupError: null }),
    {
      prepareScratchWorkspace: async (_item, task, baseCwd) => {
        prepareCalls.push({ task, baseCwd });
        return {
          cwd: "/repos/.manor-worktrees/manor/butler--scratch-pad",
          workspaceMode: "managed_worktree",
          branchName: "butler/scratch-pad",
          created: true
        };
      },
      startThread: async (input) => {
        startCalls.push({ cwd: input.cwd, developerInstructions: input.developerInstructions });
        return { threadId: "thread-started" };
      }
    }
  );

  try {
    const response = await fetch(`${server.baseUrl}/api/scratch-pad/items`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "Try this idea.", autoStart: true })
    });
    const body = (await response.json()) as {
      item?: {
        cwd?: string | null;
        workspaceMode?: string;
        branchName?: string | null;
        threadId?: string | null;
      };
    };

    assert.equal(response.status, 201);
    assert.equal(prepareCalls.length, 1);
    assert.equal(prepareCalls[0]?.baseCwd, "/repos");
    assert.equal(startCalls[0]?.cwd, "/repos/.manor-worktrees/manor/butler--scratch-pad");
    assert.match(startCalls[0]?.developerInstructions ?? "", /isolated scratch-pad worktree/);
    assert.equal(body.item?.cwd, "/repos/.manor-worktrees/manor/butler--scratch-pad");
    assert.equal(body.item?.workspaceMode, "managed_worktree");
    assert.equal(body.item?.branchName, "butler/scratch-pad");
    assert.equal(body.item?.threadId, "thread-started");
  } finally {
    await server.cleanup();
  }
});

test("scratch pad start uses focused thread workspace when no cwd is posted", async () => {
  const prepareCalls: Array<{ baseCwd: string }> = [];
  const server = await createServer(
    async () => ({ deletedArtifacts: 0, cleanupFailed: false, cleanupError: null }),
    {
      focusedCwd: "/repos/manor",
      prepareScratchWorkspace: async (_item, _task, baseCwd) => {
        prepareCalls.push({ baseCwd });
        return {
          cwd: "/repos/.manor-worktrees/manor/butler--focused-scratch",
          workspaceMode: "managed_worktree",
          branchName: "butler/focused-scratch",
          created: true
        };
      }
    }
  );

  try {
    const response = await fetch(`${server.baseUrl}/api/scratch-pad/items`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "Use focused workspace.", autoStart: true })
    });
    const body = (await response.json()) as { item?: { cwd?: string | null; workspaceMode?: string } };

    assert.equal(response.status, 201);
    assert.deepEqual(prepareCalls, [{ baseCwd: "/repos/manor" }]);
    assert.equal(body.item?.cwd, "/repos/.manor-worktrees/manor/butler--focused-scratch");
    assert.equal(body.item?.workspaceMode, "managed_worktree");
  } finally {
    await server.cleanup();
  }
});

test("scratch pad cleanup deletes linked thread and artifacts before removing the item", async () => {
  const calls: DeleteThreadCall[] = [];
  const cleanupCalls: string[] = [];
  const server = await createServer(async (threadId, options) => {
    calls.push({ threadId, waitForCleanup: options?.waitForCleanup });
    return { deletedArtifacts: 3, cleanupFailed: false, cleanupError: null };
  }, {
    cleanupScratchWorkspace: async (cwd) => {
      cleanupCalls.push(cwd);
      return 2;
    }
  });

  try {
    const created = server.scratchPadStore.create({ text: "Clean up linked work." });
    server.scratchPadStore.start(created.id, {
      threadId: "thread-cleanup-1",
      cwd: "/repos/.manor-worktrees/manor/butler--cleanup",
      workspaceMode: "managed_worktree",
      branchName: "butler/cleanup"
    });

    const response = await fetch(`${server.baseUrl}/api/scratch-pad/items/${created.id}/delete`, { method: "POST" });
    const body = (await response.json()) as { deletedArtifacts?: number; threadDeleted?: boolean };

    assert.equal(response.status, 200);
    assert.deepEqual(calls, [{ threadId: "thread-cleanup-1", waitForCleanup: true }]);
    assert.deepEqual(cleanupCalls, ["/repos/.manor-worktrees/manor/butler--cleanup"]);
    assert.equal(body.threadDeleted, true);
    assert.equal(body.deletedArtifacts, 5);
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
