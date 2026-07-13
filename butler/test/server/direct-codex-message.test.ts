import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { ButlerAgentService } from "../../src/server/butler-agent.js";
import { directWorkerDispatchMarker } from "../../src/server/butler-callback-state.js";
import { normalizeOperatorMessages } from "../../src/server/butler-operator-messages.js";
import { backfillDirectCodexMessagesFromSessionFiles, buildDirectCodexMessagePingSummary } from "../../src/server/direct-codex-message.js";
import { ButlerStateStore } from "../../src/server/state-store.js";
import { StaleWorkerOperationError } from "../../src/server/stale-worker-operation-error.js";
import { buildThreadExecutionContract } from "../../src/server/thread-contract.js";
import { runSerializedJobMutation } from "../../src/server/butler-job-mutation-guard.js";
import { sendWorkerMessage } from "../../src/server/worker-client-router.js";
import type { ButlerThreadCallbackView } from "../../src/server/types.js";

async function createStore(): Promise<ButlerStateStore> {
  const dir = await mkdtemp(path.join(tmpdir(), "manor-direct-codex-test-"));
  return new ButlerStateStore(path.join(dir, "state.json"));
}

function createButlerAgent(store: ButlerStateStore, sessionDir: string, codexClient: unknown = {
  getConnectionState: () => ({
    compose: {
      availableModels: []
    }
  })
}): ButlerAgentService {
  return new ButlerAgentService({
    store,
    codexClient: codexClient as never,
    runtimeBroker: {} as never,
    serviceTemplateRegistry: {} as never,
    imageStore: {} as never,
    fileStore: {} as never,
    piAuthPath: path.join(sessionDir, "pi-auth.json"),
    codexAuthPath: path.join(sessionDir, "codex-auth.json"),
    codexConfigDir: sessionDir,
    sessionDir,
    artifactsDir: sessionDir
  });
}

test("operator message persistence preserves presentation metadata", async () => {
  const store = await createStore();
  const sessionDir = await mkdtemp(path.join(tmpdir(), "manor-operator-message-reload-"));
  await writeFile(path.join(sessionDir, "operator-messages.json"), JSON.stringify([{
    id: "operator-1",
    role: "user",
    text: "internal reference context",
    displayText: "Review these",
    hiddenFromTranscript: true,
    at: 100,
    taskDurationMs: null,
    kind: "message",
    attachments: [
      { id: "image-1", kind: "image", name: "screen.png", mimeType: "image/png", sizeBytes: 10, url: "/api/images/image-1" },
      { id: "file-1", kind: "file", name: "report.pdf", mimeType: "application/pdf", sizeBytes: 20, url: "/api/files/file-1" }
    ]
  }]), "utf8");
  const agent = createButlerAgent(store, sessionDir);
  const internals = agent as unknown as {
    loadOperatorMessageState(): Promise<void>;
    saveOperatorMessageState(): Promise<void>;
    operatorMessages: Array<{ displayText?: string; hiddenFromTranscript?: boolean; attachments?: Array<{ id: string }> }>;
  };

  await internals.loadOperatorMessageState();

  assert.equal(internals.operatorMessages[0]?.displayText, "Review these");
  assert.equal(internals.operatorMessages[0]?.hiddenFromTranscript, true);
  assert.deepEqual(internals.operatorMessages[0]?.attachments?.map((attachment) => attachment.id), ["image-1", "file-1"]);
  await internals.saveOperatorMessageState();
  const persisted = JSON.parse(await readFile(path.join(sessionDir, "operator-messages.json"), "utf8"));
  assert.equal(persisted[0]?.hiddenFromTranscript, true);
});

test("direct Codex ping summary includes message and selected context", () => {
  const summary = buildDirectCodexMessagePingSummary({
    text: "Please retry the smoke proof.",
    imageReferenceIds: ["image-1"],
    fileReferenceIds: ["file-1", "file-2"],
    inputItems: [{ type: "mention", path: "app://example" }]
  });

  assert.match(summary, /Please retry the smoke proof/);
  assert.match(summary, /1 image reference/);
  assert.match(summary, /2 file references/);
  assert.match(summary, /1 selected context item/);
});

