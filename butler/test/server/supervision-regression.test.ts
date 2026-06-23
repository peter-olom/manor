import { readFileSync } from "node:fs";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import {
  buildCallbackReviewPrompt,
  buildChatCallbackText,
  buildFallbackChatCallbackText,
  buildJobDetail,
  buildOperatorThreadGuard,
  buildProofsByThreadMap,
  buildProjectInventorySummary,
  buildSystemPrompt,
  isCallbackOutstanding,
  selectReviewableProofArtifacts
} from "../../src/server/butler-agent-helpers.js";
import { formatDelegationContractText } from "../../src/server/butler-agent-delegation-contract.js";
import {
  buildSelfImprovementTask,
  classifyManorBlocker,
  hasStartedSelfImprovement
} from "../../src/server/butler-self-improvement.js";
import { validateCompletedWorkerEvidence } from "../../src/server/codex-harness-report-validation.js";
import { contractRequiresVisualProof, hasVisualProof, taskHasUiImplication } from "../../src/server/proof-policy.js";
import { listWorkspaceProjectDirectories, resolveWorkspaceProjectInfo } from "../../src/server/repo-worktree.js";
import { buildReviewPanel, summarizeReviewPanel } from "../../src/server/review-panel.js";
import { ButlerStateStore } from "../../src/server/state-store.js";
import { evaluateOperatorCloseoutGate } from "../../src/server/supervision-checklist.js";
import { buildThreadExecutionContract, buildVerificationMatrix } from "../../src/server/thread-contract.js";
import type { ButlerThreadCallbackView, CodexThreadExecutionContractView, CodexWorkerEvidenceView, PreviewProofRecordView } from "../../src/server/types.js";

async function createStore(): Promise<ButlerStateStore> {
  const dir = await mkdtemp(path.join(tmpdir(), "manor-butler-test-"));
  return new ButlerStateStore(path.join(dir, "state.json"));
}

function makeContract(overrides: Partial<CodexThreadExecutionContractView> = {}): CodexThreadExecutionContractView {
  const acceptancePoints = overrides.acceptancePoints ?? ["Acknowledge delegation", "Record callback", "Post closeout"];
  const taskCategory = overrides.taskCategory ?? "generic_code";
  const inferredWorkDepth = overrides.inferredWorkDepth ?? "deep";
  const reviewPanel = overrides.reviewPanel ?? buildReviewPanel({ taskCategory, inferredWorkDepth, requestedTask: "Verify the delegated flow with proof." });
  return {
    threadId: "thread-1",
    workspaceCwd: "/workspace",
    projectId: "project-1",
    projectLabel: "Project One",
    branch: "main",
    requestedTask: "Verify the delegated flow with proof.",
    operatorGoal: "The operator gets one reliable closeout.",
    acceptancePoints,
    proofExpectation: "requested",
    proofExpectationLabel: "proof requested",
    inferredWorkDepth,
    taskCategory,
    verificationMatrix: buildVerificationMatrix({ acceptancePoints, taskCategory, inferredWorkDepth }),
    reviewPanel,
    reviewPanelSummary: overrides.reviewPanelSummary ?? summarizeReviewPanel(reviewPanel),
    notes: [],
    ...overrides
  };
}

function makeProof(
  id: string,
  checkedAt: number,
  artifacts: PreviewProofRecordView["verification"]["artifacts"],
  overrides: Partial<PreviewProofRecordView> = {}
): PreviewProofRecordView {
  return {
    id,
    previewId: "preview-1",
    threadId: "thread-1",
    projectId: "project-1",
    projectLabel: "Project One",
    previewTitle: "Proof",
    stackId: null,
    verification: {
      runId: id,
      mode: "headless",
      checkedAt,
      durationMs: 1000,
      ok: true,
      status: 200,
      title: "Proof",
      url: "http://localhost/proof",
      error: null,
      failureKind: "none",
      summary: {
        consoleMessageCount: 0,
        pageErrorCount: 0,
        failedRequestCount: 0,
        responseErrorCount: 0,
        assetFailureCount: 0,
        phaseCount: 1
      },
      phases: [],
      readiness: {
        initialUrl: "http://localhost/proof",
        finalUrl: "http://localhost/proof",
        expectedPath: null,
        selector: null,
        selectorSatisfied: null,
        routeStatus: 200,
        routeOk: true,
        loginRedirectDetected: false,
        htmlErrorSignals: [],
        sameOriginAssetFailureCount: 0,
        websocketFailureCount: 0,
        notes: []
      },
      auth: {
        headerCount: 0,
        cookieCount: 0,
        cookieNames: [],
        usedSessionCookie: false
      },
      diagnostics: undefined,
      artifacts,
      consoleMessages: [],
      pageErrors: [],
      failedRequests: []
    },
    proofReviews: [],
    createdAt: checkedAt,
    updatedAt: checkedAt,
    ...overrides
  };
}

