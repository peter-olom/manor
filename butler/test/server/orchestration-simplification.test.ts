import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { getOperatorCloseoutBlocker } from "../../src/server/butler-closeout-gate.js";
import { formatDelegationContractText } from "../../src/server/butler-agent-delegation-contract.js";
import { buildButlerDelegationTools } from "../../src/server/butler-agent-stack-preview-tools.js";
import { normalizeWorkerClaimsReport } from "../../src/server/butler-orchestration.js";
import { ButlerRoutingClassifier } from "../../src/server/butler-routing-classifier.js";
import { validateCompletedWorkerEvidence } from "../../src/server/codex-harness-report-validation.js";
import { ButlerStateStore } from "../../src/server/state-store.js";
import { buildThreadExecutionContract } from "../../src/server/thread-contract.js";
import { CodexWorkerReviewService } from "../../src/server/worker-codex-review.js";
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
    reviewRecommendation: { target: "codex_review", required: true, reason: "Risk-based review required." },
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

test("routing classifier returns strict decisions for common task classes", async () => {
  const stateDir = await mkdtemp(path.join(tmpdir(), "manor-routing-classifier-"));
  const outputs = [
    routingDecision({ taskClass: "trivial", reviewRecommendation: { target: "none", required: false, reason: null }, riskLevel: "low" }),
    routingDecision({ taskClass: "ui", goalRecommendation: { mode: "native_goal", goal: "Complete the UI workflow", fallbackReason: null } }),
    routingDecision({ taskClass: "api" }),
    routingDecision({ taskClass: "deploy", riskLevel: "critical" }),
    routingDecision({ taskClass: "research", subAgentRoles: ["researcher", "critic"] })
  ];
  const service = new ButlerRoutingClassifier({
    stateDir,
    codexHomeDir: stateDir,
    runner: async () => outputs.shift()!
  });

  assert.equal((await service.classify({ task: "What time is it?", cwd: "/tmp" })).taskClass, "trivial");
  assert.equal((await service.classify({ task: "Build the settings UI", cwd: "/tmp" })).goalRecommendation.mode, "native_goal");
  assert.equal((await service.classify({ task: "Add an API route", cwd: "/tmp" })).taskClass, "api");
  assert.equal((await service.classify({ task: "Deploy to staging", cwd: "/tmp" })).riskLevel, "critical");
  assert.deepEqual((await service.classify({ task: "Research options", cwd: "/tmp" })).subAgentRoles, ["researcher", "critic"]);
});

test("routing classifier falls back from native goal when capability is unavailable", async () => {
  const stateDir = await mkdtemp(path.join(tmpdir(), "manor-routing-goal-"));
  const service = new ButlerRoutingClassifier({
    stateDir,
    codexHomeDir: stateDir,
    runner: async () => routingDecision({ goalRecommendation: { mode: "native_goal", goal: "Finish the long job", fallbackReason: null } })
  });

  const decision = await service.classify({ task: "Long multi-phase implementation", cwd: "/tmp", goalModeAvailable: false });
  assert.equal(decision.goalRecommendation.mode, "contract_fallback");
  assert.match(decision.goalRecommendation.fallbackReason ?? "", /Native goal mode/);
});

test("routing classifier rejects malformed decisions", async () => {
  const stateDir = await mkdtemp(path.join(tmpdir(), "manor-routing-malformed-"));
  const service = new ButlerRoutingClassifier({
    stateDir,
    codexHomeDir: stateDir,
    runner: async () => ({})
  });

  await assert.rejects(
    () => service.classify({ task: "Implement something", cwd: "/tmp" }),
    /invalid JSON/
  );
});

test("classifier failure posts structured operator questions instead of delegating", async () => {
  const questions: unknown[] = [];
  let questionRounds = 0;
  const tool = buildButlerDelegationTools({
    defineButlerTool: (definition) => definition,
    getToolUiEffects: () => [],
    classifyDelegationRoute: async () => {
      throw new Error("bad classifier output");
    },
    prepareDelegationWorkspace: async () => ({ cwd: "/workspace", branchName: null }),
    getDelegationQuestionRoundCount: () => questionRounds,
    noteDelegationQuestionRound: () => {
      questionRounds += 1;
      return questionRounds;
    },
    postOperatorQuestion: async (input) => {
      questions.push(input);
      return {} as never;
    }
  } as never).find((entry) => entry.name === "delegate_to_codex") as {
    execute: (toolCallId: string, params: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }>;
  };

  const result = await tool.execute("call-1", { task: "Implement something" });
  assert.match(result.content[0]!.text, /Routing classifier failed/);
  assert.equal(questions.length, 1);
});

