import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import {
  buildCallbackReviewPrompt,
  buildChatCallbackText,
  buildFallbackChatCallbackText,
  isCallbackOutstanding
} from "../../src/server/butler-agent-helpers.js";
import { ButlerStateStore } from "../../src/server/state-store.js";
import { buildThreadExecutionContract } from "../../src/server/thread-contract.js";
import type { ButlerThreadCallbackView, CodexThreadExecutionContractView } from "../../src/server/types.js";

async function createStore(): Promise<ButlerStateStore> {
  const dir = await mkdtemp(path.join(tmpdir(), "manor-butler-test-"));
  return new ButlerStateStore(path.join(dir, "state.json"));
}

function makeContract(overrides: Partial<CodexThreadExecutionContractView> = {}): CodexThreadExecutionContractView {
  return {
    threadId: "thread-1",
    workspaceCwd: "/workspace",
    projectId: "project-1",
    projectLabel: "Project One",
    branch: "main",
    requestedTask: "Verify the delegated flow with proof.",
    operatorGoal: "The operator gets one reliable closeout.",
    acceptancePoints: ["Acknowledge delegation", "Record callback", "Post closeout"],
    proofExpectation: "requested",
    proofExpectationLabel: "proof requested",
    notes: [],
    ...overrides
  };
}

test("execution contracts create a pending checklist with every acceptance point", async () => {
  const store = await createStore();
  const contract = makeContract();

  store.setThreadExecutionContract(contract.threadId, contract);

  const checklist = store.getSupervisionChecklist(contract.threadId);
  assert.ok(checklist);
  assert.equal(checklist.reviewState, "needs_review");
  assert.deepEqual(checklist.items.map((item) => item.text), contract.acceptancePoints);
  assert.deepEqual(checklist.items.map((item) => item.status), ["pending", "pending", "pending"]);
});

test("worker reports attach evidence without accepting checklist points", async () => {
  const store = await createStore();
  const contract = makeContract();
  store.upsertThreadSummary({
    id: contract.threadId,
    status: "idle",
    cwd: contract.workspaceCwd,
    turns: [{ id: "turn-1", status: "completed", items: [] }]
  });
  store.setThreadExecutionContract(contract.threadId, contract);

  const report = store.recordWorkerReport(contract.threadId, {
    turnId: "turn-1",
    status: "completed",
    summary: "All acceptance points are done.",
    details: "Proof bundle captured."
  });

  const checklist = store.getSupervisionChecklist(contract.threadId);
  assert.ok(checklist);
  assert.equal(report.status, "completed");
  assert.equal(checklist.reviewState, "needs_review");
  assert.deepEqual(checklist.items.map((item) => item.status), ["pending", "pending", "pending"]);
  assert.ok(checklist.items.every((item) => item.evidence.at(-1)?.summary === "All acceptance points are done."));
});

test("rejected checklist points require an instruction before worker follow-up", async () => {
  const store = await createStore();
  const contract = makeContract();
  store.setThreadExecutionContract(contract.threadId, contract);

  assert.throws(
    () => store.reviewAcceptancePoint({ threadId: contract.threadId, pointId: "point-1", status: "pending" }),
    /must accept, reject, or waive/
  );

  assert.throws(
    () => store.reviewAcceptancePoint({ threadId: contract.threadId, pointId: "point-1", status: "rejected" }),
    /Rejected acceptance points require nextInstruction/
  );
});

test("queued rejection follow-ups batch rejected points and clear after flush", async () => {
  const store = await createStore();
  const contract = makeContract();
  store.setThreadExecutionContract(contract.threadId, contract);

  store.reviewAcceptancePoint({
    threadId: contract.threadId,
    pointId: "point-1",
    status: "rejected",
    note: "No proof for acknowledgement.",
    nextInstruction: "Show the acknowledgement event."
  });
  store.reviewAcceptancePoint({
    threadId: contract.threadId,
    pointId: "point-2",
    status: "rejected",
    note: "Callback was not evidenced.",
    nextInstruction: "Show the callback event."
  });

  const instruction = store.buildQueuedRejectionInstruction(contract.threadId);
  assert.ok(instruction);
  assert.match(instruction, /BUTLER CHECKLIST REJECTION FOLLOW-UP/);
  assert.match(instruction, /Show the acknowledgement event/);
  assert.match(instruction, /Show the callback event/);

  store.clearQueuedRejectionInstructions(contract.threadId);
  assert.equal(store.buildQueuedRejectionInstruction(contract.threadId), null);
});

test("callback helper only treats owed non-closed callbacks as outstanding", () => {
  const base: ButlerThreadCallbackView = {
    threadId: "thread-1",
    callbackState: "waiting",
    resolutionState: null,
    requestedAt: 1,
    lastEventAt: 1,
    lastWorkerStatusSeen: "active",
    lastTerminalReportAt: null,
    lastPrivateSteerText: null,
    lastPrivateSteerAt: null,
    nextWorkerReportAction: "review",
    operatorCloseoutStatus: "owed",
    owesOperatorReply: true,
    closeoutChannel: "none",
    reviewState: "idle",
    reviewReason: null,
    closedAt: null,
    updatedAt: 1
  };

  assert.equal(isCallbackOutstanding(base), true);
  assert.equal(isCallbackOutstanding({ ...base, owesOperatorReply: false }), false);
  assert.equal(isCallbackOutstanding({ ...base, callbackState: "closed" }), false);
});