test("direct Codex messages register Butler supervision callback", async () => {
  const store = await createStore();
  const sessionDir = await mkdtemp(path.join(tmpdir(), "manor-direct-codex-session-"));
  const threadId = "thread-direct-1";
  store.upsertThreadSummary({
    id: threadId,
    status: "active",
    cwd: "/workspace",
    turns: [{ id: "turn-1", status: "completed", items: [] }]
  });

  const agent = createButlerAgent(store, sessionDir);
  await agent.notifyDirectCodexMessage({
    threadId,
    text: "Continue with the operator correction.",
    imageReferenceIds: [],
    fileReferenceIds: [],
    inputItems: []
  });

  const callbacks = agent.getShellSnapshot().supervision.callbacks;
  assert.equal(callbacks.length, 1);
  assert.equal(callbacks[0]?.threadId, threadId);
  assert.equal(callbacks[0]?.lastPrivateSteerText, "Continue with the operator correction.");
  assert.equal(callbacks[0]?.operatorCloseoutStatus, "owed");
  assert.equal(callbacks[0]?.nextWorkerReportAction, "review");
  assert.equal(store.getThread(threadId)?.eventLog[0]?.method, "butler.direct_message.pinged");

  const messages = agent.getLiveSnapshot().messages;
  assert.equal(messages.length, 0);
});

test("deleting a Worker removes its outstanding Butler callback", async () => {
  const store = await createStore();
  const sessionDir = await mkdtemp(path.join(tmpdir(), "manor-direct-codex-delete-"));
  const threadId = "thread-delete-callback";
  store.upsertThreadSummary({ id: threadId, status: "active", cwd: "/workspace", turns: [{ id: "turn-1", status: "completed", items: [] }] });
  const agent = createButlerAgent(store, sessionDir);
  await agent.notifyDirectCodexMessage({ threadId, text: "Continue.", imageReferenceIds: [], fileReferenceIds: [], inputItems: [] });
  assert.equal(agent.getShellSnapshot().supervision.callbacks.length, 1);

  await agent.removeExternalWorkerDelegation(threadId);

  assert.equal(agent.getShellSnapshot().supervision.callbacks.length, 0);
});

test("direct Worker callback is persisted before send and rolled back on failure", async () => {
  const store = await createStore();
  const sessionDir = await mkdtemp(path.join(tmpdir(), "manor-direct-codex-reserve-"));
  const threadId = "thread-reserved-callback";
  store.upsertThreadSummary({ id: threadId, status: { type: "idle" }, cwd: "/workspace", turns: [{ id: "turn-1", status: "completed", items: [] }] });
  const agent = createButlerAgent(store, sessionDir);
  const requestedAt = Date.now();

  const reservation = await agent.reserveDirectCodexMessage({ threadId, text: "Run the follow-up.", requestedAt });
  assert.equal(agent.getShellSnapshot().supervision.callbacks[0]?.requestedAt, requestedAt);
  assert.equal(agent.getShellSnapshot().supervision.callbacks[0]?.lastPrivateSteerText, "Run the follow-up.");
  assert.equal(agent.getShellSnapshot().supervision.callbacks[0]?.dispatchState, "reserving");
  await agent.notifyDirectCodexMessage({ threadId, text: "Run the follow-up.", requestedAt, callbackAlreadyRegistered: true });
  assert.equal(agent.getShellSnapshot().supervision.callbacks[0]?.dispatchState, "ready");

  await agent.rollbackDirectCodexMessage(threadId, requestedAt, reservation);
  assert.equal(agent.getShellSnapshot().supervision.callbacks.length, 0);

  await agent.notifyDirectCodexMessage({ threadId, text: "Original review.", requestedAt: requestedAt + 1 });
  const internals = agent as unknown as { pendingChatCallbacks: Map<string, ButlerThreadCallbackView> };
  internals.pendingChatCallbacks.get(threadId)!.reviewState = "running";
  await runSerializedJobMutation(threadId, async () => {
    const interrupted = await agent.reserveDirectCodexMessage({ threadId, text: "Replacement send.", requestedAt: requestedAt + 2 });
    await agent.rollbackDirectCodexMessage(threadId, requestedAt + 2, interrupted);
    assert.equal(internals.pendingChatCallbacks.get(threadId)?.reviewState, "queued");
  });
  agent.dispose();
});

test("a stale direct Worker dispatch rolls back its reserved callback", async () => {
  const store = await createStore();
  const sessionDir = await mkdtemp(path.join(tmpdir(), "manor-direct-codex-stale-dispatch-"));
  const threadId = "thread-stale-direct-dispatch";
  store.upsertThreadSummary({ id: threadId, source: "appServer", status: { type: "idle" }, cwd: "/workspace", turns: [] });
  const agent = createButlerAgent(store, sessionDir);
  const requestedAt = Date.now();
  const reservation = await agent.reserveDirectCodexMessage({ threadId, text: "Never accepted.", requestedAt });

  let caught: unknown;
  try {
    await sendWorkerMessage({
      store,
      codexClient: {
        sendMessage: async () => { throw new StaleWorkerOperationError(threadId); }
      }
    } as never, threadId, "Never accepted.");
  } catch (error) {
    caught = error;
    await agent.rollbackDirectCodexMessage(threadId, requestedAt, reservation);
  }

  assert.ok(caught instanceof StaleWorkerOperationError);
  assert.equal(agent.getShellSnapshot().supervision.callbacks.length, 0);
  agent.dispose();
});

