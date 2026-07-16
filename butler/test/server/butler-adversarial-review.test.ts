import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { assertPiReviewerPromptSucceeded, createPiReviewSubmissionTool, ensureButlerAdversarialReview, runProviderAdversarialReview, validateAdversarialReviewOutput, waitForPiReviewSubmission } from "../../src/server/butler-adversarial-review.js";
import { ActivityWatchdogService } from "../../src/server/activity-watchdog.js";
import { getOrchestrationCloseoutBlocker } from "../../src/server/butler-orchestration.js";
import { ButlerStateStore } from "../../src/server/state-store.js";
import { buildThreadExecutionContract } from "../../src/server/thread-contract.js";

test("isolated adversarial review stores only compact findings and reuses the exact review", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "manor-adversarial-review-"));
  const store = new ButlerStateStore(path.join(dir, "state.json"));
  const threadId = "worker-review-thread";
  store.upsertThreadSummary({
    id: threadId,
    status: "idle",
    cwd: dir,
    turns: [{ id: "turn-1", status: "completed", items: [] }]
  });
  store.setThreadExecutionContract(threadId, buildThreadExecutionContract({
    threadId,
    workspaceCwd: dir,
    projectId: "project",
    projectLabel: "Project",
    branch: null,
    taskText: "Fix the retry path and verify it.",
    taskCategory: "generic_code",
    inferredWorkDepth: "standard",
    notes: []
  }));
  const report = store.recordWorkerReport(threadId, {
    turnId: "turn-1",
    status: "completed",
    summary: "Implemented the retry path.",
    details: "Tests passed."
  });

  const messages = [{ role: "user", content: "operator context" }];
  const model = { provider: "openai-codex", id: "gpt-5.5" } as never;
  let runs = 0;
  let reviewerPrompt = "";
  const progress: string[] = [];
  const review = () => ensureButlerAdversarialReview({
    watchdogs: new ActivityWatchdogService(),
    store,
    threadId,
    model,
    modelRegistry: {} as never,
    codexHomeDir: dir,
    piAuthPath: path.join(dir, "auth.json"),
    scratchDir: path.join(dir, "reviews"),
    thinkingLevel: "high",
    onProgress: (entry) => progress.push(entry.stage),
    reviewBrief: "Latest Butler steer: verify the retry exhaustion path.",
    buildWorkspaceSnapshot: async () => "diff --git a/retry.ts b/retry.ts",
    runReview: async (input) => {
      runs += 1;
      reviewerPrompt = input.prompt;
      return {
        findings: [{
          severity: "high",
          findingSummary: "The retry failure path lacks an assertion.",
          blocking: true,
          linkedClaimIds: []
        }]
      };
    }
  });

  const first = await review();
  const second = await review();

  assert.equal(runs, 1);
  assert.deepEqual(progress, ["preparing", "reviewing_changes"]);
  assert.deepEqual(second, first);
  assert.match(reviewerPrompt, /Fix the retry path/);
  assert.match(reviewerPrompt, /verify the retry exhaustion path/);
  assert.match(reviewerPrompt, /diff --git/);
  assert.deepEqual(messages, [{ role: "user", content: "operator context" }]);
  assert.deepEqual(first.map((finding) => ({
    summary: finding.findingSummary,
    provider: finding.modelProvider,
    model: finding.modelId,
    reasoning: finding.reasoningLevel,
    blocking: finding.blocking
  })), [{
    summary: "The retry failure path lacks an assertion.",
    provider: "openai-codex",
    model: "gpt-5.5",
    reasoning: "high",
    blocking: true
  }]);

  const stale = await ensureButlerAdversarialReview({
    watchdogs: new ActivityWatchdogService(),
    store,
    threadId,
    model,
    modelRegistry: {} as never,
    codexHomeDir: dir,
    piAuthPath: path.join(dir, "auth.json"),
    scratchDir: path.join(dir, "reviews"),
    thinkingLevel: "high",
    minimumReportUpdatedAt: report.updatedAt + 1,
    buildWorkspaceSnapshot: async () => "should not run",
    runReview: async () => {
      runs += 1;
      return { findings: [] };
    }
  });
  assert.deepEqual(stale, []);
  assert.equal(runs, 1);
});

