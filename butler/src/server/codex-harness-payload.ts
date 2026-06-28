import crypto from "node:crypto";
import type { HarnessCapability } from "./codex-harness-helpers.js";
import type { CodexThreadRecord } from "./types.js";

export function buildHarnessCurrentPayload(input: { capability: HarnessCapability; thread: CodexThreadRecord }): Record<string, unknown> {
  const { capability, thread } = input;
  const contract = thread.executionContract;
  if (!contract) {
    throw new Error("No Manor job payload is stored for this thread");
  }

  const checklistItems = thread.supervisionChecklist?.items ?? contract.acceptancePoints.map((point, index) => ({
    id: `point-${index + 1}`,
    text: point,
    status: "pending",
    butlerNote: null
  }));
  const payloadCore = {
    threadId: thread.id,
    workspaceCwd: contract.workspaceCwd ?? capability.cwd,
    requestedTask: contract.requestedTask,
    operatorGoal: contract.operatorGoal,
    acceptancePoints: contract.acceptancePoints
  };
  const checksum = crypto.createHash("sha256").update(JSON.stringify(payloadCore)).digest("hex");
  const summary = thread.supervisor.summary || contract.operatorGoal || contract.requestedTask.split("\n")[0] || `Job ${thread.id}`;
  const instruction = contract.operatorGoal ? `${contract.requestedTask}\n\nGoal: ${contract.operatorGoal}` : contract.requestedTask;

  return {
    schemaVersion: "manor.job_payload.v1",
    payloadId: `payload-${thread.id}`,
    threadId: thread.id,
    rootNodeId: `node-${thread.id}`,
    currentNodeId: `node-${thread.id}`,
    revision: 1,
    checksum,
    kind: "delegation",
    status: thread.workerReport?.status ?? "active",
    createdAt: thread.createdAt,
    updatedAt: thread.updatedAt,
    workspace: { cwd: contract.workspaceCwd ?? capability.cwd, branch: contract.branch },
    project: { id: contract.projectId, label: contract.projectLabel },
    display: { summary, tags: ["checklist", "proof", "constraints", "notes"] },
    workerDirective: instruction,
    operatorGoal: contract.operatorGoal,
    requestedTask: contract.requestedTask,
    checklist: checklistItems.map((item) => ({ id: item.id, text: item.text, status: item.status, note: item.butlerNote })),
    proof: [contract.proofExpectationLabel].filter(Boolean),
    constraints: contract.notes,
    notes: contract.notes,
    attachments: { images: [], files: [] },
    nodes: [{
      id: `node-${thread.id}`,
      kind: "delegation",
      parentId: null,
      turnId: null,
      messageId: null,
      createdAt: thread.createdAt,
      updatedAt: thread.updatedAt,
      summary,
      instruction,
      imageReferenceIds: [],
      fileReferenceIds: []
    }],
    delivery: { threadId: thread.id, turnId: null, messageId: null },
    report: thread.workerReport,
    executionContract: contract
  };
}
