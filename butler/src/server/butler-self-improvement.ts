import type { CodexThreadRecord, CodexWorkerReportView } from "./types.js";
import type { SelfImprovementRequestView } from "../shared/self-improvement.js";

const MANOR_PLATFORM_TERMS = [
  "manor",
  "butler",
  "worker",
  "codex box",
  "shared codex",
  "manor-harness",
  "harness binding",
  "runtime broker",
  "preview",
  "preview isolate",
  "stack lease",
  "service lease",
  "service template",
  "desktop proof",
  "egress",
  "install guard",
  "install-guard",
  "supervision",
  "worker callback",
  "proof artifact",
  "scratch pad",
  "self-improvement",
  "self improvement",
  "host controller",
  "restart controller"
];

const OPERATOR_ONLY_TERMS = [
  "need operator",
  "operator input",
  "credential",
  "secret",
  "api key",
  "password",
  "access token",
  "2fa",
  "mfa",
  "captcha",
  "approval",
  "billing",
  "license",
  "permission denied"
];

const STRONG_PLATFORM_TERMS = [
  "manor platform blocker",
  "runtime broker",
  "manor-harness",
  "harness binding",
  "install guard",
  "install-guard",
  "shared codex",
  "worker",
  "butler",
  "supervision",
  "worker callback",
  "proof artifact",
  "desktop proof",
  "host controller",
  "restart controller"
];

export type ManorBlockerClassification = {
  shouldInvestigate: boolean;
  confidence: "none" | "low" | "medium" | "high";
  reason: string;
  matchedTerms: string[];
};

function normalizeText(value: string | null | undefined): string {
  return (value ?? "").toLowerCase().replace(/\s+/g, " ").trim();
}

function includesAny(text: string, terms: string[]): string[] {
  return terms.filter((term) => text.includes(term));
}

export function classifyManorBlocker(input: {
  thread: CodexThreadRecord | null | undefined;
  workerReport: CodexWorkerReportView | null | undefined;
}): ManorBlockerClassification {
  const report = input.workerReport;
  if (report?.status !== "blocked") {
    return {
      shouldInvestigate: false,
      confidence: "none",
      reason: "No blocked worker report is available.",
      matchedTerms: []
    };
  }

  const contract = input.thread?.executionContract ?? null;
  const reportText = normalizeText([report.summary, report.details, input.thread?.supervisor.latestAgentReply].filter(Boolean).join("\n"));
  const contextText = normalizeText(
    [
      contract?.requestedTask,
      contract?.operatorGoal,
      ...(contract?.acceptancePoints ?? []),
      ...(contract?.notes ?? [])
    ]
      .filter(Boolean)
      .join("\n")
  );
  const text = [reportText, contextText].filter(Boolean).join("\n");
  const matchedTerms = includesAny(text, MANOR_PLATFORM_TERMS);
  if (matchedTerms.length === 0) {
    return {
      shouldInvestigate: false,
      confidence: "none",
      reason: "The blocker does not appear to involve Manor platform behavior.",
      matchedTerms
    };
  }

  const reportPlatformTerms = includesAny(reportText, MANOR_PLATFORM_TERMS);
  const operatorOnlyTerms = includesAny(reportText, OPERATOR_ONLY_TERMS);
  const strongPlatformTerms = includesAny(reportText, STRONG_PLATFORM_TERMS);
  if (operatorOnlyTerms.length > 0 && strongPlatformTerms.length === 0) {
    return {
      shouldInvestigate: false,
      confidence: "low",
      reason: `The blocker looks like operator-provided access is required: ${operatorOnlyTerms.slice(0, 3).join(", ")}.`,
      matchedTerms
    };
  }
  const platformSpecific = reportPlatformTerms.length > 0 || matchedTerms.some((term) => term.includes("manor") || term.includes("butler") || term.includes("runtime") || term.includes("harness"));

  return {
    shouldInvestigate: true,
    confidence: platformSpecific ? "high" : "medium",
    reason: `The blocker mentions Manor platform surfaces: ${matchedTerms.slice(0, 5).join(", ")}.`,
    matchedTerms
  };
}