test("startup drops a pre-send callback reservation with no Worker activity", async () => {
  const store = await createStore();
  const sessionDir = await mkdtemp(path.join(tmpdir(), "manor-direct-codex-phantom-"));
  const threadId = "thread-phantom-callback";
  store.upsertThreadSummary({ id: threadId, status: "idle", cwd: "/workspace", turns: [{ id: "turn-old", status: "completed", items: [] }] });
  const requestedAt = Date.now() - 10 * 60_000;
  const agent = createButlerAgent(store, sessionDir, {
    getConnectionState: () => ({ compose: { availableModels: [] } }),
    loadThread: async () => { throw new Error("provider session is unavailable after restart"); }
  });
  await agent.reserveDirectCodexMessage({ threadId, text: "Never sent.", requestedAt });

  await (agent as unknown as { reconcilePendingChatCallbacks(): Promise<void> }).reconcilePendingChatCallbacks();

  assert.equal(agent.getShellSnapshot().supervision.callbacks.length, 0);
  agent.dispose();
});

test("startup promotes only the exact accepted direct-message dispatch", async () => {
  const store = await createStore();
  const sessionDir = await mkdtemp(path.join(tmpdir(), "manor-direct-codex-accepted-"));
  const threadId = "thread-accepted-callback";
  const requestedAt = Date.now() - 1_000;
  store.upsertThreadSummary({
    id: threadId,
    status: "active",
    cwd: "/workspace",
    turns: [{
      id: "turn-direct",
      status: "started",
      items: [
        { id: "user-old", type: "userMessage", text: "Earlier request." },
        { id: "user-direct", type: "userMessage", text: `Run it.\n${directWorkerDispatchMarker(threadId, requestedAt)}` }
      ]
    }]
  });
  const agent = createButlerAgent(store, sessionDir, {
    getConnectionState: () => ({ compose: { availableModels: [] } }),
    loadThread: async () => { throw new Error("provider session is unavailable after restart"); }
  });
  await agent.reserveDirectCodexMessage({ threadId, text: "Run it.", requestedAt });

  await (agent as unknown as { reconcilePendingChatCallbacks(): Promise<void> }).reconcilePendingChatCallbacks();

  assert.equal(agent.getShellSnapshot().supervision.callbacks[0]?.dispatchState, "ready");
  agent.dispose();
});

test("an unconfirmed reservation ignores unrelated Worker activity during recovery", async () => {
  const store = await createStore();
  const sessionDir = await mkdtemp(path.join(tmpdir(), "manor-direct-codex-unconfirmed-"));
  const threadId = "thread-unconfirmed-callback";
  const requestedAt = Date.now() - 1_000;
  store.upsertThreadSummary({ id: threadId, status: "idle", cwd: "/workspace", turns: [{ id: "turn-unrelated", status: "completed", items: [{ id: "reply", type: "agentMessage", text: "Unrelated work completed.", at: Date.now() }] }] });
  store.recordWorkerReport(threadId, { turnId: "turn-unrelated", status: "completed", summary: "Unrelated work.", details: null });
  const agent = createButlerAgent(store, sessionDir, {
    getConnectionState: () => ({ compose: { availableModels: [] } }),
    loadThread: async () => undefined
  });
  await agent.reserveDirectCodexMessage({ threadId, text: "This was never sent.", requestedAt });

  await (agent as unknown as { reconcilePendingChatCallbacks(): Promise<void> }).reconcilePendingChatCallbacks();

  const callback = agent.getShellSnapshot().supervision.callbacks[0];
  assert.equal(callback?.dispatchState, "reserving");
  assert.equal(callback?.callbackState, "waiting");
  assert.equal(callback?.reviewState, "idle");
  agent.dispose();
});

test("a persisted closeout message reconciles its callback without posting twice", async () => {
  const store = await createStore();
  const sessionDir = await mkdtemp(path.join(tmpdir(), "manor-direct-codex-closeout-recovery-"));
  const threadId = "thread-closeout-recovery";
  store.upsertThreadSummary({
    id: threadId,
    status: "idle",
    cwd: "/workspace",
    turns: [{ id: "turn-1", status: "completed", items: [] }]
  });
  const agent = createButlerAgent(store, sessionDir);
  const internals = agent as unknown as {
    operatorMessages: Array<{ id: string; role: string; text: string; at: number; taskDurationMs: null; kind: "message" }>;
    operatorSink: { onOperatorReply(input: unknown): void } | null;
    postOperatorJobReply(threadId: string, text: string): Promise<void>;
    pendingChatCallbacks: Map<string, ButlerThreadCallbackView>;
  };
  await agent.notifyDirectCodexMessage({ threadId, text: "Finish it.", requestedAt: 1 });
  internals.operatorMessages.push({ id: `callback-fallback-${threadId}:turn-1`, role: "assistant", text: "Already posted.", at: 2, taskDurationMs: null, kind: "message" });
  let reposts = 0;
  internals.operatorSink = { onOperatorReply: () => { reposts += 1; } };

  await internals.postOperatorJobReply(threadId, "Do not repost this.");

  assert.equal(reposts, 0);
  assert.equal(internals.pendingChatCallbacks.get(threadId)?.operatorCloseoutStatus, "posted");
  assert.equal(internals.pendingChatCallbacks.get(threadId)?.owesOperatorReply, false);
  agent.dispose();
});

