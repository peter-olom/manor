import type {
  CodexInferredWorkDepth,
  MissionContractView,
  CodexProofExpectation,
  CodexTaskCategory,
  CodexThreadExecutionContractView,
  VerificationCheckKind,
  VerificationMatrixRowView
} from "./types.js";
import { normalizeRoutingDecision } from "./butler-orchestration.js";
import { acceptancePointsNeedVisualProof, taskHasUiImplication, VISUAL_PROOF_REQUIREMENT } from "./proof-policy.js";
import { buildReviewPanel, summarizeReviewPanel } from "./review-panel.js";

const MAX_ACCEPTANCE_POINTS = 24;
const DEFAULT_BLOCKED_CONDITIONS = [
  "Required credentials, secrets, operator approval, or external access are unavailable.",
  "The local build, runtime, or proof environment cannot run after focused diagnosis.",
  "A product, taste, permission, or irreversible execution choice would materially change the outcome and no safe default is available."
];
const API_PATTERN =
  /\b(api|endpoint|route|graphql|mutation|query|resolver|controller|service|backend|server|request|response|webhook|auth|database|db|schema|migration)\b/i;
const DEPLOY_PATTERN = /\b(deploy|deployment|restart|release|production|staging|live|rollback|health check|smoke prod|publish)\b/i;
const DOCS_PATTERN = /\b(doc|docs|documentation|readme|markdown|pdf|deck|slides|spreadsheet|xlsx|csv|report)\b/i;
const DATA_PATTERN = /\b(data|database|db|sql|migration|seed|analytics|metric|row|table|record|query)\b/i;
const WRITING_PATTERN = /\b(copy|writing|rewrite|caption|post|article|voice|tone|wording|message)\b/i;
const CODE_PATTERN = /\b(implement|build|fix|debug|test|refactor|code|component|function|bug|feature|land this|do the work)\b/i;
const DEEP_INTENT_PATTERN = /\b(investigate|debug|fix|implement|build|test|verify|land this|do the work|thorough|deep|smoke|proof|ship|finish)\b/i;
const READ_ONLY_PATTERN = /\b(explain|summarize|inspect|read|review|what is|what are|do you understand|can you tell|question)\b/i;
const RESEARCH_PATTERN = /\b(research|investigate|explore|study|compare|survey|look into)\b/i;
const PROTOTYPE_PATTERN = /\b(prototype|spike|proof of concept|poc|mock|experiment)\b/i;
const PLAN_PATTERN = /\b(plan|roadmap|checklist|spec|proposal|phase)\b/i;
const RECOMMENDATION_PATTERN = /\b(recommend|recommendation|decide|advise|suggest|option)\b/i;

function normalizeContractText(value: string | null | undefined): string | null {
  if (!value) {
    return null;
  }

  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized || null;
}

function normalizeContractList(values: Array<string | null | undefined>, max = 8): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const normalized = normalizeContractText(value);
    if (!normalized) {
      continue;
    }
    const key = normalized.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(normalized);
    if (result.length >= max) {
      break;
    }
  }
  return result;
}

function inferTasteNotes(taskText: string, category: CodexTaskCategory): string[] {
  const notes: string[] = [
    "Prefer simple, maintainable, production-friendly work that satisfies the operator's real intent."
  ];
  if (category === "ui" || category === "prototype") {
    notes.push("Operator-visible UI should feel polished, coherent, usable, and visually reviewed before acceptance.");
  }
  if (category === "writing" || category === "docs") {
    notes.push("Writing should preserve the concrete point first and avoid over-polished or generic phrasing.");
  }
  if (/\b(taste|style|polish|design|voice|tone|brand|look|feel|ux|ui)\b/i.test(taskText)) {
    notes.push("Treat taste and intent fit as first-class acceptance concerns, not optional cleanup.");
  }
  return notes;
}