test("OpenAI review falls back to the isolated same-provider harness when native Codex auth is unavailable", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "manor-adversarial-auth-"));
  const store = new ButlerStateStore(path.join(dir, "state.json"));
  const threadId = "worker-review-auth";
  store.upsertThreadSummary({ id: threadId, status: "idle", cwd: dir, turns: [{ id: "turn-1", status: "completed", items: [] }] });
  store.setThreadExecutionContract(threadId, buildThreadExecutionContract({
    threadId,
    workspaceCwd: dir,
    projectId: "project",
    projectLabel: "Project",
    branch: null,
    taskText: "Review auth handling.",
    taskCategory: "generic_code",
    inferredWorkDepth: "standard",
    notes: []
  }));
  store.recordWorkerReport(threadId, { turnId: "turn-1", status: "completed", summary: "Done.", details: null });

  let nativeAvailable: boolean | null = null;
  const results = await ensureButlerAdversarialReview({
    watchdogs: new ActivityWatchdogService(),
    store,
    threadId,
    model: { provider: "openai-codex", id: "gpt-5.5" } as never,
    modelRegistry: {} as never,
    codexHomeDir: dir,
    piAuthPath: path.join(dir, "auth.json"),
    scratchDir: path.join(dir, "reviews"),
    thinkingLevel: "high",
    codexAuthenticated: false,
    buildWorkspaceSnapshot: async () => "No changes.",
    runReview: async (input) => {
      nativeAvailable = input.codexNativeAvailable;
      return { findings: [] };
    }
  });
  assert.equal(nativeAvailable, false);
  assert.equal(results[0]?.findingSummary, "Adversarial review found no actionable findings.");
});

test("adversarial review rejects malformed clean-looking output", () => {
  assert.throws(() => validateAdversarialReviewOutput({}), /findings must be an array/);
  assert.throws(() => validateAdversarialReviewOutput({ findings: [], error: "review failed" }), /unsupported root fields/);
  assert.throws(() => validateAdversarialReviewOutput({ findings: [{ severity: "high", findingSummary: "Missing proof", blocking: true }] }), /linked claim ids/);
  assert.deepEqual(validateAdversarialReviewOutput({ findings: [] }), { findings: [] });
});

test("Pi adversarial review submission tool captures only schema-valid findings", async () => {
  let submitted: ReturnType<typeof validateAdversarialReviewOutput> | null = null;
  const tool = createPiReviewSubmissionTool((review) => { submitted = review; });
  await tool.execute("call-1", {
    findings: [{ severity: "high", findingSummary: "The recovery path drops the worker.", blocking: true, linkedClaimIds: ["claim-1"] }]
  });
  assert.deepEqual(submitted, {
    findings: [{ severity: "high", findingSummary: "The recovery path drops the worker.", blocking: true, linkedClaimIds: ["claim-1"] }]
  });
  const invalidTool = createPiReviewSubmissionTool(() => undefined);
  await assert.rejects(
    () => invalidTool.execute("call-2", { findings: [{ severity: "high", findingSummary: "Missing fields" }] } as never),
    /blocking value/
  );
  await assert.rejects(
    () => tool.execute("call-3", { findings: [] }),
    /already submitted/
  );
});

test("Pi adversarial reviewer surfaces the exact redacted terminal provider error", () => {
  assert.throws(() => assertPiReviewerPromptSucceeded([{
    role: "assistant",
    stopReason: "error",
    errorMessage: "Provider rejected Authorization: Bearer opaque-token-123456"
  }]), (error: unknown) => {
    assert.equal((error as Error).message, "Provider rejected Authorization: Bearer [REDACTED]");
    return true;
  });
});

test("Pi adversarial review stops as soon as a valid submission arrives", async () => {
  let abortCalls = 0;
  const review = { findings: [{ severity: "low", findingSummary: "Minor issue", blocking: false, linkedClaimIds: [] }] };
  const result = await waitForPiReviewSubmission({
    watchdogs: new ActivityWatchdogService(),
    prompt: new Promise<void>(() => undefined),
    submission: Promise.resolve(review),
    abort: async () => { abortCalls += 1; },
    timeoutMs: 50
  });
  assert.deepEqual(result, review);
  assert.equal(abortCalls, 1);
});

