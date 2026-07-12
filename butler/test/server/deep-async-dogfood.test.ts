import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { buildOperatorCloseoutText } from "../../src/server/butler-agent-closeout-text.js";
import { validateCompletedWorkerEvidence } from "../../src/server/codex-harness-report-validation.js";
import { contractRequiresVisualProof } from "../../src/server/proof-policy.js";
import { ButlerStateStore } from "../../src/server/state-store.js";
import { evaluateOperatorCloseoutGate } from "../../src/server/supervision-checklist.js";
import { buildThreadExecutionContract } from "../../src/server/thread-contract.js";
import type {
  CodexThreadExecutionContractView,
  CodexWorkerEvidenceView,
  PreviewProofRecordView,
  PreviewVerificationArtifactView,
  PreviewVerificationView,
  WorkerEvidenceKind
} from "../../src/server/types.js";

async function createStore(): Promise<ButlerStateStore> {
  const dir = await mkdtemp(path.join(tmpdir(), "manor-deep-dogfood-"));
  return new ButlerStateStore(path.join(dir, "state.json"));
}

function createThread(store: ButlerStateStore, contract: CodexThreadExecutionContractView): void {
  store.upsertThreadSummary({
    id: contract.threadId,
    status: "idle",
    cwd: contract.workspaceCwd,
    turns: [{ id: "turn-1", status: "completed", items: [] }]
  });
  store.setThreadExecutionContract(contract.threadId, contract);
}

function evidence(
  kind: WorkerEvidenceKind,
  row: CodexThreadExecutionContractView["verificationMatrix"][number],
  overrides: Partial<CodexWorkerEvidenceView> = {}
): CodexWorkerEvidenceView {
  return {
    id: `${row.id}-${kind}-${overrides.id ?? "evidence"}`,
    pointId: row.acceptancePointId,
    matrixRowId: row.id,
    kind,
    summary: `${kind} checked for ${row.text}`,
    details: null,
    command:
      kind === "api_smoke" || kind === "negative_case" || kind === "build" || kind === "integration_test"
        ? `${kind} command passed`
        : null,
    exitCode: kind === "api_smoke" || kind === "negative_case" || kind === "build" || kind === "integration_test" ? 0 : null,
    proofRunId: kind === "browser_flow" || kind === "visual_review" || kind === "screenshot" || kind === "proof" ? "proof-ui" : null,
    artifactId: null,
    route: kind === "api_smoke" ? "GET /api/deep-async-dogfood" : null,
    logRef: kind === "log_review" ? "runtime log scan contained no errors" : null,
    dataRef: kind === "data_check" ? "state store readback matched evidence ids" : null,
    createdAt: Date.now(),
    ...overrides
  };
}

function proofArtifact(kind: PreviewVerificationArtifactView["kind"], fileName: string): PreviewVerificationArtifactView {
  return {
    kind,
    label: kind === "screenshot" ? "Final screenshot" : "Text proof",
    fileName,
    filePath: `/tmp/${fileName}`,
    contentType: kind === "screenshot" ? "image/png" : "text/plain",
    sizeBytes: 100,
    url: `/api/artifacts/${fileName}`,
    downloadUrl: `/api/artifacts/${fileName}?download=1`,
    availability: "available",
    retainedUntilAt: null,
    expiredAt: null
  };
}

function verification(runId: string, artifacts: PreviewVerificationArtifactView[]): PreviewVerificationView {
  return {
    runId,
    mode: "headless",
    checkedAt: Date.now(),
    durationMs: 1200,
    ok: true,
    status: 200,
    title: "Deep async dogfood",
    url: "http://localhost/dogfood",
    error: null,
    failureKind: "none",
    summary: {
      consoleMessageCount: 0,
      pageErrorCount: 0,
      failedRequestCount: 0,
      responseErrorCount: 0,
      assetFailureCount: 0,
      phaseCount: 2
    },
    phases: [],
    readiness: {
      initialUrl: "http://localhost/dogfood",
      finalUrl: "http://localhost/dogfood",
      expectedPath: "/dogfood",
      selector: "[data-check='dossier']",
      selectorSatisfied: true,
      routeStatus: 200,
      routeOk: true,
      loginRedirectDetected: false,
      htmlErrorSignals: [],
      sameOriginAssetFailureCount: 0,
      websocketFailureCount: 0,
      notes: ["desktop and mobile layout metrics passed"]
    },
    auth: {
      headerCount: 0,
      cookieCount: 0,
      cookieNames: [],
      usedSessionCookie: false
    },
    artifacts,
    consoleMessages: [],
    pageErrors: [],
    failedRequests: []
  };
}