function inferPlannerSteps(category: CodexTaskCategory): string[] {
  const steps = [
    "Restate the mission intent, hard constraints, durable taste notes, and available context before choosing work.",
    "Inspect the current repo, runtime, or source state and reuse existing project patterns before changing behavior.",
    "Choose a practical route, then execute the smallest complete slice that satisfies the mission."
  ];
  if (category === "ui" || category === "prototype") {
    steps.push("Review the operator-visible flow across the main viewport, responsive state, and fit-and-finish before claiming completion.");
  } else if (category === "deploy") {
    steps.push("Check build, release, health, and logs before treating the deployment as complete.");
  } else if (category === "api" || category === "data") {
    steps.push("Exercise success and failure paths, persistence, and logs before treating the behavior as complete.");
  } else if (category === "writing" || category === "docs" || category === "plan" || category === "recommendation") {
    steps.push("Check that the output preserves the operator's concrete point, priority, and intended audience.");
  }
  steps.push("Verify with checks that match the task category and capture the required proof.");
  steps.push("Run the critic checks, fix gaps, then package a clear decision or closeout.");
  return steps;
}

function inferCriticChecks(category: CodexTaskCategory): string[] {
  const checks = [
    "Would the operator accept this outcome without more handholding?",
    "Does the result satisfy the mission intent, not just the literal checklist?",
    "Were durable taste notes applied before and after execution?",
    "Is there convincing evidence for every acceptance point and verification row?",
    "Is the route simple, maintainable, and consistent with existing project patterns?"
  ];
  if (category === "ui" || category === "prototype") {
    checks.push("Does the visible result feel polished, coherent, usable, and visually verified?");
  } else if (category === "deploy") {
    checks.push("Do health checks and logs prove the live service is actually running the intended version?");
  } else if (category === "api" || category === "data") {
    checks.push("Were negative cases, persistence, and runtime logs checked, not just the happy path?");
  } else if (category === "writing" || category === "docs" || category === "plan" || category === "recommendation") {
    checks.push("Is the writing concrete, useful, and in the operator's preferred voice?");
  }
  return checks;
}

function buildOperatorQuestionPolicy(tasteNotes: string[]): string {
  const base =
    "Ask only when a product, taste, priority, permission, or irreversible execution choice materially changes the outcome and no safe default exists; otherwise infer from memory and context, inspect state, act, and note the decision.";
  return tasteNotes.length > 0
    ? `${base} Apply durable taste notes before asking.`
    : `${base} If taste is central and no durable note applies, ask 1-3 structured questions before delegation or final acceptance.`;
}

export function buildMissionContract(input: {
  taskText: string;
  requestedTask: string;
  operatorGoal: string | null;
  taskCategory: CodexTaskCategory;
  tasteNotes?: string[];
  plannerSteps?: string[];
  criticChecks?: string[];
  operatorQuestionPolicy?: string | null;
  blockedConditions?: string[];
}): MissionContractView {
  const tasteNotes = normalizeContractList([...(input.tasteNotes ?? []), ...inferTasteNotes(input.taskText, input.taskCategory)], 10);
  return {
    intent: normalizeContractText(input.operatorGoal) ?? normalizeContractText(input.requestedTask) ?? "Deliver the delegated outcome.",
    tasteNotes,
    plannerSteps: normalizeContractList([...(input.plannerSteps ?? []), ...inferPlannerSteps(input.taskCategory)], 8),
    criticChecks: normalizeContractList([...(input.criticChecks ?? []), ...inferCriticChecks(input.taskCategory)], 10),
    operatorQuestionPolicy:
      normalizeContractText(input.operatorQuestionPolicy) ?? buildOperatorQuestionPolicy(tasteNotes),
    blockedConditions: normalizeContractList([...(input.blockedConditions ?? []), ...DEFAULT_BLOCKED_CONDITIONS], 10)
  };
}

function deriveRequestedTask(taskText: string): string {
  return normalizeContractText(taskText) ?? "Carry out the delegated task.";
}

function normalizeAcceptancePoint(value: string): string | null {
  const normalized = value
    .replace(/^[-*]\s+/, "")
    .replace(/^\d+[.)]\s+/, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!normalized || normalized.length < 3) {
    return null;
  }
  return normalized.replace(/[.;]\s*$/, "");
}

function addListParts(listText: string, addPoint: (value: string) => void, prefix: string | null = null): void {
  for (const part of listText.split(/\s*,\s*|\s+and\s+/)) {
    addPoint(prefix ? `${prefix} ${part}` : part);
  }
}