test("callback closeout text distinguishes complete, blocked, and recovered jobs", async () => {
  const store = await createStore();
  const contract = makeContract();
  store.upsertThreadSummary({
    id: contract.threadId,
    status: "idle",
    cwd: contract.workspaceCwd,
    turns: [
      {
        id: "turn-1",
        status: "completed",
        items: [
          { id: "item-1", type: "agentMessage", status: "completed", text: "The worker final answer.", at: Date.now(), raw: {} }
        ]
      }
    ]
  });
  store.setThreadExecutionContract(contract.threadId, contract);

  const completedReport = store.recordWorkerReport(contract.threadId, {
    turnId: "turn-1",
    status: "completed",
    summary: "Done.",
    details: "Evidence attached."
  });
  assert.match(buildChatCallbackText(store.getThread(contract.threadId), completedReport) ?? "", /Update on .+\./);
  assert.match(buildChatCallbackText(store.getThread(contract.threadId), completedReport) ?? "", /Evidence attached/);

  const blockedReport = store.recordWorkerReport(contract.threadId, {
    turnId: "turn-1",
    status: "blocked",
    summary: "Blocked.",
    details: "Needs a credential."
  });
  assert.match(buildChatCallbackText(store.getThread(contract.threadId), blockedReport) ?? "", /needs attention/);

  assert.match(
    buildFallbackChatCallbackText({
      status: "idle",
      supervisor: {
        projectLabel: "Project One",
        latestAgentReply: "The worker final answer."
      }
    } as ReturnType<ButlerStateStore["getThread"]>) ?? "",
    /I never got feedback from the worker/
  );
});

test("contract derivation preserves many explicit acceptance points for checklist review", () => {
  const taskText = Array.from({ length: 12 }, (_, index) => `${index + 1}. Acceptance point ${index + 1}`).join("\n");

  const contract = buildThreadExecutionContract({
    threadId: "thread-many",
    workspaceCwd: "/workspace",
    projectId: "project-1",
    projectLabel: "Project One",
    branch: null,
    taskText,
    requestedTask: "Review all listed acceptance points.",
    notes: []
  });

  assert.equal(contract.acceptancePoints.length, 12);
  assert.equal(contract.acceptancePoints[0], "Acceptance point 1");
  assert.equal(contract.acceptancePoints[11], "Acceptance point 12");
});

test("callback review prompt keeps proof-required jobs behind evidence review", async () => {
  const store = await createStore();
  const contract = makeContract({
    acceptancePoints: ["Capture browser proof", "Confirm closeout"],
    proofExpectation: "requested",
    proofExpectationLabel: "proof requested"
  });
  store.upsertThreadSummary({
    id: contract.threadId,
    status: "idle",
    cwd: contract.workspaceCwd,
    turns: [{ id: "turn-1", status: "completed", items: [] }]
  });
  store.setThreadExecutionContract(contract.threadId, contract);
  store.recordWorkerReport(contract.threadId, {
    turnId: "turn-1",
    status: "completed",
    summary: "Done.",
    details: "I checked it manually."
  });

  const prompt = buildCallbackReviewPrompt(store, {
    threadId: contract.threadId,
    callbackState: "received_worker_callback",
    resolutionState: null,
    requestedAt: 1,
    lastEventAt: Date.now(),
    lastWorkerStatusSeen: "idle",
    lastTerminalReportAt: Date.now(),
    lastPrivateSteerText: null,
    lastPrivateSteerAt: null,
    nextWorkerReportAction: "review",
    operatorCloseoutStatus: "owed",
    owesOperatorReply: true,
    closeoutChannel: "none",
    reviewState: "queued",
    reviewReason: "worker_callback",
    closedAt: null,
    updatedAt: Date.now()
  });

  assert.match(prompt, /Proof expectation: proof requested/);
  assert.match(prompt, /review_preview_proof/);
  assert.match(prompt, /If any acceptance point lacks convincing evidence/);
  assert.match(prompt, /Use reply_to_operator only when all acceptance points are accepted/);
});

test("thread snapshot merge removes synthetic duplicate chat messages", async () => {
  const store = await createStore();
  const threadId = "thread-dupes";
  store.updateTurn(threadId, { id: "turn-1", status: "unknown" });
  store.updateItem(threadId, "turn-1", { id: "item-1", type: "userMessage", text: "Run the task" }, "completed");
  store.updateItem(threadId, "turn-1", { id: "item-2", type: "agentMessage", text: "I will inspect it." }, "completed");

  store.upsertThreadSummary({
    id: threadId,
    status: "idle",
    turns: [
      {
        id: "turn-1",
        status: "completed",
        items: [
          { id: "msg-user", type: "userMessage", text: "Run the task" },
          { id: "msg-agent", type: "agentMessage", text: "I will inspect it." }
        ]
      }
    ]
  });

  const items = store.getThread(threadId)?.turns[0]?.items ?? [];
  assert.deepEqual(items.map((item) => item.id), ["msg-user", "msg-agent"]);
});

test("thread detail projection hides persisted synthetic duplicate chat messages", async () => {
  const store = await createStore();
  const threadId = "thread-persisted-dupes";
  store.updateTurn(threadId, { id: "turn-1", status: "completed" });
  store.updateItem(threadId, "turn-1", { id: "item-1", type: "userMessage", text: "Run the task" }, "completed");
  store.updateItem(threadId, "turn-1", { id: "msg-user", type: "userMessage", text: "Run the task" }, "completed");

  const items = store.getThreadDetail(threadId)?.turns[0]?.items ?? [];
  assert.deepEqual(items.map((item) => item.id), ["msg-user"]);
});