test("Pi adversarial review can outlive the former hard maximum while activity continues", async () => {
  let lastActivityAt = Date.now();
  const review = { findings: [] };
  const activity = setInterval(() => { lastActivityAt = Date.now(); }, 10);
  try {
    const result = await waitForPiReviewSubmission({
    watchdogs: new ActivityWatchdogService(),
      prompt: new Promise<void>(() => undefined),
      submission: new Promise<typeof review>((resolve) => setTimeout(() => resolve(review), 130)),
      abort: async () => undefined,
      timeoutMs: 50,
      lastActivityAt: () => lastActivityAt
    });
    assert.deepEqual(result, review);
  } finally {
    clearInterval(activity);
  }
});

test("Pi adversarial review still stops after sustained inactivity", async () => {
  await assert.rejects(() => waitForPiReviewSubmission({
    watchdogs: new ActivityWatchdogService(),
    prompt: new Promise<void>(() => undefined),
    submission: new Promise<{ findings: [] }>(() => undefined),
    abort: async () => undefined,
    timeoutMs: 20,
    lastActivityAt: () => Date.now() - 20
  }), /timed out/);
});

test("Pi adversarial review uses and releases a registered activity watchdog", async () => {
  const watchdogs = new ActivityWatchdogService();
  await assert.rejects(() => waitForPiReviewSubmission({
    prompt: new Promise<void>(() => undefined),
    submission: new Promise<{ findings: [] }>(() => undefined),
    abort: async () => undefined,
    timeoutMs: 10,
    lastActivityAt: () => Date.now() - 10,
    watchdogs,
    watchdogId: "review:test"
  }), /timed out/);
  assert.equal(watchdogs.size, 0);
});

test("Pi adversarial review stops promptly when the callback is cancelled", async () => {
  let current = true;
  setTimeout(() => { current = false; }, 10);
  const startedAt = Date.now();

  await assert.rejects(() => waitForPiReviewSubmission({
    watchdogs: new ActivityWatchdogService(),
    prompt: new Promise<void>(() => undefined),
    submission: new Promise(() => undefined),
    abort: async () => undefined,
    timeoutMs: 500,
    isCurrent: () => current
  }), /superseded/);
  assert.ok(Date.now() - startedAt < 300);
});

test("native Codex review tolerates startup delay and outlives the former hard maximum while output continues", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "manor-review-active-child-"));
  const binDir = path.join(dir, "bin");
  const scratchDir = path.join(dir, "scratch");
  await mkdir(binDir, { recursive: true });
  const executable = path.join(binDir, "codex");
  await writeFile(executable, [
    "#!/usr/bin/env node",
    "const fs = require('node:fs');",
    "const outputIndex = process.argv.indexOf('--output-last-message') + 1;",
    "let heartbeat = null;",
    "setTimeout(() => {",
    "  process.stderr.write('.');",
    "  heartbeat = setInterval(() => process.stderr.write('.'), 100);",
    "}, 1800);",
    "setTimeout(() => {",
    "  if (heartbeat) clearInterval(heartbeat);",
    "  fs.writeFileSync(process.argv[outputIndex], JSON.stringify({ findings: [] }));",
    "  process.exit(0);",
    "}, 3200);"
  ].join("\n"), "utf8");
  await chmod(executable, 0o755);
  const result = await runProviderAdversarialReview({
    watchdogs: new ActivityWatchdogService(),
    cwd: dir,
    codexHomeDir: dir,
    piAuthPath: path.join(dir, "pi-auth.json"),
    scratchDir,
    modelRegistry: {} as never,
    selection: { model: { provider: "openai-codex", id: "gpt-5.5" } as never, thinkingLevel: "high" },
    codexNativeAvailable: true,
    codexExecutable: executable,
    prompt: "Review the change.",
    timeoutMs: 1_500
  });

  assert.deepEqual(result, { findings: [] });
  assert.deepEqual(await readdir(scratchDir), []);
});

