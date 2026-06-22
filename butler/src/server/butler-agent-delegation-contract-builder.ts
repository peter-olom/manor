import { promises as fs } from "node:fs";

import { extractWorkspaceMentions } from "./butler-agent-helpers.js";
import { formatDelegationContractText } from "./butler-agent-delegation-contract.js";
import { findDurableOperatorTasteNotes } from "./butler-agent-operator-question.js";
import { formatProjectPolicyContextLines } from "./project-artifacts-policies.js";
import { resolveExistingWorkspaceCwd, resolveWorkspaceProjectInfo } from "./repo-worktree.js";
import type { ButlerStateStore } from "./state-store.js";
import { buildThreadExecutionContract, isSharedShellRepoBootstrapTask } from "./thread-contract.js";
import type { ButlerRoutingDecisionView, CodexThreadExecutionContractView } from "./types.js";

export async function buildButlerDelegationContract(options: {
  store: ButlerStateStore;
  threadId: string;
  task: string;
  goal?: string;
  workspace: { cwd: string; branchName: string | null };
  extraNotes?: string[];
  orchestration?: ButlerRoutingDecisionView | null;
}): Promise<{ text: string; contract: CodexThreadExecutionContractView }> {
  const requestedTask = options.goal ? `${options.task}\n\nGoal: ${options.goal}` : options.task;
  const requestedTaskOnly = options.task.trim();
  const operatorGoal = options.goal?.trim() ? options.goal.trim() : null;
  const project = resolveWorkspaceProjectInfo(options.workspace.cwd);
  const notes = ["Use this job brief if older task text points at a stale workspace or branch."];

  for (const mention of extractWorkspaceMentions(requestedTask).filter((entry) => entry !== options.workspace.cwd)) {
    const resolvedMention = await resolveExistingWorkspaceCwd(mention);
    const mentionExists = await fs.access(resolvedMention).then(() => true).catch(() => false);
    if (!mentionExists) notes.push(`Ignore stale workspace hint ${mention}. Use ${options.workspace.cwd} instead.`);
    else if (resolvedMention !== mention && resolvedMention === options.workspace.cwd) notes.push(`The task referenced ${mention}, but the live workspace resolves to ${options.workspace.cwd}.`);
  }

  if (options.extraNotes?.length) notes.push(...options.extraNotes);
  if (options.orchestration?.goalRecommendation.mode === "native_goal") notes.push("Use native Codex goal mode for this long or multi-phase job when the worker surface supports it.");
  else if (options.orchestration?.goalRecommendation.mode === "contract_fallback") notes.push(`Use the goal recommendation as a compact worker contract: ${options.orchestration.goalRecommendation.fallbackReason ?? "native goal mode was not available"}.`);
  if (options.orchestration?.reviewRecommendation.required) notes.push(`Butler will run a Codex review before acceptance: ${options.orchestration.reviewRecommendation.reason ?? "risk-based review required"}.`);
  if (options.orchestration?.subAgentRoles.length) notes.push(`Run sub-agents inside the worker thread for these roles and return only distilled summaries: ${options.orchestration.subAgentRoles.join(", ")}.`);
  if (isSharedShellRepoBootstrapTask(requestedTaskOnly)) notes.push("This job begins in the shared /repos workspace. Create or clone the repo first, then continue inside it.");

  const durableTasteNotes = findDurableOperatorTasteNotes(options.store.listButlerMemory());
  if (durableTasteNotes.length > 0) notes.push(...durableTasteNotes.map((note) => `Durable operator taste: ${note}`));
  const projectPolicyLines = formatProjectPolicyContextLines({ store: options.store, projectId: project.id });
  if (projectPolicyLines.length > 1) notes.push(...projectPolicyLines.slice(1));

  const baseContract = buildThreadExecutionContract({
    threadId: options.threadId,
    workspaceCwd: options.workspace.cwd,
    projectId: project.id,
    projectLabel: project.label,
    branch: options.workspace.branchName,
    taskText: requestedTask,
    requestedTask: requestedTaskOnly,
    operatorGoal,
    tasteNotes: durableTasteNotes,
    notes
  });
  const contract: CodexThreadExecutionContractView = {
    ...baseContract,
    requestedTask: requestedTaskOnly,
    operatorGoal,
    ...(options.orchestration ? { orchestration: options.orchestration, reviewResults: [] } : {}),
    notes: [...new Set(notes.map((note) => note.trim()).filter(Boolean))]
  };
  return {
    text: formatDelegationContractText({ threadId: options.threadId, workspace: options.workspace, project, contract, notes, requestedTask }),
    contract
  };
}
