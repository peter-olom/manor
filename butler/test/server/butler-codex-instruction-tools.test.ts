import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { ActivityWatchdogService } from "../../src/server/activity-watchdog.js";
import { buildCallbackReviewPrompt } from "../../src/server/butler-agent-helpers.js";
import { buildButlerCodexTools } from "../../src/server/butler-agent-codex-tools.js";
import { buildButlerDelegationTools } from "../../src/server/butler-agent-stack-preview-tools.js";
import { runWithCallbackReviewGuard } from "../../src/server/butler-job-mutation-guard.js";
import { buildJobPayload, updateJobPayload } from "../../src/server/job-instruction-artifacts.js";
import { discardSelfImprovementRequest } from "../../src/server/self-improvement-actions.js";
import { configureSelfImprovementRequestState, SelfImprovementRequestState } from "../../src/server/self-improvement-request-state.js";
import { ButlerStateStore } from "../../src/server/state-store.js";
import { buildThreadExecutionContract } from "../../src/server/thread-contract.js";
import type { ButlerAgentToolAccess } from "../../src/server/butler-agent-tool-access.js";
import type { JobPayloadView } from "../../src/server/job-payload-types.js";

async function createHarness(options: { attachedWorkerThreadId?: string | null; activeImageReferenceIds?: string[]; activeFileReferenceIds?: string[]; activeOperatorRequestText?: string; settleDuringSend?: boolean; dispatchError?: Error; stopError?: Error; bindError?: Error; budgetLimitMessage?: string; sendDelayMs?: number } = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), "manor-codex-instruction-tools-"));
  const store = new ButlerStateStore(path.join(dir, "state.json"));
  await store.load();
  const threadId = "thread-tools";
  store.upsertThreadSummary({
    id: threadId,
    cwd: "/workspace",
    source: "codex",
    status: "active",
    turns: [{ id: "turn-1", status: "completed", items: [] }]
  });
  const contract = buildThreadExecutionContract({
    threadId,
    workspaceCwd: "/workspace",
    projectId: "project",
    projectLabel: "Project",
    branch: "main",
    taskText: "- First point\n- Second point",
    notes: []
  });
  store.setThreadExecutionContract(threadId, contract);
  const sent: unknown[] = [];
  const started: string[] = [];
  const stopped: string[] = [];
  const removedCallbacks: string[] = [];
  const closedCallbacks: string[] = [];
  const payloads: JobPayloadView[] = [];
  const callbackDispatches: Array<{ requestedAt: number; turnId: string | null }> = [];
  const reservedInputs: Parameters<ButlerAgentToolAccess["reserveDirectCodexMessage"]>[0][] = [];
  const dispatchOrder: string[] = [];
  let activeSends = 0;
  let maxConcurrentSends = 0;
  let workspacePreparations = 0;
  const watchdogs = new ActivityWatchdogService();
  const access = {
    defineButlerTool: (definition: unknown) => definition,
    getToolUiEffects: () => [],
    store,
    watchdogs,
    piRpcWorkerClient: {
      loadThread: async () => undefined,
      stopThread: async (_threadId: string) => {
        stopped.push(_threadId);
        if (options.stopError) throw options.stopError;
        store.upsertThreadSummary({ id: _threadId, status: "idle" });
        return true;
      },
      sendMessage: async (_threadId: string, input: unknown) => {
        dispatchOrder.push("send");
        sent.push(input);
        activeSends += 1;
        maxConcurrentSends = Math.max(maxConcurrentSends, activeSends);
        try {
          if (options.sendDelayMs) await new Promise((resolve) => setTimeout(resolve, options.sendDelayMs));
          if (options.settleDuringSend) store.upsertThreadSummary({ id: _threadId, status: "idle", turns: [{ id: "turn-sent", status: "interrupted", startedAt: 500, completedAt: Date.now(), items: [] }] });
          if (options.dispatchError) throw options.dispatchError;
          return { threadId: _threadId, turnId: "turn-sent" };
        } finally {
          activeSends -= 1;
        }
      },
      startThread: async () => {
        started.push("unexpected");
        throw new Error("A second Worker should not start.");
      }
    },
    imageStore: { resolveViews: () => [], getFilePath: () => null },
    fileStore: { resolveViews: () => [], getFilePath: () => null },
    createOrUpdateJobPayload: async (input: Parameters<ButlerAgentToolAccess["createOrUpdateJobPayload"]>[0]) => {
      const thread = store.getThread(input.threadId);
      const existing = store.getThreadJobPayload(input.threadId);
      const payload = existing
        ? updateJobPayload(existing, {
            ...input,
            contract: thread?.executionContract ?? null,
            checklist: thread?.supervisionChecklist ?? null
          })
        : buildJobPayload({
            ...input,
            contract: thread?.executionContract ?? null,
            checklist: thread?.supervisionChecklist ?? null
          });
      input.onPrepared?.(structuredClone(payload));
      store.setThreadJobPayload(payload);
      payloads.push(payload);
      return payload;
    },
    getActiveOperatorThreadGuard: () => options.activeOperatorRequestText ? ({
      explicitThreadIds: [],
      lockedThreadId: threadId,
      contextPrompt: null,
      operatorRequestText: options.activeOperatorRequestText
    }) : null,
    getActiveOperatorReferences: () => ({
      imageReferenceIds: options.activeImageReferenceIds ?? [],
      fileReferenceIds: options.activeFileReferenceIds ?? []
    }),
    getWorkerDefaults: () => ({
      runtime: "auto",
      threadId: options.attachedWorkerThreadId === undefined ? threadId : options.attachedWorkerThreadId
    }),
    getThreadBudgetLimitMessage: (workerThreadId: string) => {
      if (options.budgetLimitMessage) return options.budgetLimitMessage;
      const supervision = store.getThreadSupervision(workerThreadId);
      return supervision.capReached ? "Worker supervision budget is exhausted." : null;
    },
    prepareDelegationWorkspace: async (_task: string, cwd?: string) => {
      workspacePreparations += 1;
      return { cwd: cwd ?? "/workspace", branchName: null };
    },
    bindJobPayloadDelivery: async (threadId: string) => {
      if (options.bindError) throw options.bindError;
      return store.getThreadJobPayload(threadId);
    },
    reserveDirectCodexMessage: async (input) => {
      reservedInputs.push(input);
      dispatchOrder.push("reserve");
      const thread = store.getThread(threadId);
      return {
        callback: null,
        failureCount: null,
        notBefore: null,
        jobPayload: thread?.jobPayload ?? null,
        jobPayloadReplacement: null,
        executionContract: thread?.executionContract ? structuredClone(thread.executionContract) : null,
        supervisionChecklist: thread?.supervisionChecklist ? structuredClone(thread.supervisionChecklist) : null,
        reviewScopeReplacement: null
      };
    },
    markPendingChatCallbackDispatched: async (_threadId: string, requestedAt: number, turnId: string | null) => { dispatchOrder.push("mark"); callbackDispatches.push({ requestedAt, turnId }); },
    rollbackDirectCodexMessage: async (_threadId: string, _requestedAt: number, reservation: Awaited<ReturnType<ButlerAgentToolAccess["reserveDirectCodexMessage"]>>) => {
      dispatchOrder.push("rollback");
      const currentPayload = store.getThreadJobPayload(_threadId);
      const current = store.getThread(_threadId);
      const comparableChecklist = (checklist: typeof current.supervisionChecklist) => checklist ? { ...checklist, updatedAt: 0, heartbeat: { ...checklist.heartbeat, lastThreadEventAt: null } } : null;
      const ownsPayload = !reservation.jobPayloadReplacement || [reservation.jobPayloadReplacement, reservation.jobPayload].some((candidate) => JSON.stringify(currentPayload) === JSON.stringify(candidate));
      const ownsScope = !reservation.reviewScopeReplacement || JSON.stringify(current?.executionContract ?? null) === JSON.stringify(reservation.reviewScopeReplacement.executionContract) && JSON.stringify(comparableChecklist(current?.supervisionChecklist)) === JSON.stringify(comparableChecklist(reservation.reviewScopeReplacement.supervisionChecklist));
      if (reservation.jobPayloadReplacement && ownsPayload && ownsScope) {
        if (reservation.jobPayload) store.setThreadJobPayload(reservation.jobPayload);
        else store.clearThreadJobPayload(_threadId);
      }
      if (reservation.reviewScopeReplacement && ownsPayload && ownsScope) store.restoreThreadReviewScope(_threadId, reservation.executionContract, reservation.supervisionChecklist);
    },
    registerPendingChatCallback: () => undefined,
    closeExternalWorkerDelegation: async (workerThreadId: string) => { closedCallbacks.push(workerThreadId); },
    removeExternalWorkerDelegation: async (workerThreadId: string) => { removedCallbacks.push(workerThreadId); },
    noteThreadFocus: () => undefined
  } as unknown as ButlerAgentToolAccess;
  const tools = buildButlerCodexTools(access);
  return { access, store, threadId, sent, started, stopped, closedCallbacks, removedCallbacks, payloads, callbackDispatches, reservedInputs, dispatchOrder, tools, watchdogs, maxConcurrentSends: () => maxConcurrentSends, workspacePreparations: () => workspacePreparations };
}