test("native Codex review force-kills a child that ignores SIGTERM before cleanup", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "manor-review-stubborn-child-"));
  const binDir = path.join(dir, "bin");
  const scratchDir = path.join(dir, "scratch");
  const pidFile = path.join(dir, "reviewer.pid");
  await mkdir(binDir, { recursive: true });
  const executable = path.join(binDir, "codex");
  const watchdogs = new ActivityWatchdogService();
  await writeFile(executable, [
    "#!/usr/bin/env node",
    "const fs = require('node:fs');",
    `fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));`,
    "process.on('SIGTERM', () => {});",
    "setInterval(() => {}, 1000);"
  ].join("\n"), "utf8");
  await chmod(executable, 0o755);
  await assert.rejects(runProviderAdversarialReview({
    cwd: dir,
    codexHomeDir: dir,
    piAuthPath: path.join(dir, "pi-auth.json"),
    scratchDir,
    modelRegistry: {} as never,
    selection: { model: { provider: "openai-codex", id: "gpt-5.5" } as never, thinkingLevel: "high" },
    codexNativeAvailable: true,
    codexExecutable: executable,
    prompt: "Review the change.",
    timeoutMs: 3_000,
    watchdogs
  }), /Adversarial review/);

  const pid = Number(await readFile(pidFile, "utf8"));
  assert.throws(() => process.kill(pid, 0), (error: unknown) => (error as NodeJS.ErrnoException).code === "ESRCH");
  assert.deepEqual(await readdir(scratchDir), []);
  assert.equal(watchdogs.size, 0);
});

test("overlapping Workers stay isolated after the other baseline has been cleaned", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "manor-adversarial-overlap-"));
  const store = new ButlerStateStore(path.join(dir, "state.json"));
  const contract = (threadId: string, objectDir: string) => ({
    ...buildThreadExecutionContract({
      threadId,
      workspaceCwd: dir,
      projectId: "project",
      projectLabel: "Project",
      branch: null,
      taskText: `Change files for ${threadId}.`,
      taskCategory: "generic_code",
      inferredWorkDepth: "standard",
      notes: []
    }),
    reviewBaselineCwd: dir,
    reviewBaselineTreeSha: "a".repeat(40),
    reviewBaselineObjectDir: objectDir
  });
  store.upsertThreadSummary({
    id: "worker-a",
    status: "idle",
    cwd: dir,
    turns: [{ id: "turn-a", status: "completed", items: [
      { id: "command", type: "commandExecution", text: "git status lists worker-b.txt" },
      { id: "change", type: "fileChange", text: "updated worker-a.txt" }
    ] }]
  });
  store.upsertThreadSummary({
    id: "worker-b",
    status: "idle",
    cwd: dir,
    turns: [
      { id: "turn-b-old", status: "completed", items: [] },
      { id: "turn-b-later", status: "completed", items: [
      { id: "change", type: "fileChange", text: "updated worker-b.txt" }
      ] }
    ]
  });
  store.setThreadExecutionContract("worker-a", contract("worker-a", path.join(dir, "a-objects")));
  store.setThreadExecutionContract("worker-b", contract("worker-b", path.join(dir, "already-deleted-objects")));
  const reportA = store.recordWorkerReport("worker-a", { turnId: "turn-a", status: "completed", summary: "Changed worker-a.txt.", details: null });
  const reportB = store.recordWorkerReport("worker-b", { turnId: "turn-b-old", status: "completed", summary: "Changed worker-b.txt and did not modify worker-a.txt.", details: null });
  Object.assign(store.getThread("worker-a")!, { createdAt: 2_000, updatedAt: 4_000 });
  Object.assign(store.getThread("worker-b")!, { createdAt: 1_000, updatedAt: 3_000 });
  Object.assign(store.getThread("worker-a")!.turns[0]!, { startedAt: 2_000, completedAt: 4_000 });
  Object.assign(store.getThread("worker-b")!.turns[0]!, { startedAt: 1_000, completedAt: 1_500 });
  Object.assign(store.getThread("worker-b")!.turns[1]!, { startedAt: 2_500, completedAt: 3_000 });
  Object.assign(reportA, { updatedAt: 4_000 });
  Object.assign(reportB, { updatedAt: 1_500 });

  let scopedInput: { workerContextText: string; otherWorkerContextTexts?: string[] } | null = null;
  await ensureButlerAdversarialReview({
    watchdogs: new ActivityWatchdogService(),
    store,
    threadId: "worker-a",
    model: { provider: "openai-codex", id: "gpt-5.5" } as never,
    modelRegistry: {} as never,
    codexHomeDir: dir,
    piAuthPath: path.join(dir, "auth.json"),
    scratchDir: path.join(dir, "reviews"),
    thinkingLevel: "high",
    createScopedWorkspace: async (input) => {
      scopedInput = input;
      return { cwd: dir, baselineSha: null, attributedPaths: ["worker-a.txt"], suppressedPathCount: 1, scopeNote: "isolated" };
    },
    buildWorkspaceSnapshot: async () => "only worker-a.txt",
    runReview: async () => ({ findings: [] })
  });

  assert.ok(scopedInput);
  assert.match(scopedInput.workerContextText, /worker-a\.txt/);
  assert.doesNotMatch(scopedInput.workerContextText, /git status lists worker-b\.txt/);
  assert.match(scopedInput.otherWorkerContextTexts?.[0] ?? "", /worker-b\.txt/);
  assert.doesNotMatch(scopedInput.otherWorkerContextTexts?.[0] ?? "", /worker-a\.txt/);
});

