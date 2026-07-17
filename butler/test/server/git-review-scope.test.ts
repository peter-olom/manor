import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readdir, realpath, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import { buildReviewWorkspaceSnapshot, captureGitReviewBaseline, cleanupGitReviewBaseline, cleanupScopedReviewWorkspace, createScopedReviewWorkspace, resolveReviewWorkspaceCwd } from "../../src/server/git-review-scope.js";
import { ButlerStateStore } from "../../src/server/state-store.js";
import { buildThreadExecutionContract } from "../../src/server/thread-contract.js";
import { rotateWorkerReviewBaseline } from "../../src/server/worker-review-baseline.js";
import { workerFileChangeAttribution } from "../../src/server/worker-review-attribution.js";

const execFileAsync = promisify(execFile);

async function git(cwd: string, ...args: string[]): Promise<void> {
  await execFileAsync("git", args, { cwd });
}

async function gitText(cwd: string, ...args: string[]): Promise<string> {
  return (await execFileAsync("git", args, { cwd })).stdout.trim();
}

async function createRepo(parent: string, name = "repo"): Promise<string> {
  const repo = path.join(parent, name);
  await mkdir(repo, { recursive: true });
  await git(repo, "init");
  await git(repo, "config", "user.email", "test@example.com");
  await git(repo, "config", "user.name", "Test");
  await writeFile(path.join(repo, "feature.txt"), "before\n", "utf8");
  await git(repo, "add", "feature.txt");
  await git(repo, "commit", "-m", "baseline");
  return repo;
}

test("review snapshot includes committed Worker changes since the delegation baseline", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "manor-review-baseline-"));
  const repo = await createRepo(dir);
  const baseline = await captureGitReviewBaseline(repo);
  assert.ok(baseline);

  await writeFile(path.join(repo, "feature.txt"), "after\n", "utf8");
  await git(repo, "add", "feature.txt");
  await git(repo, "commit", "-m", "worker change");

  const snapshot = await buildReviewWorkspaceSnapshot(repo, baseline.sha, baseline.treeSha, baseline.objectDir);
  assert.match(snapshot, new RegExp(`Delegation baseline commit: ${baseline.sha}`));
  assert.match(snapshot, /-before/);
  assert.match(snapshot, /\+after/);
});

test("review snapshot excludes changes that were already dirty before delegation", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "manor-review-dirty-baseline-"));
  const repo = await createRepo(dir);
  await writeFile(path.join(repo, "feature.txt"), "dirty before delegation\n", "utf8");
  const baseline = await captureGitReviewBaseline(repo);
  assert.ok(baseline);

  await writeFile(path.join(repo, "worker.txt"), "worker change\n", "utf8");
  const snapshot = await buildReviewWorkspaceSnapshot(repo, baseline.sha, baseline.treeSha, baseline.objectDir);

  assert.match(snapshot, /worker\.txt/);
  assert.doesNotMatch(snapshot, /feature\.txt/);
  assert.doesNotMatch(snapshot, /dirty before delegation/);
});

test("review baseline stores dirty objects outside the repository and cleans them safely", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "manor-review-private-objects-"));
  const repo = await createRepo(dir);
  const storageRoot = path.join(dir, "review-storage");
  await writeFile(path.join(repo, "untracked-secret.txt"), "temporary secret\n", "utf8");
  const before = await gitText(repo, "fsck", "--unreachable", "--no-reflogs");

  const baseline = await captureGitReviewBaseline(repo, storageRoot);
  assert.ok(baseline);
  const after = await gitText(repo, "fsck", "--unreachable", "--no-reflogs");

  assert.equal(after, before);
  assert.equal(baseline.objectDir.startsWith(storageRoot), true);
  await cleanupGitReviewBaseline(baseline.objectDir);
  assert.equal(await stat(path.dirname(baseline.objectDir)).catch(() => null), null);
});

