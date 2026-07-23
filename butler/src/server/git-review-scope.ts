import crypto from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  ensureWorkerOwnedDirectory,
  execFileAsWorker,
  resolveWorkerOwnership,
  type WorkerOwnership
} from "./repo-worktree.js";

type GitOutputResult = { output: string; ok: boolean; truncated: boolean };

function reviewWorkerOwnership(): WorkerOwnership {
  const configured = resolveWorkerOwnership();
  const uid = process.getuid?.();
  const gid = process.getgid?.();
  if (uid === undefined || gid === undefined || (process.platform === "linux" && (uid === 0 || uid === configured.uid))) {
    return configured;
  }
  return { uid, gid, label: `current process (${uid}:${gid})` };
}

function safeGitArgs(args: string[]): string[] {
  return ["-c", "safe.directory=*", "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", ...args];
}

async function gitOutputResult(
  cwd: string,
  args: string[],
  maxLength = 160_000,
  env?: NodeJS.ProcessEnv
): Promise<GitOutputResult> {
  try {
    const { stdout } = await execFileAsWorker(
      "git",
      safeGitArgs(args),
      cwd,
      reviewWorkerOwnership(),
      env ?? {},
      { maxBuffer: maxLength + 1, timeout: 10_000 }
    );
    const output = stdout.toString();
    return { output: output.slice(0, maxLength).trim(), ok: output.length <= maxLength, truncated: output.length > maxLength };
  } catch (error) {
    const output = typeof (error as { stdout?: unknown }).stdout === "string"
      ? (error as { stdout: string }).stdout
      : "";
    const truncated = output.length > maxLength || (error as { code?: unknown }).code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER";
    return { output: output.slice(0, maxLength).trim(), ok: false, truncated };
  }
}

async function gitOutput(cwd: string, args: string[], maxLength = 160_000, env?: NodeJS.ProcessEnv): Promise<string> {
  const result = await gitOutputResult(cwd, args, maxLength, env);
  return result.ok ? result.output : "";
}

async function gitSucceeds(cwd: string, args: string[], env: NodeJS.ProcessEnv): Promise<boolean> {
  return (await gitOutputResult(cwd, args, 8_000, env)).ok;
}

export async function resolveGitRoot(cwd: string): Promise<string | null> {
  const root = await gitOutput(cwd, ["rev-parse", "--show-toplevel"], 8_000);
  return root ? path.resolve(root) : null;
}

async function repositoryObjectDirectory(cwd: string): Promise<string | null> {
  const objectPath = await gitOutput(cwd, ["rev-parse", "--git-path", "objects"], 8_000);
  return objectPath ? path.resolve(cwd, objectPath) : null;
}

function snapshotObjectEnv(objectDir: string, repositoryObjectDir: string): NodeJS.ProcessEnv {
  return {
    GIT_OBJECT_DIRECTORY: objectDir,
    GIT_ALTERNATE_OBJECT_DIRECTORIES: repositoryObjectDir
  };
}