export function buildSelfImprovementTask(input: {
  problem?: string;
  desiredOutcome?: string | null;
  request?: SelfImprovementRequestView | null;
  sourceThread?: CodexThreadRecord | null;
  workerReport?: CodexWorkerReportView | null;
  classification?: ManorBlockerClassification | null;
}): string {
  const request = input.request ?? null;
  const sourceThread = input.sourceThread ?? null;
  const workerReport = input.workerReport ?? null;
  const classification = input.classification ?? null;
  const problem = request?.trigger ?? input.problem ?? "";
  const sections = [
    "Approved Manor self-improvement session.",
    request ? `Request id: ${request.id}` : null,
    "",
    "Problem:",
    problem.trim(),
    "",
    request ? `Symptoms:\n${request.symptoms}` : null,
    request?.logs ? `Logs:\n${request.logs}` : null,
    request ? `Observations:\n${request.observations}` : null,
    request ? `Suspected cause:\n${request.suspectedCause}` : null,
    request ? `Proposed change:\n${request.proposedChange}` : null,
    request ? `Risk:\n${request.risk}` : null,
    (request?.desiredOutcome ?? input.desiredOutcome)?.trim() ? `Desired outcome:\n${(request?.desiredOutcome ?? input.desiredOutcome)?.trim()}\n` : null,
    request?.operatorContext ? `Additional operator context:\n${request.operatorContext}` : null,
    request?.sourceThreadId ? `Source job: ${request.sourceThreadId}` : sourceThread ? `Source job: ${sourceThread.id}` : null,
    request?.sourceProjectLabel ? `Source project: ${request.sourceProjectLabel}` : sourceThread ? `Source project: ${sourceThread.supervisor.projectLabel}` : null,
    workerReport ? `Blocked report summary: ${workerReport.summary}` : null,
    workerReport?.details ? `Blocked report details: ${workerReport.details}` : null,
    classification ? `Blocker classification: ${classification.confidence} - ${classification.reason}` : null,
    "",
    "Execution requirements:",
    "- Work on Manor itself.",
    "- Work directly in the active Manor source checkout prepared for this request.",
    "- Leave changes uncommitted so the operator can inspect, test, continue editing, or commit later.",
    "- Stay in the existing checkout. Do not create or switch branches unless the operator explicitly asks.",
    "- Inspect the current implementation before editing.",
    "- Keep the fix small, explicit, and production-friendly.",
    "- Add focused regression coverage for the behavior.",
    "- Run the relevant tests and the Butler build when practical.",
    "- Choose proof that directly demonstrates the change. Frontend work usually needs screenshots or video plus test output; operational work may be better shown with command transcripts, logs, or diffs.",
    "- Do not restart Manor directly. Report whether a source restart is needed so Butler can request operator authorization.",
    "- Do not deploy, commit, push, or open a pull request unless the operator explicitly asks after reviewing the local result.",
    "- Do not include secrets, tokens, private URLs, or sensitive proof artifacts in the branch or pull request.",
    "",
    "Report back with:",
    "- What changed.",
    "- Tests and build checks run.",
    "- The active source checkout and branch.",
    "- Any remaining risk or live-restart requirement.",
    "- Whether the result should stay open, be closed, be committed, or receive more review."
  ].filter((entry): entry is string => Boolean(entry));

  return sections.join("\n");
}

export function buildSelfImprovementReviewInstruction(input: {
  classification: ManorBlockerClassification;
  alreadyQueued: boolean;
}): string {
  if (!input.classification.shouldInvestigate) {
    return `Manor blocker classifier: do not start self-improvement. ${input.classification.reason}`;
  }

  if (input.alreadyQueued) {
    return "Manor blocker classifier: a self-improvement request already exists for this source blocker. Do not create another one unless the operator explicitly asks.";
  }

  return [
    `Manor blocker classifier: ${input.classification.confidence} confidence. ${input.classification.reason}`,
    "Before posting the blocked closeout, use request_self_improvement with the source job id, symptoms, logs, observations, suspected cause, proposed change, and risk so the operator can review it in the queue.",
    "After the tool succeeds, use reply_to_operator to explain the blocker and mention that a self-improvement request is waiting for operator approval."
  ].join("\n");
}