test("accepted closeout rotates the review baseline and retires peer attribution", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "manor-review-rotate-"));
  const repo = await createRepo(dir);
  const artifactsDir = path.join(dir, "artifacts");
  const initial = await captureGitReviewBaseline(repo, path.join(artifactsDir, "review-baselines"));
  assert.ok(initial);
  const store = new ButlerStateStore(path.join(dir, "state.json"));
  const threadId = "worker-rotate";
  store.upsertThreadSummary({ id: threadId, source: "pi-rpc", status: "idle", cwd: repo, turns: [] });
  store.setThreadExecutionContract(threadId, {
    ...buildThreadExecutionContract({ threadId, workspaceCwd: repo, projectId: "project", projectLabel: "Project", branch: null, taskText: "Change feature.txt.", taskCategory: "generic_code", inferredWorkDepth: "standard", notes: [] }),
    reviewBaselineCwd: initial.cwd,
    reviewBaselineSha: initial.sha,
    reviewBaselineTreeSha: initial.treeSha,
    reviewBaselineObjectDir: initial.objectDir,
    reviewPeerContexts: [{ sourceThreadId: "peer", baselineTreeSha: initial.treeSha, paths: ["peer.ts"], recordedAt: 1 }],
    reviewPeerContextOverflow: true
  });
  await writeFile(path.join(repo, "feature.txt"), "accepted state\n", "utf8");

  assert.equal(await rotateWorkerReviewBaseline(store, threadId, artifactsDir), true);
  const rotated = store.getThread(threadId)?.executionContract;
  assert.notEqual(rotated?.reviewBaselineTreeSha, initial.treeSha);
  assert.deepEqual(rotated?.reviewPeerContexts, []);
  assert.equal(rotated?.reviewPeerContextOverflow, false);
  assert.equal(await stat(path.dirname(initial.objectDir)).catch(() => null), null);
  assert.ok(await stat(rotated!.reviewBaselineObjectDir!));
  await cleanupGitReviewBaseline(rotated?.reviewBaselineObjectDir);
});

test("rotating a handed-off worker keeps a review baseline still referenced by its peer", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "manor-review-shared-baseline-"));
  const repo = await createRepo(dir);
  const artifactsDir = path.join(dir, "artifacts");
  const initial = await captureGitReviewBaseline(repo, path.join(artifactsDir, "review-baselines"));
  assert.ok(initial);
  const store = new ButlerStateStore(path.join(dir, "state.json"));
  for (const threadId of ["source-worker", "replacement-worker"]) {
    store.upsertThreadSummary({ id: threadId, source: "pi-rpc", status: "idle", cwd: repo, turns: [] });
    store.setThreadExecutionContract(threadId, {
      ...buildThreadExecutionContract({ threadId, workspaceCwd: repo, projectId: "project", projectLabel: "Project", branch: null, taskText: "Change feature.txt.", notes: [] }),
      reviewBaselineCwd: initial.cwd,
      reviewBaselineSha: initial.sha,
      reviewBaselineTreeSha: initial.treeSha,
      reviewBaselineObjectDir: initial.objectDir
    });
  }
  await writeFile(path.join(repo, "feature.txt"), "handoff state\n", "utf8");

  assert.equal(await rotateWorkerReviewBaseline(store, "source-worker", artifactsDir), true);
  assert.ok(await stat(initial.objectDir));

  await cleanupGitReviewBaseline(initial.objectDir);
  await cleanupGitReviewBaseline(store.getThread("source-worker")?.executionContract?.reviewBaselineObjectDir);
});

