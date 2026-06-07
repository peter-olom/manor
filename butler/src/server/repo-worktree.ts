import { execFile } from "node:child_process";
import type { Dirent } from "node:fs";
import { promisify } from "node:util";
import path from "node:path";
import { promises as fs } from "node:fs";

const execFileAsync = promisify(execFile);
const MANAGED_WORKTREE_ROOT = "/repos/.manor-worktrees";
const SHARED_WORKSPACE_ROOT = "/repos";

export type WorkstreamGroupKind = "project" | "workspace";

export interface WorkspaceProjectDirectory {
  id: string;
  label: string;
  cwd: string;
  kind: "project";
  gitBacked: boolean;
}

export function resolveWorkspaceProjectInfo(cwd: string | null | undefined): { id: string; label: string; kind: WorkstreamGroupKind } {
  const normalized = typeof cwd === "string" ? cwd.replace(/\\/g, "/").replace(/\/+$/, "") : "";
  if (!normalized) {
    return { id: "unknown", label: "Unknown", kind: "workspace" };
  }

  if (normalized === SHARED_WORKSPACE_ROOT) {
    return { id: "workspace:shared", label: "Shared workspace", kind: "workspace" };
  }

  if (normalized.startsWith(`${MANAGED_WORKTREE_ROOT}/`)) {
    const relative = normalized.slice(MANAGED_WORKTREE_ROOT.length + 1);
    const [repoName] = relative.split("/").filter(Boolean);
    if (repoName) {
      return { id: repoName, label: repoName, kind: "project" };
    }
  }

  if (normalized.startsWith("/repos/")) {
    const relative = normalized.replace(/^\/repos\/?/, "");
    const [repoName] = relative.split("/").filter(Boolean);
    if (repoName) {
      return { id: repoName, label: repoName, kind: "project" };
    }
  }

  return { id: normalized, label: `Workspace: ${normalized}`, kind: "workspace" };
}

function slugifyTask(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 36);

  return slug || "task";
}

async function git(args: string[], cwd: string): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-c", "safe.directory=*", ...args], { cwd });
  return stdout.trim();
}

function normalizeTaskText(value: string): string {
  return value.toLowerCase().replace(/\s+/g, " ").trim();
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

function resolveManagedWorktreeFallback(cwd: string): string | null {
  const normalized = cwd.replace(/\\/g, "/").replace(/\/+$/, "");
  if (!normalized.startsWith(`${MANAGED_WORKTREE_ROOT}/`)) {
    return null;
  }

  const relative = normalized.slice(MANAGED_WORKTREE_ROOT.length + 1);
  const [repoName] = relative.split("/").filter(Boolean);
  if (!repoName) {
    return null;
  }

  return path.join("/repos", repoName);
}

export async function resolveExistingWorkspaceCwd(cwd: string): Promise<string> {
  const normalized = cwd.trim();
  if (!normalized) {
    return normalized;
  }

  if (await pathExists(normalized)) {
    return normalized;
  }

  const managedFallback = resolveManagedWorktreeFallback(normalized);
  if (managedFallback && await pathExists(managedFallback)) {
    return managedFallback;
  }

  return normalized;
}

export async function listWorkspaceProjectDirectories(root: string = SHARED_WORKSPACE_ROOT): Promise<WorkspaceProjectDirectory[]> {
  const normalizedRoot = path.resolve(root);
  const projectsByCwd = new Map<string, WorkspaceProjectDirectory>();

  async function readDirectoryEntries(directory: string): Promise<Dirent[] | null> {
    try {
      return await fs.readdir(directory, { withFileTypes: true });
    } catch {
      return null;
    }
  }

  function addProject(directory: string, gitBacked: boolean): void {
    const relativeLabel = path.relative(normalizedRoot, directory) || path.basename(directory);
    const existing = projectsByCwd.get(directory);
    projectsByCwd.set(directory, {
      id: existing?.id ?? relativeLabel,
      label: existing?.label ?? relativeLabel,
      cwd: directory,
      kind: "project",
      gitBacked: Boolean(existing?.gitBacked || gitBacked)
    });
  }

  async function visitGitRepositories(directory: string): Promise<void> {
    const entries = await readDirectoryEntries(directory);
    if (!entries) {
      return;
    }
    if (entries.some((entry) => entry.isDirectory() && entry.name === ".git")) {
      addProject(directory, true);
      return;
    }

    const childDirectories = entries
      .filter((entry) => entry.isDirectory())
      .filter((entry) => !entry.name.startsWith("."))
      .map((entry) => path.join(directory, entry.name));

    await Promise.all(childDirectories.map((childDirectory) => visitGitRepositories(childDirectory)));
  }

  const rootEntries = await readDirectoryEntries(normalizedRoot);
  if (!rootEntries) {
    return [];
  }

  const topLevelDirectories = rootEntries
    .filter((entry) => entry.isDirectory())
    .filter((entry) => !entry.name.startsWith("."))
    .map((entry) => path.join(normalizedRoot, entry.name));

  await Promise.all(
    topLevelDirectories.map(async (directory) => {
      const entries = await readDirectoryEntries(directory);
      addProject(directory, Boolean(entries?.some((entry) => entry.isDirectory() && entry.name === ".git")));
      if (!entries?.some((entry) => entry.isDirectory() && entry.name === ".git")) {
        await visitGitRepositories(directory);
      }
    })
  );

  return [...projectsByCwd.values()].sort((left, right) => left.label.localeCompare(right.label));
}

export async function cleanupManagedWorktree(cwd: string): Promise<number> {
  if (!isManagedWorktree(cwd)) {
    return 0;
  }

  const worktreePath = cwd.trim();
  if (!worktreePath) {
    return 0;
  }
  if (!await pathExists(worktreePath)) {
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

export async function resolveWorkspaceBranchName(cwd: string): Promise<string | null> {
  const repoRoot = await resolveGitRoot(cwd);
  if (!repoRoot) {
    return null;
  }

  const branchName = await git(["branch", "--show-current"], cwd).catch(() => "");
  return branchName || null;
}

export function isManagedWorktree(cwd: string): boolean {
  return cwd.startsWith(`${MANAGED_WORKTREE_ROOT}/`);
}

export function taskRequiresManagedWorktree(taskText: string): boolean {
  const normalized = normalizeTaskText(taskText);
  if (/\b(read-only|report only|question only|no code changes|do not code|do not edit|do not modify)\b/.test(normalized)) {
    return false;
  }

  return /\b(dedicated branch|isolated branch|branch isolation|isolated worktree|managed worktree|parallel jobs|parallel workstreams|checkout|new branch|create branch|switch branch|worktree)\b/.test(
    normalized
  );
}

export async function ensureTaskWorktree(options: {
  cwd: string;
  task: string;
}): Promise<{ cwd: string; branchName: string | null; repoRoot: string | null; created: boolean }> {
  const requestedCwd = await resolveExistingWorkspaceCwd(options.cwd);
  const repoRoot = await resolveGitRoot(requestedCwd);
  if (!repoRoot) {
    return {
      cwd: requestedCwd,
      branchName: null,
      repoRoot: null,
      created: false
    };
  }

  if (isManagedWorktree(requestedCwd)) {
    const branchName = await git(["branch", "--show-current"], requestedCwd).catch(() => "");
    return {
      cwd: requestedCwd,
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
