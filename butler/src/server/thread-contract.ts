import type { CodexExecutionMode, CodexPreviewLane, CodexThreadExecutionContractView } from "./types.js";

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

function deriveSuccessConditions(input: {
  executionMode: CodexExecutionMode;
  proofRequired: boolean;
  operatorGoal: string | null;
}): string[] {
  const conditions = [
    "The requested task is materially completed and the result matches the operator ask.",
    input.executionMode === "live-remote-runtime"
      ? "Verification is tied to the live deployed target, not a local substitute."
      : "Verification stays on the assigned Manor workspace or preview path.",
    "A concise supervisor report is recorded before the worker finishes."
  ];

  if (input.operatorGoal) {
    conditions.push(`The result satisfies this goal: ${input.operatorGoal}`);
  }

  if (input.proofRequired) {
    conditions.push("Persisted runtime proof is gathered before reporting completion.");
  }

  return conditions;
}

function deriveStopConditions(input: { proofRequired: boolean }): string[] {
  const conditions = [
    "Do not switch execution mode or runtime strategy inside the same job thread.",
    "Do not treat shared-shell bootstrap alone as a valid reason to block a runtime task while a preview path remains untried."
  ];

  if (input.proofRequired) {
    conditions.push("Do not report completion without the required proof bundle.");
  }

  return conditions;
}

function deriveEscalationConditions(): string[] {
  return [
    "Escalate when operator input is required to choose between materially different paths.",
    "Escalate when auth, secrets, policy, or environment limits block progress after normal recovery attempts.",
    "Escalate when risk or uncertainty could change the claimed outcome."
  ];
}

export function requiresPersistedProof(taskText: string): boolean {
  const normalized = taskText.toLowerCase();

  if (
    /\b(playwright|screenshot|video|trace|headful|browser|ui|frontend|visual|proof bundle|proof review)\b/.test(normalized)
  ) {
    return true;
  }

  if (/\bverify\b/.test(normalized) && /\b(browser|ui|page|screen|visual|frontend|mailpit|proof)\b/.test(normalized)) {
    return true;
  }

  if (/\bsmoke(?:\s+test)?\b/.test(normalized) && /\b(browser|ui|page|screen|frontend|visual|proof)\b/.test(normalized)) {
    return true;
  }

  return false;
}

export function isSharedShellRepoBootstrapTask(taskText: string): boolean {
  const normalized = taskText.toLowerCase();
  const mentionsClone = /\b(git clone|clone(?:\s+the)?\s+github\s+repository|clone(?:\s+the)?\s+repository)\b/.test(normalized);
  const mentionsRepoRoot = /\/repos\b/.test(normalized);
  const mentionsBranchSetup =
    /\b(create|switch|checkout)\b/.test(normalized) && /\bbranch\b/.test(normalized) && /\bbutler\//.test(normalized);
  const mentionsGitStatus = /\b(default branch|working tree status|git status)\b/.test(normalized);
  const mentionsRuntime = /\b(start|run|serve|dev server|preview|browser|ui|playwright|screenshot|video)\b/.test(normalized);

  return mentionsClone && mentionsRepoRoot && (mentionsBranchSetup || mentionsGitStatus) && !mentionsRuntime;
}

export function detectExecutionMode(text: string): CodexExecutionMode {
  const normalized = text.toLowerCase();
  if (
    /live deployed|live deployment|production|prod\b|staging\b|already-online deployment|https?:\/\/|inuoja\.com/.test(normalized)
  ) {
    return "live-remote-runtime";
  }

  if (
    /checkout|branch|worktree|preview|mailpit|manor stack|local runtime|this branch|inuoja project|smoke test|proof/.test(normalized)
  ) {
    return "local-manor-runtime";
  }

  return "unspecified";
}

