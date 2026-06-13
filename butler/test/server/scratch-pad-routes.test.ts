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
  input?: unknown;
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
    startThread?: (input: { cwd: string; developerInstructions: string; input: (threadId: string) => Promise<unknown> }) => Promise<{ threadId: string }>;
    prepareScratchWorkspace?: (item: unknown, task: string, baseCwd: string) => Promise<PreparedWorkspace>;
    cleanupScratchWorkspace?: (cwd: string) => Promise<number>;
    focusedCwd?: string | null;
    imageReferences?: Array<{ id: string; name: string; mimeType: string; sizeBytes: number; createdAt: number; url: string; filePath: string }>;
    fileReferences?: Array<{ id: string; name: string; mimeType: string; sizeBytes: number; createdAt: number; url: string; filePath: string }>;
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
    imageStore: {
      resolveViews: (ids: string[]) =>
        ids.map((id) => {
          const reference = (options.imageReferences ?? []).find((entry) => entry.id === id);
          if (!reference) throw new Error(`Image reference ${id} was not found`);
          const { filePath: _filePath, ...view } = reference;
          return view;
        }),
      getFilePath: (id: string) => (options.imageReferences ?? []).find((entry) => entry.id === id)?.filePath ?? null
    } as never,
    fileStore: {
      resolveViews: (ids: string[]) =>
        ids.map((id) => {
          const reference = (options.fileReferences ?? []).find((entry) => entry.id === id);
          if (!reference) throw new Error(`File reference ${id} was not found`);
          const { filePath: _filePath, ...view } = reference;
          return view;
        }),
      getFilePath: (id: string) => (options.fileReferences ?? []).find((entry) => entry.id === id)?.filePath ?? null
    } as never,
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
        startCalls.push({ cwd: input.cwd, developerInstructions: input.developerInstructions, input: input.input });
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

test("scratch pad carries attachments and deep contract rows into worker input", async () => {
  let builtInput: unknown[] = [];
  const server = await createServer(
    async () => ({ deletedArtifacts: 0, cleanupFailed: false, cleanupError: null }),
    {
      imageReferences: [
        {
          id: "img-1",
          name: "screen.png",
          mimeType: "image/png",
          sizeBytes: 1200,
          createdAt: 10,
          url: "/api/images/img-1",
          filePath: "/tmp/screen.png"
        }
      ],
      fileReferences: [
        {
          id: "file-1",
          name: "notes.pdf",
          mimeType: "application/pdf",
          sizeBytes: 2400,
          createdAt: 11,
          url: "/api/files/file-1",
          filePath: "/tmp/notes.pdf"
        }
      ],
      prepareScratchWorkspace: async () => ({
        cwd: "/repos/.manor-worktrees/manor/butler--attached-scratch",
        workspaceMode: "managed_worktree",
        branchName: "butler/attached-scratch",
        created: true
      }),
      startThread: async (input) => {
        builtInput = (await input.input("thread-attached")) as unknown[];
        return { threadId: "thread-attached" };
      }
    }
  );

  try {
    const response = await fetch(`${server.baseUrl}/api/scratch-pad/items`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        text: "Research the attached issue.",
        autoStart: true,
        imageReferenceIds: ["img-1"],
        fileReferenceIds: ["file-1"]
      })
    });
    const body = (await response.json()) as { item?: { attachments?: Array<{ name: string; used: boolean }> } };
    const promptText = builtInput.find((entry) => typeof entry === "object" && entry && (entry as { type?: string }).type === "text") as
      | { text?: string }
      | undefined;
    const localImage = builtInput.find((entry) => typeof entry === "object" && entry && (entry as { type?: string }).type === "localImage") as
      | { path?: string }
      | undefined;

    assert.equal(response.status, 201);
    assert.deepEqual(body.item?.attachments?.map((attachment) => ({ name: attachment.name, used: attachment.used })), [
      { name: "screen.png", used: true },
      { name: "notes.pdf", used: true }
    ]);
    assert.match(promptText?.text ?? "", /task_category: research/);
    assert.match(promptText?.text ?? "", /inferred_work_depth: deep/);
    assert.match(promptText?.text ?? "", /verification_row: row-1\|point-1\|data_check,intent_review,manual_waiver/);
    assert.match(promptText?.text ?? "", /Attached reference images:/);
    assert.match(promptText?.text ?? "", /screen.png/);
    assert.match(promptText?.text ?? "", /notes.pdf \| \/tmp\/notes.pdf/);
    assert.equal(localImage?.path, "/tmp/screen.png");
  } finally {
    await server.cleanup();
  }
});

test("scratch pad attachment can be removed before start", async () => {
  const server = await createServer(
    async () => ({ deletedArtifacts: 0, cleanupFailed: false, cleanupError: null }),
    {
      fileReferences: [
        {
          id: "file-remove",
          name: "draft.md",
          mimeType: "text/markdown",
          sizeBytes: 32,
          createdAt: 20,
          url: "/api/files/file-remove",
          filePath: "/tmp/draft.md"
        }
      ]
    }
  );

  try {
    const createResponse = await fetch(`${server.baseUrl}/api/scratch-pad/items`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "Hold this for later.", autoStart: false, fileReferenceIds: ["file-remove"] })
    });
    const created = (await createResponse.json()) as { item: { id: string; attachments: Array<{ id: string }> } };
    const removeResponse = await fetch(
      `${server.baseUrl}/api/scratch-pad/items/${created.item.id}/attachments/${created.item.attachments[0]?.id}/remove`,
      { method: "POST" }
    );
    const removed = (await removeResponse.json()) as { item?: { attachments?: unknown[] } };

    assert.equal(createResponse.status, 201);
    assert.equal(removeResponse.status, 200);
    assert.deepEqual(removed.item?.attachments, []);
  } finally {
    await server.cleanup();
  }
});

test("scratch pad infers prototype, plan, recommendation, and API contracts without UI controls", async () => {
  const prompts: string[] = [];
  const server = await createServer(
    async () => ({ deletedArtifacts: 0, cleanupFailed: false, cleanupError: null }),
    {
      prepareScratchWorkspace: async () => ({
        cwd: "/repos/.manor-worktrees/manor/butler--shape-scratch",
        workspaceMode: "managed_worktree",
        branchName: "butler/shape-scratch",
        created: true
      }),
      startThread: async (input) => {
        const built = (await input.input(`thread-shape-${prompts.length}`)) as Array<{ type?: string; text?: string }>;
        prompts.push(built.find((entry) => entry.type === "text")?.text ?? "");
        return { threadId: `thread-shape-${prompts.length}` };
      }
    }
  );

  try {
    for (const text of [
      "Prototype a retry policy experiment.",
      "Create an implementation plan for scratchpad review.",
      "Recommend which option Butler should take next.",
      "Add API smoke coverage for the scratchpad endpoint."
    ]) {
      const response = await fetch(`${server.baseUrl}/api/scratch-pad/items`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text, autoStart: true })
      });
      assert.equal(response.status, 201);
    }

    assert.match(prompts[0] ?? "", /task_category: prototype/);
    assert.match(prompts[1] ?? "", /task_category: plan/);
    assert.match(prompts[2] ?? "", /task_category: recommendation/);
    assert.match(prompts[3] ?? "", /task_category: api/);
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
