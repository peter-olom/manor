import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { getOperatorCloseoutBlocker } from "../../src/server/butler-closeout-gate.js";
import { buildCallbackReviewPrompt, mergeThreadProofBundles } from "../../src/server/butler-agent-helpers.js";
import { normalizeReportEvidence, validateCompletedWorkerEvidence } from "../../src/server/codex-harness-report-validation.js";
import { ButlerStateStore } from "../../src/server/state-store.js";
import type { CodexThreadRecord, CodexWorkerEvidenceView, PreviewProofRecordView } from "../../src/server/types.js";

function proof(id: string, label = "Home page", route = "/"): PreviewProofRecordView {
  const url = `http://localhost/preview/lease-1${route}`;
  return {
    id, previewId: "preview-1", threadId: "thread-1", projectId: "project-1", projectLabel: "Project One", previewTitle: "Proof", stackId: null,
    verification: {
      runId: id, mode: "headless", checkedAt: 1000, durationMs: 10, ok: true, status: 200, title: "Proof", url, error: null, failureKind: "none",
      summary: { consoleMessageCount: 0, pageErrorCount: 0, failedRequestCount: 0, responseErrorCount: 0, assetFailureCount: 0, phaseCount: 0 },
      phases: [],
      readiness: { initialUrl: url, finalUrl: url, expectedPath: route, selector: null, selectorSatisfied: null, routeStatus: 200, routeOk: true, loginRedirectDetected: false, htmlErrorSignals: [], sameOriginAssetFailureCount: 0, websocketFailureCount: 0, notes: [] },
      auth: { headerCount: 0, cookieCount: 0, cookieNames: [], usedSessionCookie: false },
      artifacts: [{ kind: "screenshot", label, fileName: `${id}.png`, filePath: `/tmp/${id}.png`, contentType: "image/png", sizeBytes: 100, url: null, downloadUrl: null, availability: "available", retainedUntilAt: null, expiredAt: null, checksumSha256: "a".repeat(64), captureUrl: url }],
      consoleMessages: [], pageErrors: [], failedRequests: []
    },
    proofReviews: [], createdAt: 1000, updatedAt: 1000
  };
}

function evidence(route = "/"): CodexWorkerEvidenceView {
  return { id: "evidence-1", pointId: "point-1", matrixRowId: "row-1", kind: "screenshot", summary: "Screenshot", details: null, command: null, exitCode: null, proofRunId: "proof-1", artifactId: null, route, logRef: null, dataRef: null, createdAt: 1000 };
}

function thread(): CodexThreadRecord {
  return {
    id: "thread-1",
    executionContract: {
      threadId: "thread-1", workspaceCwd: "/workspace", projectId: "project-1", projectLabel: "Project One", branch: "main", requestedTask: "Build UI", operatorGoal: null,
      acceptancePoints: ["Show page"], proofExpectation: "requested", proofExpectationLabel: "proof requested", inferredWorkDepth: "standard", taskCategory: "ui",
      verificationMatrix: [{ id: "row-1", acceptancePointId: "point-1", text: "Show page", requiredChecks: [], checkKinds: ["screenshot"], expectedEvidence: [], owner: "worker", status: "pending", evidenceIds: [], artifactRefs: [], commandRefs: [], reviewerNote: null, updatedAt: null }],
      reviewPanel: [], reviewPanelSummary: { required: false, roles: [], summary: "" }, notes: []
    }
  } as CodexThreadRecord;
}

test("completed UI reports reject failed, mismatched, and duplicate browser proof", () => {
  const currentThread = thread();
  const goodProof = proof("proof-1");
  assert.doesNotThrow(() => validateCompletedWorkerEvidence({ thread: currentThread, evidence: [evidence()], threadProofs: [goodProof] }));
  assert.throws(() => validateCompletedWorkerEvidence({ thread: currentThread, evidence: [evidence("/marketplace")], threadProofs: [goodProof] }), /did not capture that route/);

  const failedProof = structuredClone(goodProof);
  failedProof.verification.actions = [{ type: "navigate", label: "Marketplace", fileName: "marketplace.png", startUrl: "http://localhost/", endUrl: "http://localhost/marketplace", at: 1000, durationMs: 10, status: "failed", error: "navigation failed" }];
  assert.throws(() => validateCompletedWorkerEvidence({ thread: currentThread, evidence: [evidence()], threadProofs: [failedProof] }), /failed browser action/);

  const duplicateProof = structuredClone(goodProof);
  duplicateProof.verification.artifacts.push({ ...duplicateProof.verification.artifacts[0]!, label: "Marketplace page", fileName: "marketplace.png", filePath: "/tmp/marketplace.png", captureUrl: "http://localhost/preview/lease-1/marketplace" });
  assert.throws(() => validateCompletedWorkerEvidence({ thread: currentThread, evidence: [evidence()], threadProofs: [duplicateProof] }), /identical image content/);
});

