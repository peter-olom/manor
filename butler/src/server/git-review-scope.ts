import { spawn } from "node:child_process";
import crypto from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

type GitOutputResult = { output: string; ok: boolean; truncated: boolean };

async function gitOutputResult(
  cwd: string,
  args: string[],
  maxLength = 160_000,
  env?: NodeJS.ProcessEnv
): Promise<GitOutputResult> {
  return await new Promise<GitOutputResult>((resolve) => {
    const child = spawn("git", args, {
      cwd,
      env: env ? { ...process.env, ...env } : process.env,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let truncated = false;
    let timedOut = false;
    let settled = false;
    const finish = (result: GitOutputResult) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    const timeout = setTimeout(() => { timedOut = true; child.kill("SIGTERM"); }, 10_000);
    child.stdout.on("data", (chunk: Buffer) => {
      const next = `${stdout}${chunk.toString("utf8")}`;
      if (next.length > maxLength) truncated = true;
      stdout = next.slice(0, maxLength);
    });
    child.on("error", () => { clearTimeout(timeout); finish({ output: "", ok: false, truncated }); });
    child.on("close", (code) => { clearTimeout(timeout); finish({ output: stdout.trim(), ok: code === 0 && !timedOut, truncated }); });
  });
}

async function gitOutput(cwd: string, args: string[], maxLength = 160_000, env?: NodeJS.ProcessEnv): Promise<string> {
  const result = await gitOutputResult(cwd, args, maxLength, env);
  return result.ok ? result.output : "";
}

async function gitSucceeds(cwd: string, args: string[], env: NodeJS.ProcessEnv): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    const child = spawn("git", args, { cwd, env: { ...process.env, ...env }, stdio: "ignore" });
    const timeout = setTimeout(() => child.kill("SIGTERM"), 10_000);
    child.on("error", () => { clearTimeout(timeout); resolve(false); });
    child.on("close", (code) => { clearTimeout(timeout); resolve(code === 0); });
  });
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
  await fs.mkdir(objectDir, { recursive: true });
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

function absolutePathCandidates(text: string): string[] {
  return [...text.matchAll(/\/(?:repos|workspace|workspaces|tmp)\/[A-Za-z0-9._@+~/-]+/g)]
    .map((match) => match[0]!.replace(/[),.;:'"`\]}]+$/g, ""))
    .sort((left, right) => right.length - left.length)
    .slice(0, 80);
}

async function nearestExistingDirectory(candidate: string): Promise<string | null> {
  let current = path.resolve(candidate);
  for (let depth = 0; depth < 12; depth += 1) {
    const stat = await fs.stat(current).catch(() => null);
    if (stat?.isDirectory()) return current;
    if (stat?.isFile()) return path.dirname(current);
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
  return null;
}

export async function resolveReviewWorkspaceCwd(input: {
  preferredCwd: string;
  contextText: string;
  startedAt: number;
}): Promise<string> {
  const preferredRoot = await resolveGitRoot(input.preferredCwd);
  if (preferredRoot) return preferredRoot;

  for (const candidate of absolutePathCandidates(input.contextText)) {
    const directory = await nearestExistingDirectory(candidate);
    if (!directory) continue;
    const root = await resolveGitRoot(directory);
    if (root && root !== path.resolve(input.preferredCwd)) return root;
  }

  const children = await fs.readdir(input.preferredCwd, { withFileTypes: true }).catch(() => []);
  const recentRoots: Array<{ root: string; updatedAt: number }> = [];
  for (const child of children.filter((entry) => entry.isDirectory()).slice(0, 100)) {
    const childPath = path.join(input.preferredCwd, child.name);
    const stat = await fs.stat(childPath).catch(() => null);
    if (!stat || stat.mtimeMs + 60_000 < input.startedAt) continue;
    const root = await resolveGitRoot(childPath);
    if (root) recentRoots.push({ root, updatedAt: stat.mtimeMs });
  }
  recentRoots.sort((left, right) => right.updatedAt - left.updatedAt);
  return recentRoots[0]?.root ?? input.preferredCwd;
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