async function createReadySelfImprovementState(threadId: string) {
  const dir = await mkdtemp(path.join(tmpdir(), "manor-self-improvement-continuation-"));
  let failNextChange = false;
  const state = new SelfImprovementRequestState(path.join(dir, "requests.json"), () => {
    if (failNextChange) {
      failNextChange = false;
      throw new Error("self-improvement save failed");
    }
  }, () => undefined);
  await state.load();
  const request = state.create({
    trigger: "Test the current Manor fix.",
    symptoms: "The restart needs another test.",
    logs: "",
    observations: "The existing Worker already owns the checkout.",
    suspectedCause: "The follow-up was routed as a new delegation.",
    proposedChange: "Continue the attached Worker.",
    risk: "Low.",
    createdBy: "operator"
  });
  const ready = state.update(request.id, {
    status: "changes_ready",
    threadId,
    workerThreadIds: [threadId],
    workspaceCwd: "/workspace",
    startedAt: 1,
    completedAt: 2
  });
  await state.flush();
  configureSelfImprovementRequestState(state);
  return { state, request: ready, failNextSave: () => { failNextChange = true; } };
}

async function resetSelfImprovementRequestState() {
  const dir = await mkdtemp(path.join(tmpdir(), "manor-self-improvement-reset-"));
  const state = new SelfImprovementRequestState(path.join(dir, "requests.json"), () => undefined, () => undefined);
  await state.load();
  configureSelfImprovementRequestState(state);
}