test("Butler bookkeeping after Worker completion does not create false review overlap", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "manor-adversarial-bookkeeping-overlap-"));
  const store = new ButlerStateStore(path.join(dir, "state.json"));
  const addWorker = (threadId: string, createdAt: number, completedAt: number, changedPath: string) => {
    store.upsertThreadSummary({ id: threadId, status: "idle", cwd: dir, turns: [{ id: `turn-${threadId}`, status: "completed", items: [{ id: `change-${threadId}`, type: "fileChange", text: `updated ${changedPath}` }] }] });
    store.setThreadExecutionContract(threadId, {
      ...buildThreadExecutionContract({ threadId, workspaceCwd: dir, projectId: "project", projectLabel: "Project", branch: null, taskText: `Change ${changedPath}.`, taskCategory: "generic_code", inferredWorkDepth: "standard", notes: [] }),
      reviewBaselineCwd: dir,
      reviewBaselineTreeSha: "c".repeat(40),
      reviewBaselineObjectDir: path.join(dir, `baseline-${threadId}`, "objects")
    });
    const report = store.recordWorkerReport(threadId, { turnId: `turn-${threadId}`, status: "completed", summary: `Changed ${changedPath}.`, details: null });
    Object.assign(store.getThread(threadId)!, { createdAt, updatedAt: completedAt });
    Object.assign(store.getThread(threadId)!.turns[0]!, { startedAt: createdAt, completedAt });
    Object.assign(report, { updatedAt: completedAt });
  };
  addWorker("finished-a", 1_000, 2_000, "a.ts");
  addWorker("later-b", 3_000, 4_000, "b.ts");
  store.addEvent("finished-a", "butler.review.closeout", "Bookkeeping after both Workers completed.");
  Object.assign(store.getThread("finished-a")!, { updatedAt: 9_000 });

  let otherWorkerContexts: string[] | undefined;
  let attributeAllChangedPaths = false;
  await ensureButlerAdversarialReview({
    watchdogs: new ActivityWatchdogService(),
    store,
    threadId: "later-b",
    model: { provider: "openai-codex", id: "gpt-5.5" } as never,
    modelRegistry: {} as never,
    codexHomeDir: dir,
    piAuthPath: path.join(dir, "auth.json"),
    scratchDir: path.join(dir, "reviews"),
    thinkingLevel: "high",
    createScopedWorkspace: async (input) => {
      otherWorkerContexts = input.otherWorkerContextTexts;
      attributeAllChangedPaths = input.attributeAllChangedPaths === true;
      return { cwd: dir, baselineSha: null, attributedPaths: ["b.ts"], suppressedPathCount: 0, scopeNote: "isolated" };
    },
    buildWorkspaceSnapshot: async () => "only b.ts",
    runReview: async () => ({ findings: [] })
  });

  assert.deepEqual(otherWorkerContexts, []);
  assert.equal(attributeAllChangedPaths, true);
});