export function describeExecutionMode(mode: CodexExecutionMode): string {
  switch (mode) {
    case "local-manor-runtime":
      return "local Manor branch runtime";
    case "live-remote-runtime":
      return "live deployed runtime";
    default:
      return "unspecified runtime";
  }
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
  const executionMode = detectExecutionMode(input.taskText);
  const proofRequired = requiresPersistedProof(input.taskText);
  const previewLane: CodexPreviewLane = proofRequired ? "expected" : "available";
  const operatorGoal = normalizeContractText(input.operatorGoal);
  const requestedTask = normalizeContractText(input.requestedTask) ?? deriveRequestedTask(input.taskText);

  return {
    threadId: input.threadId,
    workspaceCwd: input.workspaceCwd,
    projectId: input.projectId,
    projectLabel: input.projectLabel,
    branch: input.branch,
    executionMode,
    executionModeLabel: describeExecutionMode(executionMode),
    previewLane,
    proofRequired,
    operatorAcknowledgementRequired: false,
    operatorCallbackRequired: false,
    requestedTask,
    operatorGoal,
    successConditions: deriveSuccessConditions({ executionMode, proofRequired, operatorGoal }),
    stopConditions: deriveStopConditions({ proofRequired }),
    escalationConditions: deriveEscalationConditions(),
    notes: [...new Set(input.notes.map((note) => note.trim()).filter(Boolean))]
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

export function parseThreadExecutionContract(previewText: string): CodexThreadExecutionContractView | null {
  const normalized = typeof previewText === "string" ? previewText.trim() : "";
  if (!normalized.startsWith("AUTHORITATIVE JOB CONTRACT")) {
    return null;
  }

  const requestedTaskMarker = "\nREQUESTED TASK";
  const requestedTaskStart = normalized.indexOf(requestedTaskMarker);
  const contractBlock = requestedTaskStart >= 0 ? normalized.slice(0, requestedTaskStart).trim() : normalized;
  const requestBlock = requestedTaskStart >= 0 ? normalized.slice(requestedTaskStart + requestedTaskMarker.length).trim() : "";
  const notes: string[] = [];
  const successConditions: string[] = [];
  const stopConditions: string[] = [];
  const escalationConditions: string[] = [];
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
    if (key === "success_condition") {
      successConditions.push(value);
      continue;
    }
    if (key === "stop_condition") {
      stopConditions.push(value);
      continue;
    }
    if (key === "escalation_condition") {
      escalationConditions.push(value);
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
  const requestedTask = requestedTaskLines.join("\n").trim() || values.get("requested_task") || "";
  const operatorGoal =
    goalLineIndex >= 0
      ? requestLines
          .slice(goalLineIndex)
          .join("\n")
          .trim()
          .replace(/^Goal:\s*/i, "") || null
      : normalizeContractText(values.get("operator_goal") ?? null);

  const executionModeLabel = values.get("execution_mode") || describeExecutionMode("unspecified");
  const executionMode = detectExecutionMode(executionModeLabel);
  const previewLaneRaw = values.get("preview_lane") || "";
  const previewLane: CodexPreviewLane = /expected/i.test(previewLaneRaw) ? "expected" : "available";
  const proofRequiredRaw = values.get("proof_required");
  const proofRequired = proofRequiredRaw ? /^yes$/i.test(proofRequiredRaw) : previewLane === "expected";
  const operatorAcknowledgementRaw = values.get("operator_acknowledgement");
  const operatorAcknowledgementRequired = operatorAcknowledgementRaw ? /^required$/i.test(operatorAcknowledgementRaw) : false;
  const operatorCallbackRaw = values.get("operator_callback");
  const operatorCallbackRequired = operatorCallbackRaw ? /^required$/i.test(operatorCallbackRaw) : false;

  return {
    threadId,
    workspaceCwd: values.get("workspace_cwd") || null,
    projectId: values.get("project_id") || "unknown",
    projectLabel: values.get("project_label") || "Unknown",
    branch: values.get("branch") || null,
    executionMode,
    executionModeLabel,
    previewLane,
    proofRequired,
    operatorAcknowledgementRequired,
    operatorCallbackRequired,
    requestedTask: normalizeContractText(requestedTask) ?? "Carry out the delegated task.",
    operatorGoal,
    successConditions:
      successConditions.length > 0
        ? successConditions
        : deriveSuccessConditions({ executionMode, proofRequired, operatorGoal }),
    stopConditions: stopConditions.length > 0 ? stopConditions : deriveStopConditions({ proofRequired }),
    escalationConditions: escalationConditions.length > 0 ? escalationConditions : deriveEscalationConditions(),
    notes
  };
}
