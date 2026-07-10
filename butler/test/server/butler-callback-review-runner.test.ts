import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { applyCallbackReviewFailure, buildCallbackAdversarialReviewBrief, buildGuardedCallbackReviewTools, isCallbackReviewAutomationPause, isCurrentCallbackReview, selectRunnableCallbackReviews, shouldIgnoreCallbackReviewFailure } from "../../src/server/butler-callback-review-runner.js";
import type { PendingChatCallback } from "../../src/server/butler-agent-helpers.js";
import { loadButlerCallbackState } from "../../src/server/butler-callback-state.js";
import { buildJobPayload } from "../../src/server/job-instruction-artifacts.js";
import { getCallbackReviewExecution, runButlerJobMutationGuardedTool, runOutsideJobMutationContext, runSerializedCallbackReplacement, runSerializedJobMutation, runWithCallbackReviewGuard } from "../../src/server/butler-job-mutation-guard.js";
import { ButlerStateStore } from "../../src/server/state-store.js";
import { buildThreadExecutionContract } from "../../src/server/thread-contract.js";
import { sendWorkerMessage } from "../../src/server/worker-client-router.js";

function callback(threadId: string, updatedAt: number): PendingChatCallback {
  return {
    threadId,
    callbackState: "received_worker_callback",
    resolutionState: "received_worker_callback",
    requestedAt: updatedAt - 1,
    lastEventAt: updatedAt,
    lastWorkerStatusSeen: "idle",
    lastTerminalReportAt: updatedAt,
    lastPrivateSteerText: null,
    lastPrivateSteerAt: null,
    nextWorkerReportAction: "review",
    operatorCloseoutStatus: "owed",
    owesOperatorReply: true,
    closeoutChannel: "none",
    reviewState: "queued",
    reviewReason: "worker_callback",
    reviewModelProvider: "openai",
    reviewModelId: "gpt-5-codex",
    reviewReasoningLevel: "high",
    blockedCloseoutReason: null,
    blockedCloseoutReportAt: null,
    closedAt: null,
    updatedAt
  };
}

test("callback review queue waits for backoff and keeps ready work ordered", () => {
  const now = 10_000;
  const later = callback("later", 3);
  const first = callback("first", 1);
  const second = callback("second", 2);
  const notBefore = new Map([[later.threadId, now + 5_000]]);

  const selected = selectRunnableCallbackReviews([later, second, first], notBefore, now);

  assert.deepEqual(selected.pendingReviews.map((entry) => entry.threadId), ["first", "second"]);
  assert.equal(selected.retryAt, now + 5_000);
});

test("callback review failures back off twice and then block closeout", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "manor-review-retry-"));
  const store = new ButlerStateStore(path.join(dir, "state.json"));
  const target = callback("worker", Date.now());
  const failureCount = new Map<string, number>();
  const notBefore = new Map<string, number>();

  applyCallbackReviewFailure({ callback: target, error: new Error("provider unavailable"), store, failureCount, notBefore });
  assert.equal(target.reviewState, "queued");
  assert.ok((notBefore.get(target.threadId) ?? 0) > Date.now());

  applyCallbackReviewFailure({ callback: target, error: new Error("provider unavailable"), store, failureCount, notBefore });
  assert.equal(target.reviewState, "queued");

  applyCallbackReviewFailure({ callback: target, error: new Error("provider unavailable"), store, failureCount, notBefore });
  assert.equal(target.reviewState, "blocked");
  assert.match(target.blockedCloseoutReason ?? "", /paused after 3 failed attempts/);
  assert.equal(isCallbackReviewAutomationPause(target, target.blockedCloseoutReportAt), true);
});

test("callback review interrupted by restart resumes from the queue", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "manor-review-restart-"));
  const callbackStatePath = path.join(dir, "callbacks.json");
  const persisted = callback("worker", Date.now());
  persisted.reviewState = "running";
  await writeFile(callbackStatePath, JSON.stringify({ callbackRecords: [persisted] }), "utf8");
  const callbacks = new Map<string, PendingChatCallback>();

  await loadButlerCallbackState({ callbackStatePath, pendingChatCallbacks: callbacks, deliveredCloseoutIds: new Set() });

  assert.equal(callbacks.get("worker")?.reviewState, "queued");
  assert.equal(callbacks.get("worker")?.reviewModelId, "gpt-5-codex");
  assert.equal(callbacks.get("worker")?.reviewReasoningLevel, "high");

  persisted.reviewState = "blocked";
  persisted.blockedCloseoutReason = "Adversarial review paused after 3 failed attempts: expired token";
  persisted.blockedCloseoutReportAt = persisted.updatedAt;
  await writeFile(callbackStatePath, JSON.stringify({ callbackRecords: [persisted] }), "utf8");
  await loadButlerCallbackState({ callbackStatePath, pendingChatCallbacks: callbacks, deliveredCloseoutIds: new Set() });
  assert.equal(callbacks.get("worker")?.reviewState, "queued");
  assert.equal(callbacks.get("worker")?.blockedCloseoutReason, null);
});

