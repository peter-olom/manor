import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { getOperatorCloseoutBlocker } from "../../src/server/butler-closeout-gate.js";
import { buildButlerDelegationTools } from "../../src/server/butler-agent-stack-preview-tools.js";
import { buildButlerCodexTools } from "../../src/server/butler-agent-codex-tools.js";
import { buildDelegationRoutingDecision } from "../../src/server/butler-delegation-routing.js";
import { normalizeWorkerClaimsReport } from "../../src/server/butler-orchestration.js";
import { validateCompletedWorkerEvidence } from "../../src/server/codex-harness-report-validation.js";
import { ButlerStateStore } from "../../src/server/state-store.js";
import { buildThreadExecutionContract } from "../../src/server/thread-contract.js";
import type {
  ButlerRoutingDecisionView,
  CodexThreadExecutionContractView,
  WorkerClaimsReportView,
  WorkerReviewResultRecordView
} from "../../src/server/types.js";

async function createStore(): Promise<ButlerStateStore> {
  const dir = await mkdtemp(path.join(tmpdir(), "manor-orchestration-"));
  return new ButlerStateStore(path.join(dir, "state.json"));
}

function routingDecision(overrides: Partial<ButlerRoutingDecisionView> = {}): ButlerRoutingDecisionView {
  return {
    taskClass: "generic_code",
    confidence: 0.91,
    questionSet: [],
    goalRecommendation: { mode: "none", goal: null, fallbackReason: null },
    reviewRecommendation: { target: "adversarial_review", required: true, reason: "Review required." },
    subAgentRoles: ["qa", "adversarial-review"],
    riskLevel: "high",
    fallbackReason: null,
    createdAt: 1,
    ...overrides
  };
}

function claims(overrides: Partial<WorkerClaimsReportView> = {}): WorkerClaimsReportView {
  return {
    version: 1,
    changedWorkSummary: "Implemented the delegated work.",
    claims: [
      {
        claimId: "claim-1",
        status: "completed",
        summary: "The requested behavior is complete.",
        evidencePointer: "build passed",
        proofId: null,
        riskNote: null,
        reviewerTarget: "qa"
      }
    ],
    risks: [],
    unresolvedItems: [],
    subAgentSummaries: [],
    ...overrides
  };
}

