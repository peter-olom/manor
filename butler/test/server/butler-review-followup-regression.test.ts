import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { ActivityWatchdogService } from "../../src/server/activity-watchdog.js";
import { ButlerAgentService } from "../../src/server/butler-agent.js";
import { applyCallbackReviewFailure } from "../../src/server/butler-callback-review-runner.js";
import { assertCallbackReviewCurrent, monitorCallbackReviewCurrent, runWithCallbackReviewGuard } from "../../src/server/butler-job-mutation-guard.js";
import { settleFailedDirectWorkerDispatch } from "../../src/server/direct-codex-message.js";
import { ButlerStateStore } from "../../src/server/state-store.js";
import { buildThreadExecutionContract } from "../../src/server/thread-contract.js";
import type { ButlerThreadCallbackView } from "../../src/server/types.js";

async function createStore(): Promise<ButlerStateStore> {
  const dir = await mkdtemp(path.join(tmpdir(), "manor-review-followup-test-"));
  return new ButlerStateStore(path.join(dir, "state.json"));
}

function createButlerAgent(store: ButlerStateStore, sessionDir: string, piRpcWorkerClient: unknown = { getConnectionState: () => ({ compose: { availableModels: [] } }) }): ButlerAgentService {
  return new ButlerAgentService({
    store,
    piRpcWorkerClient: piRpcWorkerClient as never,
    runtimeBroker: {} as never,
    serviceTemplateRegistry: {} as never,
    imageStore: {} as never,
    fileStore: {} as never,
    piAuthPath: path.join(sessionDir, "pi-auth.json"),
    workerAuthPath: path.join(sessionDir, "codex-auth.json"),
    workerConfigDir: sessionDir,
    sessionDir,
    artifactsDir: sessionDir
  });
}

test("a dispatched review follow-up stays current until the review tool finishes", async () => {
  const store = await createStore();
  const sessionDir = await mkdtemp(path.join(tmpdir(), "manor-review-followup-dispatch-"));
  const threadId = "thread-review-followup-dispatch";
  store.upsertThreadSummary({ id: threadId, status: "idle", cwd: "/workspace", turns: [] });
  const agent = createButlerAgent(store, sessionDir);
  await agent.notifyDirectCodexMessage({ threadId, text: "Review this work.", requestedAt: 1, scopeDisposition: "replace" });
  const internals = agent as unknown as { pendingChatCallbacks: Map<string, ButlerThreadCallbackView> };
  const attempted = internals.pendingChatCallbacks.get(threadId)!;
  attempted.reviewState = "running";
  attempted.reviewStage = "supervising_closeout";
  const requestedAt = 2;

  await runWithCallbackReviewGuard({
    threadId,
    isCurrent: () => internals.pendingChatCallbacks.get(threadId) === attempted && attempted.reviewState === "running"
  }, async () => {
    const watchdogs = new ActivityWatchdogService();
    await agent.reserveDirectCodexMessage({ threadId, text: "Fix the rejected point.", requestedAt, scopeDisposition: "preserve" });
    const monitor = monitorCallbackReviewCurrent(threadId, watchdogs);
    assert.ok(monitor);
    assert.equal(watchdogs.size, 1);
    let superseded = false;
    void monitor.promise.catch(() => { superseded = true; });
    await agent.markPendingChatCallbackDispatched(threadId, requestedAt, "turn-followup");
    await new Promise((resolve) => setTimeout(resolve, 75));
    monitor.dispose();
    assert.equal(watchdogs.size, 0);
    assert.equal(superseded, false);
    assert.doesNotThrow(() => assertCallbackReviewCurrent(threadId));
    assert.equal(attempted.reviewState, "running");
  });
  agent.dispose();
});

test("an external Worker dispatch supersedes an in-flight callback review", async () => {
  const store = await createStore();
  const sessionDir = await mkdtemp(path.join(tmpdir(), "manor-external-followup-dispatch-"));
  const threadId = "thread-external-followup-dispatch";
  store.upsertThreadSummary({ id: threadId, status: "idle", cwd: "/workspace", turns: [] });
  const agent = createButlerAgent(store, sessionDir);
  await agent.notifyDirectCodexMessage({ threadId, text: "Review this work.", requestedAt: 1, scopeDisposition: "replace" });
  const internals = agent as unknown as { pendingChatCallbacks: Map<string, ButlerThreadCallbackView> };
  const attempted = internals.pendingChatCallbacks.get(threadId)!;
  attempted.reviewState = "running";
  const reviewIsCurrent = () => internals.pendingChatCallbacks.get(threadId) === attempted && attempted.reviewState === "running";
  assert.equal(reviewIsCurrent(), true);

  await agent.reserveDirectCodexMessage({ threadId, text: "Operator changed the task.", requestedAt: 2, scopeDisposition: "replace" });

  assert.notEqual(internals.pendingChatCallbacks.get(threadId), attempted);
  assert.equal(reviewIsCurrent(), false);
  agent.dispose();
});