test("restart reconciliation closes a delivered callback before queuing recovery", async () => {
  const store = await createStore();
  const sessionDir = await mkdtemp(path.join(tmpdir(), "manor-direct-codex-delivered-recovery-"));
  const threadId = "thread-delivered-recovery";
  store.upsertThreadSummary({
    id: threadId,
    status: "idle",
    cwd: "/workspace",
    turns: [{
      id: "turn-1",
      status: "completed",
      items: [{ id: "reply", type: "agentMessage", status: "completed", text: "Finished." }]
    }]
  });
  const agent = createButlerAgent(store, sessionDir, {
    getConnectionState: () => ({ compose: { availableModels: [] } }),
    loadThread: async () => undefined
  });
  await agent.notifyDirectCodexMessage({ threadId, text: "Finish it.", requestedAt: 10 });
  const internals = agent as unknown as {
    operatorMessages: Array<{ id: string; role: string; text: string; at: number; taskDurationMs: null; kind: "message" }>;
    pendingChatCallbacks: Map<string, ButlerThreadCallbackView>;
    reconcilePendingChatCallbacks(): Promise<void>;
  };
  internals.operatorMessages.push({
    id: `callback-${threadId}:turn-1`,
    role: "assistant",
    text: "Already delivered.",
    at: 51,
    taskDurationMs: null,
    kind: "message"
  });
  Object.assign(internals.pendingChatCallbacks.get(threadId)!, {
    callbackState: "missing_worker_callback",
    reviewState: "queued",
    reviewReason: "thread_recovery"
  });

  await internals.reconcilePendingChatCallbacks();

  const callback = internals.pendingChatCallbacks.get(threadId);
  assert.equal(callback?.callbackState, "closed");
  assert.equal(callback?.operatorCloseoutStatus, "posted");
  assert.equal(callback?.owesOperatorReply, false);
  assert.equal(callback?.reviewState, "idle");
  assert.equal(internals.operatorMessages.filter((message) => message.id === `callback-${threadId}:turn-1`).length, 1);
  agent.dispose();
});

test("startup does not rearm a delivered latest Worker turn", async () => {
  const store = await createStore();
  const sessionDir = await mkdtemp(path.join(tmpdir(), "manor-direct-codex-delivered-latest-"));
  const threadId = "thread-delivered-latest";
  store.upsertThreadSummary({ id: threadId, status: "idle", cwd: "/workspace", turns: [{ id: "turn-1", status: "completed", items: [] }] });
  const agent = createButlerAgent(store, sessionDir);
  const internals = agent as unknown as {
    deliveredCloseoutIds: Set<string>;
    pendingChatCallbacks: Map<string, ButlerThreadCallbackView>;
  };
  internals.deliveredCloseoutIds.add(`${threadId}:turn-1`);

  await agent.ensureExternalWorkerDelegation(threadId);

  assert.equal(internals.pendingChatCallbacks.size, 0);
  agent.dispose();
});

test("startup rearms when Worker has a newer undelivered turn", async () => {
  const store = await createStore();
  const sessionDir = await mkdtemp(path.join(tmpdir(), "manor-direct-codex-undelivered-latest-"));
  const threadId = "thread-undelivered-latest";
  store.upsertThreadSummary({
    id: threadId,
    status: "idle",
    cwd: "/workspace",
    turns: [
      { id: "turn-1", status: "completed", items: [] },
      { id: "turn-2", status: "completed", items: [] }
    ]
  });
  const agent = createButlerAgent(store, sessionDir);
  const internals = agent as unknown as {
    deliveredCloseoutIds: Set<string>;
    pendingChatCallbacks: Map<string, ButlerThreadCallbackView>;
  };
  internals.deliveredCloseoutIds.add(`${threadId}:turn-1`);

  await agent.ensureExternalWorkerDelegation(threadId);

  assert.equal(internals.pendingChatCallbacks.get(threadId)?.owesOperatorReply, true);
  agent.dispose();
});