function deriveColonListPrefix(beforeColon: string): string | null {
  const clause = beforeColon.split(/[.;]\s*/).at(-1)?.trim() ?? "";
  const includeForMatch = clause.match(/\b(?:research\s+and\s+)?include\s+(.+?)\s+for$/i);
  if (includeForMatch) {
    return `Include ${includeForMatch[1].trim()} for`;
  }
  return null;
}

export function deriveAcceptancePoints(taskText: string, requestedTask?: string | null): string[] {
  const source = [requestedTask ?? "", taskText].filter(Boolean).join("\n");
  const points: string[] = [];
  const seen = new Set<string>();
  const addPoint = (value: string): void => {
    const point = normalizeAcceptancePoint(value);
    if (!point) {
      return;
    }
    const key = point.toLowerCase();
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    points.push(point);
  };

  for (const line of source.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (/^[-*]\s+\S/.test(trimmed) || /^\d+[.)]\s+\S/.test(trimmed)) {
      addPoint(trimmed);
    }
    if (points.length >= MAX_ACCEPTANCE_POINTS) {
      return points;
    }
  }

  if (points.length > 0) {
    return points;
  }

  const sentence = normalizeContractText(requestedTask ?? taskText) ?? "";
  const colonListMatch = sentence.match(/(^|[.;]\s*|.*?\b(?:with|including|include|covering|for)\b[^.;]*):\s*([^.;]+,[^.;]+)/i);
  if (colonListMatch) {
    addListParts(colonListMatch[2], addPoint, deriveColonListPrefix(colonListMatch[1]));
  }

  const listMatch = points.length === 0 ? sentence.match(/\b(?:with|including|include|covering)\s+([^.;:]+,[^.;:]+)/i) : null;
  if (listMatch) {
    const listText = listMatch[1].replace(/^.*\be\.g\.\s*/i, "");
    addListParts(listText, addPoint);
    if (points.length >= MAX_ACCEPTANCE_POINTS) {
      return points;
    }
  }

  if (points.length === 0) {
    addPoint(deriveRequestedTask(taskText));
  }

  return points.slice(0, MAX_ACCEPTANCE_POINTS);
}

export function detectProofExpectation(taskText: string): CodexProofExpectation {
  const normalized = taskText.toLowerCase();
  return /\b(proof|artifact|artifacts|screenshot|screenshots|video|videos|record|recording|trace|capture)\b/.test(normalized) ||
    taskHasUiImplication(taskText)
    ? "requested"
    : "none";
}

export function describeProofExpectation(expectation: CodexProofExpectation): string {
  return expectation === "requested" ? "proof requested" : "no explicit proof request";
}

export function inferTaskCategory(taskText: string): CodexTaskCategory {
  const normalized = taskText.replace(/\s+/g, " ").trim();
  if (!normalized) return "unknown";
  if (DEPLOY_PATTERN.test(normalized)) return "deploy";
  if (taskHasUiImplication(normalized)) return "ui";
  if (API_PATTERN.test(normalized)) return "api";
  if (PROTOTYPE_PATTERN.test(normalized)) return "prototype";
  if (PLAN_PATTERN.test(normalized)) return "plan";
  if (RECOMMENDATION_PATTERN.test(normalized)) return "recommendation";
  if (RESEARCH_PATTERN.test(normalized)) return "research";
  if (WRITING_PATTERN.test(normalized)) return "writing";
  if (DOCS_PATTERN.test(normalized)) return "docs";
  if (DATA_PATTERN.test(normalized)) return "data";
  if (CODE_PATTERN.test(normalized)) return "generic_code";
  if (READ_ONLY_PATTERN.test(normalized)) return "read_only";
  return "unknown";
}

export function inferWorkDepth(taskText: string, category: CodexTaskCategory): CodexInferredWorkDepth {
  const normalized = taskText.replace(/\s+/g, " ").trim();
  if (!normalized) return "standard";
  if (category === "deploy") return "incident";
  if (DEEP_INTENT_PATTERN.test(normalized)) return "deep";
  if (category === "ui" || category === "api" || category === "generic_code" || category === "prototype") return "deep";
  if (category === "read_only" && READ_ONLY_PATTERN.test(normalized)) return "standard";
  return "standard";
}