test("message_job cannot steer a Worker attached to another Butler session", async () => {
  const { threadId, sent, tools } = await createHarness({ attachedWorkerThreadId: null });
  const accessTool = tool(tools, "message_job");

  await assert.rejects(
    () => accessTool.execute("call-cross-session", {
      threadId,
      text: "Reuse this idle Worker for an unrelated session.",
      reviewScope: "preserve"
    }),
    /another Butler session/
  );
  assert.equal(sent.length, 0);
});

test("delegate_to_worker reuses the Worker already attached to the Butler session", async () => {
  const { access, store, threadId, sent, started } = await createHarness();
  const delegationTools = buildButlerDelegationTools(access);
  const followUp = "Investigate the failed restart and keep testing the existing changes.";
  const result = await tool(delegationTools, "delegate_to_worker").execute("call-reuse", {
    task: followUp,
    cwd: "/workspace"
  }) as { content: Array<{ text: string }>; details: { threadId: string; reusedWorker: boolean } };

  assert.equal(started.length, 0);
  assert.equal(sent.length, 1);
  assert.equal(result.details.threadId, threadId);
  assert.equal(result.details.reusedWorker, true);
  assert.deepEqual(store.getSupervisionChecklist(threadId)?.items.map((item) => item.text), [followUp.slice(0, -1)]);
  assert.match(result.content[0]?.text ?? "", /no second Worker was started/);
});

test("delegate_to_worker refuses a different workspace without starting another Worker", async () => {
  const { access, sent, started } = await createHarness();
  const delegationTools = buildButlerDelegationTools(access);

  await assert.rejects(() => tool(delegationTools, "delegate_to_worker").execute("call-other-workspace", {
    task: "Start unrelated work.",
    cwd: "/other-workspace"
  }), /Use Switch worker for an explicit handoff/);

  assert.equal(started.length, 0);
  assert.equal(sent.length, 0);
});

test("delegate_to_worker preserves a supervision-budget block instead of claiming continuation", async () => {
  const limit = "Worker supervision budget is exhausted.";
  const { access, sent, started } = await createHarness({ budgetLimitMessage: limit });
  const result = await tool(buildButlerDelegationTools(access), "delegate_to_worker").execute("call-budget", {
    task: "Keep testing the current changes.",
    cwd: "/workspace"
  }) as { content: Array<{ text: string }>; details: { dispatched: boolean } };

  assert.equal(result.content[0]?.text, limit);
  assert.equal(result.details.dispatched, false);
  assert.equal(started.length, 0);
  assert.equal(sent.length, 0);
});

test("attached Worker delegation rejects isolated work before workspace preparation", async () => {
  const { access, sent, started, workspacePreparations } = await createHarness();

  await assert.rejects(() => tool(buildButlerDelegationTools(access), "delegate_to_worker").execute("call-isolated", {
    task: "Use an isolated worktree for this change.",
    cwd: "/workspace"
  }), /Switch worker for an explicit handoff/);

  assert.equal(workspacePreparations(), 0);
  assert.equal(started.length, 0);
  assert.equal(sent.length, 0);
});

test("concurrent attached Worker delegations serialize their complete sends", async () => {
  const { access, sent, started, maxConcurrentSends } = await createHarness({ sendDelayMs: 20 });
  const delegation = tool(buildButlerDelegationTools(access), "delegate_to_worker");

  await Promise.all([
    delegation.execute("call-concurrent-1", { task: "Run the first follow-up.", cwd: "/workspace" }),
    delegation.execute("call-concurrent-2", { task: "Run the second follow-up.", cwd: "/workspace" })
  ]);

  assert.equal(maxConcurrentSends(), 1);
  assert.equal(sent.length, 2);
  assert.equal(started.length, 0);
});