test("failed baseline persistence restores the prior baseline and peer attribution", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "manor-review-rotate-rollback-"));
  const repo = await createRepo(dir);
  const artifactsDir = path.join(dir, "artifacts");
  const baselineRoot = path.join(artifactsDir, "review-baselines");
  const initial = await captureGitReviewBaseline(repo, baselineRoot);
  assert.ok(initial);
  const store = new ButlerStateStore(path.join(dir, "state.json"));
  const threadId = "worker-rotate-rollback";
  const peerContexts = [{ sourceThreadId: "peer", baselineTreeSha: initial.treeSha, paths: ["peer.ts"], recordedAt: 1 }];
  store.upsertThreadSummary({ id: threadId, source: "pi-rpc", status: "idle", cwd: repo, turns: [] });
  store.setThreadExecutionContract(threadId, {
    ...buildThreadExecutionContract({ threadId, workspaceCwd: repo, projectId: "project", projectLabel: "Project", branch: null, taskText: "Change feature.txt.", taskCategory: "generic_code", inferredWorkDepth: "standard", notes: [] }),
    reviewBaselineCwd: initial.cwd,
    reviewBaselineSha: initial.sha,
    reviewBaselineTreeSha: initial.treeSha,
    reviewBaselineObjectDir: initial.objectDir,
    reviewPeerContexts: peerContexts,
    reviewPeerContextOverflow: true
  });
  await writeFile(path.join(repo, "feature.txt"), "unpersisted accepted state\n", "utf8");

  assert.equal(await rotateWorkerReviewBaseline(store, threadId, artifactsDir, { flush: async () => { throw new Error("save failed"); } }), false);
  const restored = store.getThread(threadId)?.executionContract;
  assert.equal(restored?.reviewBaselineCwd, initial.cwd);
  assert.equal(restored?.reviewBaselineSha, initial.sha);
  assert.equal(restored?.reviewBaselineTreeSha, initial.treeSha);
  assert.equal(restored?.reviewBaselineObjectDir, initial.objectDir);
  assert.deepEqual(restored?.reviewPeerContexts, peerContexts);
  assert.equal(restored?.reviewPeerContextOverflow, true);
  assert.deepEqual(await readdir(baselineRoot), [path.basename(path.dirname(initial.objectDir))]);
  assert.ok(await stat(initial.objectDir));
  await cleanupGitReviewBaseline(initial.objectDir);
});

test("review scope resolves a cloned child repository from Worker report context", async () => {
  const parent = await mkdtemp(path.join(tmpdir(), "manor-review-parent-"));
  const repo = await createRepo(parent, "cloned-project");
  const resolved = await resolveReviewWorkspaceCwd({
    preferredCwd: parent,
    contextText: `Implemented ${path.join(repo, "feature.txt")} and verified it.`,
    startedAt: Date.now() - 60_000
  });
  assert.equal(await realpath(resolved), await realpath(repo));
});

test("concurrent review workspace contains only Worker-attributed changes", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "manor-review-concurrent-"));
  const repo = await createRepo(dir);
  const baseline = await captureGitReviewBaseline(repo);
  assert.ok(baseline);
  await writeFile(path.join(repo, "worker-a.txt"), "change from worker A\n", "utf8");
  await writeFile(path.join(repo, "worker-b.txt"), "change from worker B\n", "utf8");

  const scoped = await createScopedReviewWorkspace({
    cwd: repo,
    baselineTreeSha: baseline.treeSha,
    baselineObjectDir: baseline.objectDir,
    workerContextText: "Worker A changed worker-a.txt and verified it."
  });
  assert.ok(scoped);
  const snapshot = await buildReviewWorkspaceSnapshot(scoped.cwd, scoped.baselineSha);
  assert.match(snapshot, /worker-a\.txt/);
  assert.match(snapshot, /change from worker A/);
  assert.doesNotMatch(snapshot, /worker-b\.txt|change from worker B/);
  assert.equal(await stat(path.join(scoped.cwd, "worker-b.txt")).catch(() => null), null);
  assert.equal(scoped.suppressedPathCount, 1);
  await cleanupScopedReviewWorkspace(scoped.cwd);
});

test("concurrent review workspace suppresses paths claimed by another overlapping Worker", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "manor-review-overlap-"));
  const repo = await createRepo(dir);
  const baseline = await captureGitReviewBaseline(repo);
  assert.ok(baseline);
  await writeFile(path.join(repo, "shared.txt"), "combined change\n", "utf8");

  const scoped = await createScopedReviewWorkspace({
    cwd: repo,
    baselineTreeSha: baseline.treeSha,
    baselineObjectDir: baseline.objectDir,
    workerContextText: JSON.stringify({ paths: ["shared.txt"] }),
    otherWorkerContextTexts: [JSON.stringify({ paths: ["shared.txt"] })]
  });
  assert.ok(scoped);
  const snapshot = await buildReviewWorkspaceSnapshot(scoped.cwd, scoped.baselineSha);
  assert.doesNotMatch(snapshot, /combined change/);
  assert.equal(await stat(path.join(scoped.cwd, "shared.txt")).catch(() => null), null);
  assert.equal(scoped.suppressedPathCount, 1);
  assert.equal(scoped.ownershipAmbiguous, true);
  assert.equal(scoped.ambiguousPathCount, 1);
  await cleanupScopedReviewWorkspace(scoped.cwd);
});

