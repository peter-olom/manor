import { promises as fs } from "node:fs";

import type { CodexThreadRecord, CodexWorkerReportView } from "./types.js";

const MANOR_WORKSPACE_CWD = "/repos/manor";
const SHARED_WORKSPACE_CWD = "/repos";

const MANOR_PLATFORM_TERMS = [
  "manor",
  "butler",
  "codex-box",
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
  "codex-box",
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

export async function resolveManorSelfImprovementCwd(): Promise<string> {
  try {
    await fs.access(MANOR_WORKSPACE_CWD);
    return MANOR_WORKSPACE_CWD;
  } catch {
    return SHARED_WORKSPACE_CWD;
  }
}

export function hasStartedSelfImprovement(thread: CodexThreadRecord | null | undefined): boolean {
  return Boolean(thread?.eventLog.some((entry) => entry.method === "butler.self_improvement.started"));
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
  problem: string;
  desiredOutcome?: string | null;
  sourceThread?: CodexThreadRecord | null;
  workerReport?: CodexWorkerReportView | null;
  classification?: ManorBlockerClassification | null;
}): string {
  const sourceThread = input.sourceThread ?? null;
  const workerReport = input.workerReport ?? null;
  const classification = input.classification ?? null;
  const sections = [
    "Manor self-improvement job.",
    "",
    "Problem:",
    input.problem.trim(),
    "",
    input.desiredOutcome?.trim() ? `Desired outcome:\n${input.desiredOutcome.trim()}\n` : null,
    sourceThread ? `Source job: ${sourceThread.id}` : null,
    sourceThread ? `Source project: ${sourceThread.supervisor.projectLabel}` : null,
    workerReport ? `Blocked report summary: ${workerReport.summary}` : null,
    workerReport?.details ? `Blocked report details: ${workerReport.details}` : null,
    classification ? `Blocker classification: ${classification.confidence} - ${classification.reason}` : null,
    "",
    "Execution requirements:",
    "- Work on Manor itself.",
    "- If the Manor checkout is already available, create or use a fresh dedicated branch or worktree for this issue.",
    "- If the Manor checkout is missing and the job starts in the shared workspace, clone the Manor repository first, then create a fresh dedicated branch.",
    "- Inspect the current implementation before editing.",
    "- Keep the fix small, explicit, and production-friendly.",
    "- Add focused regression coverage for the behavior.",
    "- Run the relevant tests and the Butler build when practical.",
    "- If the change has any UI implication, capture and surface screenshot or video proof of the relevant UI state; text logs or TXT/file proof alone are insufficient.",
    "- Do not restart, deploy, or mutate the live Manor stack unless the operator explicitly asks.",
    "- Do not include secrets, tokens, private URLs, or sensitive proof artifacts in the branch or pull request.",
    "- Commit the implementation with a clear multi-line message.",
    "- Push the branch and open a draft pull request against the default branch.",
    "",
    "Report back with:",
    "- What changed.",
    "- Tests and build checks run.",
    "- Draft pull request URL.",
    "- Any remaining risk or live-restart requirement."
  ].filter((entry): entry is string => Boolean(entry));

  return sections.join("\n");
}

export function buildSelfImprovementReviewInstruction(input: {
  classification: ManorBlockerClassification;
  alreadyStarted: boolean;
}): string {
  if (!input.classification.shouldInvestigate) {
    return `Manor blocker classifier: do not start self-improvement. ${input.classification.reason}`;
  }

  if (input.alreadyStarted) {
    return "Manor blocker classifier: a self-improvement job has already been started for this source blocker. Do not start another one unless the operator explicitly asks.";
  }

  return [
    `Manor blocker classifier: ${input.classification.confidence} confidence. ${input.classification.reason}`,
    "Before posting the blocked closeout, use start_self_improvement with the source job id and blocker summary so a separate Codex job investigates Manor and opens a draft PR.",
    "After the tool succeeds, use reply_to_operator to explain the blocker and mention that a self-improvement job was started."
  ].join("\n");
}