test("adversarial review brief carries Butler's latest steering and unresolved decisions", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "manor-review-brief-"));
  const store = new ButlerStateStore(path.join(dir, "state.json"));
  const target = callback("worker", Date.now());
  target.lastPrivateSteerText = "Check the timeout recovery path.";
  store.upsertThreadSummary({ id: target.threadId, status: "idle", cwd: dir, turns: [] });
  const contract = buildThreadExecutionContract({
    threadId: target.threadId,
    workspaceCwd: dir,
    projectId: "project",
    projectLabel: "Project",
    branch: null,
    taskText: "Fix timeout recovery.",
    notes: []
  });
  store.setThreadExecutionContract(target.threadId, contract);
  store.setThreadJobPayload(buildJobPayload({
    threadId: target.threadId,
    kind: "held_context",
    instruction: "Preserve the original error for the operator.",
    contract
  }));
  const firstPoint = store.getSupervisionChecklist(target.threadId)?.items[0];
  assert.ok(firstPoint);
  store.reviewAcceptancePoint({
    threadId: target.threadId,
    pointId: firstPoint.id,
    status: "rejected",
    note: "No negative-path proof.",
    nextInstruction: "Add an exhausted-retry assertion."
  });
  store.addEvent(target.threadId, "butler.context.held", "The operator needs the original error preserved.");
  store.recordWorkerReviewResults(target.threadId, [{
    id: "finding-old",
    reviewSource: "adversarial_review",
    turnId: "turn-old",
    reportUpdatedAt: 1,
    severity: "high",
    findingSummary: "The retry loop hides the original error.",
    blocking: true,
    linkedClaimIds: [],
    automationFailure: false,
    modelProvider: "openai",
    modelId: "gpt-5-codex",
    reasoningLevel: "high",
    waived: false,
    waiverReason: null,
    createdAt: 1
  }]);

  const brief = buildCallbackAdversarialReviewBrief(store, target);
  assert.match(brief, /Check the timeout recovery path/);
  assert.match(brief, /not sent to the Worker/);
  assert.match(brief, /original error preserved/);
  assert.match(brief, /Add an exhausted-retry assertion/);
  assert.match(brief, /retry loop hides the original error/);
});

test("a replacement callback is a new review generation", () => {
  const attempted = callback("worker", 1);
  const replacement = callback("worker", 2);
  assert.equal(isCurrentCallbackReview(attempted, attempted), true);
  assert.equal(isCurrentCallbackReview(attempted, replacement), false);
  assert.equal(shouldIgnoreCallbackReviewFailure(attempted, replacement), true);
  attempted.callbackState = "closed";
  attempted.owesOperatorReply = false;
  assert.equal(shouldIgnoreCallbackReviewFailure(attempted, attempted), true);
});

test("isolated review tools stop when a newer callback replaces the attempt", async () => {
  const target = callback("worker", 1);
  let current = true;
  let executions = 0;
  let executionSelection: ReturnType<typeof getCallbackReviewExecution> = null;
  let receivedSignal: AbortSignal | undefined;
  const tools = buildGuardedCallbackReviewTools({
    callback: target,
    isCurrent: () => current,
    reviewSelection: { modelProvider: "openai", modelId: "gpt-5-codex", reasoningLevel: "high" },
    tools: [
      {
        name: "message_job",
        label: "Message job",
        description: "",
        parameters: {} as never,
        execute: async (_id, _params, signal) => {
          executions += 1;
          executionSelection = getCallbackReviewExecution();
          receivedSignal = signal;
          return { content: [{ type: "text", text: "sent" }], details: {} };
        }
      },
      {
        name: "delete_job",
        label: "Delete job",
        description: "",
        parameters: {} as never,
        execute: async () => ({ content: [{ type: "text", text: "deleted" }], details: {} })
      }
    ] as never
  });

  assert.deepEqual(tools.map((tool) => tool.name), ["message_job"]);
  const controller = new AbortController();
  await tools[0]!.execute("call-1", { threadId: target.threadId } as never, controller.signal);
  assert.deepEqual(executionSelection, { modelProvider: "openai", modelId: "gpt-5-codex", reasoningLevel: "high" });
  assert.equal(receivedSignal, controller.signal);
  current = false;
  await assert.rejects(() => tools[0]!.execute("call-2", { threadId: target.threadId } as never), /superseded/);
  assert.equal(executions, 1);
});

test("a stale review waiting on a job mutation cannot send after replacement", async () => {
  let current = true;
  let releaseFirst!: () => void;
  let enteredFirst!: () => void;
  const firstEntered = new Promise<void>((resolve) => { enteredFirst = resolve; });
  const firstBlocked = new Promise<void>((resolve) => { releaseFirst = resolve; });
  const first = runButlerJobMutationGuardedTool("message_job", { threadId: "worker" }, async () => {
    enteredFirst();
    await firstBlocked;
  });
  await firstEntered;
  let staleExecutions = 0;
  const stale = runWithCallbackReviewGuard(
    { threadId: "worker", isCurrent: () => current },
    () => runButlerJobMutationGuardedTool("message_job", { threadId: "worker" }, async () => { staleExecutions += 1; })
  );
  current = false;
  releaseFirst();
  await first;
  await assert.rejects(stale, /superseded/);
  assert.equal(staleExecutions, 0);
});