test("a cancelled follow-up restores retry history before the outer review failure", async () => {
  const store = await createStore();
  const sessionDir = await mkdtemp(path.join(tmpdir(), "manor-review-followup-retry-count-"));
  const threadId = "thread-review-followup-retry-count";
  store.upsertThreadSummary({ id: threadId, status: "idle", cwd: "/workspace", turns: [] });
  const agent = createButlerAgent(store, sessionDir);
  await agent.notifyDirectCodexMessage({ threadId, text: "Review this work.", requestedAt: 1, scopeDisposition: "replace" });
  const internals = agent as unknown as {
    pendingChatCallbacks: Map<string, ButlerThreadCallbackView>;
    callbackReviewFailureCount: Map<string, number>;
    callbackReviewNotBefore: Map<string, number>;
  };
  const attempted = internals.pendingChatCallbacks.get(threadId)!;
  attempted.reviewState = "running";
  attempted.reviewStage = "supervising_closeout";
  internals.callbackReviewFailureCount.set(threadId, 2);
  internals.callbackReviewNotBefore.set(threadId, 123);
  await runWithCallbackReviewGuard({ threadId, isCurrent: () => true }, async () => {
    const reservation = await agent.reserveDirectCodexMessage({ threadId, text: "Retry the follow-up.", requestedAt: 2, scopeDisposition: "preserve" });
    await agent.rollbackDirectCodexMessage(threadId, 2, reservation);
  });

  assert.equal(internals.callbackReviewFailureCount.get(threadId), 2);
  assert.equal(internals.callbackReviewNotBefore.get(threadId), 123);
  applyCallbackReviewFailure({
    callback: attempted,
    error: new Error("Third review attempt failed."),
    store,
    failureCount: internals.callbackReviewFailureCount,
    notBefore: internals.callbackReviewNotBefore
  });
  assert.equal(internals.callbackReviewFailureCount.get(threadId), 3);
  assert.equal(attempted.reviewState, "blocked");
  assert.match(attempted.blockedCloseoutReason ?? "", /3 failed attempts/);
  agent.dispose();
});

test("a failed review schedules its retry without waiting for status polling", async () => {
  const store = await createStore();
  const sessionDir = await mkdtemp(path.join(tmpdir(), "manor-review-retry-schedule-"));
  const threadId = "thread-review-retry-schedule";
  store.upsertThreadSummary({ id: threadId, status: "idle", cwd: "/workspace", turns: [] });
  const agent = createButlerAgent(store, sessionDir);
  await agent.notifyDirectCodexMessage({ threadId, text: "Review this work.", requestedAt: 1, scopeDisposition: "replace" });
  const internals = agent as unknown as {
    pendingChatCallbacks: Map<string, ButlerThreadCallbackView>;
    processCallbackReviews(): Promise<void>;
    callbackReviewScheduler: { scheduleAt(at: number): void };
  };
  const callback = internals.pendingChatCallbacks.get(threadId)!;
  Object.assign(callback, { callbackState: "received_worker_callback", dispatchState: "ready", reviewState: "queued", reviewStage: "queued" });
  let scheduledAt: number | null = null;
  internals.callbackReviewScheduler.scheduleAt = (at) => { scheduledAt = at; };

  await assert.rejects(() => internals.processCallbackReviews(), /Butler is not ready to supervise this review/);

  assert.equal(scheduledAt, callback.reviewNextAttemptAt);
  assert.ok(scheduledAt && scheduledAt > Date.now());
  agent.dispose();
});