test("deleted Worker attribution survives event-log pruning", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "manor-adversarial-peer-context-"));
  const store = new ButlerStateStore(path.join(dir, "state.json"));
  const threadId = "surviving-worker";
  store.upsertThreadSummary({ id: threadId, status: "idle", cwd: dir, turns: [{ id: "turn-1", status: "completed", items: [{ id: "change", type: "fileChange", text: "updated b.ts" }] }] });
  store.setThreadExecutionContract(threadId, {
    ...buildThreadExecutionContract({ threadId, workspaceCwd: dir, projectId: "project", projectLabel: "Project", branch: null, taskText: "Change b.ts.", taskCategory: "generic_code", inferredWorkDepth: "standard", notes: [] }),
    reviewBaselineCwd: dir,
    reviewBaselineTreeSha: "d".repeat(40),
    reviewBaselineObjectDir: path.join(dir, "baseline-survivor", "objects"),
    reviewPeerContexts: [{ sourceThreadId: "deleted-worker", baselineTreeSha: "d".repeat(40), paths: ["a.ts"], recordedAt: 1_500 }]
  });
  store.recordWorkerReport(threadId, { turnId: "turn-1", status: "completed", summary: "Changed b.ts.", details: null });
  for (let index = 0; index < 100; index += 1) store.addEvent(threadId, "runtime.noise", `Noise ${index}`);

  let otherWorkerContexts: string[] | undefined;
  await ensureButlerAdversarialReview({
    watchdogs: new ActivityWatchdogService(),
    store,
    threadId,
    model: { provider: "openai-codex", id: "gpt-5.5" } as never,
    modelRegistry: {} as never,
    codexHomeDir: dir,
    piAuthPath: path.join(dir, "auth.json"),
    scratchDir: path.join(dir, "reviews"),
    thinkingLevel: "high",
    createScopedWorkspace: async (input) => {
      otherWorkerContexts = input.otherWorkerContextTexts;
      return { cwd: dir, baselineSha: null, attributedPaths: ["b.ts"], suppressedPathCount: 1, scopeNote: "isolated" };
    },
    buildWorkspaceSnapshot: async () => "only b.ts",
    runReview: async () => ({ findings: [] })
  });

  assert.match(otherWorkerContexts?.[0] ?? "", /a\.ts/);
});

test("ambiguous shared-checkout ownership becomes a blocking review finding", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "manor-adversarial-ambiguous-ownership-"));
  const store = new ButlerStateStore(path.join(dir, "state.json"));
  const threadId = "ambiguous-worker";
  store.upsertThreadSummary({ id: threadId, status: "idle", cwd: dir, turns: [{ id: "turn-1", status: "completed", items: [] }] });
  store.setThreadExecutionContract(threadId, {
    ...buildThreadExecutionContract({ threadId, workspaceCwd: dir, projectId: "project", projectLabel: "Project", branch: null, taskText: "Change shared.ts.", taskCategory: "generic_code", inferredWorkDepth: "standard", notes: [] }),
    reviewBaselineCwd: dir,
    reviewBaselineTreeSha: "e".repeat(40),
    reviewBaselineObjectDir: path.join(dir, "baseline-ambiguous", "objects"),
    reviewPeerContexts: [{ sourceThreadId: "peer", baselineTreeSha: "e".repeat(40), paths: ["shared.ts"], recordedAt: 1 }]
  });
  store.recordWorkerReport(threadId, { turnId: "turn-1", status: "completed", summary: "Changed shared.ts.", details: null });

  const results = await ensureButlerAdversarialReview({
    watchdogs: new ActivityWatchdogService(),
    store,
    threadId,
    model: { provider: "openai-codex", id: "gpt-5.5" } as never,
    modelRegistry: {} as never,
    codexHomeDir: dir,
    piAuthPath: path.join(dir, "auth.json"),
    scratchDir: path.join(dir, "reviews"),
    thinkingLevel: "high",
    createScopedWorkspace: async () => ({ cwd: dir, baselineSha: null, attributedPaths: [], changedPathCount: 1, ambiguousPathCount: 1, ownershipAmbiguous: true, suppressedPathCount: 1, scopeNote: "ambiguous" }),
    buildWorkspaceSnapshot: async () => "No safely attributed changes.",
    runReview: async () => ({ findings: [] })
  });

  assert.equal(results.some((finding) => finding.blocking && /could not safely attribute/i.test(finding.findingSummary)), true);
  assert.match(getOrchestrationCloseoutBlocker({ thread: store.getThread(threadId), workerReport: store.getWorkerReport(threadId) }) ?? "", /could not safely attribute/i);
});