test("an external callback replacement waits for the active review mutation", async () => {
  let releaseMutation!: () => void;
  let mutationEntered!: () => void;
  const entered = new Promise<void>((resolve) => { mutationEntered = resolve; });
  const blocked = new Promise<void>((resolve) => { releaseMutation = resolve; });
  const mutation = runButlerJobMutationGuardedTool("message_job", { threadId: "worker" }, async () => {
    mutationEntered();
    await blocked;
  });
  await entered;
  let replacementRan = false;
  const replacement = runSerializedCallbackReplacement("worker", async () => { replacementRan = true; });
  await Promise.resolve();
  assert.equal(replacementRan, false);
  releaseMutation();
  await Promise.all([mutation, replacement]);
  assert.equal(replacementRan, true);
});

test("a timed-out callback send is stopped before stale completion can escape", async () => {
  let current = true;
  let releaseSend!: () => void;
  let sendEntered!: () => void;
  const entered = new Promise<void>((resolve) => { sendEntered = resolve; });
  const blocked = new Promise<void>((resolve) => { releaseSend = resolve; });
  const stopped: string[] = [];
  const access = {
    store: { getThread: () => ({ source: "codex" }) },
    codexClient: {
      async sendMessage() { sendEntered(); await blocked; return { threadId: "worker", turnId: "turn-1" }; },
      async stopThread(threadId: string) { stopped.push(threadId); return true; }
    }
  } as never;
  const send = runWithCallbackReviewGuard(
    { threadId: "worker", isCurrent: () => current },
    () => sendWorkerMessage(access, "worker", "fix it")
  );
  await entered;
  current = false;
  releaseSend();
  await assert.rejects(send, /superseded/);
  assert.deepEqual(stopped, ["worker"]);
});

test("a superseded callback releases its lock even when send never resolves", async () => {
  let current = true;
  let sendEntered!: () => void;
  const entered = new Promise<void>((resolve) => { sendEntered = resolve; });
  const stopped: string[] = [];
  const access = {
    store: { getThread: () => ({ source: "codex" }) },
    codexClient: {
      async sendMessage() { sendEntered(); return new Promise<never>(() => undefined); },
      async stopThread(threadId: string) { stopped.push(threadId); return true; }
    }
  } as never;
  const send = runWithCallbackReviewGuard(
    { threadId: "worker", isCurrent: () => current },
    () => runSerializedJobMutation("worker", () => sendWorkerMessage(access, "worker", "fix it"))
  );
  await entered;
  current = false;
  await assert.rejects(send, /superseded/);
  let nextRan = false;
  await runSerializedJobMutation("worker", async () => { nextRan = true; });
  assert.equal(nextRan, true);
  assert.deepEqual(stopped, ["worker"]);
});

test("job mutation locks are reentrant without serializing unrelated jobs", async () => {
  let releaseA!: () => void;
  let enteredA!: () => void;
  const blockedA = new Promise<void>((resolve) => { releaseA = resolve; });
  const startedA = new Promise<void>((resolve) => { enteredA = resolve; });
  const jobA = runSerializedJobMutation("worker-a", async () => {
    enteredA();
    await runSerializedJobMutation("worker-a", async () => blockedA);
  });
  await startedA;
  let jobBRan = false;
  await runSerializedJobMutation("worker-b", async () => { jobBRan = true; });
  assert.equal(jobBRan, true);
  releaseA();
  await jobA;
});

test("detached mutation context reacquires after its owner releases", async () => {
  let releaseDetached!: () => void;
  const detachedGate = new Promise<void>((resolve) => { releaseDetached = resolve; });
  let detached!: Promise<void>;
  let detachedRan = false;
  await runSerializedJobMutation("worker", async () => {
    detached = detachedGate.then(() => runSerializedJobMutation("worker", async () => { detachedRan = true; }));
  });
  let releaseCurrent!: () => void;
  let currentEntered!: () => void;
  const currentBlocked = new Promise<void>((resolve) => { releaseCurrent = resolve; });
  const currentStarted = new Promise<void>((resolve) => { currentEntered = resolve; });
  const current = runSerializedJobMutation("worker", async () => { currentEntered(); await currentBlocked; });
  await currentStarted;
  releaseDetached();
  await Promise.resolve();
  assert.equal(detachedRan, false);
  releaseCurrent();
  await Promise.all([current, detached]);
  assert.equal(detachedRan, true);
});

test("detached store work explicitly leaves the reentrant mutation context", async () => {
  let detached!: Promise<void>;
  let detachedRan = false;
  await runSerializedJobMutation("worker", async () => {
    runOutsideJobMutationContext(() => {
      detached = runSerializedJobMutation("worker", async () => { detachedRan = true; });
    });
    await Promise.resolve();
    assert.equal(detachedRan, false);
  });
  await detached;
  assert.equal(detachedRan, true);
});
