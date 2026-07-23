import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { buildCallbackReviewPrompt } from "../../src/server/butler-agent-helpers.js";
import { buildJobPayload } from "../../src/server/job-instruction-artifacts.js";
import { ButlerStateStore } from "../../src/server/state-store.js";
import { buildThreadExecutionContract } from "../../src/server/thread-contract.js";

test("callback review prompt makes the latest operator follow-up authoritative", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "manor-callback-response-scope-"));
  const store = new ButlerStateStore(path.join(dir, "state.json"));
  const contract = buildThreadExecutionContract({
    threadId: "thread-response-scope",
    workspaceCwd: "/workspace",
    projectId: "project",
    projectLabel: "Boardwalk",
    branch: "main",
    taskText: "Build and publish the Boardwalk dossier.",
    requestedTask: "Build and publish the Boardwalk dossier.",
    operatorGoal: null,
    notes: []
  });
  store.upsertThreadSummary({
    id: contract.threadId,
    status: "idle",
    cwd: contract.workspaceCwd,
    turns: [{ id: "turn-egress", status: "completed", items: [] }]
  });
  store.setThreadExecutionContract(contract.threadId, contract);
  const report = store.recordWorkerReport(contract.threadId, {
    turnId: "turn-egress",
    status: "completed",
    summary: "Worker can reach here.now.",
    details: "The Worker received HTTP 200 and the proxy CONNECT succeeded."
  });
  const payload = buildJobPayload({ threadId: contract.threadId, kind: "delegation", instruction: contract.requestedTask, contract });
  payload.outputManifest.entries.push({
    id: `${payload.protocol.currentAttemptId}:worker_report:${report.turnId}`,
    kind: "worker_report",
    title: report.summary,
    threadId: contract.threadId,
    projectId: contract.projectId,
    attemptId: payload.protocol.currentAttemptId,
    sourceTurnId: report.turnId,
    artifactId: null,
    proofRunId: null,
    reportTurnId: report.turnId,
    createdAt: report.updatedAt
  });
  store.setThreadJobPayload(payload);

  const prompt = buildCallbackReviewPrompt(store, {
    threadId: contract.threadId,
    callbackState: "received_worker_callback",
    resolutionState: "received_worker_callback",
    requestedAt: 1,
    operatorRequestText: "See if you and the Worker have here.now egress.",
    lastEventAt: Date.now(),
    lastWorkerStatusSeen: "idle",
    lastTerminalReportAt: Date.now(),
    lastPrivateSteerText: "Check here.now from the Worker shell.",
    lastPrivateSteerAt: 2,
    nextWorkerReportAction: "review",
    operatorCloseoutStatus: "owed",
    owesOperatorReply: true,
    closeoutChannel: "none",
    reviewState: "queued",
    reviewReason: "worker_callback",
    closedAt: null,
    updatedAt: Date.now()
  }, {
    butlerTurnContext: "Butler tool result (bash): https://here.now/ returned HTTP 200."
  });

  assert.ok(prompt.indexOf("Current operator request governing this callback") < prompt.indexOf("Governing Worker review scope"));
  assert.match(prompt, /latest operator request is the authoritative response scope/i);
  assert.match(prompt, /Butler-side work from the current operator turn/);
  assert.match(prompt, /If the operator asked about both environments, report both explicitly/);
  assert.match(prompt, /persisted review scope still governs whether work may close/i);
  assert.match(prompt, /Structured supervision checklist/);
  assert.match(prompt, /Do not substitute a general job completion report/);
  assert.match(prompt, /Resolved durable outputs for the current job attempt/);
  assert.match(prompt, /Worker can reach here\.now\./);
  assert.match(prompt, /instead of guessing artifact locations/i);
});