test("an expired running review without a runtime watchdog is recovered", async () => {
  const store = await createStore();
  const sessionDir = await mkdtemp(path.join(tmpdir(), "manor-review-orphan-recovery-"));
  const threadId = "thread-review-orphan";
  store.upsertThreadSummary({ id: threadId, status: "idle", cwd: "/workspace", turns: [] });
  const agent = createButlerAgent(store, sessionDir);
  await agent.notifyDirectCodexMessage({ threadId, text: "Review this work.", requestedAt: Date.now() - 10_000, scopeDisposition: "replace" });
  const internals = agent as unknown as {
    pendingChatCallbacks: Map<string, ButlerThreadCallbackView>;
    activeCallbackReviewThreads: Set<string>;
    reconcilePendingChatCallbacks(): Promise<void>;
  };
  const callback = internals.pendingChatCallbacks.get(threadId)!;
  Object.assign(callback, {
    callbackState: "received_worker_callback",
    dispatchState: "ready",
    reviewState: "running",
    reviewStage: "supervising_closeout",
    reviewAttempt: 1,
    reviewDeadlineAt: Date.now() - 1,
    reviewLastActivityAt: Date.now() - 5_000
  });
  internals.activeCallbackReviewThreads.add("another-active-review");

  await internals.reconcilePendingChatCallbacks();

  assert.notEqual(callback.reviewState, "running");
  assert.equal(callback.reviewStage, "retry_wait");
  assert.match(callback.reviewLastError ?? "", /without recording a terminal state/);
  agent.dispose();
});

test("an expired activity lease is not recovered while its exact review run is active", async () => {
  const store = await createStore();
  const sessionDir = await mkdtemp(path.join(tmpdir(), "manor-review-active-watchdog-"));
  const threadId = "thread-review-active";
  store.upsertThreadSummary({ id: threadId, status: "idle", cwd: "/workspace", turns: [] });
  const agent = createButlerAgent(store, sessionDir);
  await agent.notifyDirectCodexMessage({ threadId, text: "Review this work.", requestedAt: Date.now() - 10_000, scopeDisposition: "replace" });
  const internals = agent as unknown as {
    pendingChatCallbacks: Map<string, ButlerThreadCallbackView>;
    reconcilePendingChatCallbacks(): Promise<void>;
    activeCallbackReviewThreads: Set<string>;
  };
  const callback = internals.pendingChatCallbacks.get(threadId)!;
  Object.assign(callback, {
    callbackState: "received_worker_callback",
    dispatchState: "ready",
    reviewState: "running",
    reviewStage: "supervising_closeout",
    reviewAttempt: 1,
    reviewDeadlineAt: Date.now() - 1
  });
  internals.activeCallbackReviewThreads.add(threadId);

  await internals.reconcilePendingChatCallbacks();

  assert.equal(callback.reviewState, "running");
  internals.activeCallbackReviewThreads.delete(threadId);
  agent.dispose();
});

test("a failed ordinary steer preserves checklist updates that arrived while sending", async () => {
  const store = await createStore();
  const sessionDir = await mkdtemp(path.join(tmpdir(), "manor-review-scope-concurrency-"));
  const threadId = "thread-review-scope-concurrency";
  store.upsertThreadSummary({ id: threadId, status: "idle", cwd: "/workspace", turns: [] });
  store.setThreadExecutionContract(threadId, buildThreadExecutionContract({ threadId, workspaceCwd: "/workspace", projectId: "project", projectLabel: "Project", branch: "main", taskText: "Verify the result", notes: [] }));
  const agent = createButlerAgent(store, sessionDir);
  const reservation = await agent.reserveDirectCodexMessage({ threadId, text: "Retry the send.", requestedAt: 2, scopeDisposition: "preserve" });
  const pointId = store.getSupervisionChecklist(threadId)!.items[0]!.id;
  store.reviewAcceptancePoint({ threadId, pointId, status: "accepted", note: "Worker evidence arrived." });

  await agent.rollbackDirectCodexMessage(threadId, 2, reservation);

  assert.equal(store.getSupervisionChecklist(threadId)?.items[0]?.status, "accepted");
  assert.equal(store.getSupervisionChecklist(threadId)?.items[0]?.butlerNote, "Worker evidence arrived.");
  agent.dispose();
});