function tool(tools: unknown[], name: string) {
  return tools.find((entry) => (entry as { name?: string }).name === name) as {
    execute: (id: string, params: Record<string, unknown>) => Promise<unknown>;
  };
}

test("batch acceptance review records several explicit decisions atomically", async () => {
  const { store, threadId, tools } = await createHarness();

  const result = await tool(tools, "review_acceptance_points").execute("call-batch", {
    threadId,
    decisions: [
      { pointId: "point-1", status: "accepted", note: "Build evidence is convincing." },
      { pointId: "point-2", status: "waived", note: "The operator explicitly waived this point." }
    ]
  }) as { content: Array<{ text: string }> };

  const checklist = store.getSupervisionChecklist(threadId);
  assert.equal(result.content[0]?.text, "Recorded 2 acceptance-point decisions. Checklist is reviewed.");
  assert.deepEqual(checklist?.items.map((item) => item.status), ["accepted", "waived"]);
  assert.deepEqual(checklist?.items.map((item) => item.butlerNote), [
    "Build evidence is convincing.",
    "The operator explicitly waived this point."
  ]);
  assert.ok(checklist?.items.every((item) => item.evidence.at(-1)?.source === "butler_review"));
  assert.deepEqual(
    store.getThread(threadId)?.executionContract?.verificationMatrix.map((row) => row.status),
    ["accepted", "waived"]
  );
});

test("batch acceptance review leaves every point unchanged when one decision is invalid", async () => {
  const { store, threadId, tools } = await createHarness();
  const before = structuredClone(store.getSupervisionChecklist(threadId));

  await assert.rejects(
    () => tool(tools, "review_acceptance_points").execute("call-invalid-batch", {
      threadId,
      decisions: [
        { pointId: "point-1", status: "accepted", note: "Would otherwise pass." },
        { pointId: "point-missing", status: "accepted", note: "Unknown point." }
      ]
    }),
    /Unknown acceptance point point-missing/
  );

  assert.deepEqual(store.getSupervisionChecklist(threadId), before);
});

test("batch acceptance review rejects duplicate point decisions without mutation", async () => {
  const { store, threadId, tools } = await createHarness();
  const before = structuredClone(store.getSupervisionChecklist(threadId));

  await assert.rejects(
    () => tool(tools, "review_acceptance_points").execute("call-duplicate-batch", {
      threadId,
      decisions: [
        { pointId: "point-1", status: "accepted" },
        { pointId: "point-1", status: "waived" }
      ]
    }),
    /cannot decide the same acceptance point twice/
  );

  assert.deepEqual(store.getSupervisionChecklist(threadId), before);
});

test("batch acceptance review requires rejection steering before mutating any point", async () => {
  const { store, threadId, tools } = await createHarness();
  const before = structuredClone(store.getSupervisionChecklist(threadId));

  await assert.rejects(
    () => tool(tools, "review_acceptance_points").execute("call-rejected-batch", {
      threadId,
      decisions: [
        { pointId: "point-1", status: "accepted" },
        { pointId: "point-2", status: "rejected", note: "Proof is incomplete." }
      ]
    }),
    /Rejected acceptance points require nextInstruction/
  );

  assert.deepEqual(store.getSupervisionChecklist(threadId), before);
});

test("message_job updates the job payload and sends readable chat", async () => {
  const operatorRequestText = "See if you and the Worker have here.now egress.";
  const { store, threadId, sent, payloads, reservedInputs, tools } = await createHarness({
    activeImageReferenceIds: ["image-current-turn"],
    activeFileReferenceIds: ["file-current-turn"],
    activeOperatorRequestText: operatorRequestText
  });

  await tool(tools, "message_job").execute("call-1", {
    threadId,
    text: "Please retry the browser proof.",
    imageReferenceIds: [],
    fileReferenceIds: ["file-explicit"],
    reviewScope: "preserve",
    nextWorkerReportAction: "review"
  });

  assert.equal(payloads[0]?.kind, "steering");
  assert.deepEqual(payloads[0]?.attachments.images, ["image-current-turn"]);
  assert.deepEqual(payloads[0]?.attachments.files, ["file-current-turn", "file-explicit"]);
  assert.match(JSON.stringify(sent[0]), /Please retry the browser proof/);
  assert.match(JSON.stringify(sent[0]), /I updated the job payload/);
  assert.doesNotMatch(JSON.stringify(sent[0]), /MANOR INSTRUCTION/);
  assert.equal(reservedInputs[0]?.operatorRequestText, operatorRequestText);
  assert.equal(store.getThreadSupervision(threadId).butlerTurnsUsed, 1);

  await tool(tools, "message_job").execute("call-direct-reply", {
    threadId,
    text: "Return this result directly to the operator.",
    reviewScope: "preserve",
    nextWorkerReportAction: "reply_to_operator"
  });
  assert.equal(store.getThreadSupervision(threadId).butlerTurnsUsed, 2);
});

