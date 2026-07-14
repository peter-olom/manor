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
import { ensureManagedWorktreeWritableForWorker, resolveWorkspaceBranchName } from "./repo-worktree.js";
import { runSerializedSelfImprovementAction } from "./self-improvement-actions.js";
import {
  getSelfImprovementSourceCheckoutRequestId,
  isSelfImprovementSourceCheckoutOwnedByThread,
  rollbackSelfImprovementSourceCheckout,
  transferSelfImprovementSourceCheckout,
  type SelfImprovementCheckoutTransfer
} from "./self-improvement-request-state.js";
import type { ButlerStateStore } from "./state-store.js";
import type { CodexThreadExecutionContractView, ReasoningEffort } from "./types.js";
import { deleteWorkerThread, resolveThreadWorkerRuntime, startWorkerThread, type WorkerClientAccess, type WorkerRuntime, type WorkerThreadStartResult } from "./worker-client-router.js";
import { workerFileChangeAttribution } from "./worker-review-attribution.js";
import { workerThreadIsRunning } from "./worker-thread-status.js";

const HANDOFF_TEXT_LIMIT = 4_000;

type WorkspaceOwnershipRepair = (cwd: string) => Promise<void>;

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

function workerHarnessDisplayName(harness: string): string {
  if (harness === "codex") return "Codex";
  if (harness === "pi") return "Pi";
  return harness;
}

async function prepareWorkerHandoffWorkspace(input: {
  sourceRuntime: WorkerRuntime;
  targetHarness: string;
  cwd: string;
  repairOwnership?: WorkspaceOwnershipRepair;
}): Promise<void> {
  if (input.sourceRuntime !== "pi-rpc" || input.targetHarness !== "codex") return;
  await (input.repairOwnership ?? ensureManagedWorktreeWritableForWorker)(input.cwd);
}

