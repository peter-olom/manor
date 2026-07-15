import assert from "node:assert/strict";
import test from "node:test";

import { pageWorkerProofRecords, pageWorkerThread } from "../../src/server/worker-thread-page.js";

function threadWithTurns(count: number) {
  return {
    id: "worker-history",
    status: "idle",
    turnCount: count,
    turns: Array.from({ length: count }, (_, index) => ({
      id: `turn-${index}`,
      status: "completed",
      startedAt: index * 10,
      completedAt: index * 10 + 5,
      items: [{ id: `item-${index}`, type: "agentMessage", status: "completed", text: `result ${index}`, at: index * 10 + 5 }]
    })),
    eventLog: [],
    jobPayload: null,
    workerReport: null,
    workerReports: []
  } as never;
}

test("Worker history defaults to the newest ten turns", () => {
  const page = pageWorkerThread(threadWithTurns(25), null, 10);
  assert.deepEqual(page.turns.map((turn) => turn.id), Array.from({ length: 10 }, (_, index) => `turn-${index + 15}`));
  assert.equal(page.loadedStart, 15);
  assert.equal(page.hasMore, true);
  assert.equal(page.turnCount, 25);
});

test("Worker history pages backward without overlap", () => {
  const page = pageWorkerThread(threadWithTurns(25), 15, 10);
  assert.deepEqual(page.turns.map((turn) => turn.id), Array.from({ length: 10 }, (_, index) => `turn-${index + 5}`));
  assert.equal(page.loadedStart, 5);
  assert.equal(page.hasMore, true);

  const first = pageWorkerThread(threadWithTurns(25), page.loadedStart, 50);
  assert.deepEqual(first.turns.map((turn) => turn.id), Array.from({ length: 5 }, (_, index) => `turn-${index}`));
  assert.equal(first.loadedStart, 0);
  assert.equal(first.hasMore, false);
});

test("Worker pages omit heavy thread state and retain only relevant diagnostics", () => {
  const thread = threadWithTurns(25) as never as Record<string, unknown>;
  thread.executionContract = { large: "x".repeat(10_000) };
  thread.jobMemory = { large: "x".repeat(10_000) };
  thread.eventLog = [
    { at: 140, method: "runtime.error", summary: "too old" },
    { at: 155, method: "runtime.info", summary: "not an error" },
    { at: 156, method: "runtime.error", summary: "visible failure" }
  ];
  thread.supervisionChecklist = {
    items: [{
      id: "point-1",
      text: "Ship it",
      status: "pending",
      butlerNote: null,
      queuedInstruction: null,
      evidence: [{ details: "x".repeat(10_000) }]
    }]
  };

  const page = pageWorkerThread(thread as never, null, 10) as never as Record<string, unknown>;
  assert.equal("executionContract" in page, false);
  assert.equal("jobMemory" in page, false);
  assert.deepEqual(page.eventLog, [{ at: 156, method: "runtime.error", summary: "visible failure" }]);
  assert.deepEqual(page.supervisionChecklist, {
    items: [{ id: "point-1", text: "Ship it", status: "pending", butlerNote: null, queuedInstruction: null }]
  });
});

test("paged Worker proofs keep explicit report references outside the time window", () => {
  const thread = threadWithTurns(25) as never as Record<string, unknown>;
  thread.workerReports = [{
    threadId: "worker-history",
    turnId: "turn-20",
    status: "completed",
    summary: "Done",
    details: null,
    evidence: [{ proofRunId: "run-referenced", artifactId: null }],
    claims: null,
    createdAt: 200,
    updatedAt: 205
  }];
  const page = pageWorkerThread(thread as never, null, 10);
  const proof = (id: string, runId: string, checkedAt: number) => ({
    id,
    createdAt: checkedAt,
    updatedAt: checkedAt,
    verification: { runId, checkedAt }
  });
  const visible = pageWorkerProofRecords([
    proof("old-referenced", "run-referenced", 10),
    proof("old-unreferenced", "run-old", 20),
    proof("recent", "run-recent", 200)
  ] as never, page);

  assert.deepEqual(visible.map((entry) => entry.id), ["old-referenced", "recent"]);
});