test("continuing a self-improvement Worker reactivates its tracked request", async () => {
  const { threadId, tools } = await createHarness();
  const { state, request } = await createReadySelfImprovementState(threadId);

  await tool(tools, "message_job").execute("call-self-improvement", {
    threadId,
    text: "Retry the restart verification.",
    reviewScope: "preserve"
  });

  assert.equal(state.get(request.id)?.status, "running");
  assert.equal(state.get(request.id)?.completedAt, null);
  await resetSelfImprovementRequestState();
});

test("a definitely rejected self-improvement continuation restores changes-ready state", async () => {
  const { threadId, tools } = await createHarness({ dispatchError: new Error("send rejected") });
  const { state, request } = await createReadySelfImprovementState(threadId);

  await assert.rejects(() => tool(tools, "message_job").execute("call-self-improvement-failed", {
    threadId,
    text: "Retry the restart verification.",
    reviewScope: "preserve"
  }), /send rejected/);

  assert.equal(state.get(request.id)?.status, "changes_ready");
  assert.equal(state.get(request.id)?.completedAt, 2);
  await resetSelfImprovementRequestState();
});

test("an ambiguously accepted self-improvement continuation stays running", async () => {
  const dispatchError = new Error("Worker message send timed out; stopping the uncertain turn.");
  dispatchError.name = "WorkerSendTimeoutError";
  const { threadId, tools } = await createHarness({
    dispatchError,
    stopError: new Error("interrupt transport unavailable")
  });
  const { state, request } = await createReadySelfImprovementState(threadId);

  await assert.rejects(() => tool(tools, "message_job").execute("call-self-improvement-ambiguous", {
    threadId,
    text: "Retry the restart verification.",
    reviewScope: "preserve"
  }), /timed out/);

  assert.equal(state.get(request.id)?.status, "running");
  assert.equal(state.get(request.id)?.completedAt, null);
  await resetSelfImprovementRequestState();
});

test("a self-improvement continuation stays running after post-dispatch persistence failure", async () => {
  const { store, threadId, sent, tools } = await createHarness({ bindError: new Error("payload binding failed") });
  const { state, request } = await createReadySelfImprovementState(threadId);

  await assert.rejects(() => tool(tools, "message_job").execute("call-self-improvement-bind-failed", {
    threadId,
    text: "Retry the restart verification.",
    reviewScope: "preserve"
  }), /payload binding failed/);

  assert.equal(sent.length, 1);
  assert.equal(store.getThreadSupervision(threadId).butlerTurnsUsed, 1);
  assert.equal(state.get(request.id)?.status, "running");
  assert.equal(state.get(request.id)?.completedAt, null);
  await resetSelfImprovementRequestState();
});

test("a failed self-improvement reactivation save rolls back before dispatch", async () => {
  const { threadId, sent, tools } = await createHarness();
  const { state, request, failNextSave } = await createReadySelfImprovementState(threadId);
  failNextSave();

  await assert.rejects(() => tool(tools, "message_job").execute("call-self-improvement-save-failed", {
    threadId,
    text: "Retry the restart verification.",
    reviewScope: "preserve"
  }), /self-improvement save failed/);

  assert.equal(sent.length, 0);
  assert.equal(state.get(request.id)?.status, "changes_ready");
  assert.equal(state.get(request.id)?.completedAt, 2);
  await resetSelfImprovementRequestState();
});

test("published self-improvement sessions reject further Worker mutation", async () => {
  const { threadId, sent, tools } = await createHarness();
  const { state, request } = await createReadySelfImprovementState(threadId);
  state.update(request.id, { status: "committed", commitSha: "a".repeat(40) });
  await state.flush();

  await assert.rejects(() => tool(tools, "message_job").execute("call-self-improvement-published", {
    threadId,
    text: "Make another change.",
    reviewScope: "preserve"
  }), /already been published/);

  assert.equal(sent.length, 0);
  assert.equal(state.get(request.id)?.status, "committed");
  await resetSelfImprovementRequestState();
});

test("concurrent self-improvement continuation and close cannot deadlock", async () => {
  const { access, threadId, tools } = await createHarness({ sendDelayMs: 20 });
  const { state, request } = await createReadySelfImprovementState(threadId);
  const continuation = tool(tools, "message_job").execute("call-self-improvement-concurrent", {
    threadId,
    text: "Retry the restart verification.",
    reviewScope: "preserve"
  });
  const close = discardSelfImprovementRequest(state, access, request.id);

  await Promise.race([
    Promise.all([continuation, close]),
    new Promise((_, reject) => setTimeout(() => reject(new Error("concurrent continuation and close deadlocked")), 1_000))
  ]);

  assert.equal(state.get(request.id)?.status, "discarded");
  await resetSelfImprovementRequestState();
});

