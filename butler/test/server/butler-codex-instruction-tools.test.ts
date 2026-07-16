import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { ActivityWatchdogService } from "../../src/server/activity-watchdog.js";
import { buildButlerCodexTools } from "../../src/server/butler-agent-codex-tools.js";
import { runWithCallbackReviewGuard } from "../../src/server/butler-job-mutation-guard.js";
import { buildJobPayload, updateJobPayload } from "../../src/server/job-instruction-artifacts.js";
import { ButlerStateStore } from "../../src/server/state-store.js";
import { buildThreadExecutionContract } from "../../src/server/thread-contract.js";
import type { ButlerAgentToolAccess } from "../../src/server/butler-agent-tool-access.js";
import type { JobPayloadView } from "../../src/server/job-payload-types.js";

async function createHarness(options: { attachedWorkerThreadId?: string | null; activeImageReferenceIds?: string[]; activeFileReferenceIds?: string[]; settleDuringSend?: boolean; dispatchError?: Error; stopError?: Error } = {}) {
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
  const stopped: string[] = [];
  const removedCallbacks: string[] = [];
  const payloads: JobPayloadView[] = [];
  const callbackDispatches: Array<{ requestedAt: number; turnId: string | null }> = [];
  const dispatchOrder: string[] = [];
  const watchdogs = new ActivityWatchdogService();
  const access = {
    defineButlerTool: (definition: unknown) => definition,
    getToolUiEffects: () => [],
    store,
    watchdogs,
    codexClient: {
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
        if (options.settleDuringSend) store.upsertThreadSummary({ id: _threadId, status: "idle", turns: [{ id: "turn-sent", status: "interrupted", startedAt: 500, completedAt: Date.now(), items: [] }] });
        if (options.dispatchError) throw options.dispatchError;
        return { threadId: _threadId, turnId: "turn-sent" };
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
    getActiveOperatorThreadGuard: () => null,
    getActiveOperatorReferences: () => ({
      imageReferenceIds: options.activeImageReferenceIds ?? [],
      fileReferenceIds: options.activeFileReferenceIds ?? []
    }),
    getWorkerDefaults: () => ({
      runtime: "auto",
      threadId: options.attachedWorkerThreadId === undefined ? threadId : options.attachedWorkerThreadId
    }),
    getThreadBudgetLimitMessage: () => null,
    bindJobPayloadDelivery: async (threadId: string) => store.getThreadJobPayload(threadId),
    reserveDirectCodexMessage: async () => {
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
    removeExternalWorkerDelegation: async (workerThreadId: string) => { removedCallbacks.push(workerThreadId); },
    noteThreadFocus: () => undefined
  } as unknown as ButlerAgentToolAccess;
  const tools = buildButlerCodexTools(access);
  return { store, threadId, sent, stopped, removedCallbacks, payloads, callbackDispatches, dispatchOrder, tools, watchdogs };
}

test("message_job cannot steer a Worker attached to another Butler session", async () => {
  const { threadId, sent, tools } = await createHarness({ attachedWorkerThreadId: null });
  const accessTool = tool(tools, "message_job");

  await assert.rejects(
    () => accessTool.execute("call-cross-session", {
      threadId,
      text: "Reuse this idle Worker for an unrelated session."
    }),
    /another Butler session/
  );
  assert.equal(sent.length, 0);
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
  const { threadId, sent, payloads, tools } = await createHarness({
    activeImageReferenceIds: ["image-current-turn"],
    activeFileReferenceIds: ["file-current-turn"]
  });

  await tool(tools, "message_job").execute("call-1", {
    threadId,
    text: "Please retry the browser proof.",
    imageReferenceIds: [],
    fileReferenceIds: ["file-explicit"],
    nextWorkerReportAction: "review"
  });

  assert.equal(payloads[0]?.kind, "steering");
  assert.deepEqual(payloads[0]?.attachments.images, ["image-current-turn"]);
  assert.deepEqual(payloads[0]?.attachments.files, ["file-current-turn", "file-explicit"]);
  assert.match(JSON.stringify(sent[0]), /Please retry the browser proof/);
  assert.match(JSON.stringify(sent[0]), /I updated the job payload/);
  assert.doesNotMatch(JSON.stringify(sent[0]), /MANOR INSTRUCTION/);
});

test("message_job forced refresh replaces stale rejected scope before building its payload", async () => {
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
    refreshChecklist: true
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

test("message_job without refresh keeps the existing review contract", async () => {
  const { store, threadId, payloads, tools } = await createHarness();
  const before = store.getThread(threadId)?.executionContract;

  await tool(tools, "message_job").execute("call-no-refresh", {
    threadId,
    text: "Clarify how to verify the first point."
  });

  assert.deepEqual(store.getThread(threadId)?.executionContract, before);
  assert.equal((payloads[0]?.executionContract as { requestedTask?: string })?.requestedTask, before?.requestedTask);
  assert.deepEqual(payloads[0]?.checklist.map((item) => item.text), before?.acceptancePoints);
});

test("message_job reserves its callback before a steered turn can settle", async () => {
  const { callbackDispatches, dispatchOrder, store, threadId, tools } = await createHarness({ settleDuringSend: true });

  await tool(tools, "message_job").execute("call-race", { threadId, text: "Finish the document." });

  assert.deepEqual(dispatchOrder, ["reserve", "send", "mark"]);
  assert.equal(callbackDispatches[0]?.turnId, "turn-sent");
  assert.equal(store.getThread(threadId)?.status, "idle");
});

test("message_job preserves supervision when a timed-out dispatch may have been accepted", async () => {
  const dispatchError = new Error("Worker message send timed out; stopping the uncertain turn.");
  dispatchError.name = "WorkerSendTimeoutError";
  const { callbackDispatches, dispatchOrder, threadId, tools } = await createHarness({
    dispatchError,
    stopError: new Error("interrupt transport unavailable")
  });

  await assert.rejects(() => tool(tools, "message_job").execute("call-ambiguous", { threadId, text: "Finish the document." }), /timed out/);

  assert.deepEqual(dispatchOrder, ["reserve", "send", "mark"]);
  assert.equal(callbackDispatches[0]?.turnId, null);
});

test("failed refreshed follow-up restores the prior review scope and payload", async () => {
  const { store, threadId, dispatchOrder, tools } = await createHarness({ dispatchError: new Error("send failed") });
  const priorContract = structuredClone(store.getThread(threadId)?.executionContract ?? null);
  const priorChecklist = structuredClone(store.getSupervisionChecklist(threadId));

  await assert.rejects(() => tool(tools, "message_job").execute("call-refresh-failure", {
    threadId,
    text: "- Replace the old scope\n- Verify the replacement",
    refreshChecklist: true
  }), /send failed/);

  assert.deepEqual(store.getThread(threadId)?.executionContract, priorContract);
  assert.equal(store.getSupervisionChecklist(threadId)?.requestedTask, priorChecklist?.requestedTask);
  assert.deepEqual(store.getSupervisionChecklist(threadId)?.items, priorChecklist?.items);
  assert.equal(store.getSupervisionChecklist(threadId)?.reviewState, priorChecklist?.reviewState);
  assert.equal(store.getThreadJobPayload(threadId), null);
  assert.deepEqual(dispatchOrder, ["reserve", "send", "rollback"]);
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

test("stop_job immediately stops the Worker and removes its pending callback", async () => {
  const { threadId, stopped, removedCallbacks, tools } = await createHarness();
  const definition = tools.find((entry) => entry.name === "stop_job");
  assert.match(definition?.promptSnippet ?? "", /operator says stop, cancel, interrupt, or pause/);

  const result = await tool(tools, "stop_job").execute("call-stop", { threadId });

  assert.deepEqual(stopped, [threadId]);
  assert.deepEqual(removedCallbacks, [threadId]);
  assert.match(JSON.stringify(result), /Stopped job thread-tools/);
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
    codexClient: { deleteAllThreads: async () => { throw new Error("Codex deletion should not run"); } },
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
  store.upsertThreadSummary({ id: threadId, source: "appServer", status: "idle", cwd: "/workspace", turns: [] });
  store.setThreadExecutionContract(threadId, {
    ...buildThreadExecutionContract({ threadId, workspaceCwd: "/workspace", projectId: "project", projectLabel: "Project", branch: null, taskText: "Work", taskCategory: "generic_code", inferredWorkDepth: "standard", notes: [] }),
    reviewBaselineObjectDir: path.join(dir, "baseline-delete", "objects")
  });
  const removedCallbacks: string[] = [];
  const tools = buildButlerCodexTools({
    defineButlerTool: (definition) => definition,
    getToolUiEffects: () => [],
    store,
    codexClient: { deleteThread: async () => { store.removeThread(threadId); return { deletedArtifacts: 0 }; } },
    cleanupReviewBaseline: async () => { throw new Error("cleanup failed"); },
    removeExternalWorkerDelegation: async (deletedThreadId: string) => { removedCallbacks.push(deletedThreadId); }
  } as never);

  await tool(tools, "delete_job").execute("call-1", { threadId });
  assert.deepEqual(removedCallbacks, [threadId]);
  assert.equal(store.getThread(threadId), undefined);
});