test("a failed scope replacement does not overwrite newer Worker review evidence", async () => {
  const store = await createStore();
  const sessionDir = await mkdtemp(path.join(tmpdir(), "manor-review-scope-version-"));
  const threadId = "thread-review-scope-version";
  store.upsertThreadSummary({ id: threadId, status: "idle", cwd: "/workspace", turns: [] });
  store.setThreadExecutionContract(threadId, buildThreadExecutionContract({ threadId, workspaceCwd: "/workspace", projectId: "project", projectLabel: "Project", branch: "main", taskText: "Old work", notes: [] }));
  const agent = createButlerAgent(store, sessionDir);
  const reservation = await agent.reserveDirectCodexMessage({ threadId, text: "New work", requestedAt: 2, scopeDisposition: "replace" });
  store.refreshCompletedSupervisionChecklistForFollowup(threadId, "New work", { force: true });
  const refreshed = store.getThread(threadId)!;
  reservation.reviewScopeReplacement = { executionContract: structuredClone(refreshed.executionContract), supervisionChecklist: structuredClone(refreshed.supervisionChecklist) };
  const pointId = refreshed.supervisionChecklist!.items[0]!.id;
  store.reviewAcceptancePoint({ threadId, pointId, status: "accepted", note: "Concurrent evidence." });

  await agent.rollbackDirectCodexMessage(threadId, 2, reservation);

  assert.equal(store.getThread(threadId)?.executionContract?.requestedTask, "New work");
  assert.equal(store.getSupervisionChecklist(threadId)?.items[0]?.status, "accepted");
  assert.equal(store.getSupervisionChecklist(threadId)?.items[0]?.butlerNote, "Concurrent evidence.");
  agent.dispose();
});

test("an already dispatched callback posts attention when restart hydration fails", async () => {
  const sessionDir = await mkdtemp(path.join(tmpdir(), "manor-ready-callback-hydration-"));
  const threadId = "thread-ready-callback-hydration";
  const originalStore = await createStore();
  originalStore.upsertThreadSummary({ id: threadId, status: "idle", cwd: "/workspace", turns: [] });
  const originalAgent = createButlerAgent(originalStore, sessionDir);
  await originalAgent.reserveDirectCodexMessage({ threadId, text: "Finish and report.", requestedAt: 1, scopeDisposition: "replace" });
  await originalAgent.markPendingChatCallbackDispatched(threadId, 1, "turn-dispatched");
  originalAgent.dispose();

  const recoveringStore = await createStore();
  const recoveringAgent = createButlerAgent(recoveringStore, sessionDir, { getConnectionState: () => ({ compose: { availableModels: [] } }), loadThread: async () => { throw new Error("provider unavailable"); } });
  const internals = recoveringAgent as unknown as { loadCallbackState(): Promise<void>; reconcilePendingChatCallbacks(): Promise<void>; pendingChatCallbacks: Map<string, ButlerThreadCallbackView>; operatorMessages: Array<{ text: string }> };
  await internals.loadCallbackState();
  await internals.reconcilePendingChatCallbacks();

  assert.equal(internals.pendingChatCallbacks.get(threadId)?.dispatchState, "ready");
  assert.ok(internals.pendingChatCallbacks.get(threadId)?.watchdogAttentionAt);
  assert.match(internals.operatorMessages.at(-1)?.text ?? "", /could not reload this Worker session/);
  recoveringAgent.dispose();
});

test("a direct notification failure restores scope refreshed before payload persistence", async () => {
  const store = await createStore();
  const sessionDir = await mkdtemp(path.join(tmpdir(), "manor-direct-notify-scope-rollback-"));
  const threadId = "thread-direct-notify-scope-rollback";
  store.upsertThreadSummary({ id: threadId, status: "idle", cwd: "/workspace", turns: [] });
  store.setThreadExecutionContract(threadId, buildThreadExecutionContract({ threadId, workspaceCwd: "/workspace", projectId: "project", projectLabel: "Project", branch: "main", taskText: "Old work", notes: [] }));
  for (const item of store.getSupervisionChecklist(threadId)?.items ?? []) store.reviewAcceptancePoint({ threadId, pointId: item.id, status: "accepted" });
  const agent = createButlerAgent(store, sessionDir);
  const reservation = await agent.reserveDirectCodexMessage({ threadId, text: "New work", requestedAt: 2, scopeDisposition: "replace" });
  const internals = agent as unknown as { createOrUpdateJobPayload(input: { threadId: string; kind: "direct_message"; instruction: string; onPrepared?: (payload: never) => void }): Promise<unknown> };
  const createPayload = internals.createOrUpdateJobPayload.bind(agent);
  internals.createOrUpdateJobPayload = async (input) => { await createPayload(input); throw new Error("callback persistence failed"); };

  await assert.rejects(() => agent.notifyDirectCodexMessage({ threadId, text: "New work", requestedAt: 2, callbackAlreadyRegistered: true, scopeDisposition: "replace" }, reservation), /callback persistence failed/);
  assert.deepEqual(store.getThread(threadId)?.executionContract, reservation.reviewScopeReplacement?.executionContract);
  assert.deepEqual(store.getThread(threadId)?.supervisionChecklist?.items, reservation.reviewScopeReplacement?.supervisionChecklist?.items);
  await agent.rollbackDirectCodexMessage(threadId, 2, reservation);

  assert.equal(store.getThread(threadId)?.executionContract?.requestedTask, "Old work");
  assert.equal(store.getSupervisionChecklist(threadId)?.items[0]?.status, "accepted");
  assert.equal(store.getThreadJobPayload(threadId), null);
  agent.dispose();
});