test("message_job replace scope replaces stale rejected scope before building its payload", async () => {
  const { store, threadId, payloads, tools } = await createHarness();
  store.reviewAcceptancePoint({
    threadId,
    pointId: "point-1",
    status: "rejected",
    nextInstruction: "Retry the old bootstrap point."
  });

  await tool(tools, "message_job").execute("call-refresh", {
    threadId,
    text: "- Second point\n- Implement passwordless authentication\n- Add capability overrides",
    reviewScope: "replace"
  });

  assert.deepEqual(
    store.getSupervisionChecklist(threadId)?.items.map((item) => item.text),
    ["Second point", "Implement passwordless authentication", "Add capability overrides"]
  );
  const payload = payloads[0];
  assert.equal(payload?.requestedTask, "- Second point - Implement passwordless authentication - Add capability overrides");
  assert.deepEqual(payload?.checklist.map((item) => item.text), ["Second point", "Implement passwordless authentication", "Add capability overrides"]);
  const executionContract = payload?.executionContract as {
    requestedTask?: string;
    acceptancePoints?: string[];
    verificationMatrix?: Array<{ acceptancePointId: string }>;
    mission?: { intent?: string };
  };
  assert.equal(executionContract.requestedTask, payload?.requestedTask);
  assert.deepEqual(executionContract.acceptancePoints, payload?.checklist.map((item) => item.text));
  assert.deepEqual(executionContract.verificationMatrix?.map((row) => row.acceptancePointId), ["point-1", "point-2", "point-3"]);
  assert.match(executionContract.mission?.intent ?? "", /passwordless authentication/);
  assert.doesNotMatch(JSON.stringify(executionContract), /First point/);
});

test("message_job preserve scope keeps the existing review contract", async () => {
  const { store, threadId, payloads, tools } = await createHarness();
  const before = store.getThread(threadId)?.executionContract;

  await tool(tools, "message_job").execute("call-no-refresh", {
    threadId,
    text: "Clarify how to verify the first point.",
    reviewScope: "preserve"
  });

  assert.deepEqual(store.getThread(threadId)?.executionContract, before);
  assert.equal((payloads[0]?.executionContract as { requestedTask?: string })?.requestedTask, before?.requestedTask);
  assert.deepEqual(payloads[0]?.checklist.map((item) => item.text), before?.acceptancePoints);
});

test("message_job explicitly replaces a completed review scope for a new follow-up", async () => {
  const operatorRequestText = "See if you and the Worker have here.now egress.";
  const { store, threadId, payloads, reservedInputs, tools } = await createHarness({ activeOperatorRequestText: operatorRequestText });
  for (const item of store.getSupervisionChecklist(threadId)?.items ?? []) {
    store.reviewAcceptancePoint({ threadId, pointId: item.id, status: "accepted", note: "Original work is complete." });
  }

  await tool(tools, "message_job").execute("call-implicit-refresh", {
    threadId,
    text: "Check here.now reachability from the Worker shell and report the exact HTTP result.",
    reviewScope: "replace"
  });

  const contract = store.getThread(threadId)?.executionContract;
  assert.equal(contract?.requestedTask, "Check here.now reachability from the Worker shell and report the exact HTTP result.");
  assert.deepEqual(contract?.acceptancePoints, ["Check here.now reachability from the Worker shell and report the exact HTTP result"]);
  assert.doesNotMatch(JSON.stringify(payloads[0]), /First point|Second point/);
  assert.equal(reservedInputs[0]?.operatorRequestText, operatorRequestText);

  store.recordWorkerReport(threadId, {
    turnId: "turn-egress",
    status: "completed",
    summary: "Worker can reach here.now.",
    details: "HTTP 200 and proxy CONNECT succeeded."
  });
  const prompt = buildCallbackReviewPrompt(store, {
    threadId,
    callbackState: "received_worker_callback",
    resolutionState: "received_worker_callback",
    requestedAt: 1,
    operatorRequestText,
    lastEventAt: Date.now(),
    lastWorkerStatusSeen: "idle",
    lastTerminalReportAt: Date.now(),
    lastPrivateSteerText: "Check here.now reachability from the Worker shell and report the exact HTTP result.",
    lastPrivateSteerAt: 2,
    nextWorkerReportAction: "review",
    operatorCloseoutStatus: "owed",
    owesOperatorReply: true,
    closeoutChannel: "none",
    reviewState: "queued",
    reviewReason: "worker_callback",
    closedAt: null,
    updatedAt: Date.now()
  });
  assert.match(prompt, /Governing Worker review scope/);
  assert.match(prompt, /Structured supervision checklist/);
  assert.doesNotMatch(prompt, /Original job context \(background only\)|First point|Second point/);
});

