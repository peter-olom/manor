import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { promises as fs } from "node:fs";

const execFileAsync = promisify(execFile);
const MANAGED_WORKTREE_ROOT = "/repos/.manor-worktrees";

function slugifyTask(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 36);

  return slug || "task";
}

async function git(args: string[], cwd: string): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd });
  return stdout.trim();
}

export async function cleanupManagedWorktree(cwd: string): Promise<number> {
  if (!isManagedWorktree(cwd)) {
    return 0;
  }

  const worktreePath = cwd.trim();
  if (!worktreePath) {
    return 0;
  }

  const branchName = await git(["branch", "--show-current"], worktreePath).catch(() => "");
  const commonGitDir = await git(["rev-parse", "--git-common-dir"], worktreePath).catch(() => "");
  const repoRoot = commonGitDir ? path.dirname(commonGitDir) : "";

  let removed = 0;

  await git(["worktree", "remove", "--force", worktreePath], repoRoot || worktreePath).catch(() => undefined);
  await fs.rm(worktreePath, { recursive: true, force: true }).catch(() => undefined);
  removed += 1;

  if (repoRoot && branchName) {
    await git(["branch", "-D", branchName], repoRoot).catch(() => undefined);
    removed += 1;
  }

  return removed;
}

async function branchExists(repoRoot: string, branchName: string): Promise<boolean> {
  try {
    await git(["rev-parse", "--verify", "--quiet", `refs/heads/${branchName}`], repoRoot);
    return true;
  } catch {
    return false;
  }
}

async function ensureUniqueBranchName(repoRoot: string, baseName: string): Promise<string> {
  let branchName = baseName;
  let index = 2;

  while (await branchExists(repoRoot, branchName)) {
    branchName = `${baseName}-${index}`;
    index += 1;
  }

  return branchName;
}

export async function resolveGitRoot(cwd: string): Promise<string | null> {
  try {
    const root = await git(["rev-parse", "--show-toplevel"], cwd);
    return root || null;
  } catch {
    return null;
  }
}

export function isManagedWorktree(cwd: string): boolean {
  return cwd.startsWith(`${MANAGED_WORKTREE_ROOT}/`);
}

export async function ensureTaskWorktree(options: {
  cwd: string;
  task: string;
}): Promise<{ cwd: string; branchName: string | null; repoRoot: string | null; created: boolean }> {
  const repoRoot = await resolveGitRoot(options.cwd);
  if (!repoRoot) {
    return {
      cwd: options.cwd,
      branchName: null,
      repoRoot: null,
      created: false
    };
  }

  if (isManagedWorktree(options.cwd)) {
    const branchName = await git(["branch", "--show-current"], options.cwd).catch(() => "");
    return {
      cwd: options.cwd,
      branchName: branchName || null,
      repoRoot,
      created: false
    };
  }

  const repoName = path.basename(repoRoot);
  const baseBranchName = `butler/${slugifyTask(options.task)}`;
  const branchName = await ensureUniqueBranchName(repoRoot, baseBranchName);
  const worktreePath = path.join(MANAGED_WORKTREE_ROOT, repoName, branchName.replace(/\//g, "--"));

  await fs.mkdir(path.dirname(worktreePath), { recursive: true });
  await git(["worktree", "add", "-b", branchName, worktreePath, "HEAD"], repoRoot);

  return {
    cwd: worktreePath,
    branchName,
    repoRoot,
    created: true
  };
}
