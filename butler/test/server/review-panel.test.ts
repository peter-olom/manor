import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { getOperatorCloseoutBlocker } from "../../src/server/butler-closeout-gate.js";
import { buildCallbackReviewPrompt } from "../../src/server/butler-agent-helpers.js";
import { buildReviewPanel, selectReviewPanelRoles, summarizeReviewPanel } from "../../src/server/review-panel.js";
import { ButlerStateStore } from "../../src/server/state-store.js";
import { buildThreadExecutionContract } from "../../src/server/thread-contract.js";
import type { ButlerThreadCallbackView } from "../../src/server/types.js";

async function createStore(): Promise<ButlerStateStore> {
  const dir = await mkdtemp(path.join(tmpdir(), "manor-review-panel-"));
  return new ButlerStateStore(path.join(dir, "state.json"));
}

function callback(threadId: string): ButlerThreadCallbackView {
  return {
    threadId,
    callbackState: "received_worker_callback",
    resolutionState: "received_worker_callback",
    requestedAt: 1,
    lastEventAt: 2,
    lastWorkerStatusSeen: "idle",
    lastTerminalReportAt: 2,
    lastPrivateSteerText: null,
    lastPrivateSteerAt: null,
    nextWorkerReportAction: "review",
    operatorCloseoutStatus: "owed",
    owesOperatorReply: true,
    closeoutChannel: "none",
    reviewState: "queued",
    reviewReason: "worker_callback",
    closedAt: null,
    updatedAt: 2
  };
}

test("review panel selection stays minimal and category aware", () => {
  assert.deepEqual(selectReviewPanelRoles({ taskCategory: "ui", inferredWorkDepth: "deep", requestedTask: "Polish the settings UI" }), [
    "intent",
    "qa",
    "ui_taste"
  ]);
  assert.deepEqual(selectReviewPanelRoles({ taskCategory: "api", inferredWorkDepth: "deep", requestedTask: "Add API negative cases" }), [
    "intent",
    "qa",
    "api"
  ]);
  assert.deepEqual(selectReviewPanelRoles({ taskCategory: "deploy", inferredWorkDepth: "incident", requestedTask: "Deploy and verify health" }), [
    "intent",
    "qa",
    "ops"
  ]);
  assert.deepEqual(selectReviewPanelRoles({ taskCategory: "research", inferredWorkDepth: "deep", requestedTask: "Research options" }), [
    "intent",
    "product",
    "qa"
  ]);
});

test("review panel verdicts persist and failed verdicts block closeout", async () => {
  const store = await createStore();
  const contract = buildThreadExecutionContract({
    threadId: "thread-panel",
    workspaceCwd: "/workspace",
    projectId: "project",
    projectLabel: "Project",
    branch: null,
    taskText: "Build a UI workflow and verify it.",
    notes: []
  });
  store.setThreadExecutionContract("thread-panel", contract);
  contract.acceptancePoints.forEach((_point, index) => {
    store.reviewAcceptancePoint({ threadId: "thread-panel", pointId: `point-${index + 1}`, status: "accepted" });
  });
  const updated = store.recordReviewPanelVerdict({
    threadId: "thread-panel",
    role: "ui_taste",
    verdict: "failed",
    concerns: ["Mobile state overlaps"],
    evidenceRefs: ["proof-1"],
    requiredFollowUp: "Fix mobile overlap and rerun visual proof."
  });

  assert.equal(updated.reviewPanel.find((entry) => entry.role === "ui_taste")?.verdict, "failed");
  assert.equal(updated.reviewPanelSummary.status, "blocked");
  assert.match(
    getOperatorCloseoutBlocker(store, "thread-panel", {
      thread: store.getThread("thread-panel"),
      workerReport: {
        threadId: "thread-panel",
        turnId: "turn-1",
        status: "completed",
        summary: "Done",
        details: null,
        evidence: [],
        createdAt: 1,
        updatedAt: 1
      }
    }),
    /UI taste reviewer blocked closeout/
  );
});

test("callback review prompt includes panel instructions and state", async () => {
  const store = await createStore();
  const contract = buildThreadExecutionContract({
    threadId: "thread-prompt",
    workspaceCwd: "/workspace",
    projectId: "project",
    projectLabel: "Project",
    branch: null,
    taskText: "Research the attached workflow deeply.",
    taskCategory: "research",
    inferredWorkDepth: "deep",
    notes: []
  });
  const reviewPanel = buildReviewPanel({ taskCategory: "research", inferredWorkDepth: "deep", requestedTask: contract.requestedTask, attachmentCount: 1 });
  store.setThreadExecutionContract("thread-prompt", { ...contract, reviewPanel, reviewPanelSummary: summarizeReviewPanel(reviewPanel) });

  const prompt = buildCallbackReviewPrompt(store, callback("thread-prompt"));

  assert.match(prompt, /Hidden review panel:/);
  assert.match(prompt, /record_review_panel_verdict/);
  assert.match(prompt, /Failed or blocked reviewer concerns must become rejected checklist points/);
});
