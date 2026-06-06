import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { CodexAppServerClient } from "../../src/server/codex-client.js";
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