test("payload rollback preserves a newer Worker checkpoint", async () => {
  const store = await createStore();
  const sessionDir = await mkdtemp(path.join(tmpdir(), "manor-payload-concurrency-"));
  const threadId = "thread-payload-concurrency";
  store.upsertThreadSummary({ id: threadId, status: "idle", cwd: "/workspace", turns: [] });
  const agent = createButlerAgent(store, sessionDir);
  const internals = agent as unknown as { createOrUpdateJobPayload(input: { threadId: string; kind: "steering" | "worker_report"; instruction: string; onPrepared?: (payload: never) => void }): Promise<unknown> };
  const reservation = await agent.reserveDirectCodexMessage({ threadId, text: "Unsent follow-up", requestedAt: 2, scopeDisposition: "preserve" });
  const replacement = await internals.createOrUpdateJobPayload({ threadId, kind: "steering", instruction: "Unsent follow-up", onPrepared: (payload) => { reservation.jobPayloadReplacement = structuredClone(payload); } });
  assert.ok(replacement);
  const checkpoint = await internals.createOrUpdateJobPayload({ threadId, kind: "worker_report", instruction: "Worker checkpoint arrived" });

  await agent.rollbackDirectCodexMessage(threadId, 2, reservation);

  assert.deepEqual(store.getThreadJobPayload(threadId), checkpoint);
  agent.dispose();
});

test("a newer Worker checkpoint preserves the refreshed payload and review scope together", async () => {
  const store = await createStore();
  const sessionDir = await mkdtemp(path.join(tmpdir(), "manor-payload-scope-generation-"));
  const threadId = "thread-payload-scope-generation";
  store.upsertThreadSummary({ id: threadId, status: "idle", cwd: "/workspace", turns: [] });
  store.setThreadExecutionContract(threadId, buildThreadExecutionContract({ threadId, workspaceCwd: "/workspace", projectId: "project", projectLabel: "Project", branch: "main", taskText: "Old work", notes: [] }));
  for (const item of store.getSupervisionChecklist(threadId)?.items ?? []) store.reviewAcceptancePoint({ threadId, pointId: item.id, status: "accepted" });
  const agent = createButlerAgent(store, sessionDir);
  const reservation = await agent.reserveDirectCodexMessage({ threadId, text: "New work", requestedAt: 2, scopeDisposition: "replace" });
  await agent.notifyDirectCodexMessage({ threadId, text: "New work", requestedAt: 2, callbackAlreadyRegistered: true, scopeDisposition: "replace" }, reservation);
  const internals = agent as unknown as { createOrUpdateJobPayload(input: { threadId: string; kind: "worker_report"; instruction: string }): Promise<unknown> };
  const checkpoint = await internals.createOrUpdateJobPayload({ threadId, kind: "worker_report", instruction: "Worker checkpoint arrived" });

  await agent.rollbackDirectCodexMessage(threadId, 2, reservation);

  assert.deepEqual(store.getThreadJobPayload(threadId), checkpoint);
  assert.equal(store.getThread(threadId)?.executionContract?.requestedTask, "New work");
  assert.equal((store.getThreadJobPayload(threadId)?.executionContract as { requestedTask?: string } | null)?.requestedTask, "New work");
  agent.dispose();
});