function makeContract(overrides: Partial<CodexThreadExecutionContractView> = {}): CodexThreadExecutionContractView {
  const base = buildThreadExecutionContract({
    threadId: "thread-orchestration",
    workspaceCwd: "/workspace",
    projectId: "project",
    projectLabel: "Project",
    branch: null,
    taskText: "Make a small code change and verify it.",
    taskCategory: "generic_code",
    inferredWorkDepth: "standard",
    notes: []
  });
  return {
    ...base,
    orchestration: routingDecision(),
    reviewResults: [],
    ...overrides
  };
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

function acceptChecklist(store: ButlerStateStore, threadId: string): void {
  for (const item of store.getSupervisionChecklist(threadId)?.items ?? []) {
    store.reviewAcceptancePoint({ threadId, pointId: item.id, status: "accepted" });
  }
}

test("delegation routing is derived from Butler's explicit tool call", () => {
  const apiDecision = buildDelegationRoutingDecision({ task: "Implement an API route and tests" });
  assert.equal(apiDecision.taskClass, "api");
  assert.equal(apiDecision.reviewRecommendation.target, "adversarial_review");
  assert.equal(apiDecision.reviewRecommendation.required, true);
  assert.equal(apiDecision.questionSet.length, 0);
  assert.equal(apiDecision.fallbackReason, null);

  const readOnlyDecision = buildDelegationRoutingDecision({ task: "What is the Runner setting?" });
  assert.equal(readOnlyDecision.taskClass, "read_only");
  assert.equal(readOnlyDecision.reviewRecommendation.required, true);
});

test("delegation starts worker directly with deterministic routing metadata", async () => {
  const store = await createStore();
  let capturedOrchestration: ButlerRoutingDecisionView | null = null;
  let acknowledgement = "";
  let postedQuestions = 0;
  let delegatedImageReferenceIds: string[] = [];
  let delegatedFileReferenceIds: string[] = [];
  let requestedCwd: string | undefined;
  const tool = buildButlerDelegationTools({
    prepareWorkerWorkspace: async () => undefined,
    defineButlerTool: (definition) => definition,
    getToolUiEffects: () => [],
    getWorkerDefaults: () => ({ runtime: "auto", threadId: null, cwd: "/workspace" }),
    prepareDelegationWorkspace: async (_task: string, cwd?: string) => {
      requestedCwd = cwd;
      return { cwd: "/workspace", branchName: null };
    },
    buildDelegationDeveloperInstructions: async () => "",
    buildDelegationContract: async (input: { threadId: string; orchestration?: ButlerRoutingDecisionView | null }) => {
      capturedOrchestration = input.orchestration ?? null;
      const contract = makeContract({
        threadId: input.threadId,
        workspaceCwd: "/workspace",
        orchestration: input.orchestration ?? routingDecision()
      });
      return { text: "brief", contract };
    },
    postOperatorQuestion: async () => {
      postedQuestions += 1;
      return {} as never;
    },
    codexClient: {
      getConnectionState: () => ({ compose: { model: "gpt-5-codex", effort: "medium", availableModels: [{ id: "gpt-5-codex", label: "GPT-5 Codex", provider: null, supportsReasoning: true, supportedThinkingLevels: ["medium"], supportedReasoningEfforts: ["medium"], defaultReasoningEffort: "medium" }] } }),
      updateComposeSettings: async () => undefined,
      startThread: async (input: { input: (threadId: string) => Promise<unknown> }) => {
        await input.input("thread-direct");
        return { threadId: "thread-direct" };
      }
    },
    imageStore: { resolveViews: () => [], getFilePath: () => null },
    fileStore: { resolveViews: () => [], getFilePath: () => null },
    getActiveOperatorReferences: () => ({ imageReferenceIds: ["image-current-turn"], fileReferenceIds: ["file-current-turn"] }),
    createOrUpdateJobPayload: async (input: { imageReferenceIds?: string[]; fileReferenceIds?: string[] }) => {
      delegatedImageReferenceIds = input.imageReferenceIds ?? [];
      delegatedFileReferenceIds = input.fileReferenceIds ?? [];
      return {} as never;
    },
    store,
    getCodexAuthStatus: () => ({ loggedIn: true }),
    noteThreadFocus: () => undefined,
    queueDelegationAcknowledgement: (_threadId: string, text: string) => { acknowledgement = text; },
    registerPendingChatCallback: () => undefined
  } as never).find((entry) => entry.name === "delegate_to_worker") as {
    execute: (toolCallId: string, params: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }>;
  };

  const result = await tool.execute("call-1", {
    task: "Implement the API change",
    imageReferenceIds: [],
    fileReferenceIds: ["file-explicit"]
  });
  assert.match(result.content[0]!.text, /Delegated/);
  assert.equal(capturedOrchestration?.taskClass, "api");
  assert.equal(capturedOrchestration?.reviewRecommendation.required, true);
  assert.equal(capturedOrchestration?.fallbackReason, null);
  assert.equal(postedQuestions, 0);
  assert.deepEqual(delegatedImageReferenceIds, ["image-current-turn"]);
  assert.deepEqual(delegatedFileReferenceIds, ["file-current-turn", "file-explicit"]);
  assert.equal(requestedCwd, "/workspace");
  assert.match(acknowledgement, /delegated this to a Worker/);
  assert.match(acknowledgement, /Codex harness/);
  assert.doesNotMatch(acknowledgement, /Codex worker/i);
});

test("delegation cleans up a Worker when the occupied pair rejects attachment", async () => {
  const store = await createStore();
  let deletedThreadId: string | null = null;
  let callbackRegistrations = 0;
  const tool = buildButlerDelegationTools({
    prepareWorkerWorkspace: async () => undefined,
    defineButlerTool: (definition) => definition,
    getToolUiEffects: () => [],
    prepareDelegationWorkspace: async () => ({ cwd: "/workspace", branchName: null }),
    buildDelegationDeveloperInstructions: async () => "",
    buildDelegationContract: async (input: { threadId: string }) => ({
      text: "brief",
      contract: makeContract({ threadId: input.threadId, workspaceCwd: "/workspace" })
    }),
    codexClient: {
      getConnectionState: () => ({ compose: { model: "gpt-5-codex", effort: "medium", availableModels: [{ id: "gpt-5-codex", label: "GPT-5 Codex", provider: null, supportsReasoning: true, supportedThinkingLevels: ["medium"], supportedReasoningEfforts: ["medium"], defaultReasoningEffort: "medium" }] } }),
      updateComposeSettings: async () => undefined,
      startThread: async (input: { input: (threadId: string) => Promise<unknown> }) => {
        await input.input("thread-rejected");
        return { threadId: "thread-rejected" };
      },
      deleteThread: async (threadId: string) => { deletedThreadId = threadId; return true; }
    },
    imageStore: { resolveViews: () => [], getFilePath: () => null },
    fileStore: { resolveViews: () => [], getFilePath: () => null },
    store,
    getCodexAuthStatus: () => ({ loggedIn: true }),
    noteThreadFocus: () => undefined,
    getActiveOperatorReferences: () => null,
    queueDelegationAcknowledgement: () => ({ attached: false }),
    registerPendingChatCallback: () => { callbackRegistrations += 1; }
  } as never).find((entry) => entry.name === "delegate_to_worker") as {
    execute: (toolCallId: string, params: Record<string, unknown>) => Promise<unknown>;
  };

  await assert.rejects(() => tool.execute("call-occupied", { task: "Start duplicate work" }), /already has a Worker/);
  assert.equal(deletedThreadId, "thread-rejected");
  assert.equal(callbackRegistrations, 0);
});

test("supervision smoke test stops and deletes a Worker when pair attachment is rejected", async () => {
  const store = await createStore();
  const stopped: string[] = [];
  const deleted: string[] = [];
  let callbackRegistrations = 0;
  const smokePlans = new Map();
  const tool = buildButlerDelegationTools({
    prepareWorkerWorkspace: async () => undefined,
    runtimeThreadId: "butler:pair-1",
    defineButlerTool: (definition) => definition,
    getToolUiEffects: () => [],
    buildSupervisionSmokeTask: () => "Run synthetic supervision smoke",
    buildDelegationDeveloperInstructions: async () => "",
    buildDelegationContract: async (input: { threadId: string }) => ({
      text: "brief",
      contract: makeContract({ threadId: input.threadId, workspaceCwd: "/repos" })
    }),
    codexClient: {
      getConnectionState: () => ({ compose: { model: "gpt-5-codex", effort: "medium", availableModels: [{ id: "gpt-5-codex", label: "GPT-5 Codex", provider: null, supportsReasoning: true, supportedThinkingLevels: ["medium"], supportedReasoningEfforts: ["medium"], defaultReasoningEffort: "medium" }] } }),
      updateComposeSettings: async () => undefined,
      startThread: async (input: { input: (threadId: string) => Promise<unknown> }) => {
        await input.input("thread-smoke-rejected");
        return { threadId: "thread-smoke-rejected" };
      },
      stopThread: async (threadId: string) => { stopped.push(threadId); return true; },
      deleteThread: async (threadId: string) => { deleted.push(threadId); store.removeThread(threadId); return true; }
    },
    imageStore: { resolveViews: () => [], getFilePath: () => null },
    fileStore: { resolveViews: () => [], getFilePath: () => null },
    store,
    getCodexAuthStatus: () => ({ loggedIn: true }),
    noteThreadFocus: () => undefined,
    getActiveOperatorReferences: () => null,
    queueDelegationAcknowledgement: () => ({ attached: false }),
    registerPendingChatCallback: () => { callbackRegistrations += 1; },
    supervisionSmokePlans: smokePlans
  } as never).find((entry) => entry.name === "run_supervision_smoke_test") as {
    execute: (toolCallId: string, params: Record<string, unknown>) => Promise<unknown>;
  };

  await assert.rejects(() => tool.execute("smoke-occupied", { totalFollowUps: 2 }), /stopped and deleted/);
  assert.deepEqual(stopped, ["thread-smoke-rejected"]);
  assert.deepEqual(deleted, ["thread-smoke-rejected"]);
  assert.equal(callbackRegistrations, 0);
  assert.equal(smokePlans.size, 0);
});

test("delegation contract receives the resolved workspace cwd", async () => {
  const store = await createStore();
  let capturedWorkspace: { cwd: string; branchName: string | null } | null = null;
  const tool = buildButlerDelegationTools({
    prepareWorkerWorkspace: async () => undefined,
    defineButlerTool: (definition) => definition,
    getToolUiEffects: () => [],
    prepareDelegationWorkspace: async () => ({ cwd: "/repos/project", branchName: "main" }),
    buildDelegationDeveloperInstructions: async () => "",
    buildDelegationContract: async (input: { threadId: string; workspace: { cwd: string; branchName: string | null }; orchestration?: ButlerRoutingDecisionView | null }) => {
      capturedWorkspace = input.workspace;
      return {
        text: "brief",
        contract: makeContract({
          threadId: input.threadId,
          workspaceCwd: input.workspace.cwd,
          branch: input.workspace.branchName,
          orchestration: input.orchestration ?? routingDecision()
        })
      };
    },
    codexClient: {
      getConnectionState: () => ({ compose: { model: "gpt-5-codex", effort: "medium", availableModels: [{ id: "gpt-5-codex", label: "GPT-5 Codex", provider: null, supportsReasoning: true, supportedThinkingLevels: ["medium"], supportedReasoningEfforts: ["medium"], defaultReasoningEffort: "medium" }] } }),
      updateComposeSettings: async () => undefined,
      startThread: async (input: { input: (threadId: string) => Promise<unknown> }) => {
        await input.input("thread-resolved-cwd");
        return { threadId: "thread-resolved-cwd" };
      }
    },
    imageStore: { resolveViews: () => [], getFilePath: () => null },
    fileStore: { resolveViews: () => [], getFilePath: () => null },
    store,
    getCodexAuthStatus: () => ({ loggedIn: true }),
    noteThreadFocus: () => undefined,
    getActiveOperatorReferences: () => null,
    queueDelegationAcknowledgement: () => undefined,
    registerPendingChatCallback: () => undefined
  } as never).find((entry) => entry.name === "delegate_to_worker") as {
    execute: (toolCallId: string, params: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }>;
  };

  await tool.execute("call-1", { task: "Implement the API change", cwd: "/repos/.manor-worktrees/project/stale" });
  assert.equal(capturedWorkspace?.cwd, "/repos/project");
  assert.equal(capturedWorkspace?.branchName, "main");
});

test("shared repository bootstrap delegation keeps the bootstrap note", async () => {
  let capturedNotes: string[] | undefined;
  const store = await createStore();
  const tool = buildButlerDelegationTools({
    prepareWorkerWorkspace: async () => undefined,
    defineButlerTool: (definition) => definition,
    getToolUiEffects: () => [],
    prepareDelegationWorkspace: async () => ({ cwd: "/repos", branchName: null }),
    buildDelegationDeveloperInstructions: async () => "",
    buildDelegationContract: async (input: { threadId: string; extraNotes?: string[] }) => {
      capturedNotes = input.extraNotes;
      const contract = makeContract({ threadId: input.threadId, workspaceCwd: "/repos" });
      return { text: "brief", contract };
    },
    codexClient: {
      getConnectionState: () => ({ compose: { model: "gpt-5-codex", effort: "medium", availableModels: [{ id: "gpt-5-codex", label: "GPT-5 Codex", provider: null, supportsReasoning: true, supportedThinkingLevels: ["medium"], supportedReasoningEfforts: ["medium"], defaultReasoningEffort: "medium" }] } }),
      updateComposeSettings: async () => undefined,
      startThread: async (input: { input: (threadId: string) => Promise<unknown> }) => {
        await input.input("thread-cap");
        return { threadId: "thread-cap" };
      }
    },
    imageStore: { resolveViews: () => [], getFilePath: () => null },
    fileStore: { resolveViews: () => [], getFilePath: () => null },
    store,
    getCodexAuthStatus: () => ({ loggedIn: true }),
    noteThreadFocus: () => undefined,
    getActiveOperatorReferences: () => null,
    queueDelegationAcknowledgement: () => undefined,
    registerPendingChatCallback: () => undefined
  } as never).find((entry) => entry.name === "delegate_to_worker") as {
    execute: (toolCallId: string, params: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }>;
  };

  const result = await tool.execute("call-1", {
    task: "Clone the repository into /repos, check git status, and create branch butler/bootstrap"
  });
  assert.match(result.content[0]!.text, /Delegated/);
  assert.ok(capturedNotes?.some((note) => /shared \/repos workspace/.test(note)));
});

test("completed orchestrated reports accept simple summaries without claims", async () => {
  const store = await createStore();
  const contract = makeContract();
  createThread(store, contract);
  const thread = store.getThread(contract.threadId)!;

  assert.doesNotThrow(() => validateCompletedWorkerEvidence({ thread, evidence: [], threadProofs: [] }));
  assert.doesNotThrow(() => validateCompletedWorkerEvidence({ thread, evidence: [], threadProofs: [], claims: claims() }));
});

test("strict JSON claims reject unknown statuses", () => {
  assert.equal(
    normalizeWorkerClaimsReport({
      changed_work_summary: "Implemented the delegated work.",
      claims: [
        {
          claim_id: "claim-1",
          status: "done",
          summary: "The requested behavior is complete.",
          evidence_pointer: "build passed"
        }
      ]
    }),
    null
  );
});

test("strict JSON claims reject mixed malformed claims", () => {
  assert.equal(
    normalizeWorkerClaimsReport({
      changed_work_summary: "Implemented the delegated work.",
      claims: [
        {
          claim_id: "claim-1",
          status: "completed",
          summary: "The requested behavior is complete.",
          evidence_pointer: "build passed"
        },
        {
          claim_id: "claim-2",
          status: "done",
          summary: "Malformed status should invalidate the report.",
          evidence_pointer: "review"
        }
      ]
    }),
    null
  );
});

test("review gate requires a completed adversarial review and blocks serious findings", async () => {
  const store = await createStore();
  const contract = makeContract();
  createThread(store, contract);
  const report = store.recordWorkerReport(contract.threadId, {
    turnId: "turn-1",
    status: "completed",
    summary: "Done.",
    details: null,
    claims: claims()
  });
  acceptChecklist(store, contract.threadId);

  assert.match(getOperatorCloseoutBlocker(store, contract.threadId) ?? "", /Adversarial review must finish/);

  const blocking: WorkerReviewResultRecordView = {
    id: "review-blocking",
    reviewSource: "adversarial_review",
    turnId: report.turnId,
    reportUpdatedAt: report.updatedAt,
    severity: "high",
    findingSummary: "Missing failure-path verification.",
    blocking: true,
    waived: false,
    waiverReason: null,
    linkedClaimIds: ["claim-1"],
    modelProvider: "openai-codex",
    modelId: "gpt-5.5",
    reasoningLevel: "high",
    createdAt: 1,
    updatedAt: 1
  };
  store.recordWorkerReviewResults(contract.threadId, [blocking]);
  assert.match(getOperatorCloseoutBlocker(store, contract.threadId) ?? "", /Missing failure-path verification/);

  store.recordWorkerReviewResults(contract.threadId, [{ ...blocking, id: "review-waived", waived: true, waiverReason: "Operator accepted risk." }]);
  assert.match(getOperatorCloseoutBlocker(store, contract.threadId) ?? "", /Missing failure-path verification/);

  const store2 = await createStore();
  const contract2 = makeContract({ threadId: "thread-nonserious" });
  createThread(store2, contract2);
  const report2 = store2.recordWorkerReport(contract2.threadId, {
    turnId: "turn-1",
    status: "completed",
    summary: "Done.",
    details: null,
    claims: claims()
  });
  acceptChecklist(store2, contract2.threadId);
  store2.recordWorkerReviewResults(contract2.threadId, [
    {
      ...blocking,
      id: "review-note",
      turnId: report2.turnId,
      reportUpdatedAt: report2.updatedAt,
      severity: "low",
      findingSummary: "Minor naming note.",
      blocking: false
    }
  ]);
  assert.equal(getOperatorCloseoutBlocker(store2, contract2.threadId), null);
});

test("Butler can disprove a blocking review finding from stronger evidence", async () => {
  const store = await createStore();
  const contract = makeContract();
  createThread(store, contract);
  const report = store.recordWorkerReport(contract.threadId, { turnId: "turn-1", status: "completed", summary: "Done.", details: null, claims: claims() });
  acceptChecklist(store, contract.threadId);
  store.recordWorkerReviewResults(contract.threadId, [{
    id: "review-false-positive",
    reviewSource: "adversarial_review",
    turnId: report.turnId,
    reportUpdatedAt: report.updatedAt,
    severity: "high",
    findingSummary: "The failure path is untested.",
    blocking: true,
    waived: false,
    waiverReason: null,
    linkedClaimIds: [],
    modelProvider: "openai-codex",
    modelId: "gpt-5.5",
    reasoningLevel: "high",
    createdAt: 1,
    updatedAt: 1
  }]);
  const tool = buildButlerCodexTools({
    defineButlerTool: (definition) => definition,
    getToolUiEffects: () => [],
    store
  } as never).find((entry) => entry.name === "disprove_review_finding") as { execute: (id: string, params: Record<string, unknown>) => Promise<unknown> };

  await tool.execute("call-1", {
    threadId: contract.threadId,
    findingId: "review-false-positive",
    evidence: "The persisted integration run contains the asserted 500 response."
  });

  assert.equal(getOperatorCloseoutBlocker(store, contract.threadId), null);
  const finding = store.getThread(contract.threadId)?.executionContract?.reviewResults?.find((entry) => entry.id === "review-false-positive");
  assert.equal(finding?.waived, true);
  assert.match(finding?.waiverReason ?? "", /persisted integration run/);
});

test("thread summary refresh preserves orchestration and review results", async () => {
  const store = await createStore();
  const contract = makeContract();
  createThread(store, contract);
  const review: WorkerReviewResultRecordView = {
    id: "review-preserved",
    reviewSource: "adversarial_review",
    turnId: "turn-1",
    reportUpdatedAt: 12,
    severity: "info",
    findingSummary: "No actionable findings.",
    blocking: false,
    waived: false,
    waiverReason: null,
    linkedClaimIds: [],
    modelProvider: "openai-codex",
    modelId: "gpt-5.5",
    reasoningLevel: "high",
    createdAt: 1,
    updatedAt: 1
  };
  store.recordWorkerReviewResults(contract.threadId, [review]);

  store.upsertThreadSummary({
    id: contract.threadId,
    status: "idle",
    cwd: contract.workspaceCwd,
    preview: "Updated thread preview"
  });

  const refreshed = store.getThread(contract.threadId)?.executionContract;
  assert.equal(refreshed?.orchestration?.taskClass, "generic_code");
  assert.equal(refreshed?.reviewResults?.[0]?.id, "review-preserved");
});

test("sub-agent summaries are normalized without raw transcript requirements", () => {
  const normalized = normalizeWorkerClaimsReport({
    version: 1,
    changed_work_summary: "Completed research and implementation.",
    claims: [
      {
        claim_id: "claim-1",
        status: "completed",
        summary: "Research findings were applied.",
        evidence_pointer: "sub-agent summary: researcher",
        proof_id: null,
        risk_note: null,
        reviewer_target: "product"
      }
    ],
    sub_agent_summaries: [{ role: "researcher", summary: "Compared options and found the simpler path.", evidence_pointer: "research-note" }]
  });

  assert.equal(normalized?.subAgentSummaries.length, 1);
  assert.equal(normalized?.subAgentSummaries[0]?.role, "researcher");
});
