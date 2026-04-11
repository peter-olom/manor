import type { CodexExecutionLane, CodexProofMode, CodexThreadExecutionContractView } from "./types.js";

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
  executionLane: CodexExecutionLane;
  proofMode: CodexProofMode;
  operatorGoal: string | null;
}): string[] {
  const conditions = [
    "The requested task is materially completed and the result matches the operator ask.",
    input.executionLane === "live-remote-runtime"
      ? "Verification is tied to the live deployed target, not a local substitute."
      : input.executionLane === "preview-runtime"
        ? "Verification stays on the assigned Manor preview path."
        : "Verification stays on the assigned Manor workspace or shared-shell host path.",
    "A concise supervisor report is recorded before the worker finishes."
  ];

  if (input.operatorGoal) {
    conditions.push(`The result satisfies this goal: ${input.operatorGoal}`);
  }

  if (input.proofMode === "ui") {
    conditions.push("Persisted runtime proof is gathered before reporting completion.");
  } else if (input.proofMode === "operational") {
    conditions.push("Operational verification is recorded before reporting completion.");
  }

  return conditions;
}

function deriveStopConditions(input: { executionLane: CodexExecutionLane; proofMode: CodexProofMode }): string[] {
  const conditions = ["Do not switch execution lane or runtime strategy inside the same job thread."];

  if (input.executionLane === "preview-runtime") {
    conditions.push("Do not treat shared-shell bootstrap alone as a valid reason to block a preview-runtime task while the preview path remains untried.");
  }

  if (input.proofMode === "ui") {
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

export function detectProofMode(taskText: string): CodexProofMode {
  const normalized = taskText.toLowerCase();

  if (
    /\b(playwright|screenshot|video|trace|headful|browser|ui|frontend|visual|proof bundle|proof review)\b/.test(normalized)
  ) {
    return "ui";
  }

  if (/\bverify\b/.test(normalized) && /\b(browser|ui|page|screen|visual|frontend|proof)\b/.test(normalized)) {
    return "ui";
  }

  if (/\bsmoke(?:\s+test)?\b/.test(normalized) && /\b(browser|ui|page|screen|frontend|visual|proof)\b/.test(normalized)) {
    return "ui";
  }

  if (
    /\b(verify|verification|smoke(?:\s+test)?|check|confirm|validate|test)\b/.test(normalized) &&
    /\b(api|endpoint|health|status|log|logs|process|processes|mailpit|email|inbox|delivery|smtp)\b/.test(normalized)
  ) {
    return "operational";
  }

  return "none";
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

export function detectExecutionLane(
  taskText: string,
  options?: {
    repoPrefersHostRuntime?: boolean;
  }
): CodexExecutionLane {
  const normalized = taskText.toLowerCase();

  if (
    /live deployed|live deployment|production|prod\b|staging\b|already-online deployment|https?:\/\/|inuoja\.com/.test(normalized)
  ) {
    return "live-remote-runtime";
  }

  if (isSharedShellRepoBootstrapTask(taskText)) {
    return "shared-shell-bootstrap";
  }

  if (options?.repoPrefersHostRuntime) {
    return "shared-shell-host-runtime";
  }

  if (
    /\b(start|run|serve|dev server|preview|browser|ui|playwright|screenshot|video|install|dependency|dependencies|bootstrap|logs?|process(?:es)?|mailpit|runtime)\b/.test(
      normalized
    )
  ) {
    return "preview-runtime";
  }

  return "shared-shell-bootstrap";
}

export function describeExecutionLane(lane: CodexExecutionLane): string {
  switch (lane) {
    case "shared-shell-bootstrap":
      return "shared shell bootstrap or repo work";
    case "shared-shell-host-runtime":
      return "shared shell host runtime";
    case "preview-runtime":
      return "preview runtime";
    case "live-remote-runtime":
      return "live deployed runtime";
  }
}

export function describeProofMode(proofMode: CodexProofMode): string {
  switch (proofMode) {
    case "ui":
      return "headed UI proof";
    case "operational":
      return "operational verification";
    default:
      return "no persisted proof";
  }
}

export function buildThreadExecutionContract(input: {
  threadId: string;
  workspaceCwd: string;
  projectId: string;
  projectLabel: string;
  branch: string | null;
  taskText: string;
  executionLane?: CodexExecutionLane;
  proofMode?: CodexProofMode;
  requestedTask?: string;
  operatorGoal?: string | null;
  notes: string[];
}): CodexThreadExecutionContractView {
  const executionLane = input.executionLane ?? detectExecutionLane(input.taskText);
  const proofMode = input.proofMode ?? detectProofMode(input.taskText);
  const operatorGoal = normalizeContractText(input.operatorGoal);
  const requestedTask = normalizeContractText(input.requestedTask) ?? deriveRequestedTask(input.taskText);

  return {
    threadId: input.threadId,
    workspaceCwd: input.workspaceCwd,
    projectId: input.projectId,
    projectLabel: input.projectLabel,
    branch: input.branch,
    executionLane,
    executionLaneLabel: describeExecutionLane(executionLane),
    proofMode,
    proofModeLabel: describeProofMode(proofMode),
    operatorAcknowledgementRequired: false,
    operatorCallbackRequired: false,
    requestedTask,
    operatorGoal,
    successConditions: deriveSuccessConditions({ executionLane, proofMode, operatorGoal }),
    stopConditions: deriveStopConditions({ executionLane, proofMode }),
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

function parseExecutionLane(value: string | null | undefined): CodexExecutionLane | null {
  const normalized = value?.toLowerCase().trim() ?? "";
  if (!normalized) {
    return null;
  }
  if (normalized.includes("live")) {
    return "live-remote-runtime";
  }
  if (normalized.includes("host")) {
    return "shared-shell-host-runtime";
  }
  if (normalized.includes("preview")) {
    return "preview-runtime";
  }
  if (normalized.includes("shared shell") || normalized.includes("bootstrap")) {
    return "shared-shell-bootstrap";
  }
  return null;
}

function parseProofMode(value: string | null | undefined): CodexProofMode | null {
  const normalized = value?.toLowerCase().trim() ?? "";
  if (!normalized) {
    return null;
  }
  if (normalized.includes("ui")) {
    return "ui";
  }
  if (normalized.includes("operational")) {
    return "operational";
  }
  if (normalized.includes("none")) {
    return "none";
  }
  return null;
}

export function parseThreadExecutionContract(previewText: string): CodexThreadExecutionContractView | null {
  const normalized = typeof previewText === "string" ? previewText.trim() : "";
  if (!normalized.startsWith("AUTHORITATIVE JOB CONTRACT")) {
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
  const taskContext = [requestedTask, operatorGoal].filter(Boolean).join("\n");
  const executionLane = parseExecutionLane(values.get("execution_lane")) ?? detectExecutionLane(taskContext);
  const proofMode = parseProofMode(values.get("proof_mode")) ?? detectProofMode(taskContext);
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
    executionLane,
    executionLaneLabel: describeExecutionLane(executionLane),
    proofMode,
    proofModeLabel: describeProofMode(proofMode),
    operatorAcknowledgementRequired,
    operatorCallbackRequired,
    requestedTask,
    operatorGoal,
    successConditions:
      successConditions.length > 0
        ? successConditions
        : deriveSuccessConditions({ executionLane, proofMode, operatorGoal }),
    stopConditions: stopConditions.length > 0 ? stopConditions : deriveStopConditions({ executionLane, proofMode }),
    escalationConditions: escalationConditions.length > 0 ? escalationConditions : deriveEscalationConditions(),
    notes
  };
}