function proofArtifact(
  kind: PreviewProofRecordView["verification"]["artifacts"][number]["kind"],
  label: string,
  fileName: string
): PreviewProofRecordView["verification"]["artifacts"][number] {
  return {
    kind,
    label,
    fileName,
    filePath: `/tmp/${fileName}`,
    contentType: kind === "screenshot" ? "image/png" : fileName.endsWith(".pdf") ? "application/pdf" : "text/plain",
    sizeBytes: 100,
    url: `/api/artifacts/${fileName}`,
    downloadUrl: `/api/artifacts/${fileName}?download=1`,
    availability: "available",
    retainedUntilAt: null,
    expiredAt: null
  };
}

function workerEvidence(
  kind: CodexWorkerEvidenceView["kind"],
  overrides: Partial<CodexWorkerEvidenceView> = {}
): CodexWorkerEvidenceView {
  return {
    id: `${kind}-${overrides.pointId ?? "point-1"}-${overrides.matrixRowId ?? "row-1"}`,
    pointId: "point-1",
    matrixRowId: "row-1",
    kind,
    summary: `${kind} evidence`,
    details: null,
    command: kind === "build" || kind === "api_smoke" || kind === "negative_case" ? `${kind} command` : null,
    exitCode: null,
    proofRunId: kind === "browser_flow" || kind === "visual_review" || kind === "screenshot" ? "proof-1" : null,
    artifactId: null,
    route: null,
    logRef: kind === "log_review" ? "runtime logs" : null,
    dataRef: null,
    createdAt: Date.now(),
    ...overrides
  };
}

test("thread proof maps keep concise reviewable evidence in useful order", () => {
  const oldPdf = makeProof("old-pdf", 1000, [proofArtifact("file", "old pdf", "brief.pdf")], {
    previewTitle: "Old PDF"
  });
  const newPdf = makeProof("new-pdf", 3000, [proofArtifact("file", "new pdf", "brief.pdf")], {
    previewTitle: "New PDF"
  });
  const markdown = makeProof("markdown", 4000, [proofArtifact("file", "source markdown", "brief.md")], {
    previewTitle: "Markdown"
  });
  const visual = makeProof(
    "visual",
    2000,
    [
      proofArtifact("manifest", "Download manifest", "manifest.json"),
      proofArtifact("screenshot", "Final screenshot", "final.png"),
      proofArtifact("screenshot", "Ready screenshot", "ready.png"),
      proofArtifact("screenshot", "updated first page", "updated.png"),
      proofArtifact("html", "Download rendered html", "page.html"),
      proofArtifact("trace", "Download trace", "trace.zip"),
      proofArtifact("video", "Open video", "video.webm")
    ],
    { previewId: "preview-visual", previewTitle: "Visual proof" }
  );

  const mapped = buildProofsByThreadMap([oldPdf, newPdf, markdown, visual]);

  assert.deepEqual(mapped["thread-1"]?.map((proof) => proof.id), ["visual", "new-pdf", "markdown"]);
  assert.deepEqual(selectReviewableProofArtifacts(visual.verification).map((artifact) => artifact.label), [
    "updated first page",
    "Open video",
    "Download trace",
    "Download rendered html",
    "Download manifest"
  ]);
});

test("file proof artifacts expose download links when listed", async () => {
  const store = await createStore();
  const fileArtifact = proofArtifact("file", "brief pdf", "brief.pdf");
  fileArtifact.filePath = "/artifacts/files/thread-1/file-proof/brief.pdf";
  fileArtifact.url = null;
  fileArtifact.downloadUrl = null;
  const proof = makeProof("file-proof", 1000, [fileArtifact]);

  store.recordBrowserVerification({
    threadId: proof.threadId ?? "thread-1",
    projectId: proof.projectId,
    projectLabel: proof.projectLabel,
    title: proof.previewTitle,
    verification: proof.verification
  });

  const listed = store.listPreviewProofs()[0]?.verification.artifacts[0];

  assert.equal(listed?.url, "/api/artifacts/files/thread-1/file-proof/brief.pdf");
  assert.equal(listed?.downloadUrl, "/api/artifacts/files/thread-1/file-proof/brief.pdf?download=1");
});

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

test("job detail output stays bounded for large loaded transcripts", async () => {
  const store = await createStore();
  const bigText = "large transcript chunk ".repeat(500);
  store.upsertThreadSummary({
    id: "thread-large",
    status: "idle",
    cwd: "/workspace",
    turns: Array.from({ length: 20 }, (_, turnIndex) => ({
      id: `turn-${turnIndex + 1}`,
      status: "completed",
      items: Array.from({ length: 40 }, (_, itemIndex) => ({
        id: `item-${turnIndex + 1}-${itemIndex + 1}`,
        type: "agentMessage",
        status: "completed",
        text: bigText
      }))
    }))
  });

  const detail = buildJobDetail(store, "thread-large");

  assert.ok(detail.length <= 51_000);
  assert.match(detail, /omitted_earlier_turns=8/);
  assert.match(detail, /omitted_earlier_items=120/);
  assert.match(detail, /characters omitted from job item text/);
});