test("unknown overlapping Worker attribution blocks otherwise attributed changes", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "manor-review-unknown-peer-"));
  const repo = await createRepo(dir);
  const baseline = await captureGitReviewBaseline(repo);
  assert.ok(baseline);
  await writeFile(path.join(repo, "claimed.txt"), "claimed change\n", "utf8");

  const scoped = await createScopedReviewWorkspace({
    cwd: repo,
    baselineTreeSha: baseline.treeSha,
    baselineObjectDir: baseline.objectDir,
    workerContextText: JSON.stringify({ paths: ["claimed.txt"] }),
    otherWorkerContextTexts: [JSON.stringify({ paths: [] })],
    ownershipAttributionUnknown: true
  });

  assert.ok(scoped);
  assert.deepEqual(scoped.attributedPaths, ["claimed.txt"]);
  assert.equal(scoped.ownershipAmbiguous, true);
  assert.match(scoped.scopeNote, /incomplete/i);
  await cleanupScopedReviewWorkspace(scoped.cwd);
  await cleanupGitReviewBaseline(baseline.objectDir);
});

test("delegation baseline workspace includes every post-baseline change", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "manor-review-delegation-scope-"));
  const repo = await createRepo(dir);
  const baseline = await captureGitReviewBaseline(repo);
  assert.ok(baseline);
  await writeFile(path.join(repo, "unreported-change.txt"), "post delegation\n", "utf8");

  const scoped = await createScopedReviewWorkspace({
    cwd: repo,
    baselineTreeSha: baseline.treeSha,
    baselineObjectDir: baseline.objectDir,
    workerContextText: "Worker report did not list paths.",
    attributeAllChangedPaths: true
  });
  assert.ok(scoped);
  const snapshot = await buildReviewWorkspaceSnapshot(scoped.cwd, scoped.baselineSha);
  assert.match(snapshot, /unreported-change\.txt/);
  assert.match(snapshot, /post delegation/);
  assert.match(scoped.scopeNote, /Delegation baseline isolation/);
  await cleanupScopedReviewWorkspace(scoped.cwd);
});

test("an incomplete review patch fails closed", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "manor-review-truncated-patch-"));
  const repo = await createRepo(dir);
  const baseline = await captureGitReviewBaseline(repo);
  assert.ok(baseline);
  await writeFile(path.join(repo, "large-change.txt"), "x".repeat(5_100_000), "utf8");

  const scoped = await createScopedReviewWorkspace({
    cwd: repo,
    baselineTreeSha: baseline.treeSha,
    baselineObjectDir: baseline.objectDir,
    workerContextText: "Changed large-change.txt.",
    attributeAllChangedPaths: true
  });

  assert.equal(scoped, null);
  await cleanupGitReviewBaseline(baseline.objectDir);
});

test("Worker path attribution matches exact path tokens", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "manor-review-exact-path-"));
  const repo = await createRepo(dir);
  const baseline = await captureGitReviewBaseline(repo);
  assert.ok(baseline);
  await writeFile(path.join(repo, "foo.ts"), "foo\n", "utf8");
  await writeFile(path.join(repo, "notfoo.ts"), "not foo\n", "utf8");

  const scoped = await createScopedReviewWorkspace({
    cwd: repo,
    baselineTreeSha: baseline.treeSha,
    baselineObjectDir: baseline.objectDir,
    workerContextText: "changed notfoo.ts"
  });
  assert.ok(scoped);
  const snapshot = await buildReviewWorkspaceSnapshot(scoped.cwd, scoped.baselineSha);
  assert.match(snapshot, /notfoo\.ts/);
  assert.doesNotMatch(snapshot, /diff --git a\/foo\.ts/);
  await cleanupScopedReviewWorkspace(scoped.cwd);
});

test("Worker path attribution reports overflow instead of silently dropping ownership", () => {
  const attribution = workerFileChangeAttribution({
    turns: [{
      items: Array.from({ length: 2_050 }, (_, index) => ({ type: "fileChange", text: `changed file-${index}.ts`, raw: {} }))
    }]
  } as never);

  assert.equal(attribution.paths.length, 2_048);
  assert.equal(attribution.overflow, true);
});