async function captureWorktreeTree(cwd: string, objectDir: string, repositoryObjectDir: string): Promise<string | null> {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "manor-review-index-"));
  const ownership = reviewWorkerOwnership();
  await ensureWorkerOwnedDirectory(tempDir, ownership);
  await ensureWorkerOwnedDirectory(path.dirname(objectDir), ownership);
  await ensureWorkerOwnedDirectory(objectDir, ownership);
  const env = { ...snapshotObjectEnv(objectDir, repositoryObjectDir), GIT_INDEX_FILE: path.join(tempDir, "index") };
  try {
    if (!await gitSucceeds(cwd, ["add", "-A", "--", "."], env)) return null;
    const treeSha = await gitOutput(cwd, ["write-tree"], 200, env);
    return /^[0-9a-f]{40,64}$/i.test(treeSha) ? treeSha : null;
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

export async function captureGitReviewBaseline(
  cwd: string,
  storageRoot = path.join(os.tmpdir(), "manor-review-baselines")
): Promise<{
  cwd: string;
  sha: string | null;
  treeSha: string;
  objectDir: string;
} | null> {
  const root = await resolveGitRoot(cwd);
  if (!root) return null;
  const repositoryObjects = await repositoryObjectDirectory(root);
  if (!repositoryObjects) return null;
  const baselineDir = path.join(storageRoot, `baseline-${crypto.randomUUID()}`);
  const objectDir = path.join(baselineDir, "objects");
  const sha = await gitOutput(root, ["rev-parse", "HEAD"], 200);
  const treeSha = await captureWorktreeTree(root, objectDir, repositoryObjects);
  if (!treeSha) await fs.rm(baselineDir, { recursive: true, force: true });
  return treeSha ? { cwd: root, sha: /^[0-9a-f]{40,64}$/i.test(sha) ? sha : null, treeSha, objectDir } : null;
}

export async function cleanupGitReviewBaseline(objectDir: string | null | undefined): Promise<void> {
  if (!objectDir || path.basename(objectDir) !== "objects" || !path.basename(path.dirname(objectDir)).startsWith("baseline-")) return;
  await fs.rm(path.dirname(objectDir), { recursive: true, force: true });
}

function contextReferencesPath(contextText: string, root: string, filePath: string): boolean {
  const context = contextText.replaceAll("\\", "/");
  const relative = filePath.replaceAll("\\", "/");
  const absolute = path.resolve(root, filePath).replaceAll("\\", "/");
  const pathCharacter = /[A-Za-z0-9._@+~/-]/;
  return [relative, absolute, `a/${relative}`, `b/${relative}`].some((needle) => {
    let index = context.indexOf(needle);
    while (index >= 0) {
      const before = index > 0 ? context[index - 1]! : "";
      const after = context[index + needle.length] ?? "";
      if ((!before || !pathCharacter.test(before)) && (!after || !pathCharacter.test(after))) return true;
      index = context.indexOf(needle, index + 1);
    }
    return false;
  });
}

export async function createScopedReviewWorkspace(input: {
  cwd: string;
  baselineTreeSha: string;
  baselineObjectDir: string;
  workerContextText: string;
  otherWorkerContextTexts?: string[];
  attributeAllChangedPaths?: boolean;
  ownershipAttributionUnknown?: boolean;
}): Promise<{
  cwd: string;
  baselineSha: string | null;
  attributedPaths: string[];
  changedPathCount: number;
  ambiguousPathCount: number;
  ownershipAmbiguous: boolean;
  suppressedPathCount: number;
  scopeNote: string;
} | null> {
  const root = await resolveGitRoot(input.cwd);
  const repositoryObjects = root ? await repositoryObjectDirectory(root) : null;
  if (!root || !repositoryObjects) return null;
  const objectEnv = snapshotObjectEnv(input.baselineObjectDir, repositoryObjects);
  const verifiedTree = await gitOutput(root, ["rev-parse", "--verify", `${input.baselineTreeSha}^{tree}`], 200, objectEnv);
  if (!/^[0-9a-f]{40,64}$/i.test(verifiedTree)) return null;
  const currentTree = await captureWorktreeTree(root, input.baselineObjectDir, repositoryObjects);
  if (!currentTree) return null;
  const changedResult = await gitOutputResult(root, ["diff", "--name-only", "--no-renames", verifiedTree, currentTree], 200_000, objectEnv);
  if (!changedResult.ok || changedResult.truncated) return null;
  const changedPaths = changedResult.output.split("\n").map((entry) => entry.trim()).filter(Boolean);
  const workerClaimedPaths = new Set(changedPaths.filter((filePath) => contextReferencesPath(input.workerContextText, root, filePath)));
  const peerClaimedPaths = new Set(changedPaths.filter((filePath) =>
    (input.otherWorkerContextTexts ?? []).some((context) => contextReferencesPath(context, root, filePath))
  ));
  const ambiguousPaths = changedPaths.filter((filePath) => workerClaimedPaths.has(filePath) && peerClaimedPaths.has(filePath));
  const attributedPaths = changedPaths.filter((filePath) =>
    (input.attributeAllChangedPaths || workerClaimedPaths.has(filePath)) && !peerClaimedPaths.has(filePath)
  );
  const reviewDir = await fs.mkdtemp(path.join(os.tmpdir(), "manor-scoped-review-"));
  try {
    await ensureWorkerOwnedDirectory(reviewDir, reviewWorkerOwnership());
    if (!await gitSucceeds(reviewDir, ["init", "--quiet"], {})) throw new Error("git init failed");
    const alternatesPath = path.join(reviewDir, ".git", "objects", "info", "alternates");
    await fs.mkdir(path.dirname(alternatesPath), { recursive: true });
    await fs.writeFile(alternatesPath, `${input.baselineObjectDir}\n${repositoryObjects}\n`, "utf8");
    if (!await gitSucceeds(reviewDir, ["read-tree", verifiedTree], {})) throw new Error("git read-tree failed");
    if (!await gitSucceeds(reviewDir, ["checkout-index", "--all", "--force"], {})) throw new Error("git checkout-index failed");
    const commitEnv = {
      GIT_AUTHOR_NAME: "Manor Review",
      GIT_AUTHOR_EMAIL: "review@manor.local",
      GIT_COMMITTER_NAME: "Manor Review",
      GIT_COMMITTER_EMAIL: "review@manor.local"
    };
    if (!await gitSucceeds(reviewDir, ["commit", "--quiet", "--no-gpg-sign", "-m", "Manor review baseline"], commitEnv)) {
      throw new Error("git baseline commit failed");
    }
    const baselineSha = await gitOutput(reviewDir, ["rev-parse", "HEAD"], 200);
    let appliedPaths = attributedPaths;
    if (attributedPaths.length > 0) {
      const patchResult = await gitOutputResult(root, ["diff", "--binary", "--no-renames", verifiedTree, currentTree, "--", ...attributedPaths], 5_000_000, objectEnv);
      if (!patchResult.ok || patchResult.truncated || !patchResult.output) throw new Error("git diff failed");
      const patchPath = path.join(reviewDir, ".manor-review.patch");
      await fs.writeFile(patchPath, `${patchResult.output}\n`, "utf8");
      const applied = await gitSucceeds(reviewDir, ["apply", "--whitespace=nowarn", patchPath], {});
      await fs.rm(patchPath, { force: true });
      if (!applied) throw new Error("git apply failed");
    }
    if (!await gitSucceeds(reviewDir, ["add", "-A"], {})) throw new Error("git add failed");
    const suppressedPathCount = changedPaths.length - appliedPaths.length;
    const scopeLabel = input.attributeAllChangedPaths ? "Delegation baseline isolation" : "Concurrent checkout isolation";
    const ownershipAmbiguous = !input.attributeAllChangedPaths && changedPaths.length > 0 && (input.ownershipAttributionUnknown === true || appliedPaths.length === 0 || ambiguousPaths.length > 0);
    return {
      cwd: reviewDir,
      baselineSha: /^[0-9a-f]{40,64}$/i.test(baselineSha) ? baselineSha : null,
      attributedPaths: appliedPaths,
      changedPathCount: changedPaths.length,
      ambiguousPathCount: ambiguousPaths.length,
      ownershipAmbiguous,
      suppressedPathCount,
      scopeNote: appliedPaths.length > 0
        ? `${scopeLabel}: reviewing ${appliedPaths.length} changed path(s); ${suppressedPathCount} unrelated path(s) were excluded.${input.ownershipAttributionUnknown ? " At least one overlapping Worker's changed-path attribution was incomplete." : ""}${ambiguousPaths.length > 0 ? ` ${ambiguousPaths.length} path(s) had conflicting ownership.` : ""}`
        : `${scopeLabel}: no changed paths were attributable to this Worker; ${suppressedPathCount} shared-checkout path(s) were excluded. Ownership is ambiguous and must block acceptance.`
    };
  } catch {
    await fs.rm(reviewDir, { recursive: true, force: true });
    return null;
  }
}

export async function cleanupScopedReviewWorkspace(cwd: string | null | undefined): Promise<void> {
  if (!cwd || !path.basename(cwd).startsWith("manor-scoped-review-")) return;
  await fs.rm(cwd, { recursive: true, force: true });
}

export async function resolveReviewWorkspaceCwd(input: { preferredCwd: string }): Promise<string> {
  const preferredRoot = await resolveGitRoot(input.preferredCwd);
  if (preferredRoot) return preferredRoot;
  return path.resolve(input.preferredCwd);
}

export async function createNonGitReviewWorkspace(): Promise<string> {
  const reviewDir = await fs.mkdtemp(path.join(os.tmpdir(), "manor-scoped-review-"));
  await ensureWorkerOwnedDirectory(reviewDir, reviewWorkerOwnership());
  return reviewDir;
}

async function inferredBaseSha(cwd: string): Promise<string | null> {
  const upstream = await gitOutput(cwd, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"], 500);
  if (upstream) {
    const mergeBase = await gitOutput(cwd, ["merge-base", "HEAD", upstream], 200);
    if (/^[0-9a-f]{40}$/i.test(mergeBase)) return mergeBase;
  }
  const originHead = await gitOutput(cwd, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], 500);
  if (originHead) {
    const mergeBase = await gitOutput(cwd, ["merge-base", "HEAD", originHead], 200);
    if (/^[0-9a-f]{40}$/i.test(mergeBase)) return mergeBase;
  }
  return null;
}

export async function buildReviewWorkspaceSnapshot(
  cwd: string,
  baselineSha?: string | null,
  baselineTreeSha?: string | null,
  baselineObjectDir?: string | null
): Promise<string> {
  const root = await resolveGitRoot(cwd);
  if (!root) return `Review workspace: ${cwd}\nNo Git repository was detected. Inspect the worker report and referenced files directly.`;
  const verifiedBaseline = baselineSha ? await gitOutput(root, ["rev-parse", "--verify", `${baselineSha}^{commit}`], 200) : "";
  const validBaseline = /^[0-9a-f]{40,64}$/i.test(verifiedBaseline) ? verifiedBaseline : await inferredBaseSha(root);
  const repositoryObjects = baselineObjectDir ? await repositoryObjectDirectory(root) : null;
  const objectEnv = baselineObjectDir && repositoryObjects ? snapshotObjectEnv(baselineObjectDir, repositoryObjects) : undefined;
  const verifiedTree = baselineTreeSha && objectEnv ? await gitOutput(root, ["rev-parse", "--verify", `${baselineTreeSha}^{tree}`], 200, objectEnv) : "";
  const validBaselineTree = /^[0-9a-f]{40,64}$/i.test(verifiedTree) ? verifiedTree : null;
  const currentTree = validBaselineTree && baselineObjectDir && repositoryObjects
    ? await captureWorktreeTree(root, baselineObjectDir, repositoryObjects)
    : null;

  if (validBaselineTree && currentTree) {
    const [head, branch, changedFiles, exactDiff, commits] = await Promise.all([
      gitOutput(root, ["rev-parse", "HEAD"], 200),
      gitOutput(root, ["branch", "--show-current"], 500),
      gitOutput(root, ["diff", "--name-status", validBaselineTree, currentTree], 20_000, objectEnv),
      gitOutput(root, ["diff", "--no-ext-diff", "--unified=40", validBaselineTree, currentTree], 160_000, objectEnv),
      validBaseline ? gitOutput(root, ["log", "--oneline", `${validBaseline}..HEAD`], 20_000) : Promise.resolve("")
    ]);
    return [
      `Review workspace: ${root}`,
      `Delegation baseline commit: ${validBaseline ?? "unavailable"}`,
      `Delegation baseline tree: ${validBaselineTree}`,
      `Current branch and HEAD: ${branch || "detached"} ${head || "unavailable"}`,
      `Workspace files changed since delegation:\n${changedFiles || "None."}`,
      `Workspace diff since delegation:\n${exactDiff || "None."}`,
      `Commits since delegation:\n${commits || "None."}`,
      "Attribution rule: only treat a delta as Worker evidence when it is tied to the delegated task or Worker report."
    ].join("\n\n");
  }

  const [status, trackedDiff, unstaged, staged, recentCommits] = await Promise.all([
    gitOutput(root, ["status", "--short", "--branch"]),
    validBaseline ? gitOutput(root, ["diff", "--no-ext-diff", "--unified=40", validBaseline]) : Promise.resolve(""),
    gitOutput(root, ["diff", "--no-ext-diff", "--unified=40"]),
    gitOutput(root, ["diff", "--cached", "--no-ext-diff", "--unified=40"]),
    gitOutput(root, ["log", "--oneline", "--decorate", "-8"], 20_000)
  ]);
  return [
    `Review workspace: ${root}`,
    `Baseline: ${validBaseline ?? "unavailable"}`,
    `Status:\n${status || "Clean."}`,
    `Changes since baseline:\n${trackedDiff || "None."}`,
    `Unstaged diff:\n${unstaged || "None."}`,
    `Staged diff:\n${staged || "None."}`,
    `Recent commits:\n${recentCommits || "Unavailable."}`
  ].join("\n\n");
}
