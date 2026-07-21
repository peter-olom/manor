import { Type } from "@sinclair/typebox";

import {
  buildJobDetail,
  buildJobsSummary,
  buildProjectDetail,
  buildProjectInventorySummary,
  buildSupervisorOverview,
  shouldAllowLocalThreadFallback
} from "./butler-agent-helpers.js";
import type { ButlerAgentToolAccess, ButlerCustomTool } from "./butler-agent-tool-access.js";
import { directWorkerDispatchMarker } from "./butler-callback-state.js";
import { settleFailedDirectWorkerDispatch } from "./direct-codex-message.js";
import { formatJobPayloadMessage } from "./job-instruction-artifacts.js";
import { assertCallbackReviewCurrent, runSerializedJobMutation, runSerializedJobMutations } from "./butler-job-mutation-guard.js";
import { classifyManorBlocker } from "./butler-self-improvement.js";
import { buildWorkerInputWithReferences } from "./reference-inputs.js";
import { commitSelfImprovementRequest, discardSelfImprovementRequest, openSelfImprovementPullRequest, runSerializedSelfImprovementAction } from "./self-improvement-actions.js";
import { getSelfImprovementRequestState, getSelfImprovementWorkerRequestId } from "./self-improvement-request-state.js";
import { listWorkspaceProjectDirectories } from "./repo-worktree.js";
import { deleteAllWorkerThreads, deleteWorkerThread, loadWorkerThread, sendWorkerMessage, stopWorkerThread, workerMessageDispatchMayHaveBeenAccepted } from "./worker-client-router.js";

export type ContinueWorkerJobParams = {
  threadId: string;
  text: string;
  imageReferenceIds?: string[];
  fileReferenceIds?: string[];
  refreshChecklist?: boolean;
  nextWorkerReportAction?: "review" | "reply_to_operator";
};

async function withSelfImprovementWorkerReactivated<T>(
  threadId: string,
  dispatchState: { accepted: boolean },
  action: (reactivate: () => Promise<void>) => Promise<T>
): Promise<T> {
  const requestId = getSelfImprovementWorkerRequestId(threadId);
  const withoutReactivation = () => Promise.resolve();
  if (!requestId) return action(withoutReactivation);

  return runSerializedSelfImprovementAction(requestId, async () => {
    const requests = getSelfImprovementRequestState();
    const current = requests.get(requestId);
    if (current?.threadId === threadId && (current.status === "committed" || current.status === "pr_opened")) {
      throw new Error("This self-improvement session has already been published. Start a new request before asking its Worker to make more changes.");
    }
    const readyRequest = current?.threadId === threadId && current.status === "changes_ready" ? current : null;
    let reactivated = false;
    const reactivate = async () => {
      if (!readyRequest) return;
      requests.update(requestId, { status: "running", completedAt: null });
      try {
        await requests.flush();
        reactivated = true;
      } catch (error) {
        requests.update(requestId, { status: readyRequest.status, completedAt: readyRequest.completedAt });
        await requests.flush();
        throw error;
      }
    };
    try {
      return await action(reactivate);
    } catch (error) {
      if (reactivated && !dispatchState.accepted && !workerMessageDispatchMayHaveBeenAccepted(error)) {
        const latest = requests.get(requestId);
        if (latest?.threadId === threadId && latest.status === "running") {
          requests.update(requestId, { status: readyRequest!.status, completedAt: readyRequest!.completedAt });
          await requests.flush();
        }
      }
      throw error;
    }
  });
}