test("background callback review failures stay out of Butler chat errors", async () => {
  const store = await createStore();
  const sessionDir = await mkdtemp(path.join(tmpdir(), "manor-background-review-error-"));
  const agent = createButlerAgent(store, sessionDir);
  const internals = agent as unknown as {
    lastError: string | null;
    processCallbackReviews(): Promise<void>;
    callbackReviewScheduler: { schedule(): void };
  };
  let releaseAttempt!: () => void;
  const attempted = new Promise<void>((resolve) => { releaseAttempt = resolve; });
  internals.processCallbackReviews = async () => {
    releaseAttempt();
    throw new Error("Isolated Butler supervision timed out.");
  };

  internals.callbackReviewScheduler.schedule();
  await attempted;
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(agent.getShellSnapshot().lastError, null);

  internals.lastError = "Foreground Butler failure.";
  let releaseSecondAttempt!: () => void;
  const secondAttempted = new Promise<void>((resolve) => { releaseSecondAttempt = resolve; });
  internals.processCallbackReviews = async () => {
    releaseSecondAttempt();
    throw new Error("Background provider failed.");
  };
  internals.callbackReviewScheduler.schedule();
  await secondAttempted;
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(agent.getShellSnapshot().lastError, "Foreground Butler failure.");
  agent.dispose();
});

test("startup keeps a closed historical callback closed until newer Worker activity", async () => {
  const store = await createStore();
  const sessionDir = await mkdtemp(path.join(tmpdir(), "manor-direct-codex-closed-"));
  const threadId = "thread-closed-callback";
  store.upsertThreadSummary({ id: threadId, status: { type: "idle" }, cwd: "/workspace", turns: [{ id: "turn-1", status: "completed", items: [] }] });
  const agent = createButlerAgent(store, sessionDir);
  await agent.notifyDirectCodexMessage({ threadId, text: "Initial work.", imageReferenceIds: [], fileReferenceIds: [], inputItems: [] });
  const internals = agent as unknown as { pendingChatCallbacks: Map<string, ButlerThreadCallbackView> };
  const closed = internals.pendingChatCallbacks.get(threadId)!;
  const closedAt = Date.now();
  Object.assign(closed, { callbackState: "closed", operatorCloseoutStatus: "posted", owesOperatorReply: false, closedAt, updatedAt: closedAt });

  await agent.ensureExternalWorkerDelegation(threadId);
  assert.equal(internals.pendingChatCallbacks.get(threadId), closed);

  store.getThread(threadId)!.turns.push({ id: "turn-2", requestedReasoningEffort: null, status: "started", error: null, startedAt: closedAt + 1, completedAt: null, items: [] });
  await agent.ensureExternalWorkerDelegation(threadId);
  assert.notEqual(internals.pendingChatCallbacks.get(threadId), closed);
  assert.equal(internals.pendingChatCallbacks.get(threadId)?.owesOperatorReply, true);
});

test("operator history normalization hides persisted direct Codex prompts", () => {
  const threadId = "019ecad3-eb87-7ea1-ac1e-85351742d80f";
  const requestedAt = Date.parse("2026-06-15T13:05:43.530Z");
  const messages = [
    {
      id: `operator-direct-${threadId}-${requestedAt}`,
      role: "user",
      text: "Please follow up on the numbered tags in the attached annotated preview screenshot.",
      at: requestedAt,
      taskDurationMs: null,
      kind: "message" as const
    },
    {
      id: `callback-${threadId}:turn-1`,
      role: "assistant",
      text: "Done",
      at: Date.parse("2026-06-15T13:08:11.713Z"),
      taskDurationMs: null,
      kind: "message" as const
    }
  ];

  const changed = normalizeOperatorMessages(messages);

  assert.equal(changed, true);
  assert.deepEqual(messages.map((message) => message.text), ["Done"]);
  assert.equal(messages[0]?.at, requestedAt + 1);
});

