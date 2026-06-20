import { describeProofExpectation } from "./thread-contract.js";
import type { CodexThreadExecutionContractView } from "./types.js";

export function formatDelegationContractText(input: {
  threadId: string;
  workspace: { cwd: string; branchName: string | null };
  project: { id: string; label: string };
  contract: CodexThreadExecutionContractView;
  notes: string[];
  requestedTask: string;
}): string {
  const lines = [
    "MANOR JOB BRIEF",
    `thread_id: ${input.threadId}`,
    `workspace_cwd: ${input.workspace.cwd}`,
    `project_id: ${input.project.id}`,
    `project_label: ${input.project.label}`,
    `branch: ${input.workspace.branchName ?? "(existing workspace)"}`,
    `harness_binding: manor-harness --thread ${input.threadId}`,
    `proof_expectation: ${describeProofExpectation(input.contract.proofExpectation)}`,
    `task_category: ${input.contract.taskCategory}`,
    `inferred_work_depth: ${input.contract.inferredWorkDepth}`
  ];

  if (input.contract.mission) {
    lines.push(`mission_intent: ${input.contract.mission.intent}`);
    lines.push(...input.contract.mission.tasteNotes.map((note) => `taste_note: ${note}`));
    lines.push(...input.contract.mission.plannerSteps.map((step) => `planner_step: ${step}`));
    lines.push(...input.contract.mission.criticChecks.map((check) => `critic_check: ${check}`));
    lines.push(`operator_question_policy: ${input.contract.mission.operatorQuestionPolicy}`);
    lines.push(...input.contract.mission.blockedConditions.map((condition) => `blocked_condition: ${condition}`));
  }
  lines.push(...input.contract.acceptancePoints.map((point) => `acceptance_point: ${point}`));
  lines.push(
    ...input.contract.verificationMatrix.map(
      (row) => `verification_row: ${row.id}|${row.acceptancePointId ?? ""}|${row.checkKinds.join(",")}|${row.text}`
    )
  );
  if (input.contract.operatorGoal) lines.push(`operator_goal: ${input.contract.operatorGoal}`);
  lines.push(...input.notes.map((note) => `note: ${note}`));
  return `${lines.join("\n")}\n\nREQUESTED TASK\n${input.requestedTask}`;
}