function categoryCheckKinds(category: CodexTaskCategory): VerificationCheckKind[] {
  if (category === "ui") {
    return ["browser_flow", "visual_review", "responsive_review", "accessibility_review", "taste_review", "intent_review"];
  }
  if (category === "api") {
    return ["api_smoke", "negative_case", "log_review", "intent_review"];
  }
  if (category === "deploy") {
    return ["build", "deploy_health", "log_review", "intent_review"];
  }
  if (category === "docs") {
    return ["manual_waiver", "intent_review", "taste_review"];
  }
  if (category === "data") {
    return ["data_check", "negative_case", "log_review", "intent_review"];
  }
  if (category === "writing") {
    return ["intent_review", "taste_review"];
  }
  if (category === "generic_code") {
    return ["unit_test", "build", "intent_review"];
  }
  if (category === "research") {
    return ["data_check", "intent_review", "manual_waiver"];
  }
  if (category === "prototype") {
    return ["build", "browser_flow", "taste_review", "intent_review"];
  }
  if (category === "plan" || category === "recommendation") {
    return ["intent_review", "taste_review", "manual_waiver"];
  }
  return ["intent_review"];
}

function expectedEvidenceForKinds(kinds: VerificationCheckKind[]): string[] {
  const evidence = new Set<string>();
  for (const kind of kinds) {
    if (kind === "browser_flow") evidence.add("browser proof run or recorded browser session");
    else if (kind === "visual_review") evidence.add("screenshot or video showing the relevant UI state");
    else if (kind === "responsive_review") evidence.add("desktop and mobile viewport check");
    else if (kind === "accessibility_review") evidence.add("accessibility or keyboard/contrast review note");
    else if (kind === "api_smoke") evidence.add("request-level smoke result");
    else if (kind === "negative_case") evidence.add("failure-path or edge-case check");
    else if (kind === "log_review") evidence.add("runtime log review");
    else if (kind === "data_check") evidence.add("data or persistence check");
    else if (kind === "build") evidence.add("build, typecheck, or equivalent command result");
    else if (kind === "deploy_health") evidence.add("live health and route check");
    else if (kind === "taste_review") evidence.add("taste review note");
    else if (kind === "intent_review") evidence.add("intent-fit note");
    else evidence.add("focused verification result");
  }
  return [...evidence];
}

export function buildVerificationMatrix(input: {
  acceptancePoints: string[];
  taskCategory: CodexTaskCategory;
  inferredWorkDepth: CodexInferredWorkDepth;
  createdAt?: number;
}): VerificationMatrixRowView[] {
  const now = input.createdAt ?? Date.now();
  const baseKinds = categoryCheckKinds(input.taskCategory);
  return input.acceptancePoints.map((point, index) => {
    const checkKinds = [...new Set(baseKinds)];
    return {
      id: `row-${index + 1}`,
      acceptancePointId: `point-${index + 1}`,
      text: point,
      requiredChecks: checkKinds.map((kind) => kind.replace(/_/g, " ")),
      checkKinds,
      expectedEvidence: expectedEvidenceForKinds(checkKinds),
      owner: input.inferredWorkDepth === "deep" || input.inferredWorkDepth === "incident" ? "both" : "worker",
      status: "pending",
      evidenceIds: [],
      artifactRefs: [],
      commandRefs: [],
      reviewerNote: null,
      updatedAt: now
    };
  });
}

export function isSharedShellRepoBootstrapTask(taskText: string): boolean {
  const normalized = taskText.toLowerCase();
  const mentionsClone = /\b(git clone|clone(?:\s+the)?\s+github\s+repository|clone(?:\s+the)?\s+repository)\b/.test(normalized);
  const mentionsRepoRoot = /\/repos\b/.test(normalized);
  const mentionsBranchSetup =
    /\b(create|switch|checkout)\b/.test(normalized) && /\bbranch\b/.test(normalized) && /\bbutler\//.test(normalized);
  const mentionsGitStatus = /\b(default branch|working tree status|git status)\b/.test(normalized);
  const mentionsRuntime =
    /\b(start|run|serve|dev server|preview|browser|ui|playwright|screenshot|video|electron|native|desktop|headed|vnc|novnc)\b/.test(
      normalized
    );

  return mentionsClone && mentionsRepoRoot && (mentionsBranchSetup || mentionsGitStatus) && !mentionsRuntime;
}