test("implementation contracts infer internal depth and category verification rows", () => {
  const contract = buildThreadExecutionContract({
    threadId: "thread-ui",
    workspaceCwd: "/workspace",
    projectId: "project-1",
    projectLabel: "Project One",
    branch: "main",
    taskText: "Implement the new settings UI, verify responsive behavior, and capture proof.",
    notes: []
  });

  assert.equal(contract.taskCategory, "ui");
  assert.equal(contract.inferredWorkDepth, "deep");
  assert.equal(contract.proofExpectation, "requested");
  assert.equal(contract.mission?.intent, "Implement the new settings UI, verify responsive behavior, and capture proof.");
  assert.ok(contract.mission?.tasteNotes.some((note) => /polished, coherent, usable/.test(note)));
  assert.ok(contract.mission?.plannerSteps.some((step) => /mission intent/.test(step)));
  assert.ok(contract.mission?.plannerSteps.some((step) => /operator-visible flow/.test(step)));
  assert.ok(contract.mission?.criticChecks.some((check) => /without more handholding/.test(check)));
  assert.ok(contract.mission?.criticChecks.some((check) => /visually verified/.test(check)));
  assert.match(contract.mission?.operatorQuestionPolicy ?? "", /Ask only when/);
  assert.ok(contract.mission?.blockedConditions.some((condition) => /materially change the outcome/.test(condition)));
  assert.ok(contract.verificationMatrix.length >= contract.acceptancePoints.length);
  assert.ok(contract.verificationMatrix.some((row) => row.checkKinds.includes("responsive_review")));
  assert.ok(contract.verificationMatrix.some((row) => row.checkKinds.includes("taste_review")));
});

test("delegation contract serializes the mission planner and critic loop", () => {
  const contract = buildThreadExecutionContract({
    threadId: "thread-loop",
    workspaceCwd: "/workspace",
    projectId: "project-1",
    projectLabel: "Project One",
    branch: "main",
    taskText: "Build a polished settings UI and ask fewer questions unless a product choice is required.",
    notes: []
  });

  const text = formatDelegationContractText({
    threadId: contract.threadId,
    workspace: { cwd: contract.workspaceCwd ?? "/workspace", branchName: contract.branch },
    project: { id: contract.projectId, label: contract.projectLabel },
    contract,
    notes: contract.notes,
    requestedTask: contract.requestedTask
  });

  assert.match(text, /planner_step:/);
  assert.match(text, /critic_check:/);
  assert.match(text, /operator_question_policy:/);
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

test("structured worker evidence maps only to the claimed acceptance point and matrix row", async () => {
  const store = await createStore();
  const contract = makeContract();
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
    summary: "Recorded one point of evidence.",
    evidence: [
      {
        id: "evidence-1",
        pointId: "point-1",
        matrixRowId: "row-1",
        kind: "build",
        summary: "Build passed.",
        details: null,
        command: "npm run build",
        exitCode: 0,
        proofRunId: null,
        artifactId: null,
        route: null,
        logRef: null,
        dataRef: null,
        createdAt: Date.now()
      }
    ]
  });

  const checklist = store.getSupervisionChecklist(contract.threadId);
  assert.equal(checklist?.items[0]?.evidence.length, 1);
  assert.equal(checklist?.items[1]?.evidence.length, 0);
  assert.equal(store.getThread(contract.threadId)?.executionContract?.verificationMatrix[0]?.status, "evidence_submitted");
  assert.deepEqual(store.getThread(contract.threadId)?.executionContract?.verificationMatrix[0]?.commandRefs, ["npm run build"]);
});

test("proof review verdicts persist on proof records", async () => {
  const store = await createStore();
  const proof = makeProof("proof-review", 1000, [proofArtifact("screenshot", "Final screenshot", "final.png")]);
  const recorded = store.recordBrowserVerification({
    threadId: proof.threadId ?? "thread-1",
    projectId: proof.projectId,
    projectLabel: proof.projectLabel,
    title: proof.previewTitle,
    verification: proof.verification
  });

  const updated = store.recordPreviewProofReview(recorded.id, {
    id: "review-1",
    verdict: "credible",
    visibleState: "The final screen is visible.",
    evidence: "Screenshot shows the accepted state.",
    concern: "",
    expectedOutcome: "Show the accepted state",
    reviewedAt: 2000,
    modelId: "test-model",
    modelProvider: "test"
  });

  assert.equal(updated?.proofReviews.length, 1);
  assert.equal(updated?.proofReviews[0]?.verdict, "credible");
  assert.equal(store.getPreviewProofById(recorded.id)?.proofReviews[0]?.visibleState, "The final screen is visible.");
});