function textProof(threadId: string): PreviewProofRecordView {
  const checkedAt = Date.now();
  return {
    id: `text-proof-${threadId}`,
    previewId: `preview-${threadId}`,
    threadId,
    projectId: "project-1",
    projectLabel: "Project One",
    previewTitle: "Text proof",
    stackId: null,
    verification: verification("text-proof", [proofArtifact("file", "proof.txt")]),
    proofReviews: [],
    createdAt: checkedAt,
    updatedAt: checkedAt
  };
}

test("backend dogfood closes only after API smoke, failure path, logs, Butler review, and proof dossier", async () => {
  const store = await createStore();
  const contract = buildThreadExecutionContract({
    threadId: "dogfood-api",
    workspaceCwd: "/workspace",
    projectId: "project-1",
    projectLabel: "Project One",
    branch: "main",
    requestedTask: "Implement and verify the async verification API route.",
    taskText: [
      "Implement and verify the async verification API route.",
      "- Request-level smoke check passes",
      "- Failure-path check is covered",
      "- Runtime logs are reviewed"
    ].join("\n"),
    notes: []
  });
  createThread(store, contract);
  const thread = store.getThread(contract.threadId);
  assert.ok(thread);
  assert.equal(contract.taskCategory, "api");
  assert.equal(contract.inferredWorkDepth, "deep");

  assert.doesNotThrow(() => validateCompletedWorkerEvidence({ thread, evidence: [], threadProofs: [] }));

  const workerEvidence = contract.verificationMatrix.flatMap((row) => [
    evidence("api_smoke", row),
    evidence("negative_case", row),
    evidence("log_review", row)
  ]);
  assert.doesNotThrow(() => validateCompletedWorkerEvidence({ thread, evidence: workerEvidence, threadProofs: [] }));

  const report = store.recordWorkerReport(contract.threadId, {
    turnId: "turn-1",
    status: "completed",
    summary: "API route implemented and verified.",
    details: "Smoke, failure path, and runtime logs were checked.",
    evidence: workerEvidence
  });
  assert.equal(evaluateOperatorCloseoutGate(store.getSupervisionChecklist(contract.threadId), report).ok, false);

  for (const item of store.getSupervisionChecklist(contract.threadId)?.items ?? []) {
    store.reviewAcceptancePoint({
      threadId: contract.threadId,
      pointId: item.id,
      status: "accepted",
      note: "Mapped evidence covers the API check."
    });
  }

  assert.equal(evaluateOperatorCloseoutGate(store.getSupervisionChecklist(contract.threadId), report).ok, true);
  const closeout = buildOperatorCloseoutText({
    store,
    thread: store.getThread(contract.threadId)!,
    workerReport: report,
    text: "Done."
  });
  assert.match(closeout, /Proof dossier/);
  assert.match(closeout, /Accepted evidence: 3\/3/);
  assert.match(closeout, /Proof recorded: none/);
});