test("new review evidence preserves the refreshed payload and review scope together", async () => {
  const store = await createStore();
  const sessionDir = await mkdtemp(path.join(tmpdir(), "manor-scope-payload-generation-"));
  const threadId = "thread-scope-payload-generation";
  store.upsertThreadSummary({ id: threadId, status: "idle", cwd: "/workspace", turns: [] });
  store.setThreadExecutionContract(threadId, buildThreadExecutionContract({ threadId, workspaceCwd: "/workspace", projectId: "project", projectLabel: "Project", branch: "main", taskText: "Old work", notes: [] }));
  for (const item of store.getSupervisionChecklist(threadId)?.items ?? []) store.reviewAcceptancePoint({ threadId, pointId: item.id, status: "accepted" });
  const agent = createButlerAgent(store, sessionDir);
  const reservation = await agent.reserveDirectCodexMessage({ threadId, text: "New work", requestedAt: 2, scopeDisposition: "replace" });
  await agent.notifyDirectCodexMessage({ threadId, text: "New work", requestedAt: 2, callbackAlreadyRegistered: true, scopeDisposition: "replace" }, reservation);
  const replacementPayload = structuredClone(store.getThreadJobPayload(threadId)!);
  store.setThreadJobPayload(replacementPayload);
  const pointId = store.getSupervisionChecklist(threadId)!.items[0]!.id;
  store.reviewAcceptancePoint({ threadId, pointId, status: "accepted", note: "Concurrent review evidence." });

  await agent.rollbackDirectCodexMessage(threadId, 2, reservation);

  assert.deepEqual(store.getThreadJobPayload(threadId), replacementPayload);
  assert.equal(store.getThread(threadId)?.executionContract?.requestedTask, "New work");
  assert.equal(store.getSupervisionChecklist(threadId)?.items[0]?.butlerNote, "Concurrent review evidence.");
  agent.dispose();
});

test("a rollback persistence failure keeps callback memory aligned with durable state", async () => {
  const store = await createStore();
  const sessionDir = await mkdtemp(path.join(tmpdir(), "manor-rollback-persistence-failure-"));
  const threadId = "thread-rollback-persistence-failure";
  store.upsertThreadSummary({ id: threadId, status: "idle", cwd: "/workspace", turns: [] });
  store.setThreadExecutionContract(threadId, buildThreadExecutionContract({ threadId, workspaceCwd: "/workspace", projectId: "project", projectLabel: "Project", branch: "main", taskText: "Old work", notes: [] }));
  const agent = createButlerAgent(store, sessionDir);
  const internals = agent as unknown as {
    createOrUpdateJobPayload(input: { threadId: string; kind: "steering"; instruction: string }): Promise<unknown>;
    pendingChatCallbacks: Map<string, ButlerThreadCallbackView>;
  };
  await internals.createOrUpdateJobPayload({ threadId, kind: "steering", instruction: "Old work" });
  for (const item of store.getSupervisionChecklist(threadId)?.items ?? []) store.reviewAcceptancePoint({ threadId, pointId: item.id, status: "accepted" });
  const reservation = await agent.reserveDirectCodexMessage({ threadId, text: "New work", requestedAt: 2, scopeDisposition: "replace" });
  await agent.notifyDirectCodexMessage({ threadId, text: "New work", requestedAt: 2, callbackAlreadyRegistered: true, scopeDisposition: "replace" }, reservation);
  const replacementPayload = structuredClone(store.getThreadJobPayload(threadId));
  await rm(path.join(sessionDir, "job-payloads"), { recursive: true, force: true });
  await writeFile(path.join(sessionDir, "job-payloads"), "blocks payload persistence", "utf8");
  const sendError = new Error("Worker send failed");

  await assert.rejects(
    () => settleFailedDirectWorkerDispatch(sendError, async () => { throw new Error("preserve must not run"); }, () => agent.rollbackDirectCodexMessage(threadId, 2, reservation)),
    (error) => { assert.equal(error, sendError); assert.ok(sendError.cause instanceof Error); return true; }
  );

  assert.equal(internals.pendingChatCallbacks.get(threadId)?.requestedAt, 2);
  assert.equal(internals.pendingChatCallbacks.get(threadId)?.dispatchState, "reserving");
  assert.deepEqual(store.getThreadJobPayload(threadId), replacementPayload);
  assert.equal(store.getThread(threadId)?.executionContract?.requestedTask, "New work");
  const persisted = JSON.parse(await readFile(path.join(sessionDir, "chat-callbacks.json"), "utf8")) as { callbackRecords: ButlerThreadCallbackView[] };
  assert.equal(persisted.callbackRecords[0]?.requestedAt, 2);
  assert.equal(persisted.callbackRecords[0]?.dispatchState, "reserving");
  agent.dispose();
});