test("message_job reserves its callback before a steered turn can settle", async () => {
  const { callbackDispatches, dispatchOrder, store, threadId, tools } = await createHarness({ settleDuringSend: true });

  await tool(tools, "message_job").execute("call-race", { threadId, text: "Finish the document.", reviewScope: "preserve" });

  assert.deepEqual(dispatchOrder, ["reserve", "send", "mark"]);
  assert.equal(callbackDispatches[0]?.turnId, "turn-sent");
  assert.equal(store.getThread(threadId)?.status, "idle");
});

test("message_job preserves supervision when a timed-out dispatch may have been accepted", async () => {
  const dispatchError = new Error("Worker message send timed out; stopping the uncertain turn.");
  dispatchError.name = "WorkerSendTimeoutError";
  const { callbackDispatches, dispatchOrder, store, threadId, tools } = await createHarness({
    dispatchError,
    stopError: new Error("interrupt transport unavailable")
  });

  await assert.rejects(() => tool(tools, "message_job").execute("call-ambiguous", { threadId, text: "Finish the document.", reviewScope: "preserve" }), /timed out/);

  assert.deepEqual(dispatchOrder, ["reserve", "send", "mark"]);
  assert.equal(callbackDispatches[0]?.turnId, null);
  assert.equal(store.getThreadSupervision(threadId).butlerTurnsUsed, 1);
});

test("failed refreshed follow-up restores the prior review scope and payload", async () => {
  const { store, threadId, dispatchOrder, tools } = await createHarness({ dispatchError: new Error("send failed") });
  const priorContract = structuredClone(store.getThread(threadId)?.executionContract ?? null);
  const priorChecklist = structuredClone(store.getSupervisionChecklist(threadId));

  await assert.rejects(() => tool(tools, "message_job").execute("call-refresh-failure", {
    threadId,
    text: "- Replace the old scope\n- Verify the replacement",
    reviewScope: "replace"
  }), /send failed/);

  assert.deepEqual(store.getThread(threadId)?.executionContract, priorContract);
  assert.equal(store.getSupervisionChecklist(threadId)?.requestedTask, priorChecklist?.requestedTask);
  assert.deepEqual(store.getSupervisionChecklist(threadId)?.items, priorChecklist?.items);
  assert.equal(store.getSupervisionChecklist(threadId)?.reviewState, priorChecklist?.reviewState);
  assert.equal(store.getThreadJobPayload(threadId), null);
  assert.deepEqual(dispatchOrder, ["reserve", "send", "rollback"]);
});

test("message_job rejects an omitted review scope before dispatch", async () => {
  const { threadId, dispatchOrder, tools } = await createHarness();
  await assert.rejects(() => tool(tools, "message_job").execute("call-missing-scope", {
    threadId,
    text: "Check here.now reachability."
  }), /explicit reviewScope/);
  assert.deepEqual(dispatchOrder, []);
});

test("rejected checklist flush updates payload and clears the queue", async () => {
  const { store, threadId, sent, payloads, tools, watchdogs } = await createHarness();
  store.reviewAcceptancePoint({
    threadId,
    pointId: "point-1",
    status: "rejected",
    nextInstruction: "Fix the first point with evidence."
  });

  await runWithCallbackReviewGuard(
    { threadId, isCurrent: () => true },
    () => tool(tools, "flush_rejected_acceptance_points").execute("call-1", { threadId })
  );

  assert.equal(payloads[0]?.kind, "rejection_followup");
  assert.match(String(sent[0]), /checklist items/);
  assert.equal(store.buildQueuedRejectionInstruction(threadId), null);
  assert.equal(watchdogs.size, 0);
  assert.equal(store.getThreadSupervision(threadId).butlerTurnsUsed, 1);
});

test("an ambiguously accepted rejection follow-up spends one reviewed turn", async () => {
  const dispatchError = new Error("Worker message send timed out; stopping the uncertain turn.");
  dispatchError.name = "WorkerSendTimeoutError";
  const { store, threadId, tools } = await createHarness({
    dispatchError,
    stopError: new Error("interrupt transport unavailable")
  });
  store.reviewAcceptancePoint({
    threadId,
    pointId: "point-1",
    status: "rejected",
    nextInstruction: "Fix the first point with evidence."
  });

  await assert.rejects(
    () => runWithCallbackReviewGuard(
      { threadId, isCurrent: () => true },
      () => tool(tools, "flush_rejected_acceptance_points").execute("call-ambiguous-rejection", { threadId })
    ),
    /timed out/
  );

  assert.equal(store.getThreadSupervision(threadId).butlerTurnsUsed, 1);
});