test("UI dogfood rejects weak proof, steers rework privately, then closes with proof review and dossier", async () => {
  const store = await createStore();
  const contract = buildThreadExecutionContract({
    threadId: "dogfood-ui",
    workspaceCwd: "/workspace",
    projectId: "project-1",
    projectLabel: "Project One",
    branch: "main",
    requestedTask: "Implement the operator proof dossier UI without adding a depth control.",
    taskText: [
      "Implement the operator proof dossier UI without adding a depth control.",
      "- Show verification rows and evidence clearly",
      "- Keep depth out of operator-facing controls",
      "- Capture visual proof of the dossier",
      "- Review responsive, accessibility, and taste quality"
    ].join("\n"),
    notes: []
  });
  createThread(store, contract);
  const thread = store.getThread(contract.threadId);
  assert.ok(thread);
  assert.equal(contract.taskCategory, "ui");
  assert.equal(contract.inferredWorkDepth, "deep");
  assert.equal(contractRequiresVisualProof(contract), true);

  const uiEvidence = contract.verificationMatrix.flatMap((row, index) => [
    evidence(index === 0 ? "browser_flow" : "screenshot", row),
    evidence("responsive_review", row),
    evidence("accessibility_review", row),
    evidence("taste_review", row)
  ]);
  assert.doesNotThrow(() => validateCompletedWorkerEvidence({ thread, evidence: uiEvidence, threadProofs: [] }));
  assert.doesNotThrow(() => validateCompletedWorkerEvidence({ thread, evidence: uiEvidence, threadProofs: [textProof(contract.threadId)] }));

  const proof = store.recordBrowserVerification({
    threadId: contract.threadId,
    projectId: contract.projectId,
    projectLabel: contract.projectLabel,
    title: "Dossier proof",
    verification: verification("proof-ui", [proofArtifact("screenshot", "dossier.png")])
  });
  const reviewedProof = store.recordPreviewProofReview(proof.id, {
    id: "review-ui",
    verdict: "credible",
    visibleState: "The dossier shows rows, evidence, review notes, and proof status without a depth control.",
    evidence: "Screenshot artifact plus desktop and mobile layout metrics.",
    concern: "",
    expectedOutcome: "Operator can inspect proof without reading the transcript.",
    reviewedAt: Date.now(),
    modelId: "test-model",
    modelProvider: "test"
  });
  assert.ok(reviewedProof);
  assert.doesNotThrow(() => validateCompletedWorkerEvidence({ thread, evidence: uiEvidence, threadProofs: [reviewedProof] }));

  const firstReport = store.recordWorkerReport(contract.threadId, {
    turnId: "turn-1",
    status: "completed",
    summary: "Dossier UI implemented with visual proof.",
    details: "Visual, responsive, accessibility, and taste checks are attached.",
    evidence: uiEvidence
  });
  assert.equal(evaluateOperatorCloseoutGate(store.getSupervisionChecklist(contract.threadId), firstReport).ok, false);
  store.reviewAcceptancePoint({
    threadId: contract.threadId,
    pointId: "point-1",
    status: "rejected",
    note: "Evidence exists, but the review note needs a clearer operator outcome.",
    nextInstruction: "Tie the evidence summary to the operator's ability to trust the result without reading the transcript."
  });
  assert.match(store.buildQueuedRejectionInstruction(contract.threadId) ?? "", /operator's ability to trust the result/);
  store.clearQueuedRejectionInstructions(contract.threadId);

  const correctedReport = store.recordWorkerReport(contract.threadId, {
    turnId: "turn-2",
    status: "completed",
    summary: "Dossier UI implemented with operator-trust proof.",
    details: "The corrected evidence explains what the operator can trust from the dossier.",
    evidence: uiEvidence.map((entry) =>
      entry.pointId === "point-1"
        ? { ...entry, summary: `${entry.summary}; operator can trust the outcome from the dossier.` }
        : entry
    )
  });
  for (const item of store.getSupervisionChecklist(contract.threadId)?.items ?? []) {
    store.reviewAcceptancePoint({
      threadId: contract.threadId,
      pointId: item.id,
      status: "accepted",
      note: "Evidence is specific and operator-facing."
    });
  }

  assert.equal(evaluateOperatorCloseoutGate(store.getSupervisionChecklist(contract.threadId), correctedReport).ok, true);
  const closeout = buildOperatorCloseoutText({
    store,
    thread: store.getThread(contract.threadId)!,
    workerReport: correctedReport,
    text: "Done."
  });
  assert.match(closeout, /Proof dossier/);
  assert.match(closeout, /Accepted evidence: 4\/4/);
  assert.match(closeout, /Proof reviewed: credible/);
  assert.match(closeout, /without a depth control/);
});