test("classifier failure delegates with heuristic assumptions after operator proceed", async () => {
  const store = await createStore();
  let questionRounds = 1;
  let capturedOrchestration: ButlerRoutingDecisionView | null = null;
  const tool = buildButlerDelegationTools({
    defineButlerTool: (definition) => definition,
    getToolUiEffects: () => [],
    classifyDelegationRoute: async () => {
      throw new Error("classifier timeout");
    },
    getDelegationQuestionRoundCount: () => questionRounds,
    noteDelegationQuestionRound: () => {
      questionRounds += 1;
      return questionRounds;
    },
    clearDelegationQuestionRounds: () => {
      questionRounds = 0;
    },
    prepareDelegationWorkspace: async () => ({ cwd: "/workspace", branchName: null }),
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
    codexClient: {
      startThread: async (input: { input: (threadId: string) => Promise<unknown> }) => {
        await input.input("thread-fallback");
        return { threadId: "thread-fallback" };
      }
    },
    imageStore: { resolveViews: () => [], getFilePath: () => null },
    fileStore: { resolveViews: () => [], getFilePath: () => null },
    store,
    noteThreadFocus: () => undefined,
    queueDelegationAcknowledgement: () => undefined,
    registerPendingChatCallback: () => undefined
  } as never).find((entry) => entry.name === "delegate_to_codex") as {
    execute: (toolCallId: string, params: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }>;
  };

  const result = await tool.execute("call-1", { task: "Implement the API change" });
  assert.match(result.content[0]!.text, /Delegated/);
  assert.match(capturedOrchestration?.fallbackReason ?? "", /classifier timeout/);
  assert.equal(capturedOrchestration?.reviewRecommendation.required, true);
  assert.equal(questionRounds, 0);
});

test("delegation classifier receives the resolved workspace cwd", async () => {
  const store = await createStore();
  let classifierCwd: string | null = null;
  const tool = buildButlerDelegationTools({
    defineButlerTool: (definition) => definition,
    getToolUiEffects: () => [],
    prepareDelegationWorkspace: async () => ({ cwd: "/repos/project", branchName: "main" }),
    classifyDelegationRoute: async (input: { cwd: string }) => {
      classifierCwd = input.cwd;
      return routingDecision();
    },
    getDelegationQuestionRoundCount: () => 0,
    clearDelegationQuestionRounds: () => undefined,
    buildDelegationDeveloperInstructions: async () => "",
    buildDelegationContract: async (input: { threadId: string; orchestration?: ButlerRoutingDecisionView | null }) => ({
      text: "brief",
      contract: makeContract({
        threadId: input.threadId,
        workspaceCwd: "/repos/project",
        branch: "main",
        orchestration: input.orchestration ?? routingDecision()
      })
    }),
    codexClient: {
      startThread: async (input: { input: (threadId: string) => Promise<unknown> }) => {
        await input.input("thread-resolved-cwd");
        return { threadId: "thread-resolved-cwd" };
      }
    },
    imageStore: { resolveViews: () => [], getFilePath: () => null },
    fileStore: { resolveViews: () => [], getFilePath: () => null },
    store,
    noteThreadFocus: () => undefined,
    queueDelegationAcknowledgement: () => undefined,
    registerPendingChatCallback: () => undefined
  } as never).find((entry) => entry.name === "delegate_to_codex") as {
    execute: (toolCallId: string, params: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }>;
  };

  await tool.execute("call-1", { task: "Implement the API change", cwd: "/repos/.manor-worktrees/project/stale" });
  assert.equal(classifierCwd, "/repos/project");
});

test("structured question soft cap proceeds with stated assumptions", async () => {
  let postedQuestions = 0;
  let capturedNotes: string[] | undefined;
  const store = await createStore();
  const tool = buildButlerDelegationTools({
    defineButlerTool: (definition) => definition,
    getToolUiEffects: () => [],
    classifyDelegationRoute: async () =>
      routingDecision({
        questionSet: [
          {
            id: "q1",
            prompt: "Which deploy target?",
            context: null,
            options: [
              { id: "staging", label: "Staging", description: null },
              { id: "prod", label: "Production", description: null }
            ],
            allowFreeform: true
          }
        ]
      }),
    getDelegationQuestionRoundCount: () => 3,
    noteDelegationQuestionRound: () => {
      postedQuestions += 1;
      return postedQuestions;
    },
    clearDelegationQuestionRounds: () => undefined,
    postOperatorQuestion: async () => {
      postedQuestions += 1;
      return {} as never;
    },
    prepareDelegationWorkspace: async () => ({ cwd: "/workspace", branchName: null }),
    buildDelegationDeveloperInstructions: async () => "",
    buildDelegationContract: async (input: { threadId: string; extraNotes?: string[] }) => {
      capturedNotes = input.extraNotes;
      const contract = makeContract({ threadId: input.threadId, workspaceCwd: "/workspace" });
      return { text: "brief", contract };
    },
    codexClient: {
      startThread: async (input: { input: (threadId: string) => Promise<unknown> }) => {
        await input.input("thread-cap");
        return { threadId: "thread-cap" };
      }
    },
    imageStore: { resolveViews: () => [], getFilePath: () => null },
    fileStore: { resolveViews: () => [], getFilePath: () => null },
    store,
    noteThreadFocus: () => undefined,
    queueDelegationAcknowledgement: () => undefined,
    registerPendingChatCallback: () => undefined
  } as never).find((entry) => entry.name === "delegate_to_codex") as {
    execute: (toolCallId: string, params: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }>;
  };

  const result = await tool.execute("call-1", { task: "Deploy this change" });
  assert.match(result.content[0]!.text, /Delegated/);
  assert.equal(postedQuestions, 0);
  assert.ok(capturedNotes?.some((note) => /soft cap/.test(note)));
});

