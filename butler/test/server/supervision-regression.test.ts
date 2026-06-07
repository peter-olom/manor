import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import {
  buildCallbackReviewPrompt,
  buildChatCallbackText,
  buildFallbackChatCallbackText,
  buildOperatorThreadGuard,
  buildProofsByThreadMap,
  buildProjectInventorySummary,
  buildSystemPrompt,
  isCallbackOutstanding,
  selectReviewableProofArtifacts
} from "../../src/server/butler-agent-helpers.js";
import { MANOR_RESTART_CONFIRMATION_PHRASE } from "../../src/server/manor-restart-confirmation.js";
import { listWorkspaceProjectDirectories, resolveWorkspaceProjectInfo } from "../../src/server/repo-worktree.js";
import { ButlerStateStore } from "../../src/server/state-store.js";
import { evaluateOperatorCloseoutGate } from "../../src/server/supervision-checklist.js";
import { buildThreadExecutionContract } from "../../src/server/thread-contract.js";
import type { ButlerThreadCallbackView, CodexThreadExecutionContractView, PreviewProofRecordView } from "../../src/server/types.js";

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
});

test("system prompt exposes exact Manor restart confirmation phrase", async () => {
  const store = await createStore();
  const prompt = buildSystemPrompt(store, "No callbacks.");

  assert.match(prompt, /restart\/update controller confirmation phrase is exactly/);
  assert.match(prompt, new RegExp(MANOR_RESTART_CONFIRMATION_PHRASE));
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
