import path from "node:path";

import { buildButlerDelegationContract } from "./butler-agent-delegation-contract-builder.js";
import { buildDelegationDeveloperInstructions } from "./butler-agent-delegation-instructions.js";
import { runSerializedJobMutation } from "./butler-job-mutation-guard.js";
import {
  bindJobPayloadDelivery,
  buildJobPayload,
  formatJobPayloadMessage,
  jobPayloadsRoot,
  persistJobPayload,
  remapJobPayloadForWorkerHandoff
} from "./job-instruction-artifacts.js";
import type { ButlerDelegationAttachmentAcknowledgement } from "./butler-agent-options.js";
import { resolveWorkspaceBranchName } from "./repo-worktree.js";
import type { ButlerStateStore } from "./state-store.js";
import type { CodexThreadExecutionContractView, ReasoningEffort } from "./types.js";
import { deleteWorkerThread, startWorkerThread, type WorkerClientAccess, type WorkerThreadStartResult } from "./worker-client-router.js";
import { workerFileChangeAttribution } from "./worker-review-attribution.js";

const HANDOFF_TEXT_LIMIT = 4_000;

function bounded(value: unknown, limit = HANDOFF_TEXT_LIMIT): string {
  if (value === null || value === undefined) return "";
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text.length <= limit ? text : `${text.slice(0, limit - 1)}…`;
}

function latestWorkerReplyAt(source: ReturnType<ButlerStateStore["getThread"]>): number | null {
  let latest: number | null = null;
  for (const turn of source?.turns ?? []) for (const item of turn.items) {
    if (item.type === "agentMessage" && item.text.trim() && Number.isFinite(item.at)) latest = Math.max(latest ?? 0, item.at);
  }
  return latest;
}

export function buildWorkerHandoffNotes(store: ButlerStateStore, sourceThreadId: string): string[] {
  const source = store.getThread(sourceThreadId);
  if (!source) throw new Error("The active worker job no longer exists");
  const report = store.getWorkerReport(sourceThreadId);
  const changed = workerFileChangeAttribution(source);
  const latestReplyAt = latestWorkerReplyAt(source);
  const latestReply = source.supervisor.latestAgentReply?.trim() || null;
  const notes = [
    `This is an explicit cold handoff from worker job ${sourceThreadId}. Provider cache and hidden reasoning state do not transfer.`,
    "Continue in the same workspace. Inspect and preserve existing changes before editing, then finish the remaining acceptance points.",
    report ? `Previous worker report (${report.status}): ${bounded(report.summary, 800)}${report.details ? ` — ${bounded(report.details)}` : ""}` : null,
    source.jobMemory ? `Previous worker checkpoint and memory: ${bounded(source.jobMemory)}` : null,
    source.supervisionChecklist ? `Previous supervision checklist: ${bounded(source.supervisionChecklist)}` : null,
    changed.paths.length > 0 ? `Files attributed to the previous worker: ${changed.paths.slice(0, 80).join(", ")}${changed.overflow || changed.paths.length > 80 ? ", …" : ""}` : null,
    latestReply && (!report || (latestReplyAt !== null && latestReplyAt > report.updatedAt)) ? `Latest previous worker reply: ${bounded(latestReply)}` : null
  ];
  return notes.filter((note): note is string => Boolean(note));
}

function inheritHandoffContract(input: {
  source: CodexThreadExecutionContractView | null;
  built: CodexThreadExecutionContractView;
  threadId: string;
}): CodexThreadExecutionContractView {
  if (!input.source) return input.built;
  const inherited = structuredClone(input.source);
  return {
    ...inherited,
    threadId: input.threadId,
    workspaceCwd: input.built.workspaceCwd,
    branch: input.built.branch,
    notes: [...new Set([...inherited.notes, ...input.built.notes].map((note) => note.trim()).filter(Boolean))]
  };
}

