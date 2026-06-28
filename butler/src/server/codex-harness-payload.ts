import type { HarnessCapability } from "./codex-harness-helpers.js";
import type { ButlerStateStore } from "./state-store.js";
import type { CodexThreadRecord } from "./types.js";

export function buildHarnessCurrentPayload(input: {
  capability: HarnessCapability;
  thread: CodexThreadRecord;
  project: { id: string; label: string };
  jobMemory?: ReturnType<ButlerStateStore["getJobMemory"]>;
  report?: CodexThreadRecord["workerReport"];
}): Record<string, unknown> {
  const { capability, thread, project } = input;
  const contract = thread.executionContract;
  const acceptancePoints = contract?.acceptancePoints ?? [];
  const checklistItems = thread.supervisionChecklist?.items ?? acceptancePoints.map((point, index) => ({
    id: `point-${index + 1}`,
    text: point,
    status: "pending",
    note: null
  }));
  const notes = [...(contract?.notes ?? []), ...(input.jobMemory?.notes ?? [])];

  return {
    schemaVersion: "manor.job_payload.v1",
    payloadId: `payload-${thread.id}`,
    threadId: thread.id,
    kind: thread.source || "delegation",
    status: thread.status,
    workspace: {
      cwd: contract?.workspaceCwd ?? capability.cwd,
      branch: contract?.branch ?? null
    },
    project: {
      id: contract?.projectId ?? project.id,
      label: contract?.projectLabel ?? project.label
    },
    display: {
      summary: thread.supervisor.summary,
      tags: ["checklist", "proof", "constraints", "notes"]
    },
    workerDirective: contract?.requestedTask ?? thread.supervisor.latestUserPrompt ?? thread.supervisor.summary,
    operatorGoal: contract?.operatorGoal ?? null,
    requestedTask: contract?.requestedTask ?? thread.supervisor.latestUserPrompt ?? null,
    checklist: checklistItems.map((item) => ({
      id: item.id,
      text: item.text,
      status: item.status,
      note: "butlerNote" in item ? item.butlerNote ?? null : item.note ?? null
    })),
    proof: contract?.proofExpectation === "requested" ? [contract.proofExpectationLabel] : [],
    constraints: [],
    notes,
    delivery: {
      threadId: thread.id,
      turnId: thread.turns.at(-1)?.id ?? null,
      messageId: null
    },
    report: input.report ?? thread.workerReport ?? null,
    executionContract: contract
  };
}