export function buildThreadExecutionContract(input: {
  threadId: string;
  workspaceCwd: string;
  projectId: string;
  projectLabel: string;
  branch: string | null;
  taskText: string;
  requestedTask?: string;
  operatorGoal?: string | null;
  taskCategory?: CodexTaskCategory;
  inferredWorkDepth?: CodexInferredWorkDepth;
  attachmentCount?: number;
  tasteNotes?: string[];
  blockedConditions?: string[];
  notes: string[];
}): CodexThreadExecutionContractView {
  const operatorGoal = normalizeContractText(input.operatorGoal);
  const requestedTask = normalizeContractText(input.requestedTask) ?? deriveRequestedTask(input.taskText);
  const contractText = [requestedTask, operatorGoal, input.taskText].filter(Boolean).join("\n");
  const needsVisualProof = taskHasUiImplication(contractText);
  const proofExpectation = detectProofExpectation(contractText);
  const acceptancePoints = deriveAcceptancePoints(input.taskText, requestedTask);
  if (needsVisualProof && !acceptancePointsNeedVisualProof(acceptancePoints) && acceptancePoints.length < MAX_ACCEPTANCE_POINTS) {
    acceptancePoints.push("Capture and surface visual proof of the relevant UI state");
  }
  const notes = [...new Set(input.notes.map((note) => note.trim()).filter(Boolean))];
  if (needsVisualProof) {
    notes.push(VISUAL_PROOF_REQUIREMENT);
  }
  const taskCategory = input.taskCategory ?? inferTaskCategory(contractText);
  const inferredWorkDepth = input.inferredWorkDepth ?? inferWorkDepth(contractText, taskCategory);
  const mission = buildMissionContract({
    taskText: contractText,
    requestedTask,
    operatorGoal,
    taskCategory,
    tasteNotes: input.tasteNotes,
    blockedConditions: input.blockedConditions
  });
  const verificationMatrix = buildVerificationMatrix({ acceptancePoints, taskCategory, inferredWorkDepth });
  const reviewPanel = buildReviewPanel({ taskCategory, inferredWorkDepth, requestedTask, attachmentCount: input.attachmentCount ?? 0 });

  return {
    threadId: input.threadId,
    workspaceCwd: input.workspaceCwd,
    projectId: input.projectId,
    projectLabel: input.projectLabel,
    branch: input.branch,
    requestedTask,
    operatorGoal,
    acceptancePoints,
    proofExpectation,
    proofExpectationLabel: describeProofExpectation(proofExpectation),
    inferredWorkDepth,
    taskCategory,
    verificationMatrix,
    reviewPanel,
    reviewPanelSummary: summarizeReviewPanel(reviewPanel),
    mission,
    notes: [...new Set(notes)]
  };
}

export function inferThreadExecutionContract(input: {
  threadId: string;
  workspaceCwd: string;
  projectId: string;
  projectLabel: string;
  branch: string | null;
  previewText: string | null;
  latestUserPrompt: string | null;
}): CodexThreadExecutionContractView | null {
  const parsedPreviewContract = parseThreadExecutionContract(input.previewText ?? "");
  if (parsedPreviewContract) {
    return parsedPreviewContract;
  }

  const taskText = [input.latestUserPrompt ?? "", input.previewText ?? ""].filter(Boolean).join("\n");
  if (!taskText.trim()) {
    return null;
  }

  return buildThreadExecutionContract({
    threadId: input.threadId,
    workspaceCwd: input.workspaceCwd,
    projectId: input.projectId,
    projectLabel: input.projectLabel,
    branch: input.branch,
    taskText,
    notes: ["Inferred from persisted thread state."]
  });
}

function parseProofExpectation(value: string | null | undefined): CodexProofExpectation | null {
  const normalized = value?.toLowerCase().trim() ?? "";
  if (!normalized) {
    return null;
  }
  if (normalized.includes("request")) {
    return "requested";
  }
  if (normalized.includes("none")) {
    return "none";
  }
  return null;
}