async function continueWorkerJobLocked(
  access: ButlerAgentToolAccess,
  typedParams: ContinueWorkerJobParams,
  dispatchState: { accepted: boolean },
  reactivate: () => Promise<void>
) {
  const workerDefaults = access.getWorkerDefaults?.();
  const attachedWorkerThreadId = workerDefaults?.threadId;
  if (workerDefaults && attachedWorkerThreadId !== undefined && attachedWorkerThreadId !== typedParams.threadId) {
    throw new Error(
      attachedWorkerThreadId
        ? `Job ${typedParams.threadId} belongs to another Butler session. This session can only steer its attached Worker ${attachedWorkerThreadId}.`
        : `Job ${typedParams.threadId} belongs to another Butler session. Delegate a new Worker in this session instead.`
    );
  }
  const activeGuard = access.getActiveOperatorThreadGuard();
  if (activeGuard) {
    if (activeGuard.explicitThreadIds.length > 0 && !activeGuard.explicitThreadIds.includes(typedParams.threadId)) {
      throw new Error(
        `The latest operator turn explicitly referenced job ${activeGuard.explicitThreadIds.join(", ")}. Use one of those exact jobs or clarify before steering ${typedParams.threadId}.`
      );
    }
    if (
      activeGuard.explicitThreadIds.length === 0 &&
      activeGuard.lockedThreadId &&
      activeGuard.lockedThreadId !== typedParams.threadId
    ) {
      throw new Error(
        `The latest operator turn is currently anchored to job ${activeGuard.lockedThreadId}. Use that exact job or clarify before steering ${typedParams.threadId}.`
      );
    }
  }
  const thread = access.store.getThread(typedParams.threadId);
  if (!thread || !thread.cwd || thread.source === "unknown" || thread.turnCount === 0) {
    throw new Error(
      `Job ${typedParams.threadId} is not a valid reusable worker workstream. Start a fresh worker job with delegate_to_worker instead.`
    );
  }
  const limitMessage = access.getThreadBudgetLimitMessage(typedParams.threadId);
  if (limitMessage) {
    return {
      content: [{ type: "text" as const, text: limitMessage }],
      details: {
        dispatched: false,
        thread,
        supervision: access.store.getThreadSupervision(typedParams.threadId)
      }
    };
  }
  await loadWorkerThread(access, typedParams.threadId);
  const activeReferences = access.getActiveOperatorReferences();
  const imageReferenceIds = [...new Set([...(activeReferences?.imageReferenceIds ?? []), ...(typedParams.imageReferenceIds ?? [])])];
  const fileReferenceIds = [...new Set([...(activeReferences?.fileReferenceIds ?? []), ...(typedParams.fileReferenceIds ?? [])])];
  const requestedAt = Date.now();
  const nextWorkerReportAction = typedParams.nextWorkerReportAction ?? "review";

  await reactivate();
  const reservation = await access.reserveDirectCodexMessage({
    threadId: typedParams.threadId,
    text: typedParams.text,
    operatorRequestText: activeGuard?.operatorRequestText ?? null,
    requestedAt,
    nextWorkerReportAction
  });
  let sent = false;
  let reviewedDispatchCounted = false;
  let supervision = access.store.getThreadSupervision(typedParams.threadId);
  const countReviewedDispatch = () => {
    if (reviewedDispatchCounted) return supervision;
    supervision = access.store.noteReviewedWorkerDispatch(typedParams.threadId);
    reviewedDispatchCounted = true;
    access.store.addEvent(typedParams.threadId, "butler.supervision.cycle_spent", "Butler dispatched another Worker turn for adversarial review.");
    return supervision;
  };
  try {
    const refreshedChecklist = access.store.refreshCompletedSupervisionChecklistForFollowup(
      typedParams.threadId,
      typedParams.text,
      { force: typedParams.refreshChecklist === true }
    );
    if (refreshedChecklist) {
      const refreshedThread = access.store.getThread(typedParams.threadId);
      reservation.reviewScopeReplacement = { executionContract: refreshedThread?.executionContract ? structuredClone(refreshedThread.executionContract) : null, supervisionChecklist: refreshedThread?.supervisionChecklist ? structuredClone(refreshedThread.supervisionChecklist) : null };
    }
    const payload = await access.createOrUpdateJobPayload({
      threadId: typedParams.threadId,
      kind: "steering",
      instruction: typedParams.text,
      imageReferenceIds,
      fileReferenceIds,
      onPrepared: (prepared) => { reservation.jobPayloadReplacement = structuredClone(prepared); }
    });
    assertCallbackReviewCurrent(typedParams.threadId);
    const workerInput = buildWorkerInputWithReferences({
      text: formatJobPayloadMessage("steering", payload.threadId, payload.workerDirective, payload.display.summary),
      imageStore: access.imageStore,
      imageReferenceIds,
      fileStore: access.fileStore,
      fileReferenceIds
    });
    workerInput.push({ type: "text", text: directWorkerDispatchMarker(typedParams.threadId, requestedAt) });
    const dispatch = await sendWorkerMessage(access, typedParams.threadId, workerInput);
    sent = true;
    dispatchState.accepted = true;
    countReviewedDispatch();
    await access.bindJobPayloadDelivery(typedParams.threadId, { turnId: dispatch.turnId });
    await access.markPendingChatCallbackDispatched(typedParams.threadId, requestedAt, dispatch.turnId);
    access.noteThreadFocus(typedParams.threadId, "message_job");
    return {
      content: [{ type: "text" as const, text: `Sent a private follow-up to job ${typedParams.threadId}. Reviewed Worker turns: ${supervision.butlerTurnsUsed}/${supervision.maxButlerTurns ?? "∞"}. Next worker report action: ${nextWorkerReportAction}.` }],
      details: { dispatched: true, checklist: refreshedChecklist, payload, supervision, thread: access.store.getThread(typedParams.threadId) ?? null }
    };
  } catch (error) {
    if (!reviewedDispatchCounted && workerMessageDispatchMayHaveBeenAccepted(error)) countReviewedDispatch();
    if (!sent) await settleFailedDirectWorkerDispatch(error, () => access.markPendingChatCallbackDispatched(typedParams.threadId, requestedAt, null), () => access.rollbackDirectCodexMessage(typedParams.threadId, requestedAt, reservation));
    throw error;
  }
}

export async function continueWorkerJob(access: ButlerAgentToolAccess, typedParams: ContinueWorkerJobParams) {
  const dispatchState = { accepted: false };
  return runSerializedJobMutation(
    typedParams.threadId,
    () => withSelfImprovementWorkerReactivated(
      typedParams.threadId,
      dispatchState,
      (reactivate) => continueWorkerJobLocked(access, typedParams, dispatchState, reactivate)
    )
  );
}

function assertDeletionDoesNotBypassSupervisionLimit(access: ButlerAgentToolAccess, threadId: string): void {
  const attachedWorkerThreadId = access.getWorkerDefaults?.()?.threadId ?? null;
  if (threadId !== attachedWorkerThreadId || !access.store.getThreadSupervision(threadId).capReached) return;
  throw new Error(
    "This Worker reached the review-turn limit for the current operator message. Deleting it would bypass that limit. Wait for a new operator message or use the session controls for an operator-directed deletion."
  );
}