export function buildWorkerHandoffPrompt(input: {
  threadId: string;
  task: string;
  currentDirective: string;
  summary: string;
}): string {
  const currentDirective = input.currentDirective.trim();
  return [
    formatJobPayloadMessage("delegation", input.threadId, input.task, input.summary),
    `Task boundary: ${bounded(input.task, 1_600)}`,
    currentDirective && currentDirective !== input.task.trim()
      ? `Latest handoff instruction: ${bounded(currentDirective, 1_600)}`
      : null,
    "If the payload command cannot be read, stop without editing or guessing."
  ].filter((line): line is string => Boolean(line)).join("\n");
}

export async function startWorkerHandoff(input: {
  access: WorkerClientAccess;
  sourceThreadId: string;
  targetModel: string;
  targetEffort: ReasoningEffort | null;
  artifactsDir: string;
  butlerThreadId?: string | null;
}): Promise<WorkerThreadStartResult> {
  const source = input.access.store.getThread(input.sourceThreadId);
  if (!source) throw new Error("The active worker job no longer exists");
  const sourceContract = source.executionContract;
  const task = sourceContract?.requestedTask?.trim() || source.supervisor.latestUserPrompt?.trim() || source.name?.trim();
  if (!task) throw new Error("The active worker does not have a task to hand off");
  const cwd = sourceContract?.workspaceCwd || source.cwd;
  if (!cwd) throw new Error("The active worker does not have a workspace to hand off");
  const workspace = { cwd, branchName: sourceContract?.branch ?? await resolveWorkspaceBranchName(cwd) };
  const notes = buildWorkerHandoffNotes(input.access.store, input.sourceThreadId);
  const developerInstructions = buildDelegationDeveloperInstructions(workspace, task);
  const sourcePayload = input.access.store.getThreadJobPayload(input.sourceThreadId);
  let candidateThreadId: string | null = null;

  try {
    const result = await startWorkerThread(input.access, {
      task,
      input: async (threadId) => {
        candidateThreadId = threadId;
        const built = await buildButlerDelegationContract({
          store: input.access.store,
          threadId,
          task,
          goal: sourceContract?.operatorGoal ?? undefined,
          workspace,
          extraNotes: notes,
          orchestration: sourceContract?.orchestration ?? null,
          butlerThreadId: input.butlerThreadId ?? null,
          parentThreadId: input.sourceThreadId,
          reviewBaselineRoot: path.join(input.artifactsDir, "review-baselines"),
          reviewBaselineSource: sourceContract
        });
        const contract = inheritHandoffContract({ source: sourceContract, built: built.contract, threadId });
        const payload = sourcePayload
          ? remapJobPayloadForWorkerHandoff(sourcePayload, {
              threadId,
              butlerThreadId: input.butlerThreadId ?? null,
              parentThreadId: input.sourceThreadId,
              contract
            })
          : buildJobPayload({
              threadId,
              kind: "delegation",
              instruction: task,
              butlerThreadId: input.butlerThreadId ?? null,
              parentThreadId: input.sourceThreadId,
              contract
            });
        const text = buildWorkerHandoffPrompt({
          threadId,
          task,
          currentDirective: payload.workerDirective,
          summary: payload.display.summary
        });
        await persistJobPayload(jobPayloadsRoot(input.artifactsDir), payload);
        input.access.store.setThreadJobPayload(payload);
        input.access.store.setThreadExecutionContract(threadId, contract);
        return [{ type: "text", text }];
      },
      cwd,
      developerInstructions,
      effort: input.targetEffort,
      openWindow: true,
      runtime: "auto",
      model: input.targetModel,
      recordSelection: false
    });

    const preparedPayload = input.access.store.getThreadJobPayload(result.threadId);
    if (!preparedPayload) throw new Error("The worker handoff brief could not be created");
    const boundPayload = bindJobPayloadDelivery(preparedPayload, { turnId: result.turnId });
    await persistJobPayload(jobPayloadsRoot(input.artifactsDir), boundPayload);
    input.access.store.setThreadJobPayload(boundPayload);
    return result;
  } catch (error) {
    if (candidateThreadId && input.access.store.getThread(candidateThreadId)) {
      const cleanupError = await deleteWorkerThread(input.access, candidateThreadId, { waitForCleanup: true })
        .then(() => null)
        .catch((failure) => failure);
      if (cleanupError) {
        const message = cleanupError instanceof Error ? cleanupError.message : String(cleanupError);
        throw new Error(`${error instanceof Error ? error.message : String(error)} Cleanup of replacement worker ${candidateThreadId} also failed: ${message}`);
      }
    }
    throw error;
  }
}