test("completed reports require durable references without scanning the report narrative", () => {
  const currentThread = thread();
  const withoutReference = { ...evidence(), id: "evidence-no-ref", proofRunId: null, artifactId: null };
  assert.throws(
    () => validateCompletedWorkerEvidence({ thread: currentThread, evidence: [withoutReference], threadProofs: [proof("proof-1")] }),
    /must reference a Manor proof run or durable project artifact/
  );

  const genericThread = thread();
  genericThread.executionContract!.taskCategory = "generic_code";
  const narrativeEvidence = { ...evidence(), id: "evidence-narrative", kind: "build" as const, proofRunId: null, summary: "Cleaned up /var/folders/q0/TemporaryItems/NSIRD_screencaptureui_x/Screenshot 2026-07-24 at 1.22.13 PM.png and /tmp/report.json." };
  assert.doesNotThrow(() => validateCompletedWorkerEvidence({ thread: genericThread, evidence: [narrativeEvidence], threadProofs: [] }));

  const localProofReference = { ...evidence(), id: "evidence-local-proof", kind: "proof" as const, proofRunId: "/tmp/proof.json", artifactId: null };
  assert.throws(
    () => validateCompletedWorkerEvidence({ thread: genericThread, evidence: [localProofReference], threadProofs: [] }),
    /must be a Manor reference ID/
  );
  const localArtifactReference = { ...evidence(), id: "evidence-local-artifact", kind: "file" as const, proofRunId: null, artifactId: "/tmp/output.zip" };
  assert.throws(
    () => validateCompletedWorkerEvidence({ thread: genericThread, evidence: [localArtifactReference], threadProofs: [] }),
    /must be a Manor reference ID/
  );
  const localRouteReference = { ...evidence(), id: "evidence-local-route", kind: "build" as const, proofRunId: null, route: "/tmp/route.csv" };
  assert.throws(
    () => validateCompletedWorkerEvidence({ thread: genericThread, evidence: [localRouteReference], threadProofs: [] }),
    /not local filesystem paths/
  );
  const extensionlessLogReference = { ...evidence(), id: "evidence-extensionless-log", kind: "build" as const, proofRunId: null, logRef: "/private/tmp/build-output" };
  assert.throws(
    () => validateCompletedWorkerEvidence({ thread: genericThread, evidence: [extensionlessLogReference], threadProofs: [] }),
    /not local filesystem paths/
  );
  const fileUrlDataReference = { ...evidence(), id: "evidence-file-url-data", kind: "build" as const, proofRunId: null, dataRef: "file:///tmp/data.docx" };
  assert.throws(
    () => validateCompletedWorkerEvidence({ thread: genericThread, evidence: [fileUrlDataReference], threadProofs: [] }),
    /not local filesystem paths/
  );
});

test("file and text proof runs can complete without manufactured screenshots", () => {
  const genericThread = thread();
  genericThread.executionContract!.taskCategory = "generic_code";
  const fileProof = proof("file-proof");
  fileProof.verification.artifacts = [{
    kind: "file",
    label: "Research notes",
    fileName: "notes.md",
    filePath: "/tmp/notes.md",
    contentType: "text/markdown",
    sizeBytes: 24,
    url: "/api/proofs/notes.md",
    downloadUrl: null,
    availability: "available",
    retainedUntilAt: null,
    expiredAt: null,
    checksumSha256: null
  }];
  const fileEvidence = { ...evidence(), id: "evidence-file-proof", kind: "proof" as const, proofRunId: "file-proof", summary: "Saved durable Markdown notes." };
  assert.doesNotThrow(() => validateCompletedWorkerEvidence({ thread: genericThread, evidence: [fileEvidence], threadProofs: [fileProof] }));

  const uiThread = thread();
  assert.throws(
    () => validateCompletedWorkerEvidence({ thread: uiThread, evidence: [fileEvidence], threadProofs: [fileProof] }),
    /no available screenshot or video/
  );
});

test("legacy browser evidence normalizes to browser_flow", () => {
  assert.equal(normalizeReportEvidence([{ kind: "browser", summary: "Browser proof" }])[0]?.kind, "browser_flow");
});