test("completed orchestrated reports require strict JSON claims", async () => {
  const store = await createStore();
  const contract = makeContract();
  createThread(store, contract);
  const thread = store.getThread(contract.threadId)!;

  assert.throws(
    () => validateCompletedWorkerEvidence({ thread, evidence: [], threadProofs: [] }),
    /strict JSON claims/
  );
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

test("review gate blocks missing or serious findings and allows non-serious findings", async () => {
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

  assert.match(getOperatorCloseoutBlocker(store, contract.threadId) ?? "", /Codex review is required/);

  const blocking: WorkerReviewResultRecordView = {
    id: "review-blocking",
    reviewSource: "codex_review",
    turnId: report.turnId,
    reportUpdatedAt: report.updatedAt,
    severity: "high",
    findingSummary: "Missing failure-path verification.",
    blocking: true,
    waived: false,
    waiverReason: null,
    linkedClaimIds: ["claim-1"],
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

test("thread summary refresh preserves orchestration and review results", async () => {
  const store = await createStore();
  const contract = makeContract();
  createThread(store, contract);
  const review: WorkerReviewResultRecordView = {
    id: "review-preserved",
    reviewSource: "codex_review",
    turnId: "turn-1",
    reportUpdatedAt: 12,
    severity: "info",
    findingSummary: "No actionable findings.",
    blocking: false,
    waived: false,
    waiverReason: null,
    linkedClaimIds: [],
    createdAt: 1,
    updatedAt: 1
  };
  store.recordWorkerReviewResults(contract.threadId, [review]);
  const currentContract = store.getThread(contract.threadId)!.executionContract!;
  const preview = formatDelegationContractText({
    threadId: contract.threadId,
    workspace: { cwd: contract.workspaceCwd, branchName: contract.branch },
    project: { id: contract.projectId, label: contract.projectLabel },
    contract: currentContract,
    notes: currentContract.notes,
    requestedTask: currentContract.requestedTask
  });

  store.upsertThreadSummary({
    id: contract.threadId,
    status: "idle",
    cwd: contract.workspaceCwd,
    preview
  });

  const refreshed = store.getThread(contract.threadId)?.executionContract;
  assert.equal(refreshed?.orchestration?.taskClass, "generic_code");
  assert.equal(refreshed?.reviewResults?.[0]?.id, "review-preserved");
});

test("failed Codex review is persisted as a retryable blocking review result", async () => {
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
  const stateDir = await mkdtemp(path.join(tmpdir(), "manor-review-failed-"));
  const service = new CodexWorkerReviewService({
    store,
    stateDir,
    codexHomeDir: stateDir,
    runner: async () => {
      throw new Error("review service unavailable");
    }
  });

  service.reviewWorkerReportAsync(report);
  await new Promise((resolve) => setTimeout(resolve, 10));

  const results = store.getThread(contract.threadId)?.executionContract?.reviewResults ?? [];
  assert.equal(results.length, 1);
  assert.equal(results[0]?.blocking, true);
  assert.equal(results[0]?.automationFailure, true);
  assert.match(results[0]?.findingSummary ?? "", /review service unavailable/);
});

test("automation-failure review results do not suppress retry", async () => {
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
  store.recordWorkerReviewResults(contract.threadId, [
    {
      id: "review-turn-1-failed",
      reviewSource: "codex_review",
      turnId: report.turnId,
      reportUpdatedAt: report.updatedAt,
      severity: "high",
      findingSummary: "Codex review automation failed.",
      blocking: true,
      waived: false,
      waiverReason: null,
      automationFailure: true,
      linkedClaimIds: ["claim-1"],
      createdAt: 1,
      updatedAt: 1
    }
  ]);
  const stateDir = await mkdtemp(path.join(tmpdir(), "manor-review-retry-"));
  let runs = 0;
  const service = new CodexWorkerReviewService({
    store,
    stateDir,
    codexHomeDir: stateDir,
    runner: async () => {
      runs += 1;
      return { findings: [] };
    }
  });

  await service.reviewWorkerReport(report);

  assert.equal(runs, 1);
  const results = store.getThread(contract.threadId)?.executionContract?.reviewResults ?? [];
  assert.equal(results.some((result) => result.automationFailure !== true && result.reportUpdatedAt === report.updatedAt), true);
  acceptChecklist(store, contract.threadId);
  assert.equal(getOperatorCloseoutBlocker(store, contract.threadId), null);
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
