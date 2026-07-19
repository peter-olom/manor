import { continueWorkerJob } from "./butler-agent-codex-tools.js";
import type { ButlerAgentToolAccess } from "./butler-agent-tool-access.js";

export async function continueAttachedWorkerDelegation(input: {
  access: ButlerAgentToolAccess;
  threadId: string;
  task: string;
  goal?: string;
  workspace: { cwd: string; branchName: string | null };
  attachedCwd: string | null;
  imageReferenceIds: string[];
  fileReferenceIds: string[];
}) {
  if (!input.attachedCwd || input.workspace.cwd !== input.attachedCwd) {
    throw new Error(`This Butler session already has Worker ${input.threadId} attached to ${input.attachedCwd ?? "another workspace"}. Use Switch worker for an explicit handoff before delegating work in ${input.workspace.cwd}.`);
  }
  const continuation = await continueWorkerJob(input.access, {
    threadId: input.threadId,
    text: input.goal ? `${input.task}\n\nGoal: ${input.goal}` : input.task,
    imageReferenceIds: input.imageReferenceIds,
    fileReferenceIds: input.fileReferenceIds,
    refreshChecklist: true,
    nextWorkerReportAction: "review"
  });
  if (continuation.details.dispatched === false) return continuation;
  return {
    ...continuation,
    content: [{
      type: "text" as const,
      text: `Continued the Worker already attached to this Butler session in job ${input.threadId}; no second Worker was started.`
    }],
    details: {
      ...continuation.details,
      threadId: input.threadId,
      reusedWorker: true,
      workspace: input.workspace
    }
  };
}