test("direct Codex callback recovery uses worker reply item time instead of refreshed thread update time", async () => {
  const store = await createStore();
  const sessionDir = await mkdtemp(path.join(tmpdir(), "manor-direct-codex-session-"));
  const threadId = "thread-direct-fallback";
  const requestedAt = Date.parse("2026-06-16T18:36:29.743Z");
  const replyAt = Date.parse("2026-06-16T18:36:51.474Z");
  const refreshedAt = Date.parse("2026-06-16T18:56:54.852Z");
  const originalNow = Date.now;
  Date.now = () => requestedAt;

  try {
    store.upsertThreadSummary({
      id: threadId,
      status: { type: "active" },
      cwd: "/workspace",
      turns: [{ id: "turn-0", status: "completed", items: [] }]
    });

    const refreshedThread = () => ({
      id: threadId,
      status: { type: "idle" },
      cwd: "/workspace",
      updatedAt: refreshedAt / 1000,
      turns: [
        {
          id: "turn-1",
          status: "completed",
          items: [
            {
              id: "item-user",
              type: "userMessage",
              status: "completed",
              text: "Run a website preview",
              at: requestedAt
            },
            {
              id: "item-agent",
              type: "agentMessage",
              status: "completed",
              text: "Preview is running.",
              at: replyAt
            }
          ]
        }
      ]
    });

    const agent = createButlerAgent(store, sessionDir, {
      getConnectionState: () => ({
        compose: {
          availableModels: []
        }
      }),
      loadThread: async () => {
        store.upsertThreadSummary(refreshedThread());
      }
    });

    await agent.notifyDirectCodexMessage({
      threadId,
      text: "Run a website preview",
      imageReferenceIds: [],
      fileReferenceIds: [],
      inputItems: []
    });

    Date.now = () => replyAt;
    store.upsertThreadSummary(refreshedThread());

    Date.now = () => refreshedAt;
    await (agent as unknown as { reconcilePendingChatCallbacks(): Promise<void> }).reconcilePendingChatCallbacks();

    const callback = agent.getShellSnapshot().supervision.callbacks.find((entry) => entry.threadId === threadId);
    assert.equal(callback?.callbackState, "missing_worker_callback");
    assert.equal(callback?.reviewState, "queued");
    assert.equal(callback?.reviewReason, "thread_recovery");

    const liveCallback = (agent as unknown as {
      pendingChatCallbacks: Map<string, { reviewState: string; reviewReason: string | null }>;
    }).pendingChatCallbacks.get(threadId);
    assert.ok(liveCallback);
    liveCallback.reviewState = "running";
    liveCallback.reviewReason = "thread_recovery";

    Date.now = () => refreshedAt + 1000;
    await (agent as unknown as { reconcilePendingChatCallbacks(): Promise<void> }).reconcilePendingChatCallbacks();

    assert.equal(liveCallback.reviewState, "running");
    assert.equal(liveCallback.reviewReason, "thread_recovery");
  } finally {
    Date.now = originalNow;
  }
});

test("completed direct-reply callbacks queue adversarial review before closeout", async () => {
  const store = await createStore();
  const sessionDir = await mkdtemp(path.join(tmpdir(), "manor-direct-codex-session-"));
  const threadId = "thread-gated-closeout";
  const requestedAt = 1_000;
  const reportAt = 2_000;
  const originalNow = Date.now;
  Date.now = () => requestedAt;

  try {
    store.upsertThreadSummary({
      id: threadId,
      status: "idle",
      cwd: "/workspace",
      turns: [{ id: "turn-1", status: "completed", items: [] }]
    });
    const contract = buildThreadExecutionContract({
      threadId,
      workspaceCwd: "/workspace",
      projectId: "project-1",
      projectLabel: "Project One",
      branch: "main",
      taskText: "Ship supervised code with review.",
      notes: []
    });
    store.setThreadExecutionContract(threadId, {
      ...contract,
      orchestration: {
        taskClass: "generic_code",
        confidence: 0.9,
        questionSet: [],
        goalRecommendation: { mode: "none", goal: null, fallbackReason: null },
        reviewRecommendation: { target: "adversarial_review", required: true, reason: "test review" },
        subAgentRoles: [],
        riskLevel: "medium",
        fallbackReason: null,
        createdAt: requestedAt
      },
      reviewResults: []
    });
    Date.now = () => reportAt;
    const report = store.recordWorkerReport(threadId, {
      turnId: "turn-1",
      status: "completed",
      summary: "Done.",
      details: "All work completed.",
      claims: {
        version: 1,
        changedWorkSummary: "Completed the supervised change.",
        claims: [
          {
            claimId: "claim-1",
            status: "completed",
            summary: "Implemented the requested behavior.",
            evidencePointer: "unit test",
            proofId: null,
            riskNote: null,
            reviewerTarget: "qa"
          }
        ],
        risks: [],
        unresolvedItems: [],
        subAgentSummaries: []
      }
    });
    for (const item of store.getSupervisionChecklist(threadId)?.items ?? []) {
      store.reviewAcceptancePoint({ threadId, pointId: item.id, status: "accepted" });
    }
    store.recordWorkerReviewResults(threadId, [
      {
        id: "review-failed",
        reviewSource: "adversarial_review",
        turnId: report.turnId,
        reportUpdatedAt: report.updatedAt,
        severity: "high",
        findingSummary: "Codex review automation failed.",
        blocking: true,
        waived: false,
        waiverReason: null,
        automationFailure: true,
        linkedClaimIds: ["claim-1"],
        modelProvider: "openai-codex",
        modelId: "gpt-5.5",
        reasoningLevel: "high",
        createdAt: reportAt,
        updatedAt: reportAt
      }
    ]);

    const agent = createButlerAgent(store, sessionDir);
    const internals = agent as unknown as {
      registerPendingChatCallback(threadId: string, options?: { nextWorkerReportAction?: "review" | "reply_to_operator"; requestedAt?: number }): Promise<void>;
      processPendingChatCallbacks(): Promise<boolean>;
      pendingChatCallbacks: Map<string, ButlerThreadCallbackView>;
    };
    await internals.registerPendingChatCallback(threadId, { nextWorkerReportAction: "reply_to_operator", requestedAt });

    Date.now = () => reportAt + 1;
    assert.equal(await internals.processPendingChatCallbacks(), true);
    const callback = internals.pendingChatCallbacks.get(threadId);
    assert.equal(callback?.callbackState, "received_worker_callback");
    assert.equal(callback?.operatorCloseoutStatus, "owed");
    assert.equal(callback?.reviewState, "queued");
    assert.equal(callback?.blockedCloseoutReason ?? null, null);
    assert.equal(store.getThread(threadId)?.eventLog.filter((event) => event.method === "butler.closeout.gated").length, 0);

    Date.now = () => reportAt + 2;
    assert.equal(await internals.processPendingChatCallbacks(), false);
    assert.equal(callback?.callbackState, "received_worker_callback");
    assert.equal(store.getThread(threadId)?.eventLog.filter((event) => event.method === "butler.closeout.gated").length, 0);

    if (!callback) throw new Error("callback missing");
    callback.reviewState = "blocked";
    callback.blockedCloseoutReason = "Adversarial review paused after 3 failed attempts: provider unavailable";
    callback.blockedCloseoutReportAt = report.updatedAt;
    assert.equal(await internals.processPendingChatCallbacks(), false);
    assert.equal(callback.reviewState, "blocked");
    assert.match(callback.blockedCloseoutReason ?? "", /paused after 3 failed attempts/);

    callback.reviewState = "blocked";
    callback.blockedCloseoutReason = "Adversarial review must finish before Butler can close the job.";
    callback.blockedCloseoutReportAt = report.updatedAt;
    assert.equal(await internals.processPendingChatCallbacks(), true);
    assert.equal(callback.reviewState, "queued");
  } finally {
    Date.now = originalNow;
  }
});

