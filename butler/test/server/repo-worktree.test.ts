import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, realpath, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";

import { ensureManagedWorktreeWritableForWorker, ensureWorkspaceWritableForWorker, execFileAsWorker, resolveCodexWorkerOwnership, taskRequiresManagedWorktree, validateWorkspaceCwd, WorkspaceCwdError } from "../../src/server/repo-worktree.js";

const execFileAsync = promisify(execFile);

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

test("Worker subprocesses do not inherit Butler control-plane secrets", async () => {
  const current = await stat(tmpdir());
  process.env.MANOR_HOST_CONTROLLER_TOKEN = "butler-secret";
  try {
    const { stdout } = await execFileAsWorker(
      process.execPath,
      ["-e", "process.stdout.write(process.env.MANOR_HOST_CONTROLLER_TOKEN ?? 'missing')"],
      tmpdir(),
      { uid: current.uid, gid: current.gid, label: "test" }
    );
    assert.equal(stdout, "missing");
  } finally {
    delete process.env.MANOR_HOST_CONTROLLER_TOKEN;
  }
});

test("taskRequiresManagedWorktree respects explicit existing-checkout instructions", () => {
  assert.equal(taskRequiresManagedWorktree("Stay in the existing checkout. Do not create a branch or worktree."), false);
  assert.equal(taskRequiresManagedWorktree("Implement this without a new branch."), false);
  assert.equal(taskRequiresManagedWorktree("Create an isolated worktree for this task."), true);
});

test("ensureManagedWorktreeWritableForWorker recursively prepares writable worktrees", async () => {
  const worktreePath = await mkdtemp(path.join(tmpdir(), "manor-worktree-ready-"));
  const nestedPath = path.join(worktreePath, "nested");
  const filePath = path.join(nestedPath, "file.txt");
  await mkdir(nestedPath);
  await writeFile(filePath, "content");
  await execFileAsync("git", ["init"], { cwd: worktreePath });

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

test("ensureWorkspaceWritableForWorker gives the Worker ownership of code and Git metadata without exposing ignored files", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "manor-workspace-ready-"));
  const tracked = path.join(workspace, "tracked.txt");
  const untracked = path.join(workspace, "notes.txt");
  const ignored = path.join(workspace, "ignored.env");
  const outside = path.join(await mkdtemp(path.join(tmpdir(), "manor-workspace-outside-")), "outside.txt");
  const linkedOutside = path.join(workspace, "linked-outside.txt");
  await execFileAsync("git", ["init"], { cwd: workspace });
  await execFileAsync("git", ["config", "user.name", "Manor Test"], { cwd: workspace });
  await execFileAsync("git", ["config", "user.email", "manor@example.test"], { cwd: workspace });
  await writeFile(path.join(workspace, ".gitignore"), "ignored.env\n");
  await writeFile(tracked, "tracked\n");
  await writeFile(untracked, "untracked\n");
  await writeFile(ignored, "secret\n");
  await writeFile(outside, "outside\n");
  await chmod(outside, 0o600);
  await symlink(outside, linkedOutside);
  await chmod(ignored, 0o600);
  await execFileAsync("git", ["add", ".gitignore", "tracked.txt"], { cwd: workspace });
  await execFileAsync("git", ["commit", "-m", "fixture"], { cwd: workspace });
  const hook = path.join(workspace, ".git", "hooks", "pre-commit");
  await writeFile(hook, "#!/bin/sh\nexit 0\n");
  await chmod(hook, 0o700);

  const current = await stat(workspace);
  const ownership = { uid: current.uid, gid: current.gid, label: `test (${current.uid}:${current.gid})` };
  await ensureWorkspaceWritableForWorker(workspace, ownership);
  await ensureWorkspaceWritableForWorker(workspace, ownership);

  assert.equal((await stat(workspace)).uid, ownership.uid);
  assert.equal((await stat(tracked)).uid, ownership.uid);
  assert.equal((await stat(untracked)).uid, ownership.uid);
  assert.equal((await stat(path.join(workspace, ".git"))).uid, ownership.uid);
  assert.equal((await stat(path.join(workspace, ".git", "config"))).uid, ownership.uid);
  assert.equal((await stat(hook)).uid, ownership.uid);
  assert.equal((await stat(ignored)).mode & 0o070, 0);
  assert.equal((await stat(outside)).mode & 0o070, 0);
});

test("ensureWorkspaceWritableForWorker rejects Git metadata outside an ordinary checkout", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "manor-workspace-external-git-"));
  const workspace = path.join(root, "workspace");
  const gitDir = path.join(root, "external.git");
  await mkdir(workspace);
  await execFileAsync("git", ["init", `--separate-git-dir=${gitDir}`], { cwd: workspace });
  const current = await stat(workspace);

  await assert.rejects(
    () => ensureWorkspaceWritableForWorker(workspace, { uid: current.uid, gid: current.gid, label: "test" }),
    /Linked Git worktree metadata is not allowed/
  );
});

test("validateWorkspaceCwd accepts and canonicalizes directories inside the shared root", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "manor-workspace-root-"));
  const project = path.join(root, "project");
  const alias = path.join(root, "project-alias");
  await mkdir(project);
  await symlink(project, alias);

  assert.equal(await validateWorkspaceCwd(alias, root), await realpath(project));
  assert.equal(await validateWorkspaceCwd(root, root), await realpath(root));
});

test("validateWorkspaceCwd rejects invalid paths and symlink escapes", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "manor-workspace-root-"));
  const outside = await mkdtemp(path.join(tmpdir(), "manor-workspace-outside-"));
  const file = path.join(root, "file.txt");
  const escape = path.join(root, "escape");
  await writeFile(file, "content");
  await symlink(outside, escape);

  for (const candidate of ["relative/path", path.join(root, "missing"), file, outside, escape]) {
    await assert.rejects(() => validateWorkspaceCwd(candidate, root), WorkspaceCwdError);
  }
});
