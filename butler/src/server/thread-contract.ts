import type { CodexExecutionMode, CodexPreviewLane, CodexThreadExecutionContractView } from "./types.js";

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
  notes: string[];
}): CodexThreadExecutionContractView {
  const executionMode = detectExecutionMode(input.taskText);
  const proofRequired = /playwright|proof|screenshot|video|verify|browser|ui|smoke/i.test(input.taskText);
  const previewLane: CodexPreviewLane = proofRequired ? "expected" : "available";

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

  const notes: string[] = [];
  const values = new Map<string, string>();
  for (const line of normalized.split(/\r?\n/)) {
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
    values.set(key, value);
  }

  const threadId = values.get("thread_id");
  if (!threadId) {
    return null;
  }

  const executionModeLabel = values.get("execution_mode") || describeExecutionMode("unspecified");
  const executionMode = detectExecutionMode(executionModeLabel);
  const previewLaneRaw = values.get("preview_lane") || "";
  const previewLane: CodexPreviewLane = /expected/i.test(previewLaneRaw) ? "expected" : "available";
  const proofRequiredRaw = values.get("proof_required");
  const proofRequired = proofRequiredRaw ? /^yes$/i.test(proofRequiredRaw) : previewLane === "expected";

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
    notes
  };
}
