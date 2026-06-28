import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { ButlerAgentService } from "../../src/server/butler-agent.js";
import { normalizeOperatorMessages } from "../../src/server/butler-operator-messages.js";
import { backfillDirectCodexMessagesFromSessionFiles, buildDirectCodexMessagePingSummary } from "../../src/server/direct-codex-message.js";
import { ButlerStateStore } from "../../src/server/state-store.js";
import { buildThreadExecutionContract } from "../../src/server/thread-contract.js";
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

test("automation-only review failure does not gate callback closeout", async () => {
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
        reviewRecommendation: { target: "codex_review", required: true, reason: "test review" },
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
        reviewSource: "codex_review",
        turnId: report.turnId,
        reportUpdatedAt: report.updatedAt,
        severity: "high",
        findingSummary: "Codex review automation failed.",
        blocking: true,
        waived: false,
        waiverReason: null,
        automationFailure: true,
        linkedClaimIds: ["claim-1"],
        createdAt: reportAt,
        updatedAt: reportAt
      }
    ]);

    const agent = createButlerAgent(store, sessionDir);
    const internals = agent as unknown as {
      registerPendingChatCallback(threadId: string, options?: { nextWorkerReportAction?: "review" | "reply_to_operator"; requestedAt?: number }): void;
      processPendingChatCallbacks(): Promise<boolean>;
      pendingChatCallbacks: Map<string, ButlerThreadCallbackView>;
    };
    internals.registerPendingChatCallback(threadId, { nextWorkerReportAction: "reply_to_operator", requestedAt });

    Date.now = () => reportAt + 1;
    assert.equal(await internals.processPendingChatCallbacks(), true);
    const callback = internals.pendingChatCallbacks.get(threadId);
    assert.equal(callback?.callbackState, "closed");
    assert.equal(callback?.operatorCloseoutStatus, "posted");
    assert.equal(callback?.reviewState, "idle");
    assert.equal(callback?.blockedCloseoutReason, null);
    assert.equal(store.getThread(threadId)?.eventLog.filter((event) => event.method === "butler.closeout.gated").length, 0);

    Date.now = () => reportAt + 2;
    assert.equal(await internals.processPendingChatCallbacks(), false);
    assert.equal(callback?.callbackState, "closed");
    assert.equal(store.getThread(threadId)?.eventLog.filter((event) => event.method === "butler.closeout.gated").length, 0);
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
      JSON.stringify({ timestamp: "2026-06-15T10:29:08.000Z", type: "event_msg", payload: { type: "user_message", message: "I put the job details in Manor for this thread. Please read them first, do the work, and report back through the harness." } }),
      JSON.stringify({ timestamp: "2026-06-15T13:05:43.000Z", type: "event_msg", payload: { type: "task_started", turn_id: "turn-1" } }),
      JSON.stringify({ timestamp: "2026-06-15T13:05:43.530Z", type: "event_msg", payload: { type: "user_message", message: "Use this illustration instead" } }),
      JSON.stringify({ timestamp: "2026-06-15T13:31:42.157Z", type: "event_msg", payload: { type: "user_message", message: "I updated the job details in Manor. Please read the latest payload and continue from there." } })
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

test("delegated Codex instructions define memory read and write boundaries", async () => {
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
});