export function buildWorkerHandoffNotes(store: ButlerStateStore, sourceThreadId: string, targetCwd?: string | null): string[] {
  const source = store.getThread(sourceThreadId);
  if (!source) throw new Error("The active worker job no longer exists");
  const report = store.getWorkerReport(sourceThreadId);
  const changed = workerFileChangeAttribution(source);
  const latestReplyAt = latestWorkerReplyAt(source);
  const latestReply = source.supervisor.latestAgentReply?.trim() || null;
  const notes = [
    `This is an explicit cold handoff from worker job ${sourceThreadId}. Provider cache and hidden reasoning state do not transfer.`,
    targetCwd && targetCwd !== source.cwd
      ? `Continue the task in the new workspace at ${targetCwd}. Inspect it before editing and do not modify the previous workspace.`
      : "Continue in the same workspace. Inspect and preserve existing changes before editing, then finish the remaining acceptance points.",
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
  targetHarness: string;
  targetEffort: ReasoningEffort | null;
  artifactsDir: string;
  butlerThreadId?: string | null;
  targetCwd?: string | null;
  repairWorkspaceOwnership?: WorkspaceOwnershipRepair;
  startWorker?: typeof startWorkerThread;
}): Promise<WorkerThreadStartResult> {
  const source = input.access.store.getThread(input.sourceThreadId);
  if (!source) throw new Error("The active worker job no longer exists");
  const sourceContract = source.executionContract;
  const task = sourceContract?.requestedTask?.trim() || source.supervisor.latestUserPrompt?.trim() || source.name?.trim();
  if (!task) throw new Error("The active worker does not have a task to hand off");
  const sourceCwd = sourceContract?.workspaceCwd || source.cwd;
  if (!sourceCwd) throw new Error("The active worker does not have a workspace to hand off");
  const cwd = input.targetCwd?.trim() || sourceCwd;
  const workspaceChanged = cwd !== sourceCwd;
  const workspace = { cwd, branchName: workspaceChanged ? await resolveWorkspaceBranchName(cwd) : sourceContract?.branch ?? await resolveWorkspaceBranchName(cwd) };
  const notes = buildWorkerHandoffNotes(input.access.store, input.sourceThreadId, cwd);
  const developerInstructions = buildDelegationDeveloperInstructions(workspace, task);
  const sourcePayload = input.access.store.getThreadJobPayload(input.sourceThreadId);
  let candidateThreadId: string | null = null;

  try {
    await prepareWorkerHandoffWorkspace({
      sourceRuntime: resolveThreadWorkerRuntime(input.access, input.sourceThreadId),
      targetHarness: input.targetHarness,
      cwd,
      repairOwnership: input.repairWorkspaceOwnership
    });
    const result = await (input.startWorker ?? startWorkerThread)(input.access, {
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
          reviewBaselineSource: workspaceChanged ? null : sourceContract
        });
        const contract = workspaceChanged ? built.contract : inheritHandoffContract({ source: sourceContract, built: built.contract, threadId });
        const payload = sourcePayload && !workspaceChanged
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
              contract,
              imageReferenceIds: workspaceChanged ? sourcePayload?.attachments.images ?? [] : []
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
      harness: input.targetHarness,
      model: input.targetModel,
      recordSelection: false,
      ownsManorSourceCheckoutReservation: isSelfImprovementSourceCheckoutOwnedByThread(input.sourceThreadId)
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
  targetHarness: string;
  targetEffort: ReasoningEffort | null;
  artifactsDir: string;
  butlerThreadId?: string | null;
  targetCwd?: string | null;
  trackCallback: (threadId: string) => Promise<void>;
  removeCallback: (threadId: string) => Promise<void>;
  attach: (result: WorkerThreadStartResult, text: string, at: number) => ButlerDelegationAttachmentAcknowledgement | void;
  post: (threadId: string, text: string, at: number) => void;
  startHandoff?: typeof startWorkerHandoff;
  deleteWorker?: typeof deleteWorkerThread;
}): Promise<WorkerThreadStartResult> {
  const observedSelfImprovementRequestId = getSelfImprovementSourceCheckoutRequestId(input.sourceThreadId);
  return runSerializedJobMutation(input.sourceThreadId, async () => {
    const currentSelfImprovementRequestId = getSelfImprovementSourceCheckoutRequestId(input.sourceThreadId);
    if (observedSelfImprovementRequestId && currentSelfImprovementRequestId !== observedSelfImprovementRequestId) {
      throw new Error("The self-improvement request is no longer active for this Worker.");
    }
    const selfImprovementRequestId = observedSelfImprovementRequestId ?? currentSelfImprovementRequestId;
    const sourceWorkspace = input.access.store.getThread(input.sourceThreadId)?.executionContract?.workspaceCwd
      ?? input.access.store.getThread(input.sourceThreadId)?.cwd
      ?? null;
    if (selfImprovementRequestId && input.targetCwd && input.targetCwd !== sourceWorkspace) {
      throw new Error("The workspace cannot be changed while this Worker owns a self-improvement checkout.");
    }
    const execute = async (): Promise<WorkerThreadStartResult> => {
      if (selfImprovementRequestId && getSelfImprovementSourceCheckoutRequestId(input.sourceThreadId) !== selfImprovementRequestId) {
        throw new Error("The self-improvement request is no longer active for this Worker.");
      }
      const source = input.access.store.getThread(input.sourceThreadId);
      if (!source) throw new Error("The active worker job no longer exists");
      if (input.access.store.isWorkerThreadRetired(input.sourceThreadId)) {
        throw new Error("This Worker was already retired by a handoff.");
      }
      if (workerThreadIsRunning(source)) {
        throw new Error("Wait for the current worker turn to finish before switching workers.");
      }

      let result: WorkerThreadStartResult | null = null;
      let attachment: ButlerDelegationAttachmentAcknowledgement | void = undefined;
      let checkoutTransfer: SelfImprovementCheckoutTransfer | null = null;
      let sourceRetired = false;
      let sourceCallbackRemoved = false;
      try {
        result = await (input.startHandoff ?? startWorkerHandoff)({
          access: input.access,
          sourceThreadId: input.sourceThreadId,
          targetModel: input.targetModel,
          targetHarness: input.targetHarness,
          targetEffort: input.targetEffort,
          artifactsDir: input.artifactsDir,
          butlerThreadId: input.butlerThreadId ?? null,
          targetCwd: input.targetCwd ?? null
        });
        await input.trackCallback(result.threadId);
        const route = result.model?.startsWith(`${result.provider}/`) ? result.model : `${result.provider ?? "the selected provider"}/${result.model ?? "default"}`;
        const sourceCwd = source.executionContract?.workspaceCwd ?? source.cwd;
        const workspaceChanged = Boolean(input.targetCwd && input.targetCwd !== sourceCwd);
        const workspaceChange = workspaceChanged ? ` The job moved to ${input.targetCwd}.` : "";
        const continuity = workspaceChanged
          ? "The previous work context was handed over with a fresh review baseline for the new workspace."
          : "The previous work and review baseline were handed over.";
        const text = `Switched Worker ${input.sourceThreadId} to ${route} using the ${workerHarnessDisplayName(result.harness)} harness in job ${result.threadId}.${workspaceChange} ${continuity}`;
        const at = Date.now();
        attachment = input.attach(result, text, at);
        if (attachment?.attached !== true) {
          throw new Error("The Butler session changed before the replacement Worker could be attached.");
        }
        if (selfImprovementRequestId) {
          checkoutTransfer = await transferSelfImprovementSourceCheckout(input.sourceThreadId, result.threadId);
          if (!checkoutTransfer) throw new Error("The self-improvement checkout reservation could not be transferred.");
        }
        await attachment.flush?.();
        sourceRetired = input.access.store.markWorkerThreadRetired(input.sourceThreadId);
        if (!sourceRetired) throw new Error("The source Worker could not be retired after handoff.");
        await input.access.store.flushSave();
        await input.removeCallback(input.sourceThreadId);
        sourceCallbackRemoved = true;
        input.post(result.threadId, text, at);
        input.access.store.addEvent(input.sourceThreadId, "butler.worker.handed_off", `Handed off to Worker ${result.threadId}.`);
        input.access.store.addEvent(result.threadId, "butler.worker.handoff_started", `Continued Worker ${input.sourceThreadId}.`);
        if (result.provider && result.model) {
          input.access.recordSuccessfulWorkerSelection?.({ harness: result.harness, provider: result.provider, model: result.model, effort: result.effort });
        }
        return result;
      } catch (error) {
        const rollbackErrors: string[] = [];
        if (checkoutTransfer) {
          await rollbackSelfImprovementSourceCheckout(checkoutTransfer)
            .then((rolledBack) => {
              if (!rolledBack) rollbackErrors.push("self-improvement checkout rollback was rejected");
            })
            .catch((failure) => {
              rollbackErrors.push(`self-improvement checkout rollback failed: ${failure instanceof Error ? failure.message : String(failure)}`);
            });
        }
        if (sourceRetired) {
          try {
            if (!input.access.store.restoreRetiredWorkerThread(input.sourceThreadId)) {
              rollbackErrors.push("source Worker retirement rollback was rejected");
            } else {
              await input.access.store.flushSave();
            }
          } catch (failure) {
            rollbackErrors.push(`source Worker retirement rollback failed: ${failure instanceof Error ? failure.message : String(failure)}`);
          }
        }
        try {
          if (attachment?.attached && attachment.rollback && !attachment.rollback()) {
            rollbackErrors.push("pair attachment rollback was rejected");
          } else if (attachment?.attached && !attachment.rollback) {
            rollbackErrors.push("pair attachment rollback is unavailable");
          } else if (attachment?.attached) {
            await attachment.flush?.();
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
    };

    return selfImprovementRequestId
      ? runSerializedSelfImprovementAction(selfImprovementRequestId, execute)
      : execute();
  });
}
