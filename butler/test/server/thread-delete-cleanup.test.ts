import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { CodexAppServerClient } from "../../src/server/codex-client.js";
import { handleHarnessProofAction } from "../../src/server/codex-harness-proof.js";
import { ButlerStateStore } from "../../src/server/state-store.js";

const THREAD_ID = "019e9e93-fefc-76b1-abb8-0e2f1ac1d8b4";
const THREAD_CREATED_AT = Date.UTC(2026, 5, 6, 20, 15, 59);

async function exists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function writeFixture(filePath: string, body = "{}\n"): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, body);
}

async function createStore(dir: string): Promise<ButlerStateStore> {
  const store = new ButlerStateStore(path.join(dir, "state.json"));
  await store.load();
  return store;
}

async function recordTextProof(input: {
  store: ButlerStateStore;
  artifactsDir: string;
  threadId: string;
  cwd: string;
  title?: string;
}): Promise<{ filePath: string; runDir: string; threadDir: string }> {
  const result = await handleHarnessProofAction({
    action: "proof.text",
    params: {
      title: input.title ?? "Cleanup proof",
      label: "cleanup-proof",
      text: "Proof artifact cleanup regression."
    },
    capability: { threadId: input.threadId, cwd: input.cwd } as never,
    thread: { id: input.threadId } as never,
    store: input.store,
    artifactsDir: input.artifactsDir,
    resolveWorkspaceProject: () => ({ id: "project-1", label: "Project One" })
  });
  const artifact = result?.data?.verification && typeof result.data.verification === "object"
    ? (result.data.verification as { artifacts?: Array<{ filePath?: string }> }).artifacts?.[0]
    : null;
  assert.ok(artifact?.filePath);
  return {
    filePath: artifact.filePath,
    runDir: path.dirname(artifact.filePath),
    threadDir: path.dirname(path.dirname(artifact.filePath))
  };
}

async function waitFor(predicate: () => boolean, timeoutMs = 500): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(predicate(), true);
}

async function waitForAsync(predicate: () => Promise<boolean>, timeoutMs = 500): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(await predicate(), true);
}