test("a rejection follow-up spends one reviewed turn before delivery persistence", async () => {
  const { store, threadId, tools } = await createHarness({ bindError: new Error("payload binding failed") });
  store.reviewAcceptancePoint({
    threadId,
    pointId: "point-1",
    status: "rejected",
    nextInstruction: "Fix the first point with evidence."
  });

  await assert.rejects(
    () => runWithCallbackReviewGuard(
      { threadId, isCurrent: () => true },
      () => tool(tools, "flush_rejected_acceptance_points").execute("call-bind-failed-rejection", { threadId })
    ),
    /payload binding failed/
  );

  assert.equal(store.getThreadSupervision(threadId).butlerTurnsUsed, 1);
});

test("hold_job_context persists held context in the payload without sending a turn", async () => {
  const { store, threadId, sent, payloads, tools } = await createHarness();
  store.upsertThreadSummary({
    id: threadId,
    cwd: "/workspace",
    source: "codex",
    status: { type: "active" },
    turns: [{ id: "turn-active", status: "started", items: [] }]
  });

  await tool(tools, "hold_job_context").execute("call-1", {
    threadId,
    text: "Wait for the current run, then apply this operator correction."
  });

  assert.equal(payloads[0]?.kind, "held_context");
  assert.equal(sent.length, 0);
});

test("stop_job immediately stops the Worker and closes its pending callback", async () => {
  const { threadId, stopped, closedCallbacks, removedCallbacks, tools } = await createHarness();
  const definition = tools.find((entry) => entry.name === "stop_job");
  assert.match(definition?.promptSnippet ?? "", /operator says stop, cancel, interrupt, or pause/);

  const result = await tool(tools, "stop_job").execute("call-stop", { threadId });

  assert.deepEqual(stopped, [threadId]);
  assert.deepEqual(closedCallbacks, [threadId]);
  assert.deepEqual(removedCallbacks, []);
  assert.match(JSON.stringify(result), /Stopped job thread-tools/);
});

test("a capped attached Worker cannot be deleted to obtain a fresh budget", async () => {
  const { store, threadId, tools } = await createHarness();
  store.setThreadSupervisionLimit(threadId, 1);
  store.noteReviewedWorkerDispatch(threadId);

  await assert.rejects(
    () => tool(tools, "delete_job").execute("call-delete-capped", { threadId }),
    /Deleting it would bypass that limit/
  );
  assert.ok(store.getThread(threadId));
});

test("partial delete all removes Butler callbacks only for deleted Workers", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "manor-codex-delete-all-partial-"));
  const store = new ButlerStateStore(path.join(dir, "state.json"));
  for (const threadId of ["pi-a", "pi-b"]) {
    store.upsertThreadSummary({ id: threadId, source: "pi-rpc", status: "idle", cwd: "/workspace", turns: [] });
  }
  const removedCallbacks: string[] = [];
  const deleteCalls: string[] = [];
  const tools = buildButlerCodexTools({
    defineButlerTool: (definition) => definition,
    getToolUiEffects: () => [],
    store,
    piRpcWorkerClient: {
      deleteThread: async (threadId: string) => {
        deleteCalls.push(threadId);
        if (deleteCalls.length === 1) {
          store.removeThread(threadId);
          return true;
        }
        return false;
      }
    },
    removeExternalWorkerDelegation: async (threadId: string) => { removedCallbacks.push(threadId); }
  } as never);

  await assert.rejects(() => tool(tools, "delete_all_jobs").execute("call-1", {}), /could not be deleted/);
  assert.deepEqual(removedCallbacks, [deleteCalls[0]]);
  assert.ok(store.getThread(deleteCalls[1]!));
});

test("single delete removes Butler callback when baseline cleanup fails", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "manor-codex-delete-cleanup-failure-"));
  const store = new ButlerStateStore(path.join(dir, "state.json"));
  const threadId = "codex-delete";
  store.upsertThreadSummary({ id: threadId, source: "pi-rpc", status: "idle", cwd: "/workspace", turns: [] });
  store.setThreadExecutionContract(threadId, {
    ...buildThreadExecutionContract({ threadId, workspaceCwd: "/workspace", projectId: "project", projectLabel: "Project", branch: null, taskText: "Work", taskCategory: "generic_code", inferredWorkDepth: "standard", notes: [] }),
    reviewBaselineObjectDir: path.join(dir, "baseline-delete", "objects")
  });
  const removedCallbacks: string[] = [];
  const tools = buildButlerCodexTools({
    defineButlerTool: (definition) => definition,
    getToolUiEffects: () => [],
    store,
    piRpcWorkerClient: { deleteThread: async () => { store.removeThread(threadId); return { deletedArtifacts: 0 }; } },
    cleanupReviewBaseline: async () => { throw new Error("cleanup failed"); },
    removeExternalWorkerDelegation: async (deletedThreadId: string) => { removedCallbacks.push(deletedThreadId); }
  } as never);

  await tool(tools, "delete_job").execute("call-1", { threadId });
  assert.deepEqual(removedCallbacks, [threadId]);
  assert.equal(store.getThread(threadId), undefined);
});
