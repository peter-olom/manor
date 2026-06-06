import type { CodexProofExpectation, CodexThreadExecutionContractView } from "./types.js";
import { acceptancePointsNeedVisualProof, taskHasUiImplication, VISUAL_PROOF_REQUIREMENT } from "./proof-policy.js";

const MAX_ACCEPTANCE_POINTS = 24;

function normalizeContractText(value: string | null | undefined): string | null {
  if (!value) {
    return null;
  }

  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized || null;
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
    notes
  };
}