test("direct Codex transcript backfill keeps operator anchors private", async () => {
  const codexHome = await mkdtemp(path.join(tmpdir(), "manor-direct-codex-home-"));
  const threadId = "019ecad3-eb87-7ea1-ac1e-85351742d80f";
  const sessionDir = path.join(codexHome, "sessions", "2026", "06", "15");
  await mkdir(sessionDir, { recursive: true });
  await writeFile(
    path.join(sessionDir, `rollout-2026-06-15T10-29-06-${threadId}.jsonl`),
    [
      JSON.stringify({ timestamp: "2026-06-15T10:29:08.000Z", type: "event_msg", payload: { type: "user_message", message: "We're going to build a simple todo app. I put the job details in Manor for this thread. Use manor-harness --thread thread-1 payload current to read the latest details." } }),
      JSON.stringify({ timestamp: "2026-06-15T13:05:43.000Z", type: "event_msg", payload: { type: "task_started", turn_id: "turn-1" } }),
      JSON.stringify({ timestamp: "2026-06-15T13:05:43.530Z", type: "event_msg", payload: { type: "user_message", message: "Use this illustration instead" } }),
      JSON.stringify({ timestamp: "2026-06-15T13:31:42.157Z", type: "event_msg", payload: { type: "user_message", message: "Please confirm if local storage holds the todos. I updated the job payload. Use manor-harness --thread thread-1 payload current to read the latest details." } })
    ].join("\n"),
    "utf8"
  );
  const messages = [{
    id: `callback-${threadId}:turn-1`,
    role: "assistant",
    text: "Done",
    at: Date.parse("2026-06-15T13:08:11.713Z"),
    taskDurationMs: null,
    kind: "message" as const
  }];

  const changed = await backfillDirectCodexMessagesFromSessionFiles(messages, codexHome);

  assert.equal(changed, true);
  assert.deepEqual(messages.map((message) => message.text), ["Done"]);
  assert.equal(messages[0]?.at, Date.parse("2026-06-15T13:05:43.530Z") + 1);
});