test("a failed concurrent isolation never reviews the shared checkout", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "manor-adversarial-isolation-failure-"));
  const store = new ButlerStateStore(path.join(dir, "state.json"));
  for (const [index, threadId] of ["worker-a", "worker-b"].entries()) {
    store.upsertThreadSummary({ id: threadId, status: "active", cwd: dir, turns: [{ id: `turn-${index}`, status: "completed", items: [] }] });
    store.setThreadExecutionContract(threadId, {
      ...buildThreadExecutionContract({ threadId, workspaceCwd: dir, projectId: "project", projectLabel: "Project", branch: null, taskText: "Change shared files.", taskCategory: "generic_code", inferredWorkDepth: "standard", notes: [] }),
      reviewBaselineCwd: dir,
      reviewBaselineTreeSha: "b".repeat(40),
      reviewBaselineObjectDir: path.join(dir, `${threadId}-objects`)
    });
  }
  store.recordWorkerReport("worker-a", { turnId: "turn-0", status: "completed", summary: "Done.", details: null });
  let reviewerRan = false;
  await assert.rejects(() => ensureButlerAdversarialReview({
    watchdogs: new ActivityWatchdogService(),
    store,
    threadId: "worker-a",
    model: { provider: "openai-codex", id: "gpt-5.5" } as never,
    modelRegistry: {} as never,
    codexHomeDir: dir,
    piAuthPath: path.join(dir, "auth.json"),
    scratchDir: path.join(dir, "reviews"),
    thinkingLevel: "high",
    createScopedWorkspace: async () => null,
    runReview: async () => { reviewerRan = true; return { findings: [] }; }
  }), /could not be created safely/);
  assert.equal(reviewerRan, false);
});

test("a failed delegation baseline capture blocks review instead of using the live checkout", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "manor-adversarial-baseline-failure-"));
  const store = new ButlerStateStore(path.join(dir, "state.json"));
  const threadId = "baseline-failure-worker";
  store.upsertThreadSummary({ id: threadId, status: "idle", cwd: dir, turns: [{ id: "turn-1", status: "completed", items: [] }] });
  store.setThreadExecutionContract(threadId, {
    ...buildThreadExecutionContract({ threadId, workspaceCwd: dir, projectId: "project", projectLabel: "Project", branch: null, taskText: "Change shared files.", taskCategory: "generic_code", inferredWorkDepth: "standard", notes: [] }),
    reviewBaselineCaptureFailed: true
  });
  store.recordWorkerReport(threadId, { turnId: "turn-1", status: "completed", summary: "Done.", details: null });

  await assert.rejects(() => ensureButlerAdversarialReview({
    watchdogs: new ActivityWatchdogService(),
    store,
    threadId,
    model: { provider: "openai-codex", id: "gpt-5.5" } as never,
    modelRegistry: {} as never,
    codexHomeDir: dir,
    piAuthPath: path.join(dir, "auth.json"),
    scratchDir: path.join(dir, "reviews"),
    thinkingLevel: "high",
    runReview: async () => { throw new Error("must not run"); }
  }), /isolation was not captured/i);
});

test("a superseded reviewer persists neither findings nor failure events", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "manor-adversarial-stale-"));
  const store = new ButlerStateStore(path.join(dir, "state.json"));
  const threadId = "worker-stale";
  store.upsertThreadSummary({ id: threadId, status: "idle", cwd: dir, turns: [{ id: "turn-1", status: "completed", items: [] }] });
  store.setThreadExecutionContract(threadId, buildThreadExecutionContract({ threadId, workspaceCwd: dir, projectId: "project", projectLabel: "Project", branch: null, taskText: "Review stale work.", taskCategory: "generic_code", inferredWorkDepth: "standard", notes: [] }));
  store.recordWorkerReport(threadId, { turnId: "turn-1", status: "completed", summary: "Done.", details: null });
  let current = true;
  let release!: () => void;
  let entered!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  const started = new Promise<void>((resolve) => { entered = resolve; });
  const review = ensureButlerAdversarialReview({
    watchdogs: new ActivityWatchdogService(),
    store,
    threadId,
    model: { provider: "openai-codex", id: "gpt-5.5" } as never,
    modelRegistry: {} as never,
    codexHomeDir: dir,
    piAuthPath: path.join(dir, "auth.json"),
    scratchDir: path.join(dir, "reviews"),
    thinkingLevel: "high",
    isCurrent: () => current,
    buildWorkspaceSnapshot: async () => "snapshot",
    runReview: async () => { entered(); await blocked; return { findings: [{ severity: "high", findingSummary: "stale", blocking: true, linkedClaimIds: [] }] }; }
  });
  await started;
  current = false;
  release();
  assert.deepEqual(await review, []);
  assert.deepEqual(store.getThread(threadId)?.executionContract?.reviewResults ?? [], []);
  assert.equal(store.getThread(threadId)?.eventLog.some((event) => event.method === "adversarial/review/failed"), false);
});
