import { execFile } from "node:child_process";
import { constants as fsConstants, type Dirent } from "node:fs";
import { promisify } from "node:util";
import path from "node:path";
import { promises as fs } from "node:fs";

const execFileAsync = promisify(execFile);
const MANAGED_WORKTREE_ROOT = "/repos/.manor-worktrees";
const SHARED_WORKSPACE_ROOT = "/repos";
const DEFAULT_CODEX_WORKER_UID = 1001;
const DEFAULT_CODEX_WORKER_GID = 1001;

export interface WorkerOwnership {
  uid: number;
  gid: number;
  label: string;
}

export type WorkstreamGroupKind = "project" | "workspace";

export interface WorkspaceProjectDirectory {
  id: string;
  label: string;
  cwd: string;
  kind: "project";
  gitBacked: boolean;
}

export class WorkspaceCwdError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkspaceCwdError";
  }
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
  const { stdout } = await execFileAsync("git", ["-c", "safe.directory=*", "-c", "core.hooksPath=/dev/null", ...args], { cwd });
  return stdout.trim();
}

function normalizeTaskText(value: string): string {
  return value.toLowerCase().replace(/\s+/g, " ").trim();
}

function parseWorkerId(value: string | undefined, fallback: number, name: string): number {
  const normalized = value?.trim();
  if (!normalized) {
    return fallback;
  }

  const parsed = Number(normalized);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${name} must be a non-negative integer, got ${JSON.stringify(value)}`);
  }
  return parsed;
}

export function resolveCodexWorkerOwnership(env: NodeJS.ProcessEnv = process.env): WorkerOwnership {
  const uid = parseWorkerId(env.MANOR_CODEX_WORKER_UID, DEFAULT_CODEX_WORKER_UID, "MANOR_CODEX_WORKER_UID");
  const gid = parseWorkerId(env.MANOR_CODEX_WORKER_GID, DEFAULT_CODEX_WORKER_GID, "MANOR_CODEX_WORKER_GID");
  const label = (env.MANOR_CODEX_WORKER_USER?.trim() || "codex") + ` (${uid}:${gid})`;
  return { uid, gid, label };
}

function absoluteGitPath(cwd: string, value: string): string {
  return path.isAbsolute(value) ? value : path.resolve(cwd, value);
}

function pathIsWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

async function chownPathToWorker(targetPath: string, ownership: WorkerOwnership): Promise<void> {
  const handle = await openPathNoFollow(targetPath);
  if (!handle) {
    await fs.lchown(targetPath, ownership.uid, ownership.gid);
    return;
  }
  try {
    const stat = await handle.stat();
    if (stat.uid !== ownership.uid || stat.gid !== ownership.gid) await handle.chown(ownership.uid, ownership.gid);
  } finally {
    await handle.close();
  }
}

async function chownTreeToWorker(targetPath: string, ownership: WorkerOwnership): Promise<void> {
  const handle = await openPathNoFollow(targetPath);
  if (!handle) {
    await fs.lchown(targetPath, ownership.uid, ownership.gid);
    return;
  }
  try {
    const stat = await handle.stat();
    if (stat.uid !== ownership.uid || stat.gid !== ownership.gid) await handle.chown(ownership.uid, ownership.gid);
    if (!stat.isDirectory()) return;
    const stablePath = process.platform === "linux" ? `/proc/self/fd/${handle.fd}` : targetPath;
    const entries = await fs.readdir(stablePath);
    for (const entry of entries) {
      await chownTreeToWorker(path.join(stablePath, entry), ownership);
    }
  } finally {
    await handle.close();
  }
}

async function openPathNoFollow(targetPath: string) {
  try {
    return await fs.open(targetPath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ELOOP") return null;
    throw error;
  }
}

async function resolveGitStorage(cwd: string): Promise<{ commonDir: string; gitDir: string }> {
  const [commonDirValue, gitDirValue, repoRootValue] = await Promise.all([
    git(["rev-parse", "--git-common-dir"], cwd),
    git(["rev-parse", "--git-dir"], cwd),
    git(["rev-parse", "--show-toplevel"], cwd)
  ]);
  const [repoRoot, commonDir, gitDir] = await Promise.all([
    fs.realpath(absoluteGitPath(cwd, repoRootValue)),
    fs.realpath(absoluteGitPath(cwd, commonDirValue)),
    fs.realpath(absoluteGitPath(cwd, gitDirValue))
  ]);

  const dotGit = path.join(repoRoot, ".git");
  const dotGitStat = await fs.lstat(dotGit);
  if (dotGitStat.isDirectory()) {
    const expectedCommonDir = await fs.realpath(dotGit);
    if (commonDir !== expectedCommonDir) throw new Error(`Git common directory is outside the repository metadata at ${repoRoot}.`);
  } else {
    const managedRelative = path.relative(MANAGED_WORKTREE_ROOT, repoRoot);
    const [repoName] = managedRelative.split(path.sep).filter(Boolean);
    if (managedRelative.startsWith(`..${path.sep}`) || path.isAbsolute(managedRelative) || !repoName) {
      throw new Error(`Linked Git worktree metadata is not allowed outside ${MANAGED_WORKTREE_ROOT}.`);
    }
    const expectedCommonDir = await fs.realpath(path.join(SHARED_WORKSPACE_ROOT, repoName, ".git"));
    if (commonDir !== expectedCommonDir) throw new Error(`Managed worktree Git metadata does not belong to ${repoName}.`);
  }
  if (!pathIsWithin(commonDir, gitDir)) throw new Error("Git worktree metadata is outside its common Git directory.");
  return { commonDir, gitDir };
}

async function chownGitMetadataToWorker(cwd: string, ownership: WorkerOwnership, force = false): Promise<{ gitDir: string }> {
  const { commonDir, gitDir } = await resolveGitStorage(cwd);
  const marker = path.join(commonDir, `.manor-worker-owner-${ownership.uid}-${ownership.gid}-ready-v1`);
  if (force || !await pathExists(marker)) {
    await chownTreeToWorker(commonDir, ownership);
    await fs.writeFile(marker, `${ownership.uid}:${ownership.gid}\n`, "utf8");
    await chownPathToWorker(marker, ownership);
  } else {
    await chownPathToWorker(commonDir, ownership);
  }
  if (gitDir !== commonDir) await chownTreeToWorker(gitDir, ownership);
  return { gitDir };
}

const workspaceReadinessLocks = new Map<string, Promise<void>>();

async function withWorkspaceReadinessLock<T>(cwd: string, operation: () => Promise<T>): Promise<T> {
  const commonDir = (await resolveGitStorage(cwd).catch(() => null))?.commonDir ?? path.resolve(cwd);
  const previous = workspaceReadinessLocks.get(commonDir) ?? Promise.resolve();
  let release: () => void = () => undefined;
  const current = new Promise<void>((resolve) => { release = resolve; });
  workspaceReadinessLocks.set(commonDir, current);
  await previous.catch(() => undefined);
  try {
    return await operation();
  } finally {
    release();
    if (workspaceReadinessLocks.get(commonDir) === current) workspaceReadinessLocks.delete(commonDir);
  }
}

async function chownWorkingTreeToWorker(cwd: string, ownership: WorkerOwnership): Promise<void> {
  const root = await git(["rev-parse", "--show-toplevel"], cwd);
  const listed = await git(["ls-files", "-z", "--cached", "--others", "--exclude-standard"], root);
  const directories = new Set<string>([root]);
  const files: string[] = [];

  for (const relative of listed.split("\0").filter(Boolean)) {
    const candidate = path.resolve(root, relative);
    const withinRoot = path.relative(root, candidate);
    if (withinRoot.startsWith(`..${path.sep}`) || path.isAbsolute(withinRoot)) continue;
    if (!await pathExists(candidate)) continue;
    files.push(candidate);
    for (let parent = path.dirname(candidate); parent.startsWith(root); parent = path.dirname(parent)) {
      directories.add(parent);
      if (parent === root) break;
    }
  }

  const orderedDirectories = [...directories].sort((left, right) => left.length - right.length);
  for (const directory of orderedDirectories) await chownPathToWorker(directory, ownership);
  for (const file of files) await chownPathToWorker(file, ownership);
}

async function runAsWorker(
  command: string,
  args: string[],
  cwd: string,
  ownership: WorkerOwnership
): Promise<void> {
  await execFileAsWorker(command, args, cwd, ownership);
}

export async function execFileAsWorker(
  command: string,
  args: string[],
  cwd: string,
  ownership: WorkerOwnership = resolveCodexWorkerOwnership(),
  env: NodeJS.ProcessEnv = {},
  options: { maxBuffer?: number; timeout?: number } = {}
) {
  const workerEnv: NodeJS.ProcessEnv = {
    PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
    HOME: "/tmp",
    LANG: process.env.LANG ?? "C.UTF-8",
    ...env
  };
  const sameIdentity = process.getuid?.() === ownership.uid && process.getgid?.() === ownership.gid;
  const workerArgs = sameIdentity
    ? args
    : [`--reuid=${ownership.uid}`, `--regid=${ownership.gid}`, "--clear-groups", command, ...args];
  return await execFileAsync(sameIdentity ? command : "setpriv", workerArgs, { cwd, env: workerEnv, ...options });
}

export async function ensureWorkerOwnedDirectory(
  targetPath: string,
  ownership: WorkerOwnership = resolveCodexWorkerOwnership()
): Promise<void> {
  await fs.mkdir(targetPath, { recursive: true });
  await chownTreeToWorker(targetPath, ownership);
}

async function gitAsWorker(args: string[], cwd: string, ownership: WorkerOwnership = resolveCodexWorkerOwnership()): Promise<string> {
  const { stdout } = await execFileAsWorker("git", ["-c", "safe.directory=*", "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", ...args], cwd, ownership);
  return stdout.trim();
}

async function assertWorkspaceReadyForWorker(
  cwd: string,
  gitDir: string | null,
  ownership: WorkerOwnership
): Promise<void> {
  const probeName = `.manor-worker-write-probe-${process.pid}`;
  const probeScript = [
    'const fs = require("node:fs");',
    'const path = require("node:path");',
    'const [cwd, gitDir, name] = process.argv.slice(1);',
    'const probe = path.join(cwd, name);',
    'try {',
    '  fs.writeFileSync(probe, "manor-worker-readiness\\n");',
    '  if (gitDir) {',
    '    const index = path.join(gitDir, "index");',
    '    if (fs.existsSync(index)) fs.accessSync(index, fs.constants.R_OK | fs.constants.W_OK);',
    '  }',
    '} finally { fs.rmSync(probe, { force: true }); }'
  ].join("\n");

  try {
    await runAsWorker(process.execPath, ["-e", probeScript, cwd, gitDir ?? "", probeName], cwd, ownership);
    const probePath = path.join(cwd, probeName);
    if (gitDir) {
      await fs.writeFile(probePath, "manor-worker-readiness\n", "utf8");
      try {
      await runAsWorker("git", ["-c", "safe.directory=*", "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "hash-object", "-w", probePath], cwd, ownership);
      } finally {
        await fs.rm(probePath, { force: true });
      }
      await runAsWorker("git", ["-c", "safe.directory=*", "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "status", "--short"], cwd, ownership);
    }
  } catch (error) {
    throw new Error(
      `Workspace ${cwd} is not ready for the Worker ${ownership.label}. ` +
        `${error instanceof Error ? error.message : String(error)}`
    );
  }
}

export async function checkWorkspaceReadyForWorker(
  cwd: string,
  ownership: WorkerOwnership = resolveCodexWorkerOwnership()
): Promise<void> {
  const repoRoot = await resolveGitRoot(cwd);
  const storage = repoRoot ? await resolveGitStorage(repoRoot) : null;
  const probeScript = [
    'const fs = require("node:fs");',
    'const [cwd, gitDir, commonDir] = process.argv.slice(1);',
    'fs.accessSync(cwd, fs.constants.R_OK | fs.constants.W_OK);',
    'if (gitDir) {',
    '  const index = require("node:path").join(gitDir, "index");',
    '  if (fs.existsSync(index)) fs.accessSync(index, fs.constants.R_OK | fs.constants.W_OK);',
    '  fs.accessSync(commonDir, fs.constants.R_OK | fs.constants.W_OK);',
    '  fs.accessSync(require("node:path").join(commonDir, "objects"), fs.constants.R_OK | fs.constants.W_OK);',
    '  fs.accessSync(require("node:path").join(commonDir, "config"), fs.constants.R_OK);',
    '}'
  ].join("\n");
  const target = repoRoot ?? cwd;
  await runAsWorker(process.execPath, ["-e", probeScript, target, storage?.gitDir ?? "", storage?.commonDir ?? ""], target, ownership);
  if (repoRoot) await runAsWorker("git", ["-c", "safe.directory=*", "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "status", "--short"], repoRoot, ownership);
}

export async function ensureWorkspaceWritableForWorker(
  cwd: string,
  ownership: WorkerOwnership = resolveCodexWorkerOwnership()
): Promise<void> {
  await withWorkspaceReadinessLock(cwd, async () => {
    const repoRoot = await resolveGitRoot(cwd);
    if (!repoRoot) {
      if (path.resolve(cwd) === SHARED_WORKSPACE_ROOT) await chownPathToWorker(cwd, ownership);
      else await chownTreeToWorker(cwd, ownership);
      await assertWorkspaceReadyForWorker(cwd, null, ownership);
      return;
    }
    await chownWorkingTreeToWorker(repoRoot, ownership);
    const { gitDir } = await chownGitMetadataToWorker(repoRoot, ownership);
    try {
      await assertWorkspaceReadyForWorker(repoRoot, gitDir, ownership);
    } catch {
      await chownGitMetadataToWorker(repoRoot, ownership, true);
      await assertWorkspaceReadyForWorker(repoRoot, gitDir, ownership);
    }
  });
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function assertWritableByCurrentProcess(targetPath: string): Promise<void> {
  const probePath = path.join(targetPath, `.manor-worktree-write-probe-${process.pid}-${Date.now()}`);
  await fs.writeFile(probePath, "ok");
  await fs.rm(probePath, { force: true });
}

export async function ensureManagedWorktreeWritableForWorker(
  worktreePath: string,
  ownership: WorkerOwnership = resolveCodexWorkerOwnership()
): Promise<void> {
  try {
    await chownTreeToWorker(worktreePath, ownership);
  } catch (error) {
    throw new Error(
      `Managed worktree ${worktreePath} is not ready for the Worker ${ownership.label}: ` +
        `could not repair ownership recursively. ${error instanceof Error ? error.message : String(error)}`
    );
  }

  try {
    await assertWritableByCurrentProcess(worktreePath);
  } catch (error) {
    throw new Error(
      `Managed worktree ${worktreePath} is not writable after ownership repair for the Worker ${ownership.label}. ` +
      `${error instanceof Error ? error.message : String(error)}`
    );
  }

  try {
    await withWorkspaceReadinessLock(worktreePath, async () => {
      const { gitDir } = await chownGitMetadataToWorker(worktreePath, ownership);
      await assertWorkspaceReadyForWorker(worktreePath, gitDir, ownership);
    });
  } catch (error) {
    throw new Error(
      `Managed worktree ${worktreePath} Git metadata is not ready for the Worker ${ownership.label}. ` +
        `${error instanceof Error ? error.message : String(error)}`
    );
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

export async function validateWorkspaceCwd(cwd: string, root: string = SHARED_WORKSPACE_ROOT): Promise<string> {
  const requested = cwd.trim();
  if (!requested) throw new WorkspaceCwdError("Workspace directory is required.");
  if (!path.isAbsolute(requested)) throw new WorkspaceCwdError("Workspace directory must be an absolute path.");

  const realRoot = await fs.realpath(path.resolve(root)).catch(() => {
    throw new WorkspaceCwdError("The shared workspace is unavailable.");
  });
  const realCwd = await fs.realpath(path.resolve(requested)).catch(() => {
    throw new WorkspaceCwdError("That workspace directory does not exist.");
  });
  const relative = path.relative(realRoot, realCwd);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new WorkspaceCwdError("Workspace directory must be inside the shared workspace.");
  }
  const info = await fs.stat(realCwd).catch(() => null);
  if (!info?.isDirectory()) throw new WorkspaceCwdError("Workspace must point to a directory.");
  return realCwd;
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

  const ownership = resolveCodexWorkerOwnership();
  await ensureWorkspaceWritableForWorker(worktreePath, ownership).catch(() => undefined);
  await gitAsWorker(["worktree", "remove", "--force", worktreePath], repoRoot || worktreePath, ownership).catch(() => undefined);
  await fs.rm(worktreePath, { recursive: true, force: true }).catch(() => undefined);
  removed += 1;

  if (repoRoot && branchName) {
    await gitAsWorker(["branch", "-D", branchName], repoRoot, ownership).catch(() => undefined);
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
  if (
    /\b(?:do not|don't|never) (?:create|use|make)(?: a| an| the)?(?: new| managed| isolated)? (?:branch|worktree)\b/.test(normalized) ||
    /\b(?:no|without)(?: a| an)?(?: new| managed| isolated)? (?:branch|worktree)\b/.test(normalized) ||
    /\bstay (?:on|in) (?:the )?(?:current|existing) checkout\b/.test(normalized)
  ) {
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
    await ensureManagedWorktreeWritableForWorker(requestedCwd);
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

  const worktreeParent = path.dirname(worktreePath);
  await fs.mkdir(worktreeParent, { recursive: true });
  await ensureWorkspaceWritableForWorker(repoRoot);
  await chownTreeToWorker(worktreeParent, resolveCodexWorkerOwnership());
  await gitAsWorker(["worktree", "add", "-b", branchName, worktreePath, "HEAD"], repoRoot);
  await ensureManagedWorktreeWritableForWorker(worktreePath);

  return {
    cwd: worktreePath,
    branchName,
    repoRoot,
    created: true
  };
}