export function parseThreadExecutionContract(previewText: string): CodexThreadExecutionContractView | null {
  const normalized = typeof previewText === "string" ? previewText.trim() : "";
  if (!normalized.startsWith("MANOR JOB BRIEF")) {
    return null;
  }

  const requestedTaskMarker = "\nREQUESTED TASK";
  const requestedTaskStart = normalized.indexOf(requestedTaskMarker);
  if (requestedTaskStart < 0) {
    return null;
  }

  const contractBlock = normalized.slice(0, requestedTaskStart).trim();
  const requestBlock = normalized.slice(requestedTaskStart + requestedTaskMarker.length).trim();
  const notes: string[] = [];
  const acceptancePoints: string[] = [];
  const verificationRows: string[] = [];
  const tasteNotes: string[] = [];
  const plannerSteps: string[] = [];
  const criticChecks: string[] = [];
  const blockedConditions: string[] = [];
  const subAgentRoles: string[] = [];
  const values = new Map<string, string>();

  for (const line of contractBlock.split(/\r?\n/).slice(1)) {
    const marker = line.indexOf(":");
    if (marker === -1) {
      continue;
    }
    const key = line.slice(0, marker).trim();
    const value = line.slice(marker + 1).trim();
    if (!key || !value) {
      continue;
    }
    if (key === "note") {
      notes.push(value);
      continue;
    }
    if (key === "acceptance_point") {
      const point = normalizeAcceptancePoint(value);
      if (point) {
        acceptancePoints.push(point);
      }
      continue;
    }
    if (key === "verification_row") {
      verificationRows.push(value);
      continue;
    }
    if (key === "taste_note") {
      tasteNotes.push(value);
      continue;
    }
    if (key === "planner_step") {
      plannerSteps.push(value);
      continue;
    }
    if (key === "critic_check") {
      criticChecks.push(value);
      continue;
    }
    if (key === "blocked_condition") {
      blockedConditions.push(value);
      continue;
    }
    if (key === "sub_agent_role") {
      subAgentRoles.push(value);
      continue;
    }
    values.set(key, value);
  }

  const threadId = values.get("thread_id");
  if (!threadId) {
    return null;
  }

  const requestLines = requestBlock.split("\n");
  const goalLineIndex = requestLines.findIndex((line) => line.trim().startsWith("Goal:"));
  const requestedTaskLines = goalLineIndex >= 0 ? requestLines.slice(0, goalLineIndex) : requestLines;
  const requestedTaskText = requestedTaskLines.join("\n").trim() || values.get("requested_task") || "";
  const operatorGoal =
    goalLineIndex >= 0
      ? requestLines
          .slice(goalLineIndex)
          .join("\n")
          .trim()
          .replace(/^Goal:\s*/i, "") || null
      : normalizeContractText(values.get("operator_goal") ?? null);
  const requestedTask = normalizeContractText(requestedTaskText) ?? "Carry out the delegated task.";
  const proofExpectation =
    parseProofExpectation(values.get("proof_expectation")) ?? detectProofExpectation([requestedTask, operatorGoal].filter(Boolean).join("\n"));
  const taskCategory = parseTaskCategory(values.get("task_category")) ?? inferTaskCategory([requestedTask, operatorGoal].filter(Boolean).join("\n"));
  const inferredWorkDepth =
    parseWorkDepth(values.get("inferred_work_depth")) ?? inferWorkDepth([requestedTask, operatorGoal].filter(Boolean).join("\n"), taskCategory);
  const verificationMatrix = parseVerificationMatrix(verificationRows, acceptancePoints, taskCategory, inferredWorkDepth);
  const reviewPanel = buildReviewPanel({ taskCategory, inferredWorkDepth, requestedTask, attachmentCount: 0 });
  const mission = buildMissionContract({
    taskText: [requestedTask, operatorGoal].filter(Boolean).join("\n"),
    requestedTask,
    operatorGoal,
    taskCategory,
    tasteNotes,
    plannerSteps,
    criticChecks,
    operatorQuestionPolicy: values.get("operator_question_policy") ?? null,
    blockedConditions
  });
  const missionIntent = normalizeContractText(values.get("mission_intent"));
  const codexReviewRequired = values.get("codex_review_required")?.toLowerCase() === "yes";
  const orchestration = values.has("routing_task_class")
    ? normalizeRoutingDecision({
        taskClass: values.get("routing_task_class"),
        confidence: Number(values.get("routing_confidence") ?? "0.5"),
        questionSet: [],
        goalRecommendation: {
          mode: values.get("goal_mode") ?? "none",
          goal: values.get("goal_recommendation") ?? null,
          fallbackReason: null
        },
        reviewRecommendation: {
          target: codexReviewRequired ? "codex_review" : "none",
          required: codexReviewRequired,
          reason: values.get("codex_review_reason") ?? null
        },
        subAgentRoles,
        riskLevel: values.get("routing_risk") ?? "medium",
        fallbackReason: null,
        createdAt: Date.now()
      }, taskCategory)
    : null;

  return {
    threadId,
    workspaceCwd: values.get("workspace_cwd") || null,
    projectId: values.get("project_id") || "unknown",
    projectLabel: values.get("project_label") || "Unknown",
    branch: values.get("branch") || null,
    requestedTask,
    operatorGoal,
    acceptancePoints: [...new Set(acceptancePoints)],
    proofExpectation,
    proofExpectationLabel: describeProofExpectation(proofExpectation),
    inferredWorkDepth,
    taskCategory,
    verificationMatrix,
    reviewPanel,
    reviewPanelSummary: summarizeReviewPanel(reviewPanel),
    mission: missionIntent ? { ...mission, intent: missionIntent } : mission,
    ...(orchestration ? { orchestration, reviewResults: [] } : {}),
    notes
  };
}