test("direct Codex transcript backfill pairs callbacks by worker turn", async () => {
  const codexHome = await mkdtemp(path.join(tmpdir(), "manor-direct-codex-home-"));
  const threadId = "019ecad3-eb87-7ea1-ac1e-85351742d80f";
  const sessionDir = path.join(codexHome, "sessions", "2026", "06", "15");
  await mkdir(sessionDir, { recursive: true });
  await writeFile(
    path.join(sessionDir, `rollout-2026-06-15T10-29-06-${threadId}.jsonl`),
    [
      JSON.stringify({ timestamp: "2026-06-15T12:00:00.000Z", type: "event_msg", payload: { type: "task_started", turn_id: "turn-one" } }),
      JSON.stringify({ timestamp: "2026-06-15T12:00:00.500Z", type: "event_msg", payload: { type: "user_message", message: "First direct request" } }),
      JSON.stringify({ timestamp: "2026-06-15T13:00:00.000Z", type: "event_msg", payload: { type: "task_started", turn_id: "turn-two" } }),
      JSON.stringify({ timestamp: "2026-06-15T13:00:00.500Z", type: "event_msg", payload: { type: "user_message", message: "Second direct request" } })
    ].join("\n"),
    "utf8"
  );
  const messages = [
    {
      id: `callback-${threadId}:turn-one`,
      role: "assistant",
      text: "First response",
      at: Date.parse("2026-06-15T12:02:00.000Z"),
      taskDurationMs: null,
      kind: "message" as const
    },
    {
      id: `callback-${threadId}:turn-two`,
      role: "assistant",
      text: "Second response",
      at: Date.parse("2026-06-15T12:00:00.501Z"),
      taskDurationMs: null,
      kind: "message" as const
    }
  ];

  const changed = await backfillDirectCodexMessagesFromSessionFiles(messages, codexHome);

  assert.equal(changed, true);
  assert.deepEqual(messages.map((message) => message.text), ["First response", "Second response"]);
  assert.equal(messages[0]?.at, Date.parse("2026-06-15T12:00:00.500Z") + 1);
});

test("direct Codex transcript backfill pairs hidden follow-up callbacks to prior visible request", async () => {
  const codexHome = await mkdtemp(path.join(tmpdir(), "manor-direct-codex-home-"));
  const threadId = "019ecad3-eb87-7ea1-ac1e-85351742d80f";
  const sessionDir = path.join(codexHome, "sessions", "2026", "06", "15");
  await mkdir(sessionDir, { recursive: true });
  await writeFile(
    path.join(sessionDir, `rollout-2026-06-15T10-29-06-${threadId}.jsonl`),
    [
      JSON.stringify({ timestamp: "2026-06-15T13:00:00.000Z", type: "event_msg", payload: { type: "task_started", turn_id: "operator-turn" } }),
      JSON.stringify({ timestamp: "2026-06-15T13:00:00.500Z", type: "event_msg", payload: { type: "user_message", message: "Fix the visual treatment" } }),
      JSON.stringify({ timestamp: "2026-06-15T13:05:00.000Z", type: "event_msg", payload: { type: "task_started", turn_id: "hidden-follow-up-turn" } }),
      JSON.stringify({ timestamp: "2026-06-15T13:05:00.500Z", type: "event_msg", payload: { type: "user_message", message: "I updated the job details in Manor. Please read the latest payload and continue from there." } })
    ].join("\n"),
    "utf8"
  );
  const messages = [{
    id: `callback-${threadId}:hidden-follow-up-turn`,
    role: "assistant",
    text: "Hidden follow-up response",
    at: Date.parse("2026-06-15T14:00:00.000Z"),
    taskDurationMs: null,
    kind: "message" as const
  }];

  const changed = await backfillDirectCodexMessagesFromSessionFiles(messages, codexHome);

  assert.equal(changed, true);
  assert.deepEqual(messages.map((message) => message.text), ["Hidden follow-up response"]);
  assert.equal(messages[0]?.at, Date.parse("2026-06-15T13:00:00.500Z") + 1);
});

test("delegated worker instructions define provider-neutral memory and shell boundaries", async () => {
  const store = await createStore();
  const sessionDir = await mkdtemp(path.join(tmpdir(), "manor-direct-codex-session-"));
  const agent = createButlerAgent(store, sessionDir) as unknown as {
    buildDelegationDeveloperInstructions(
      workspace: { cwd: string; branchName: string | null },
      task: string
    ): Promise<string>;
  };

  const instructions = await agent.buildDelegationDeveloperInstructions(
    { cwd: "/workspace", branchName: null },
    "Continue the prior follow-up."
  );

  assert.match(instructions, /Read memory with `manor-harness memory search/);
  assert.match(instructions, /follow-up/);
  assert.match(instructions, /requires attribution before saying who did what/);
  assert.match(instructions, /Skip memory reads for clearly self-contained mechanical work/);
  assert.match(instructions, /Write memory only when it will help a future worker/);
  assert.match(instructions, /Do not write routine progress/);
  assert.match(instructions, /worker shell/);
  assert.match(instructions, /pipe the actual commands and their output into Markdown while the work runs/);
  assert.match(instructions, /do not reconstruct a transcript afterward/);
  assert.doesNotMatch(instructions, /strict JSON claims/);
  assert.doesNotMatch(instructions, /Codex worker|Codex-shell/);
});
