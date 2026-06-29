import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { ButlerStateStore } from "../../src/server/state-store.js";
import { groupProofsByTurn, type WorkerProofRecord, type WorkerReport, type WorkerTurnGroup } from "../../src/web/WorkerPane.js";

async function createStore(): Promise<ButlerStateStore> {
  const dir = await mkdtemp(path.join(tmpdir(), "manor-worker-proof-"));
  return new ButlerStateStore(path.join(dir, "state.json"));
}

function proof(id: string, runId: string, checkedAt: number): WorkerProofRecord {
  return {
    id,
    previewTitle: runId,
    createdAt: checkedAt,
    updatedAt: checkedAt,
    verification: {
      runId,
      ok: true,
      failureKind: "none",
      checkedAt,
      url: "",
      artifacts: []
    },
    proofReviews: []
  };
}

function turn(id: string): WorkerTurnGroup {
  return {
    id,
    status: "completed",
    startedAt: 5000,
    completedAt: 6000,
    finalIndex: 0,
    items: [
      {
        id: `${id}:final`,
        type: "agentMessage",
        status: "completed",
        text: "Done",
        at: 6000
      }
    ]
  };
}

test("worker proof grouping uses report proof references before timestamp fallback", () => {
  const turns = [turn("turn-1"), turn("turn-2")];
  const reports: WorkerReport[] = [
    {
      turnId: "turn-1",
      status: "completed",
      summary: "Turn 1",
      details: null,
      evidence: [{ proofRunId: "proof-run-1" }],
      claims: { claims: [{ proofId: "browser:thread-1:file-proof-1" }] },
      updatedAt: 7000
    },
    {
      turnId: "turn-2",
      status: "completed",
      summary: "Turn 2",
      details: null,
      evidence: [{ proofRunId: "proof-run-2" }],
      updatedAt: 8000
    }
  ];
  const grouped = groupProofsByTurn(
    turns,
    [
      proof("browser:thread-1:file-proof-1", "file-proof-1", 1000),
      proof("browser:thread-1:proof-run-1", "proof-run-1", 1000),
      proof("browser:thread-1:proof-run-2", "proof-run-2", 1000)
    ],
    reports
  );

  assert.deepEqual(grouped.get("turn-1")?.map((entry) => entry.verification.runId), ["file-proof-1", "proof-run-1"]);
  assert.deepEqual(grouped.get("turn-2")?.map((entry) => entry.verification.runId), ["proof-run-2"]);
});

test("thread detail exposes worker report history for per-turn proof anchoring", async () => {
  const store = await createStore();
  store.upsertThreadSummary({
    id: "thread-1",
    status: "idle",
    cwd: "/workspace",
    turns: [
      { id: "turn-1", status: "completed", items: [] },
      { id: "turn-2", status: "completed", items: [] }
    ]
  });

  store.recordWorkerReport("thread-1", {
    turnId: "turn-1",
    status: "completed",
    summary: "First turn",
    evidence: [{ id: "ev-1", pointId: null, matrixRowId: null, kind: "browser_flow", summary: "proof one", details: null, command: null, exitCode: null, proofRunId: "proof-1", artifactId: null, route: null, logRef: null, dataRef: null, createdAt: 1 }]
  });
  store.recordWorkerReport("thread-1", {
    turnId: "turn-2",
    status: "completed",
    summary: "Second turn",
    evidence: [{ id: "ev-2", pointId: null, matrixRowId: null, kind: "browser_flow", summary: "proof two", details: null, command: null, exitCode: null, proofRunId: "proof-2", artifactId: null, route: null, logRef: null, dataRef: null, createdAt: 2 }]
  });

  const detail = store.getThreadDetail("thread-1");
  assert.deepEqual(detail?.workerReports?.map((report) => [report.turnId, report.evidence[0]?.proofRunId]), [
    ["turn-1", "proof-1"],
    ["turn-2", "proof-2"]
  ]);
  assert.equal(detail?.workerReport?.turnId, "turn-2");
});
