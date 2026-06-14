import assert from "node:assert/strict";
import { mkdir, mkdtemp, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { ensureManagedWorktreeWritableForWorker, resolveCodexWorkerOwnership } from "../../src/server/repo-worktree.js";

test("resolveCodexWorkerOwnership defaults to the codex container uid and gid", () => {
  assert.deepEqual(resolveCodexWorkerOwnership({}), {
    uid: 1001,
    gid: 1001,
    label: "codex (1001:1001)"
  });
});

test("resolveCodexWorkerOwnership rejects invalid worker uid diagnostics", () => {
  assert.throws(
    () => resolveCodexWorkerOwnership({ MANOR_CODEX_WORKER_UID: "root" }),
    /MANOR_CODEX_WORKER_UID must be a non-negative integer/
  );
});

test("ensureManagedWorktreeWritableForWorker recursively prepares writable worktrees", async () => {
  const worktreePath = await mkdtemp(path.join(tmpdir(), "manor-worktree-ready-"));
  const nestedPath = path.join(worktreePath, "nested");
  const filePath = path.join(nestedPath, "file.txt");
  await mkdir(nestedPath);
  await writeFile(filePath, "content");

  const current = await stat(worktreePath);
  const ownership = { uid: current.uid, gid: current.gid, label: `test (${current.uid}:${current.gid})` };

  await ensureManagedWorktreeWritableForWorker(worktreePath, ownership);
  await writeFile(path.join(worktreePath, "worker-can-write.txt"), "ok");

  const nested = await stat(nestedPath);
  const file = await stat(filePath);
  assert.equal(nested.uid, ownership.uid);
  assert.equal(nested.gid, ownership.gid);
  assert.equal(file.uid, ownership.uid);
  assert.equal(file.gid, ownership.gid);
});