export async function handoffWorkerAtomically(input: {
  access: WorkerClientAccess;
  sourceThreadId: string;
  targetModel: string;
  targetEffort: ReasoningEffort | null;
  artifactsDir: string;
  butlerThreadId?: string | null;
  trackCallback: (threadId: string) => Promise<void>;
  removeCallback: (threadId: string) => Promise<void>;
  attach: (result: WorkerThreadStartResult, text: string, at: number) => ButlerDelegationAttachmentAcknowledgement | void;
  post: (threadId: string, text: string, at: number) => void;
  startHandoff?: typeof startWorkerHandoff;
  deleteWorker?: typeof deleteWorkerThread;
}): Promise<WorkerThreadStartResult> {
  return runSerializedJobMutation(input.sourceThreadId, async () => {
    const source = input.access.store.getThread(input.sourceThreadId);
    const latestTurn = source?.turns.at(-1);
    if (!source) throw new Error("The active worker job no longer exists");
    if (source.status === "active" || latestTurn?.status === "inProgress" || latestTurn?.status === "started") {
      throw new Error("Wait for the current worker turn to finish before switching workers.");
    }

    let result: WorkerThreadStartResult | null = null;
    let attachment: ButlerDelegationAttachmentAcknowledgement | void = undefined;
    let sourceCallbackRemoved = false;
    try {
      result = await (input.startHandoff ?? startWorkerHandoff)({
        access: input.access,
        sourceThreadId: input.sourceThreadId,
        targetModel: input.targetModel,
        targetEffort: input.targetEffort,
        artifactsDir: input.artifactsDir,
        butlerThreadId: input.butlerThreadId ?? null
      });
      await input.trackCallback(result.threadId);
      const route = result.model?.startsWith(`${result.provider}/`) ? result.model : `${result.provider ?? "the selected provider"}/${result.model ?? "default"}`;
      const text = `Switched worker ${input.sourceThreadId} to ${route} in job ${result.threadId}. The previous work and review baseline were handed over.`;
      const at = Date.now();
      attachment = input.attach(result, text, at);
      await input.removeCallback(input.sourceThreadId);
      sourceCallbackRemoved = true;
      input.post(result.threadId, text, at);
      input.access.store.addEvent(input.sourceThreadId, "butler.worker.handed_off", `Handed off to worker ${result.threadId}.`);
      input.access.store.addEvent(result.threadId, "butler.worker.handoff_started", `Continued worker ${input.sourceThreadId}.`);
      if (result.provider && result.model) {
        input.access.recordSuccessfulWorkerSelection?.({ provider: result.provider, model: result.model, effort: result.effort });
      }
      return result;
    } catch (error) {
      const rollbackErrors: string[] = [];
      try {
        if (attachment?.attached && attachment.rollback && !attachment.rollback()) {
          rollbackErrors.push("pair attachment rollback was rejected");
        }
      } catch (failure) {
        rollbackErrors.push(`pair attachment rollback failed: ${failure instanceof Error ? failure.message : String(failure)}`);
      }
      if (result) {
        await input.removeCallback(result.threadId).catch((failure) => {
          rollbackErrors.push(`callback cleanup failed: ${failure instanceof Error ? failure.message : String(failure)}`);
        });
        await (input.deleteWorker ?? deleteWorkerThread)(input.access, result.threadId, { waitForCleanup: true }).catch((failure) => {
          rollbackErrors.push(`worker cleanup failed: ${failure instanceof Error ? failure.message : String(failure)}`);
        });
      }
      if (sourceCallbackRemoved) {
        await input.trackCallback(input.sourceThreadId).catch((failure) => {
          rollbackErrors.push(`source callback restore failed: ${failure instanceof Error ? failure.message : String(failure)}`);
        });
      }
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(rollbackErrors.length > 0
        ? `${message} Handoff rollback was incomplete: ${rollbackErrors.join("; ")}.`
        : message);
    }
  });
}