test("merged proof bundles preserve failures from every run", () => {
  const passing = proof("passing");
  const failed = proof("failed");
  failed.verification.ok = false; failed.verification.failureKind = "script"; failed.verification.error = "Browser action failed.";
  const merged = mergeThreadProofBundles([passing, failed]);
  assert.equal(merged?.verification.ok, false);
  assert.equal(merged?.verification.failureKind, "script");
  assert.equal(merged?.verification.error, "Browser action failed.");
});

test("completed UI closeout requires a credible Butler proof review", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "manor-proof-closeout-"));
  const store = new ButlerStateStore(path.join(dir, "state.json"));
  const currentThread = thread();
  store.upsertThreadSummary({ id: currentThread.id, status: "idle", cwd: "/workspace", turns: [{ id: "turn-1", status: "completed", items: [] }] });
  store.setThreadExecutionContract(currentThread.id, currentThread.executionContract!);
  const recorded = store.recordBrowserVerification({ threadId: currentThread.id, projectId: "project-1", projectLabel: "Project One", title: "Proof", verification: proof("proof-1").verification });
  const report = store.recordWorkerReport(currentThread.id, { turnId: "turn-1", status: "completed", summary: "Done", details: null, evidence: [evidence()] });
  store.recordWorkerReviewResults(currentThread.id, [{ id: "review", reviewSource: "adversarial_review", turnId: report.turnId, reportUpdatedAt: report.updatedAt, severity: "info", findingSummary: "No findings", blocking: false, waived: false, waiverReason: null, linkedClaimIds: [], modelProvider: "test", modelId: "test", reasoningLevel: "off", createdAt: 2000, updatedAt: 2000 }]);
  for (const item of store.getSupervisionChecklist(currentThread.id)?.items ?? []) {
    store.reviewAcceptancePoint({ threadId: currentThread.id, pointId: item.id, status: "accepted" });
  }

  assert.match(getOperatorCloseoutBlocker(store, currentThread.id) ?? "", /must be reviewed/);
  store.recordPreviewProofReview(recorded.id, { id: "unclear", verdict: "unclear", visibleState: "Unclear", evidence: "Image", concern: "Wrong state", expectedOutcome: null, reviewedAt: 1000, modelId: "test", modelProvider: "test" });
  assert.match(getOperatorCloseoutBlocker(store, currentThread.id) ?? "", /latest review is unclear/);
  store.recordPreviewProofReview(recorded.id, { id: "credible", verdict: "credible", visibleState: "Correct", evidence: "Image", concern: "", expectedOutcome: null, reviewedAt: 2000, modelId: "test", modelProvider: "test" });
  assert.equal(getOperatorCloseoutBlocker(store, currentThread.id, { workerReport: report }), null);
});

test("callback review names exact current proof runs and reuses credible verdicts", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "manor-proof-guidance-"));
  const store = new ButlerStateStore(path.join(dir, "state.json"));
  const currentThread = thread();
  store.upsertThreadSummary({ id: currentThread.id, status: "idle", cwd: "/workspace", turns: [{ id: "turn-1", status: "completed", items: [] }] });
  store.setThreadExecutionContract(currentThread.id, currentThread.executionContract!);
  const reviewed = store.recordBrowserVerification({ threadId: currentThread.id, projectId: "project-1", projectLabel: "Project One", title: "Home", verification: proof("run-reviewed").verification });
  store.recordBrowserVerification({ threadId: currentThread.id, projectId: "project-1", projectLabel: "Project One", title: "Clients", verification: proof("run-pending", "Clients", "/clients").verification });
  store.recordPreviewProofReview(reviewed.id, { id: "review-home", verdict: "credible", visibleState: "Home", evidence: "Screenshot", concern: "", expectedOutcome: "Show page", reviewedAt: 2_000, modelId: "test", modelProvider: "test" });
  store.recordWorkerReport(currentThread.id, {
    turnId: "turn-1",
    status: "completed",
    summary: "Captured both pages.",
    details: null,
    evidence: [
      { ...evidence(), id: "ev-reviewed", proofRunId: "run-reviewed" },
      { ...evidence("/clients"), id: "ev-pending", proofRunId: "run-pending" }
    ]
  });

  const prompt = buildCallbackReviewPrompt(store, {
    threadId: currentThread.id,
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

  assert.match(prompt, /run-reviewed: verification=passed \| review=credible/);
  assert.match(prompt, /run-pending: verification=passed \| review=unreviewed/);
  assert.match(prompt, /exact runId shown above, never the word latest/);
  assert.match(prompt, /Skip a run whose latest review is already credible/);
  assert.match(prompt, /review_acceptance_points to batch two or more checklist decisions/);
});