test("completed deep reports require evidence for every worker-owned matrix row", async () => {
  const store = await createStore();
  const contract = makeContract({
    proofExpectation: "none",
    proofExpectationLabel: "no explicit proof request"
  });
  store.setThreadExecutionContract(contract.threadId, contract);
  const thread = store.getThread(contract.threadId);
  assert.ok(thread);

  assert.throws(
    () => validateCompletedWorkerEvidence({ thread, evidence: [], threadProofs: [] }),
    /point-specific evidence/
  );
  assert.throws(
    () =>
      validateCompletedWorkerEvidence({
        thread,
        evidence: [workerEvidence("build", { pointId: "point-1", matrixRowId: "row-1" })],
        threadProofs: []
      }),
    /missing evidence for point-2/
  );
});

test("completed rejected-checklist follow-up reports only require evidence for rejected points", async () => {
  const store = await createStore();
  const contract = makeContract({
    proofExpectation: "none",
    proofExpectationLabel: "no explicit proof request"
  });
  store.setThreadExecutionContract(contract.threadId, contract);
  store.reviewAcceptancePoint({
    threadId: contract.threadId,
    pointId: "point-2",
    status: "rejected",
    note: "Callback evidence was missing.",
    nextInstruction: "Review the callback behavior and report evidence for this point."
  });
  const thread = store.getThread(contract.threadId);
  assert.ok(thread);

  assert.throws(
    () =>
      validateCompletedWorkerEvidence({
        thread,
        evidence: [workerEvidence("intent_review", { pointId: "point-1", matrixRowId: "row-1" })],
        threadProofs: []
      }),
    /missing evidence for point-2/
  );
  assert.doesNotThrow(() =>
    validateCompletedWorkerEvidence({
      thread,
      evidence: [workerEvidence("intent_review", { pointId: "point-2", matrixRowId: "row-2" })],
      threadProofs: []
    })
  );
});

test("completed API reports require smoke, failure-path, and runtime evidence", async () => {
  const store = await createStore();
  const contract = makeContract({
    acceptancePoints: ["Add endpoint"],
    taskCategory: "api",
    proofExpectation: "none",
    proofExpectationLabel: "no explicit proof request"
  });
  store.setThreadExecutionContract(contract.threadId, contract);
  const thread = store.getThread(contract.threadId);
  assert.ok(thread);

  assert.throws(
    () =>
      validateCompletedWorkerEvidence({
        thread,
        evidence: [workerEvidence("api_smoke")],
        threadProofs: []
      }),
    /failure-path evidence/
  );
  assert.throws(
    () =>
      validateCompletedWorkerEvidence({
        thread,
        evidence: [workerEvidence("api_smoke"), workerEvidence("negative_case")],
        threadProofs: []
      }),
    /log or runtime review evidence/
  );
  assert.doesNotThrow(() =>
    validateCompletedWorkerEvidence({
      thread,
      evidence: [workerEvidence("api_smoke"), workerEvidence("negative_case"), workerEvidence("log_review")],
      threadProofs: []
    })
  );
});

test("completed UI reports require visual proof plus responsive accessibility and taste evidence", async () => {
  const store = await createStore();
  const contract = buildThreadExecutionContract({
    threadId: "thread-ui-validation",
    workspaceCwd: "/workspace",
    projectId: "project-1",
    projectLabel: "Project One",
    branch: "main",
    taskText: "Implement the settings UI and capture browser proof.",
    requestedTask: "Implement the settings UI and capture browser proof.",
    notes: []
  });
  store.setThreadExecutionContract(contract.threadId, contract);
  const thread = store.getThread(contract.threadId);
  assert.ok(thread);
  const evidence = contract.verificationMatrix.flatMap((row, index) => [
    workerEvidence(index === 0 ? "responsive_review" : "screenshot", {
      id: `evidence-${index}-primary`,
      pointId: row.acceptancePointId,
      matrixRowId: row.id
    }),
    ...(index === 0
      ? [
          workerEvidence("accessibility_review", { id: "evidence-accessibility", pointId: row.acceptancePointId, matrixRowId: row.id }),
          workerEvidence("taste_review", { id: "evidence-taste", pointId: row.acceptancePointId, matrixRowId: row.id })
        ]
      : [])
  ]);
  const proof = makeProof("proof-1", 1000, [proofArtifact("screenshot", "Final screenshot", "final.png")], {
    threadId: contract.threadId
  });
  const textProof = makeProof("text-proof", 1000, [proofArtifact("file", "Text proof", "proof.txt")], {
    threadId: contract.threadId
  });

  assert.throws(
    () => validateCompletedWorkerEvidence({ thread, evidence, threadProofs: [] }),
    /This job asked for proof/
  );
  assert.throws(
    () => validateCompletedWorkerEvidence({ thread, evidence, threadProofs: [textProof] }),
    /Capture persisted screenshot or video proof/
  );
  assert.doesNotThrow(() => validateCompletedWorkerEvidence({ thread, evidence, threadProofs: [proof] }));
});

