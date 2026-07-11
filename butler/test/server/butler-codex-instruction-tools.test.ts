import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { buildButlerCodexTools } from "../../src/server/butler-agent-codex-tools.js";
import { buildJobPayload, updateJobPayload } from "../../src/server/job-instruction-artifacts.js";
import { ButlerStateStore } from "../../src/server/state-store.js";
import { buildThreadExecutionContract } from "../../src/server/thread-contract.js";
import type { ButlerAgentToolAccess } from "../../src/server/butler-agent-tool-access.js";
import type { JobPayloadView } from "../../src/server/job-payload-types.js";

async function createHarness(options: { attachedWorkerThreadId?: string | null } = {}) {
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
  const access = {
    defineButlerTool: (definition: unknown) => definition,
    getToolUiEffects: () => [],
    store,
    codexClient: {
      loadThread: async () => undefined,
      stopThread: async (_threadId: string) => {
        stopped.push(_threadId);
        store.upsertThreadSummary({ id: _threadId, status: "idle" });
        return true;
      },
      sendMessage: async (_threadId: string, input: unknown) => {
        sent.push(input);
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
      store.setThreadJobPayload(payload);
      payloads.push(payload);
      return payload;
    },
    getActiveOperatorThreadGuard: () => null,
    getWorkerDefaults: () => ({
      runtime: "auto",
      threadId: options.attachedWorkerThreadId === undefined ? threadId : options.attachedWorkerThreadId
    }),
    getThreadBudgetLimitMessage: () => null,
    bindJobPayloadDelivery: async (threadId: string) => store.getThreadJobPayload(threadId),
    registerPendingChatCallback: () => undefined,
    removeExternalWorkerDelegation: async (workerThreadId: string) => { removedCallbacks.push(workerThreadId); },
    noteThreadFocus: () => undefined
  } as unknown as ButlerAgentToolAccess;
  const tools = buildButlerCodexTools(access);
  return { store, threadId, sent, stopped, removedCallbacks, payloads, tools };
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

test("message_job updates the job payload and sends readable chat", async () => {
  const { threadId, sent, payloads, tools } = await createHarness();

  await tool(tools, "message_job").execute("call-1", {
    threadId,
    text: "Please retry the browser proof.",
    nextWorkerReportAction: "review"
  });

  assert.equal(payloads[0]?.kind, "steering");
  assert.match(JSON.stringify(sent[0]), /Please retry the browser proof/);
  assert.match(JSON.stringify(sent[0]), /I updated the job payload/);
  assert.doesNotMatch(JSON.stringify(sent[0]), /MANOR INSTRUCTION/);
});

test("rejected checklist flush updates payload and clears the queue", async () => {
  const { store, threadId, sent, payloads, tools } = await createHarness();
  store.reviewAcceptancePoint({
    threadId,
    pointId: "point-1",
    status: "rejected",
    nextInstruction: "Fix the first point with evidence."
  });

  await tool(tools, "flush_rejected_acceptance_points").execute("call-1", { threadId });

  assert.equal(payloads[0]?.kind, "rejection_followup");
  assert.match(String(sent[0]), /checklist items/);
  assert.equal(store.buildQueuedRejectionInstruction(threadId), null);
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