function parseTaskCategory(value: string | null | undefined): CodexTaskCategory | null {
  const normalized = value?.trim();
  return normalized === "ui" ||
    normalized === "api" ||
    normalized === "deploy" ||
    normalized === "docs" ||
    normalized === "data" ||
    normalized === "writing" ||
    normalized === "generic_code" ||
    normalized === "read_only" ||
    normalized === "research" ||
    normalized === "prototype" ||
    normalized === "plan" ||
    normalized === "recommendation" ||
    normalized === "unknown"
    ? normalized
    : null;
}

function parseWorkDepth(value: string | null | undefined): CodexInferredWorkDepth | null {
  const normalized = value?.trim();
  return normalized === "quick" || normalized === "standard" || normalized === "deep" || normalized === "incident" ? normalized : null;
}

function parseVerificationMatrix(
  serializedRows: string[],
  acceptancePoints: string[],
  taskCategory: CodexTaskCategory,
  inferredWorkDepth: CodexInferredWorkDepth
): VerificationMatrixRowView[] {
  if (serializedRows.length === 0) {
    return buildVerificationMatrix({ acceptancePoints, taskCategory, inferredWorkDepth });
  }
  return serializedRows.map((row, index) => {
    const [idPart, pointIdPart, kindPart, textPart] = row.split("|");
    const checkKinds = kindPart
      ?.split(",")
      .map((kind) => kind.trim())
      .filter(isVerificationCheckKind) ?? categoryCheckKinds(taskCategory);
    return {
      id: idPart?.trim() || `row-${index + 1}`,
      acceptancePointId: pointIdPart?.trim() || `point-${index + 1}`,
      text: textPart?.trim() || acceptancePoints[index] || "Verify the delegated outcome",
      requiredChecks: checkKinds.map((kind) => kind.replace(/_/g, " ")),
      checkKinds,
      expectedEvidence: expectedEvidenceForKinds(checkKinds),
      owner: inferredWorkDepth === "deep" || inferredWorkDepth === "incident" ? "both" : "worker",
      status: "pending",
      evidenceIds: [],
      artifactRefs: [],
      commandRefs: [],
      reviewerNote: null,
      updatedAt: null
    };
  });
}

function isVerificationCheckKind(value: string): value is VerificationCheckKind {
  return [
    "unit_test",
    "integration_test",
    "api_smoke",
    "browser_flow",
    "visual_review",
    "responsive_review",
    "accessibility_review",
    "log_review",
    "data_check",
    "negative_case",
    "build",
    "deploy_health",
    "taste_review",
    "intent_review",
    "manual_waiver"
  ].includes(value);
}