test("completed worker reports cannot close out until Butler accepts the checklist", async () => {
  const store = await createStore();
  const contract = makeContract();
  store.upsertThreadSummary({
    id: contract.threadId,
    status: "idle",
    cwd: contract.workspaceCwd,
    turns: [{ id: "turn-1", status: "completed", items: [] }]
  });
  store.setThreadExecutionContract(contract.threadId, contract);

  const completedReport = store.recordWorkerReport(contract.threadId, {
    turnId: "turn-1",
    status: "completed",
    summary: "All acceptance points are done.",
    details: "Trust me."
  });
  const blockedReport = store.recordWorkerReport(contract.threadId, {
    turnId: "turn-1-blocked",
    status: "blocked",
    summary: "Needs a credential.",
    details: "Cannot verify login without access."
  });

  assert.equal(evaluateOperatorCloseoutGate(store.getSupervisionChecklist(contract.threadId), completedReport).ok, false);
  assert.equal(evaluateOperatorCloseoutGate(store.getSupervisionChecklist(contract.threadId), blockedReport).ok, true);

  for (const item of store.getSupervisionChecklist(contract.threadId)?.items ?? []) {
    store.reviewAcceptancePoint({ threadId: contract.threadId, pointId: item.id, status: "accepted" });
  }

  assert.equal(evaluateOperatorCloseoutGate(store.getSupervisionChecklist(contract.threadId), completedReport).ok, true);
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

test("operator thread guard only treats tracked ids as authoritative jobs", async () => {
  const store = await createStore();
  const trackedThreadId = "019dfa69-05c4-7593-b607-c408475c6754";
  const imageReferenceId = "7259b2a1-1111-4222-8333-123456789abc";
  store.upsertThreadSummary({
    id: trackedThreadId,
    status: "idle",
    cwd: "/workspace",
    turns: [{ id: "turn-1", status: "completed", items: [] }]
  });

  const trackedGuard = buildOperatorThreadGuard(store, `Please steer ${trackedThreadId}`, null);
  assert.deepEqual(trackedGuard.explicitThreadIds, [trackedThreadId]);
  assert.equal(trackedGuard.lockedThreadId, trackedThreadId);

  const referenceGuard = buildOperatorThreadGuard(store, `Use ${imageReferenceId} and fix it`, trackedThreadId);
  assert.deepEqual(referenceGuard.explicitThreadIds, []);
  assert.equal(referenceGuard.lockedThreadId, trackedThreadId);
  assert.match(referenceGuard.contextPrompt ?? "", /none resolve to tracked Codex jobs/);

  const contextGuard = buildOperatorThreadGuard(store, "Actually use the staging account I just found.", trackedThreadId);
  assert.equal(contextGuard.lockedThreadId, trackedThreadId);
});

test("bookkeeping-only thread placeholders stay out of visible supervision", async () => {
  const store = await createStore();
  store.upsertThreadSummary({ id: "placeholder-thread" });
  store.addEvent("missing-thread", "thread/status/changed", "{\"type\":\"notLoaded\"}");
  store.setThreadStatus("missing-thread", "idle");
  store.upsertThreadSummary({
    id: "real-thread",
    status: "idle",
    cwd: "/workspace",
    turns: [{ id: "turn-1", status: "completed", items: [] }]
  });

  assert.equal(store.getThread("missing-thread"), undefined);
  assert.deepEqual(store.listThreads().map((thread) => thread.id), ["real-thread"]);
  assert.deepEqual(store.listProjectSummaries().map((project) => project.id), ["/workspace"]);
  assert.equal(store.getSupervisorSummary().totalThreads, 1);
});

test("shared root work is grouped as a workspace, not a project", async () => {
  const store = await createStore();
  store.upsertThreadSummary({
    id: "shared-thread",
    status: "idle",
    cwd: "/repos",
    turns: [{ id: "turn-1", status: "completed", items: [] }]
  });
  store.upsertThreadSummary({
    id: "repo-thread",
    status: "idle",
    cwd: "/repos/sample-app",
    turns: [{ id: "turn-1", status: "completed", items: [] }]
  });

  assert.deepEqual(resolveWorkspaceProjectInfo("/repos"), {
    id: "workspace:shared",
    label: "Shared workspace",
    kind: "workspace"
  });

  const summaries = store.listProjectSummaries().sort((left, right) => left.label.localeCompare(right.label));
  assert.deepEqual(
    summaries.map((summary) => [summary.id, summary.label, summary.kind]),
    [
      ["sample-app", "sample-app", "project"],
      ["workspace:shared", "Shared workspace", "workspace"]
    ]
  );
  assert.equal(store.getSupervisorSummary().projectCount, 1);
  assert.equal(store.getSupervisorSummary().workspaceCount, 1);
  assert.match(store.getSupervisorSummary().summary, /1 project, 1 workspace/);
});

test("project inventory lists workspace projects separately from tracked work", async () => {
  const workspaceRoot = await mkdtemp(path.join(tmpdir(), "manor-workspace-projects-"));
  await mkdir(path.join(workspaceRoot, "beta", ".git"), { recursive: true });
  await mkdir(path.join(workspaceRoot, "alpha", ".git"), { recursive: true });
  await mkdir(path.join(workspaceRoot, "plain-folder"));
  await mkdir(path.join(workspaceRoot, "nested", "gamma", ".git"), { recursive: true });
  await mkdir(path.join(workspaceRoot, ".manor-worktrees"));

  const projects = await listWorkspaceProjectDirectories(workspaceRoot);
  assert.deepEqual(
    projects.map((project) => [project.id, project.label, project.kind, project.gitBacked]),
    [
      ["alpha", "alpha", "project", true],
      ["beta", "beta", "project", true],
      ["nested", "nested", "project", false],
      ["nested/gamma", "nested/gamma", "project", true],
      ["plain-folder", "plain-folder", "project", false]
    ]
  );

  const store = await createStore();
  store.upsertThreadSummary({
    id: "shared-thread",
    status: { type: "active" },
    cwd: "/repos",
    turns: [{ id: "turn-1", status: "completed", items: [] }]
  });
  store.upsertThreadSummary({
    id: "repo-thread",
    status: "idle",
    cwd: "/repos/alpha",
    turns: [{ id: "turn-1", status: "completed", items: [] }]
  });

  const summary = buildProjectInventorySummary(projects, store.listProjectSummaries(), 10);
  assert.match(summary, /Known projects: 5/);
  assert.match(summary, /Git-backed projects: 3/);
  assert.match(summary, /Tracked workstream groups: 2/);
  assert.match(summary, /Active now: 0 project group\(s\), 1 workspace bucket\(s\)/);
});

test("completed checklists can refresh for new follow-up work", async () => {
  const store = await createStore();
  const contract = makeContract();
  store.upsertThreadSummary({
    id: contract.threadId,
    status: "active",
    cwd: contract.workspaceCwd,
    turns: [{ id: "turn-1", status: "completed", items: [] }]
  });
  store.setThreadExecutionContract(contract.threadId, contract);

  for (const item of store.getSupervisionChecklist(contract.threadId)?.items ?? []) {
    store.reviewAcceptancePoint({ threadId: contract.threadId, pointId: item.id, status: "accepted" });
  }

  const refreshed = store.refreshCompletedSupervisionChecklistForFollowup(
    contract.threadId,
    "- Add checklist refresh support\n- Cover it with tests"
  );

  assert.ok(refreshed);
  assert.equal(refreshed.reviewState, "needs_review");
  assert.deepEqual(refreshed.items.map((item) => item.text), ["Add checklist refresh support", "Cover it with tests"]);
  assert.deepEqual(refreshed.items.map((item) => item.status), ["pending", "pending"]);
});

test("incomplete checklists do not refresh for follow-up work", async () => {
  const store = await createStore();
  const contract = makeContract();
  store.setThreadExecutionContract(contract.threadId, contract);

  const refreshed = store.refreshCompletedSupervisionChecklistForFollowup(contract.threadId, "- Add another item");

  assert.equal(refreshed, null);
  assert.deepEqual(store.getSupervisionChecklist(contract.threadId)?.items.map((item) => item.text), contract.acceptancePoints);
});

test("system prompt advises focused checklist refresh for new work", async () => {
  const store = await createStore();
  const prompt = buildSystemPrompt(store, "No callbacks.");

  assert.match(prompt, /use message_job with refreshChecklist/);
  assert.match(prompt, /genuine new slice of work/);
  assert.match(prompt, /hold_job_context/);
  assert.match(prompt, /newer context for an active job/);
  assert.match(prompt, /Do not answer project inventory questions from supervisor state alone/);
  assert.match(prompt, /ask_operator: Butler-only tool/);
  assert.match(prompt, /Ask 1-3 concise structured questions/);
  assert.match(prompt, /Do not use ask_operator for work-depth selection/);
});

test("Butler callback state startup tolerates empty persisted files", () => {
  const source = readFileSync(path.resolve("src/server/butler-callback-state.ts"), "utf8");

  assert.match(source, /if \(!raw\.trim\(\)\) return;/);
  assert.match(source, /!\(error instanceof SyntaxError\)/);
});

test("system prompt biases autonomous domain resolution before job inventory", async () => {
  const store = await createStore();
  const prompt = buildSystemPrompt(store, "No callbacks.");

  assert.match(prompt, /Default to agency/);
  assert.match(prompt, /Be eager but bounded/);
  assert.match(prompt, /Resolve domain terms before job terms/);
  assert.match(prompt, /call retrieve_memory for prior naming\/context first, then list_projects/);
  assert.match(prompt, /Do not collapse real people or folders into job labels/);
});

test("system prompt routes direct Manor improvement requests to self-improvement", async () => {
  const store = await createStore();
  const prompt = buildSystemPrompt(store, "No callbacks.");
  const task = buildSelfImprovementTask({
    problem: "Improve the Butler final response UI.",
    desiredOutcome: "The operator sees timing feedback."
  });

  assert.match(prompt, /start_self_improvement/);
  assert.match(prompt, /request_manor_restart/);
  assert.match(prompt, /read_manor_restart_status/);
  assert.match(prompt, /direct Manor, Butler, Codex worker, preview, runtime broker, supervision, restart-controller, or dogfooding improvements/);
  assert.match(prompt, /missing credentials, operator approval, external outages, or app-specific bugs outside Manor/);
  assert.match(task, /If the change has any UI implication/);
  assert.match(task, /screenshot or video proof/);
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

test("contract derivation does not turn task audience prose into checklist items", () => {
  const taskText =
    "Create a polished, non-cringey PDF project brief for Joke, an early-stage frontend developer, challenging her to build a React chatbot. Research and include accurate links for: React docs, OpenRouter docs, OpenRouter account/API key docs.";

  const contract = buildThreadExecutionContract({
    threadId: "thread-brief",
    workspaceCwd: "/workspace",
    projectId: "project-1",
    projectLabel: "Project One",
    branch: null,
    taskText,
    requestedTask: taskText,
    notes: []
  });

  assert.deepEqual(contract.acceptancePoints, [
    "Include accurate links for React docs",
    "Include accurate links for OpenRouter docs",
    "Include accurate links for OpenRouter account/API key docs"
  ]);
});

test("callback review prompt keeps proof-required jobs behind evidence review", async () => {
  const store = await createStore();
  const contract = makeContract({
    acceptancePoints: ["Capture browser proof", "Confirm closeout"],
    proofExpectation: "requested",
    proofExpectationLabel: "proof requested",
    mission: {
      intent: "Ship the proof flow without making the operator inspect raw logs.",
      tasteNotes: ["The result should feel polished enough for repeated daily use."],
      plannerSteps: ["Inspect the current proof flow before changing behavior."],
      criticChecks: ["Reject completion if proof is only described in text."],
      operatorQuestionPolicy: "Ask only if the proof target is ambiguous and no safe default exists.",
      blockedConditions: ["Ask the operator if the proof target is ambiguous."]
    }
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
  assert.match(prompt, /Mission contract/);
  assert.match(prompt, /Ship the proof flow without making the operator inspect raw logs/);
  assert.match(prompt, /polished enough for repeated daily use/);
  assert.match(prompt, /Planner steps/);
  assert.match(prompt, /Inspect the current proof flow before changing behavior/);
  assert.match(prompt, /Critic checks/);
  assert.match(prompt, /Reject completion if proof is only described in text/);
  assert.match(prompt, /Operator question policy: Ask only if the proof target is ambiguous/);
  assert.match(prompt, /review_preview_proof/);
  assert.match(prompt, /If any acceptance point lacks convincing evidence/);
  assert.match(prompt, /Use reply_to_operator only when all acceptance points are accepted/);
});

test("UI-impacting contracts require visual proof", () => {
  const contract = buildThreadExecutionContract({
    threadId: "thread-ui",
    workspaceCwd: "/workspace",
    projectId: "project-1",
    projectLabel: "Project One",
    branch: "main",
    taskText: "Add task time for Butler and Codex final responses.",
    requestedTask: "Add task time for Butler and Codex final responses.",
    operatorGoal: "Final responses should include total time taken in the Butler chat.",
    notes: []
  });

  assert.equal(taskHasUiImplication(contract.requestedTask), true);
  assert.equal(contract.proofExpectation, "requested");
  assert.equal(contractRequiresVisualProof(contract), true);
  assert.match(contract.acceptancePoints.join("\n"), /Capture and surface visual proof/);
  assert.match(contract.notes.join("\n"), /UI-impacting work requires visual proof/);
});

test("visual proof policy rejects text-only file evidence", () => {
  const textOnlyProof = makeProof("text-proof", 1000, [proofArtifact("file", "verification txt", "verification.txt")]);
  const screenshotProof = makeProof("screenshot-proof", 2000, [proofArtifact("screenshot", "Final screenshot", "final.png")]);

  assert.equal(hasVisualProof([textOnlyProof]), false);
  assert.equal(hasVisualProof([textOnlyProof, screenshotProof]), true);
});

test("callback review prompt requires visual feedback for UI work", async () => {
  const store = await createStore();
  const contract = buildThreadExecutionContract({
    threadId: "thread-ui-review",
    workspaceCwd: "/workspace",
    projectId: "project-1",
    projectLabel: "Project One",
    branch: "main",
    taskText: "Polish the dashboard layout and final response footer.",
    requestedTask: "Polish the dashboard layout and final response footer.",
    operatorGoal: "The operator can see the updated UI.",
    notes: []
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
    details: "Saved a text verification transcript."
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

  assert.match(prompt, /Visual proof requirement: this job has UI implications/);
  assert.match(prompt, /screenshot or video proof/);
  assert.match(prompt, /Text-only proof can support the report, but cannot replace visual proof/);
});

test("callback review prompt includes held operator context", async () => {
  const store = await createStore();
  const contract = makeContract();
  store.upsertThreadSummary({
    id: contract.threadId,
    status: "active",
    cwd: contract.workspaceCwd,
    turns: [{ id: "turn-1", status: "completed", items: [] }]
  });
  store.setThreadExecutionContract(contract.threadId, contract);
  store.addEvent(contract.threadId, "butler.context.held", "Use the newly supplied staging account before closing.");

  const prompt = buildCallbackReviewPrompt(store, {
    threadId: contract.threadId,
    callbackState: "received_worker_callback",
    resolutionState: null,
    requestedAt: Date.now() - 1000,
    lastEventAt: Date.now(),
    lastWorkerStatusSeen: "active",
    lastTerminalReportAt: null,
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

  assert.match(prompt, /Held operator context/);
  assert.match(prompt, /newly supplied staging account/);
});

test("callback review prompt starts self-improvement for Manor platform blockers", async () => {
  const store = await createStore();
  const contract = makeContract({
    requestedTask: "Run app preview proof through Manor.",
    acceptancePoints: ["Start a preview", "Capture proof"]
  });
  store.upsertThreadSummary({
    id: contract.threadId,
    status: "idle",
    cwd: contract.workspaceCwd,
    turns: [{ id: "turn-1", status: "completed", items: [] }]
  });
  store.setThreadExecutionContract(contract.threadId, contract);
  const report = store.recordWorkerReport(contract.threadId, {
    turnId: "turn-1",
    status: "blocked",
    summary: "Preview cannot start.",
    details: "Manor platform blocker: runtime broker cleanup leaves the preview network unavailable. Need a broker retry around stale network removal."
  });
  const thread = store.getThread(contract.threadId);

  assert.equal(classifyManorBlocker({ thread, workerReport: report }).shouldInvestigate, true);

  const prompt = buildCallbackReviewPrompt(store, {
    threadId: contract.threadId,
    callbackState: "received_worker_callback",
    resolutionState: null,
    requestedAt: report.updatedAt - 1,
    lastEventAt: report.updatedAt,
    lastWorkerStatusSeen: "idle",
    lastTerminalReportAt: report.updatedAt,
    lastPrivateSteerText: null,
    lastPrivateSteerAt: null,
    nextWorkerReportAction: "review",
    operatorCloseoutStatus: "owed",
    owesOperatorReply: true,
    closeoutChannel: "none",
    reviewState: "queued",
    reviewReason: "worker_callback",
    closedAt: null,
    updatedAt: report.updatedAt
  });

  assert.match(prompt, /Manor blocker classifier: high confidence/);
  assert.match(prompt, /use start_self_improvement/);
  assert.match(prompt, /source job id and blocker summary/);
});

test("callback review prompt avoids self-improvement for operator-only blockers", async () => {
  const store = await createStore();
  const contract = makeContract({
    requestedTask: "Verify the external production dashboard through a Manor preview.",
    acceptancePoints: ["Log in", "Check dashboard"]
  });
  store.upsertThreadSummary({
    id: contract.threadId,
    status: "idle",
    cwd: contract.workspaceCwd,
    turns: [{ id: "turn-1", status: "completed", items: [] }]
  });
  store.setThreadExecutionContract(contract.threadId, contract);
  const report = store.recordWorkerReport(contract.threadId, {
    turnId: "turn-1",
    status: "blocked",
    summary: "Login is blocked.",
    details: "Need operator input: the production account requires a missing password and MFA code."
  });

  assert.equal(classifyManorBlocker({ thread: store.getThread(contract.threadId), workerReport: report }).shouldInvestigate, false);

  const prompt = buildCallbackReviewPrompt(store, {
    threadId: contract.threadId,
    callbackState: "received_worker_callback",
    resolutionState: null,
    requestedAt: report.updatedAt - 1,
    lastEventAt: report.updatedAt,
    lastWorkerStatusSeen: "idle",
    lastTerminalReportAt: report.updatedAt,
    lastPrivateSteerText: null,
    lastPrivateSteerAt: null,
    nextWorkerReportAction: "review",
    operatorCloseoutStatus: "owed",
    owesOperatorReply: true,
    closeoutChannel: "none",
    reviewState: "queued",
    reviewReason: "worker_callback",
    closedAt: null,
    updatedAt: report.updatedAt
  });

  assert.match(prompt, /Manor blocker classifier: do not start self-improvement/);
  assert.doesNotMatch(prompt, /use start_self_improvement with the source job id/);
});

test("self-improvement duplicate guard notices source blocker events", async () => {
  const store = await createStore();
  const contract = makeContract();
  store.upsertThreadSummary({
    id: contract.threadId,
    status: "idle",
    cwd: contract.workspaceCwd,
    turns: [{ id: "turn-1", status: "completed", items: [] }]
  });
  store.setThreadExecutionContract(contract.threadId, contract);

  assert.equal(hasStartedSelfImprovement(store.getThread(contract.threadId)), false);
  store.addEvent(contract.threadId, "butler.self_improvement.started", "Started Manor self-improvement job thread-2.");
  assert.equal(hasStartedSelfImprovement(store.getThread(contract.threadId)), true);
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