test("thread artifact cleanup targets the thread session date instead of scanning all history", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "manor-thread-delete-cleanup-"));
  try {
    const codexHome = path.join(dir, "codex-home");
    const store = await createStore(dir);
    const client = new CodexAppServerClient("ws://127.0.0.1:1", store, codexHome) as unknown as {
      deleteThreadArtifacts: (threadId: string, cwd: string | null, threadCreatedAt: number | null) => Promise<number>;
    };

    const targetSession = path.join(
      codexHome,
      "sessions/2026/06/06",
      `rollout-2026-06-06T20-15-59-${THREAD_ID}.jsonl`
    );
    const unrelatedHistoricSession = path.join(
      codexHome,
      "sessions/1999/01/01",
      `rollout-1999-01-01T00-00-00-${THREAD_ID}.jsonl`
    );
    const targetSnapshot = path.join(codexHome, "shell_snapshots", `${THREAD_ID}.json`);
    const nestedHistoricSnapshot = path.join(codexHome, "shell_snapshots/nested", `${THREAD_ID}.json`);

    await writeFixture(targetSession);
    await writeFixture(unrelatedHistoricSession);
    await writeFixture(targetSnapshot);
    await writeFixture(nestedHistoricSnapshot);

    await client.deleteThreadArtifacts(THREAD_ID, null, THREAD_CREATED_AT);

    assert.equal(await exists(targetSession), false);
    assert.equal(await exists(targetSnapshot), false);
    assert.equal(await exists(unrelatedHistoricSession), true);
    assert.equal(await exists(nestedHistoricSnapshot), true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("thread delete starts queued cleanup before best-effort unsubscribe can hang", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "manor-thread-delete-queue-"));
  try {
    const store = await createStore(dir);
    store.upsertThreadSummary({
      id: THREAD_ID,
      status: "idle",
      source: "appServer",
      cwd: "/workspace",
      createdAt: THREAD_CREATED_AT / 1000,
      turns: []
    });

    let cleanupContextSeen = false;
    let artifactCleanupCreatedAt: number | null | undefined;
    const client = new CodexAppServerClient("ws://127.0.0.1:1", store, path.join(dir, "codex-home"), {
      onThreadDeleting: async () => {
        cleanupContextSeen = true;
      },
      onThreadCapabilityRemoved: async () => undefined
    }) as unknown as {
      call: () => Promise<Record<string, unknown>>;
      deleteThread: (threadId: string) => Promise<{ deletedArtifacts: number }>;
      deleteThreadArtifacts: (threadId: string, cwd: string | null, threadCreatedAt: number | null) => Promise<number>;
    };

    client.call = () => new Promise(() => undefined);
    client.deleteThreadArtifacts = async (_threadId, _cwd, threadCreatedAt) => {
      artifactCleanupCreatedAt = threadCreatedAt;
      return 0;
    };

    void client.deleteThread(THREAD_ID);

    await waitFor(() => cleanupContextSeen && artifactCleanupCreatedAt === THREAD_CREATED_AT && !store.getThread(THREAD_ID));
    assert.equal(store.listDueRuntimeCleanupTasks().length, 0);
    await store.flushSave();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("ordinary thread delete removes queued proof artifacts after proof records are removed", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "manor-thread-proof-cleanup-"));
  try {
    const store = await createStore(dir);
    const artifactsDir = path.join(dir, "artifacts");
    store.upsertThreadSummary({
      id: THREAD_ID,
      status: "idle",
      source: "appServer",
      cwd: "/workspace",
      createdAt: THREAD_CREATED_AT / 1000,
      turns: []
    });
    const proof = await recordTextProof({ store, artifactsDir, threadId: THREAD_ID, cwd: "/workspace" });
    assert.equal(await exists(proof.filePath), true);
    assert.equal(store.listPreviewProofs().filter((entry) => entry.threadId === THREAD_ID).length, 1);

    const client = new CodexAppServerClient("ws://127.0.0.1:1", store, path.join(dir, "codex-home"), {
      artifactsDir
    }) as unknown as {
      call: () => Promise<Record<string, unknown>>;
      deleteThread: (threadId: string) => Promise<{ deletedArtifacts: number }>;
      processPendingCleanupTasks: () => Promise<void>;
    };
    client.call = async () => ({});

    await client.deleteThread(THREAD_ID);
    assert.equal(store.listPreviewProofs().filter((entry) => entry.threadId === THREAD_ID).length, 0);

    await client.processPendingCleanupTasks();

    await waitForAsync(async () => !(await exists(proof.filePath)) && store.listDueRuntimeCleanupTasks().length === 0);

    assert.equal(await exists(proof.filePath), false);
    assert.equal(await exists(proof.runDir), false);
    assert.equal(await exists(proof.threadDir), false);
    assert.equal(store.listDueRuntimeCleanupTasks().length, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("delete all threads preserves proof artifact paths for queued cleanup", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "manor-delete-all-proof-cleanup-"));
  try {
    const store = await createStore(dir);
    const artifactsDir = path.join(dir, "artifacts");
    const otherThreadId = "019e9e93-fefc-76b1-abb8-0e2f1ac1d8b5";
    for (const threadId of [THREAD_ID, otherThreadId]) {
      store.upsertThreadSummary({
        id: threadId,
        status: "idle",
        source: "appServer",
        cwd: `/workspace/${threadId}`,
        createdAt: THREAD_CREATED_AT / 1000,
        turns: []
      });
    }
    const firstProof = await recordTextProof({ store, artifactsDir, threadId: THREAD_ID, cwd: "/workspace/one", title: "First cleanup proof" });
    const secondProof = await recordTextProof({ store, artifactsDir, threadId: otherThreadId, cwd: "/workspace/two", title: "Second cleanup proof" });
    assert.equal(await exists(firstProof.filePath), true);
    assert.equal(await exists(secondProof.filePath), true);
    assert.equal(store.listPreviewProofs().length, 2);

    const client = new CodexAppServerClient("ws://127.0.0.1:1", store, path.join(dir, "codex-home"), {
      artifactsDir
    }) as unknown as {
      call: () => Promise<Record<string, unknown>>;
      deleteAllThreads: () => Promise<{ deletedThreadIds: string[] }>;
      processPendingCleanupTasks: () => Promise<void>;
    };
    client.call = async () => ({});

    await client.deleteAllThreads();
    assert.equal(store.listPreviewProofs().length, 0);

    await client.processPendingCleanupTasks();

    await waitForAsync(
      async () => !(await exists(firstProof.filePath)) && !(await exists(secondProof.filePath)) && store.listDueRuntimeCleanupTasks().length === 0
    );

    assert.equal(await exists(firstProof.filePath), false);
    assert.equal(await exists(firstProof.runDir), false);
    assert.equal(await exists(firstProof.threadDir), false);
    assert.equal(await exists(secondProof.filePath), false);
    assert.equal(await exists(secondProof.runDir), false);
    assert.equal(await exists(secondProof.threadDir), false);
    assert.equal(store.listDueRuntimeCleanupTasks().length, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