export function buildButlerWorkerTools(access: ButlerAgentToolAccess): ButlerCustomTool[] {
  return [
    access.defineButlerTool({
      name: "list_jobs",
      label: "List jobs",
      description: "List tracked worker jobs/threads across statuses, including active and inactive jobs, with current summaries.",
      promptSnippet:
        "list_jobs: use for broad worker job/thread checks, counts, active/idle/blocked status summaries, or finding jobs by project before choosing one to inspect. Do not use it as the first tool for people, team, intern, mentee, or folder inventory questions unless the operator explicitly asks about jobs/threads/workers.",
      parameters: Type.Object({
        limit: Type.Optional(Type.Number({ minimum: 1, maximum: 100 })),
        status: Type.Optional(Type.String())
      }),
      uiEffects: access.getToolUiEffects("list_jobs"),
      execute: async (_toolCallId, params) => {
        const typedParams = params as { limit?: number; status?: string };
        const limit = typeof typedParams.limit === "number" && Number.isFinite(typedParams.limit) ? Math.trunc(typedParams.limit) : 20;
        return {
          content: [{ type: "text", text: buildJobsSummary(access.store, limit, typedParams.status?.trim()) }],
          details: { threads: access.store.listThreads().slice(0, limit) }
        };
      }
    }),
    access.defineButlerTool({
      name: "read_job",
      label: "Read job",
      description: "Read one specific worker job/thread in detail by thread id, including loaded turns and messages.",
      promptSnippet: "read_job: use after you have a specific thread id and need that job's transcript, supervisor state, or details.",
      parameters: Type.Object({
        threadId: Type.String({ minLength: 1 })
      }),
      uiEffects: access.getToolUiEffects("read_job"),
      execute: async (_toolCallId, params) => {
        const typedParams = params as { threadId: string };
        try {
          await loadWorkerThread(access, typedParams.threadId);
        } catch (error) {
          if (!shouldAllowLocalThreadFallback(access.store, typedParams.threadId, error)) {
            throw error;
          }
          access.store.addEvent(
            typedParams.threadId,
            "thread/read/local-fallback",
            "Live worker thread refresh was unavailable, so Butler used the saved local job transcript."
          );
        }
        access.noteThreadFocus(typedParams.threadId, "read_job");
        return {
          content: [{ type: "text", text: buildJobDetail(access.store, typedParams.threadId) }],
          details: {
            thread: access.store.getThread(typedParams.threadId) ?? null
          }
        };
      }
    }),
    access.defineButlerTool({
      name: "list_projects",
      label: "List projects",
      description: "List known project directories, nested Git repositories, and current tracked work separately.",
      promptSnippet:
        "list_projects: use for project, folder, intern, mentee, or team inventory questions. It returns top-level project directories plus nested Git repositories first, then tracked workstream groups and active-work counts separately.",
      parameters: Type.Object({
        limit: Type.Optional(Type.Number({ minimum: 1, maximum: 100 }))
      }),
      uiEffects: access.getToolUiEffects("list_projects"),
      execute: async (_toolCallId, params) => {
        const typedParams = params as { limit?: number };
        const limit = typeof typedParams.limit === "number" && Number.isFinite(typedParams.limit) ? Math.trunc(typedParams.limit) : 20;
        const projects = await listWorkspaceProjectDirectories();
        const workstreamGroups = access.store.listProjectSummaries();
        return {
          content: [{ type: "text", text: buildProjectInventorySummary(projects, workstreamGroups, limit) }],
          details: {
            projects: projects.slice(0, limit),
            workstreamGroups: workstreamGroups.slice(0, limit)
          }
        };
      }
    }),
    access.defineButlerTool({
      name: "read_project",
      label: "Read group",
      description: "Read the tracked summary and thread list for one workstream group.",
      promptSnippet: "read_project: inspect one project or workspace bucket and its jobs before delegating or following up.",
      parameters: Type.Object({
        projectId: Type.String({ minLength: 1 })
      }),
      uiEffects: access.getToolUiEffects("read_project"),
      execute: async (_toolCallId, params) => {
        const typedParams = params as { projectId: string };
        return {
          content: [{ type: "text", text: buildProjectDetail(access.store, typedParams.projectId) }],
          details: {
            project: access.store.getProjectSummary(typedParams.projectId) ?? null,
            projectMemory: access.store.getProjectMemory(typedParams.projectId),
            pendingPromotionCandidates: access.store.listPendingPromotionCandidates(typedParams.projectId)
          }
        };
      }
    }),
    access.defineButlerTool({
      name: "supervisor_overview",
      label: "Supervisor overview",
      description: "Return the top-level supervisor summary across all tracked work.",
      promptSnippet: "supervisor_overview: get the top-level Butler summary across all workstream groups and threads.",
      parameters: Type.Object({}),
      uiEffects: access.getToolUiEffects("supervisor_overview"),
      execute: async () => {
        return {
          content: [{ type: "text", text: buildSupervisorOverview(access.store) }],
          details: {
            supervisor: access.store.getSupervisorSummary(),
            projects: access.store.listProjectSummaries()
          }
        };
      }
    }),
    access.defineButlerTool({
      name: "request_self_improvement",
      label: "Request self-improvement",
      description:
        "Create a pending Manor self-improvement request for operator review after a blocked worker report. This does not start work or mutate Manor.",
      promptSnippet:
        "request_self_improvement: create an operator-reviewed request only for a blocked worker report that likely indicates a Manor platform issue. Include the blocked source job id, trigger, symptoms, logs, observations, suspected cause, proposed change, and risk. Do not use for direct operator self-improvement requests, missing credentials, operator approval, third-party outage, or app-specific bugs outside Manor.",
      parameters: Type.Object({
        trigger: Type.String({ minLength: 1 }),
        symptoms: Type.String({ minLength: 1 }),
        logs: Type.Optional(Type.String()),
        observations: Type.String({ minLength: 1 }),
        suspectedCause: Type.String({ minLength: 1 }),
        proposedChange: Type.String({ minLength: 1 }),
        risk: Type.String({ minLength: 1 }),
        desiredOutcome: Type.Optional(Type.String({ minLength: 1 })),
        sourceThreadId: Type.String({ minLength: 1 })
      }),
      uiEffects: access.getToolUiEffects("request_self_improvement"),
      execute: async (_toolCallId, params) => {
        const typedParams = params as {
          trigger: string;
          symptoms: string;
          logs?: string;
          observations: string;
          suspectedCause: string;
          proposedChange: string;
          risk: string;
          desiredOutcome?: string;
          sourceThreadId: string;
        };
        const sourceThreadId = typedParams.sourceThreadId?.trim() || null;
        const sourceThread = sourceThreadId ? access.store.getThread(sourceThreadId) ?? null : null;
        if (sourceThreadId && !sourceThread) {
          throw new Error(`Source job ${sourceThreadId} was not found.`);
        }
        if (!sourceThread) {
          throw new Error("request_self_improvement requires a blocked source job. Direct operator requests should be delegated as normal work.");
        }
        const workerReport = access.store.getWorkerReport(sourceThread.id);
        if (workerReport?.status !== "blocked") {
          throw new Error("request_self_improvement requires a blocked worker report.");
        }
        const requestState = getSelfImprovementRequestState();
        if (requestState.hasOpenSourceRequest(sourceThread?.id ?? null)) {
          return {
            content: [{ type: "text", text: `A self-improvement request already exists for job ${sourceThread?.id}.` }],
            details: { sourceThread, duplicate: true, requests: requestState.list() }
          };
        }

        const classification = classifyManorBlocker({ thread: sourceThread, workerReport });
        const request = requestState.create({
          trigger: typedParams.trigger,
          symptoms: typedParams.symptoms,
          logs: typedParams.logs,
          observations: typedParams.observations,
          suspectedCause: typedParams.suspectedCause,
          proposedChange: typedParams.proposedChange,
          risk: typedParams.risk,
          desiredOutcome: typedParams.desiredOutcome,
          sourceThreadId: sourceThread?.id ?? null,
          sourceProjectLabel: sourceThread?.supervisor.projectLabel ?? null,
          createdBy: "butler"
        });
        await requestState.flush();
        if (sourceThread) {
          access.store.addEvent(sourceThread.id, "butler.self_improvement.requested", `Queued self-improvement request ${request.id}.`);
        }

        return {
          content: [
            {
              type: "text",
              text: `Created self-improvement request ${request.id}. It is pending operator approval and no work has started.`
            }
          ],
          details: {
            request,
            classification,
            sourceThreadId
          }
        };
      }
    }),
    access.defineButlerTool({
      name: "discard_self_improvement",
      label: "Close self-improvement",
      description: "Stop tracking an approved self-improvement session while leaving the active source checkout unchanged.",
      promptSnippet:
        "discard_self_improvement: use only when the operator explicitly asks to close a self-improvement request. This stops its Worker and closes the request without reverting source changes. Requires the request id.",
      parameters: Type.Object({
        requestId: Type.String({ minLength: 1 })
      }),
      uiEffects: access.getToolUiEffects("discard_self_improvement"),
      execute: async (_toolCallId, params) => {
        const typedParams = params as { requestId: string };
        const request = await discardSelfImprovementRequest(getSelfImprovementRequestState(), access, typedParams.requestId.trim());
        if (request.threadId) access.store.addEvent(request.threadId, "butler.self_improvement.discarded", `Closed self-improvement request ${request.id}.`);
        return {
          content: [{ type: "text", text: `Closed self-improvement request ${request.id}. Source changes were left untouched.` }],
          details: { request }
        };
      }
    }),
    access.defineButlerTool({
      name: "commit_self_improvement",
      label: "Commit self-improvement",
      description: "Commit all current changes in the active Manor checkout after an explicit operator request.",
      promptSnippet:
        "commit_self_improvement: use only when the operator explicitly asks to commit the active Manor checkout. This stages every current checkout change. Requires the request id and commit message.",
      parameters: Type.Object({
        requestId: Type.String({ minLength: 1 }),
        message: Type.String({ minLength: 1 })
      }),
      uiEffects: access.getToolUiEffects("commit_self_improvement"),
      execute: async (_toolCallId, params) => {
        const typedParams = params as { requestId: string; message: string };
        const request = await commitSelfImprovementRequest(getSelfImprovementRequestState(), typedParams.requestId.trim(), typedParams.message);
        if (request.threadId) access.store.addEvent(request.threadId, "butler.self_improvement.committed", `Committed self-improvement request ${request.id}.`);
        return {
          content: [{ type: "text", text: `Committed self-improvement request ${request.id} locally at ${request.commitSha}.` }],
          details: { request }
        };
      }
    }),
    access.defineButlerTool({
      name: "open_self_improvement_pr",
      label: "Open self-improvement PR",
      description: "Open a draft pull request for already committed self-improvement changes after an explicit operator request.",
      promptSnippet:
        "open_self_improvement_pr: use only when the operator explicitly asks to open a pull request for an already committed self-improvement request. Requires the request id.",
      parameters: Type.Object({
        requestId: Type.String({ minLength: 1 }),
        title: Type.Optional(Type.String({ minLength: 1 })),
        body: Type.Optional(Type.String({ minLength: 1 }))
      }),
      uiEffects: access.getToolUiEffects("open_self_improvement_pr"),
      execute: async (_toolCallId, params) => {
        const typedParams = params as { requestId: string; title?: string; body?: string };
        const request = await openSelfImprovementPullRequest(getSelfImprovementRequestState(), typedParams.requestId.trim(), typedParams.title ?? null, typedParams.body ?? null);
        if (request.threadId) access.store.addEvent(request.threadId, "butler.self_improvement.pr_opened", `Opened self-improvement pull request ${request.pullRequestUrl}.`);
        return {
          content: [{ type: "text", text: `Opened draft pull request for self-improvement request ${request.id}: ${request.pullRequestUrl}.` }],
          details: { request }
        };
      }
    }),
    access.defineButlerTool({
      name: "list_image_references",
      label: "List image references",
      description: "List stored image references Butler can reuse.",
      promptSnippet: "list_image_references: inspect uploaded references when visual requirements matter.",
      parameters: Type.Object({}),
      uiEffects: access.getToolUiEffects("list_image_references"),
      execute: async () => {
        const images = access.imageStore.list();
        const text =
          images.length === 0
            ? "No image references are stored."
            : images
                .map(
                  (image, index) => `${index + 1}. ${image.id} | ${image.name} | ${image.mimeType} | ${image.sizeBytes} bytes`
                )
                .join("\n");
        return {
          content: [{ type: "text", text }],
          details: { images }
        };
      }
    }),
    access.defineButlerTool({
      name: "list_file_references",
      label: "List file references",
      description: "List stored non-image file references Butler can reuse.",
      promptSnippet: "list_file_references: inspect uploaded files when document analysis is needed.",
      parameters: Type.Object({}),
      uiEffects: access.getToolUiEffects("list_file_references"),
      execute: async () => {
        const files = access.fileStore.list();
        const text =
          files.length === 0
            ? "No file references are stored."
            : files
                .map(
                  (file, index) => `${index + 1}. ${file.id} | ${file.name} | ${file.mimeType} | ${file.sizeBytes} bytes`
                )
                .join("\n");
        return {
          content: [{ type: "text", text }],
          details: { files }
        };
      }
    }),
    access.defineButlerTool({
      name: "open_job_window",
      label: "Open job window",
      description: "Open a focused job window in the Butler UI for a specific worker job.",
      promptSnippet: "open_job_window: open a deeper UI window for a job the operator wants to inspect.",
      parameters: Type.Object({
        threadId: Type.String({ minLength: 1 })
      }),
      uiEffects: access.getToolUiEffects("open_job_window"),
      execute: async (_toolCallId, params) => {
        const typedParams = params as { threadId: string };
        try {
          await loadWorkerThread(access, typedParams.threadId);
        } catch (error) {
          if (!shouldAllowLocalThreadFallback(access.store, typedParams.threadId, error)) {
            throw error;
          }
          access.store.addEvent(
            typedParams.threadId,
            "thread/window/local-fallback",
            "Live worker thread refresh was unavailable, so Butler opened the saved local job window instead."
          );
        }
        access.store.openWindow(typedParams.threadId);
        access.noteThreadFocus(typedParams.threadId, "open_job_window");
        return {
          content: [{ type: "text", text: `Opened a window for job ${typedParams.threadId}.` }],
          details: {
            thread: access.store.getThread(typedParams.threadId) ?? null
          }
        };
      }
    }),
    access.defineButlerTool({
      name: "list_open_windows",
      label: "List open windows",
      description: "List the windows currently open in the Butler UI.",
      promptSnippet: "list_open_windows: see which job windows are already open.",
      parameters: Type.Object({}),
      uiEffects: access.getToolUiEffects("list_open_windows"),
      execute: async () => {
        const workerState = access.piRpcWorkerClient?.getConnectionState() ?? {
          connected: false,
          lastError: "Pi Worker runtime is not available",
          compose: { model: null, effort: null, availableModels: [] }
        };
        const snapshot = access.store.getSnapshot(access.getSnapshot(), {
          ...workerState,
          auth: access.getWorkerAuthStatus()
        });

        const text =
          snapshot.codex.windows.length === 0
            ? "No windows are open."
            : snapshot.codex.windows.map((window, index) => `${index + 1}. ${window.threadId} | ${window.title}`).join("\n");

        return {
          content: [{ type: "text", text }],
          details: {
            windows: snapshot.codex.windows
          }
        };
      }
    }),
    access.defineButlerTool({
      name: "read_supervision_checklist",
      label: "Read checklist",
      description: "Read the structured Butler supervision checklist for one delegated worker job.",
      promptSnippet: "read_supervision_checklist: inspect acceptance points, worker evidence, Butler decisions, and heartbeat for one job.",
      parameters: Type.Object({
        threadId: Type.String({ minLength: 1 })
      }),
      uiEffects: access.getToolUiEffects("read_supervision_checklist"),
      execute: async (_toolCallId, params) => {
        const typedParams = params as { threadId: string };
        const checklist = access.store.getSupervisionChecklist(typedParams.threadId);
        const text = checklist
          ? [
              `Supervision checklist for job ${typedParams.threadId}: ${checklist.reviewState}`,
              `Heartbeat: ${checklist.heartbeat.lastKnownThreadStatus}${checklist.heartbeat.stale ? " stale" : ""}`,
              ...checklist.items.map((item) => {
                const latestEvidence = item.evidence.at(-1);
                return `${item.id}: ${item.status} - ${item.text}${item.butlerNote ? ` | Butler: ${item.butlerNote}` : ""}${latestEvidence ? ` | Evidence: ${latestEvidence.summary}` : ""}`;
              })
            ].join("\n")
          : `No supervision checklist exists for job ${typedParams.threadId}.`;
        return {
          content: [{ type: "text", text }],
          details: { checklist }
        };
      }
    }),
    access.defineButlerTool({
      name: "review_acceptance_point",
      label: "Review point",
      description:
        "Record Butler's structured review decision for one acceptance point. Rejections require nextInstruction and are queued for one batched worker follow-up.",
      promptSnippet:
        "review_acceptance_point: mark one acceptance point accepted, rejected, or waived after Butler reviews evidence; rejected points require nextInstruction.",
      parameters: Type.Object({
        threadId: Type.String({ minLength: 1 }),
        pointId: Type.String({ minLength: 1 }),
        status: Type.Union([Type.Literal("accepted"), Type.Literal("rejected"), Type.Literal("waived")]),
        note: Type.Optional(Type.String()),
        nextInstruction: Type.Optional(Type.String())
      }),
      uiEffects: access.getToolUiEffects("review_acceptance_point"),
      execute: async (_toolCallId, params) => {
        const typedParams = params as {
          threadId: string;
          pointId: string;
          status: "accepted" | "rejected" | "waived";
          note?: string;
          nextInstruction?: string;
        };
        if (typedParams.status === "rejected" && !typedParams.nextInstruction?.trim()) {
          throw new Error("Rejected acceptance points require nextInstruction so Butler can batch one worker follow-up.");
        }
        const checklist = access.store.reviewAcceptancePoint({
          threadId: typedParams.threadId,
          pointId: typedParams.pointId,
          status: typedParams.status,
          note: typedParams.note,
          nextInstruction: typedParams.nextInstruction
        });
        const item = checklist.items.find((entry) => entry.id === typedParams.pointId);
        return {
          content: [{ type: "text", text: `${typedParams.pointId} marked ${typedParams.status}${item ? `: ${item.text}` : ""}.` }],
          details: { checklist }
        };
      }
    }),
    access.defineButlerTool({
      name: "review_acceptance_points",
      label: "Review points",
      description: "Atomically record Butler's explicit decisions for several acceptance points after one evidence review.",
      promptSnippet: "review_acceptance_points: batch two or more accepted, rejected, or waived checklist decisions in one call; every rejected point still requires nextInstruction.",
      parameters: Type.Object({
        threadId: Type.String({ minLength: 1 }),
        decisions: Type.Array(Type.Object({
          pointId: Type.String({ minLength: 1 }),
          status: Type.Union([Type.Literal("accepted"), Type.Literal("rejected"), Type.Literal("waived")]),
          note: Type.Optional(Type.String()),
          nextInstruction: Type.Optional(Type.String())
        }), { minItems: 2, maxItems: 100 })
      }),
      uiEffects: access.getToolUiEffects("review_acceptance_points"),
      execute: async (_toolCallId, params) => {
        const typedParams = params as {
          threadId: string;
          decisions: Array<{ pointId: string; status: "accepted" | "rejected" | "waived"; note?: string; nextInstruction?: string }>;
        };
        assertCallbackReviewCurrent(typedParams.threadId);
        const checklist = access.store.reviewAcceptancePoints({ threadId: typedParams.threadId, decisions: typedParams.decisions });
        return {
          content: [{ type: "text", text: `Recorded ${typedParams.decisions.length} acceptance-point decisions. Checklist is ${checklist.reviewState}.` }],
          details: { checklist }
        };
      }
    }),
    access.defineButlerTool({
      name: "disprove_review_finding",
      label: "Disprove review finding",
      description: "Resolve one isolated blocking review finding only when stronger concrete evidence proves it is a false positive.",
      promptSnippet: "disprove_review_finding: waive a blocking adversarial finding only when you can cite stronger concrete evidence that disproves it; otherwise reject the affected acceptance point and steer the worker.",
      parameters: Type.Object({
        threadId: Type.String({ minLength: 1 }),
        findingId: Type.String({ minLength: 1 }),
        evidence: Type.String({ minLength: 1 })
      }),
      uiEffects: access.getToolUiEffects("disprove_review_finding"),
      execute: async (_toolCallId, params) => {
        const typedParams = params as { threadId: string; findingId: string; evidence: string };
        const thread = access.store.getThread(typedParams.threadId);
        const report = access.store.getWorkerReport(typedParams.threadId);
        const finding = thread?.executionContract?.reviewResults?.find((entry) =>
          entry.id === typedParams.findingId &&
          entry.turnId === report?.turnId &&
          entry.reportUpdatedAt === report?.updatedAt
        );
        if (!finding) throw new Error("The review finding is not part of the current Worker report.");
        if (!finding.blocking) throw new Error("Only blocking review findings need an explicit Butler resolution.");
        const evidence = typedParams.evidence.trim();
        access.store.recordWorkerReviewResults(typedParams.threadId, [{
          ...finding,
          waived: true,
          waiverReason: `Butler disproved this finding: ${evidence}`,
          updatedAt: Date.now()
        }]);
        access.store.addEvent(typedParams.threadId, "butler.adversarial_review.disproved", `Butler disproved review finding ${finding.id}: ${evidence}`);
        return {
          content: [{ type: "text", text: `Review finding ${finding.id} marked disproved from stronger evidence.` }],
          details: { finding: access.store.getThread(typedParams.threadId)?.executionContract?.reviewResults?.find((entry) => entry.id === finding.id) ?? null }
        };
      }
    }),
    access.defineButlerTool({
      name: "flush_rejected_acceptance_points",
      label: "Send rejected points",
      description: "Send one private worker follow-up containing all queued rejected acceptance-point instructions.",
      promptSnippet: "flush_rejected_acceptance_points: after marking all rejected points, batch-send the queued fixes to the worker once.",
      parameters: Type.Object({
        threadId: Type.String({ minLength: 1 })
      }),
      uiEffects: access.getToolUiEffects("flush_rejected_acceptance_points"),
      execute: async (_toolCallId, params) => {
        const typedParams = params as { threadId: string };
        const text = access.store.buildQueuedRejectionInstruction(typedParams.threadId);
        if (!text) {
          return {
            content: [{ type: "text", text: `No queued rejected acceptance points for job ${typedParams.threadId}.` }],
            details: { checklist: access.store.getSupervisionChecklist(typedParams.threadId) }
          };
        }
        const limitMessage = access.getThreadBudgetLimitMessage(typedParams.threadId);
        if (limitMessage) {
          return {
            content: [{ type: "text", text: limitMessage }],
            details: {
              checklist: access.store.getSupervisionChecklist(typedParams.threadId),
              supervision: access.store.getThreadSupervision(typedParams.threadId)
            }
          };
        }
        await loadWorkerThread(access, typedParams.threadId);
        const requestedAt = Date.now();
        const reservation = await access.reserveDirectCodexMessage({ threadId: typedParams.threadId, text, requestedAt });
        let sent = false;
        let reviewedDispatchCounted = false;
        let supervision = access.store.getThreadSupervision(typedParams.threadId);
        const countReviewedDispatch = () => {
          if (reviewedDispatchCounted) return supervision;
          supervision = access.store.noteReviewedWorkerDispatch(typedParams.threadId);
          reviewedDispatchCounted = true;
          access.store.addEvent(typedParams.threadId, "butler.supervision.rejection_followup", "Butler sent queued rejected checklist items to the worker.");
          return supervision;
        };
        try {
          const payload = await access.createOrUpdateJobPayload({
            threadId: typedParams.threadId,
            kind: "rejection_followup",
            instruction: text,
            onPrepared: (prepared) => { reservation.jobPayloadReplacement = structuredClone(prepared); }
          });
          assertCallbackReviewCurrent(typedParams.threadId);
          const dispatch = await sendWorkerMessage(access, typedParams.threadId, `${formatJobPayloadMessage("rejection_followup", typedParams.threadId, payload.workerDirective, payload.display.summary)}\n\n${directWorkerDispatchMarker(typedParams.threadId, requestedAt)}`);
          sent = true;
          countReviewedDispatch();
          await access.bindJobPayloadDelivery(typedParams.threadId, { turnId: dispatch.turnId });
          await access.markPendingChatCallbackDispatched(typedParams.threadId, requestedAt, dispatch.turnId);
          access.store.clearQueuedRejectionInstructions(typedParams.threadId);
          return { content: [{ type: "text", text: `Sent queued rejected acceptance points to job ${typedParams.threadId}.` }], details: { payload, supervision, checklist: access.store.getSupervisionChecklist(typedParams.threadId) } };
        } catch (error) {
          if (!reviewedDispatchCounted && workerMessageDispatchMayHaveBeenAccepted(error)) countReviewedDispatch();
          if (!sent) await settleFailedDirectWorkerDispatch(error, () => access.markPendingChatCallbackDispatched(typedParams.threadId, requestedAt, null), () => access.rollbackDirectCodexMessage(typedParams.threadId, requestedAt, reservation));
          throw error;
        }
      }
    }),
    access.defineButlerTool({
      name: "hold_job_context",
      label: "Hold job context",
      description:
        "Record newer operator context for one active worker job without interrupting the worker. Butler will apply the held context during the next callback review.",
      promptSnippet:
        "hold_job_context: use when the operator gives newer context for an active job, but the worker can finish the current turn before Butler decides whether to steer, accept, reject, or close.",
      parameters: Type.Object({
        threadId: Type.String({ minLength: 1 }),
        text: Type.String({ minLength: 1 })
      }),
      uiEffects: access.getToolUiEffects("hold_job_context"),
      execute: async (_toolCallId, params) => {
        const typedParams = params as { threadId: string; text: string };
        const activeGuard = access.getActiveOperatorThreadGuard();
        if (activeGuard) {
          if (activeGuard.explicitThreadIds.length > 0 && !activeGuard.explicitThreadIds.includes(typedParams.threadId)) {
            throw new Error(`The latest operator turn explicitly referenced job ${activeGuard.explicitThreadIds.join(", ")}. Hold context on one of those exact jobs or clarify before using ${typedParams.threadId}.`);
          }
          if (activeGuard.explicitThreadIds.length === 0 && activeGuard.lockedThreadId && activeGuard.lockedThreadId !== typedParams.threadId) {
            throw new Error(`The latest operator turn is currently anchored to job ${activeGuard.lockedThreadId}. Hold context on that exact job or clarify before using ${typedParams.threadId}.`);
          }
        }
        const thread = access.store.getThread(typedParams.threadId);
        if (!thread || !thread.cwd || thread.source === "unknown" || thread.turnCount === 0) {
          throw new Error(`Job ${typedParams.threadId} is not a valid reusable worker workstream.`);
        }
        if (thread.status !== "active") {
          throw new Error(`Job ${typedParams.threadId} is not active. Answer directly or use message_job if the worker needs a new turn.`);
        }
        const payload = await access.createOrUpdateJobPayload({
          threadId: typedParams.threadId,
          kind: "held_context",
          instruction: typedParams.text
        });
        assertCallbackReviewCurrent(typedParams.threadId);
        await access.registerPendingChatCallback(typedParams.threadId, {
          preservePrivateSteer: true,
          operatorRequestText: activeGuard?.operatorRequestText ?? null,
          nextWorkerReportAction: "review"
        });
        access.noteThreadFocus(typedParams.threadId, "hold_job_context");
        access.store.addEvent(typedParams.threadId, "butler.context.held", typedParams.text.trim());
        return {
          content: [{ type: "text", text: `Held newer operator context for job ${typedParams.threadId}. Butler will apply it during the next review.` }],
          details: { payload, thread: access.store.getThread(typedParams.threadId) ?? null }
        };
      }
    }),
    access.defineButlerTool({
      name: "message_job",
      label: "Message job",
      description:
        "Send a private follow-up instruction into one existing valid worker job outside checklist rejection review. Use flush_rejected_acceptance_points for rejected acceptance points.",
      promptSnippet:
        "message_job: steer, continue, retry, stop, clean up, or ask an existing valid worker job when this is not rejected-checklist steering.",
      parameters: Type.Object({
        threadId: Type.String({ minLength: 1 }),
        text: Type.String({ minLength: 1 }),
        imageReferenceIds: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
        fileReferenceIds: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
        refreshChecklist: Type.Optional(Type.Boolean({ description: "Replace the current review contract for a genuine new work slice or material scope/acceptance change, including when existing points are pending or rejected. When true, text must state the complete resulting scope, including every criterion that should remain." })),
        nextWorkerReportAction: Type.Optional(Type.Union([Type.Literal("review"), Type.Literal("reply_to_operator")]))
      }),
      uiEffects: access.getToolUiEffects("message_job"),
      execute: async (_toolCallId, params) => {
        return continueWorkerJob(access, params as ContinueWorkerJobParams);
      }
    }),
    access.defineButlerTool({
      name: "reply_to_operator",
      label: "Reply to operator",
      description: "Post the one operator-facing delegated-job update Butler has decided to surface.",
      promptSnippet:
        "reply_to_operator: use this only when Butler has decided the delegated job is finished, blocked, or needs operator input now.",
      parameters: Type.Object({
        threadId: Type.String({ minLength: 1 }),
        text: Type.String({ minLength: 1 })
      }),
      uiEffects: access.getToolUiEffects("reply_to_operator"),
      execute: async (_toolCallId, params) => {
        const typedParams = params as { threadId: string; text: string };
        const closeoutBlocker = access.getOperatorCloseoutBlocker(typedParams.threadId);
        if (closeoutBlocker) {
          return {
            content: [{ type: "text", text: `Closeout blocked: ${closeoutBlocker}` }],
            details: {
              closeoutBlocked: true,
              thread: access.store.getThread(typedParams.threadId) ?? null,
              supervision: access.store.getThreadSupervision(typedParams.threadId)
            }
          };
        }
        await access.postOperatorJobReply(typedParams.threadId, typedParams.text);
        return {
          content: [{ type: "text", text: `Posted the operator-facing update for job ${typedParams.threadId}.` }],
          details: {
            thread: access.store.getThread(typedParams.threadId) ?? null,
            supervision: access.store.getThreadSupervision(typedParams.threadId)
          }
        };
      }
    }),
    access.defineButlerTool({
      name: "stop_job",
      label: "Stop job",
      description: "Immediately stop one active Worker job without deleting its thread or starting a replacement.",
      promptSnippet: "stop_job: when the operator says stop, cancel, interrupt, or pause a Worker, call this immediately before inspecting or reporting the job. Do not send another Worker message or start a replacement unless the operator asks.",
      parameters: Type.Object({
        threadId: Type.String({ minLength: 1 })
      }),
      uiEffects: access.getToolUiEffects("stop_job"),
      execute: async (_toolCallId, params) => {
        const typedParams = params as { threadId: string };
        const stopped = await stopWorkerThread(access, typedParams.threadId);
        await access.removeExternalWorkerDelegation?.(typedParams.threadId);
        access.store.addEvent(typedParams.threadId, "butler.worker.stopped_by_operator", stopped ? "Stopped at the operator's request." : "The operator requested a stop after the Worker was already idle.");
        await access.store.flushSave();
        return {
          content: [{ type: "text", text: stopped ? `Stopped job ${typedParams.threadId}.` : `Job ${typedParams.threadId} was already stopped.` }],
          details: { stopped, thread: access.store.getThread(typedParams.threadId) ?? null }
        };
      }
    }),
    access.defineButlerTool({
      name: "delete_job",
      label: "Delete job",
      description: "Permanently delete one worker job thread and its local session artifacts.",
      promptSnippet: "delete_job: remove one worker job thread when the operator explicitly asks for deletion.",
      parameters: Type.Object({
        threadId: Type.String({ minLength: 1 })
      }),
      uiEffects: access.getToolUiEffects("delete_job"),
      execute: async (_toolCallId, params) => {
        const typedParams = params as { threadId: string };
        assertDeletionDoesNotBypassSupervisionLimit(access, typedParams.threadId);
        try {
          const result = await deleteWorkerThread(access, typedParams.threadId);
          return {
            content: [{ type: "text", text: `Deleted job ${typedParams.threadId}.` }],
            details: typeof result === "object" && result !== null ? result as Record<string, unknown> : { result }
          };
        } finally {
          if (!access.store.getThread(typedParams.threadId)) await access.removeExternalWorkerDelegation?.(typedParams.threadId);
        }
      }
    }),
    access.defineButlerTool({
      name: "delete_all_jobs",
      label: "Delete all jobs",
      description: "Permanently delete all worker job threads and their local session artifacts.",
      promptSnippet: "delete_all_jobs: remove all worker job threads only when the operator explicitly asks for a full cleanup.",
      parameters: Type.Object({}),
      uiEffects: access.getToolUiEffects("delete_all_jobs"),
      execute: async () => {
        const attachedWorkerThreadId = access.getWorkerDefaults?.()?.threadId ?? null;
        if (attachedWorkerThreadId) assertDeletionDoesNotBypassSupervisionLimit(access, attachedWorkerThreadId);
        const threadIds = access.store.listThreads().map((thread) => thread.id);
        const result = await runSerializedJobMutations(threadIds, async () => {
          try {
            return await deleteAllWorkerThreads(access);
          } finally {
            await Promise.all(threadIds
              .filter((threadId) => !access.store.getThread(threadId))
              .map((threadId) => access.removeExternalWorkerDelegation?.(threadId)));
          }
        });
        return {
          content: [{ type: "text", text: `Deleted ${result.deletedThreadIds.length} jobs.` }],
          details: result
        };
      }
    })
  ];
}

/** @deprecated Use buildButlerWorkerTools for provider-neutral worker tools. */
export const buildButlerCodexTools = buildButlerWorkerTools;
