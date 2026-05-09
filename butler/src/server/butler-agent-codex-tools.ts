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
import { buildCodexInputWithReferences } from "./reference-inputs.js";
import { listWorkspaceProjectDirectories } from "./repo-worktree.js";

export function buildButlerCodexTools(access: ButlerAgentToolAccess): ButlerCustomTool[] {
  return [
    access.defineButlerTool({
      name: "list_jobs",
      label: "List jobs",
      description: "List tracked Codex jobs/threads across statuses, including active and inactive jobs, with current summaries.",
      promptSnippet: "list_jobs: use for broad Codex job/thread checks, counts, active/idle/blocked status summaries, or finding jobs by project before choosing one to inspect.",
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
      description: "Read one specific Codex job/thread in detail by thread id, including loaded turns and messages.",
      promptSnippet: "read_job: use after you have a specific thread id and need that job's transcript, supervisor state, or details.",
      parameters: Type.Object({
        threadId: Type.String()
      }),
      uiEffects: access.getToolUiEffects("read_job"),
      execute: async (_toolCallId, params) => {
        const typedParams = params as { threadId: string };
        try {
          await access.codexClient.loadThread(typedParams.threadId);
        } catch (error) {
          if (!shouldAllowLocalThreadFallback(access.store, typedParams.threadId, error)) {
            throw error;
          }
          access.store.addEvent(
            typedParams.threadId,
            "thread/read/local-fallback",
            "Codex live thread refresh was unavailable, so Butler used the saved local job transcript."
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
        "list_projects: use for project inventory questions. It returns top-level project directories plus nested Git repositories first, then tracked workstream groups and active-work counts separately.",
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
        projectId: Type.String()
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
      description: "Open a focused job window in the Butler UI for a specific Codex job.",
      promptSnippet: "open_job_window: open a deeper UI window for a job the operator wants to inspect.",
      parameters: Type.Object({
        threadId: Type.String()
      }),
      uiEffects: access.getToolUiEffects("open_job_window"),
      execute: async (_toolCallId, params) => {
        const typedParams = params as { threadId: string };
        try {
          await access.codexClient.loadThread(typedParams.threadId);
        } catch (error) {
          if (!shouldAllowLocalThreadFallback(access.store, typedParams.threadId, error)) {
            throw error;
          }
          access.store.addEvent(
            typedParams.threadId,
            "thread/window/local-fallback",
            "Codex live thread refresh was unavailable, so Butler opened the saved local job window instead."
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
        const snapshot = access.store.getSnapshot(access.getSnapshot(), {
          ...access.codexClient.getConnectionState(),
          auth: access.getCodexAuthStatus()
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
      description: "Read the structured Butler supervision checklist for one delegated Codex job.",
      promptSnippet: "read_supervision_checklist: inspect acceptance points, worker evidence, Butler decisions, and heartbeat for one job.",
      parameters: Type.Object({
        threadId: Type.String()
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
        threadId: Type.String(),
        pointId: Type.String(),
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
      name: "flush_rejected_acceptance_points",
      label: "Send rejected points",
      description: "Send one private worker follow-up containing all queued rejected acceptance-point instructions.",
      promptSnippet: "flush_rejected_acceptance_points: after marking all rejected points, batch-send the queued fixes to the worker once.",
      parameters: Type.Object({
        threadId: Type.String()
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
        await access.codexClient.loadThread(typedParams.threadId);
        await access.codexClient.sendMessage(typedParams.threadId, text);
        access.store.clearQueuedRejectionInstructions(typedParams.threadId);
        access.registerPendingChatCallback(typedParams.threadId, {
          privateSteerText: text,
          nextWorkerReportAction: "review"
        });
        const supervision = access.store.noteButlerSteer(typedParams.threadId);
        access.store.addEvent(typedParams.threadId, "butler.supervision.rejection_followup", "Butler sent queued rejected checklist items to the worker.");
        return {
          content: [{ type: "text", text: `Sent queued rejected acceptance points to job ${typedParams.threadId}.` }],
          details: {
            supervision,
            checklist: access.store.getSupervisionChecklist(typedParams.threadId)
          }
        };
      }
    }),
    access.defineButlerTool({
      name: "hold_job_context",
      label: "Hold job context",
      description:
        "Record newer operator context for one active Codex job without interrupting the worker. Butler will apply the held context during the next callback review.",
      promptSnippet:
        "hold_job_context: use when the operator gives newer context for an active job, but the worker can finish the current turn before Butler decides whether to steer, accept, reject, or close.",
      parameters: Type.Object({
        threadId: Type.String(),
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
          throw new Error(`Job ${typedParams.threadId} is not a valid reusable Codex workstream.`);
        }
        if (thread.status !== "active") {
          throw new Error(`Job ${typedParams.threadId} is not active. Answer directly or use message_job if the worker needs a new turn.`);
        }
        access.registerPendingChatCallback(typedParams.threadId, { nextWorkerReportAction: "review" });
        access.noteThreadFocus(typedParams.threadId, "hold_job_context");
        access.store.addEvent(typedParams.threadId, "butler.context.held", typedParams.text.trim());
        return {
          content: [{ type: "text", text: `Held newer operator context for job ${typedParams.threadId}. Butler will apply it during the next review.` }],
          details: { thread: access.store.getThread(typedParams.threadId) ?? null }
        };
      }
    }),
    access.defineButlerTool({
      name: "message_job",
      label: "Message job",
      description:
        "Send a private follow-up instruction into one existing valid Codex job outside checklist rejection review. Use flush_rejected_acceptance_points for rejected acceptance points.",
      promptSnippet:
        "message_job: steer, continue, retry, stop, clean up, or ask an existing valid Codex job when this is not rejected-checklist steering.",
      parameters: Type.Object({
        threadId: Type.String(),
        text: Type.String({ minLength: 1 }),
        imageReferenceIds: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
        fileReferenceIds: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
        refreshChecklist: Type.Optional(Type.Boolean()),
        nextWorkerReportAction: Type.Optional(Type.Union([Type.Literal("review"), Type.Literal("reply_to_operator")]))
      }),
      uiEffects: access.getToolUiEffects("message_job"),
      execute: async (_toolCallId, params) => {
        const typedParams = params as {
          threadId: string;
          text: string;
          imageReferenceIds?: string[];
          fileReferenceIds?: string[];
          refreshChecklist?: boolean;
          nextWorkerReportAction?: "review" | "reply_to_operator";
        };
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
            `Job ${typedParams.threadId} is not a valid reusable Codex workstream. Start a fresh Codex job with delegate_to_codex instead.`
          );
        }
        const limitMessage = access.getThreadBudgetLimitMessage(typedParams.threadId);
        if (limitMessage) {
          return {
            content: [{ type: "text", text: limitMessage }],
            details: {
              thread: thread ?? null,
              supervision: access.store.getThreadSupervision(typedParams.threadId)
            }
          };
        }
        await access.codexClient.loadThread(typedParams.threadId);
        const refreshedChecklist = typedParams.refreshChecklist
          ? access.store.refreshCompletedSupervisionChecklistForFollowup(typedParams.threadId, typedParams.text)
          : null;
        await access.codexClient.sendMessage(
          typedParams.threadId,
          buildCodexInputWithReferences({
            text: `BUTLER FOLLOW-UP\nApply this within the existing job context.\n\n${typedParams.text}`,
            imageStore: access.imageStore,
            imageReferenceIds: typedParams.imageReferenceIds ?? [],
            fileStore: access.fileStore,
            fileReferenceIds: typedParams.fileReferenceIds ?? []
          })
        );
        access.registerPendingChatCallback(typedParams.threadId, {
          privateSteerText: typedParams.text,
          nextWorkerReportAction: typedParams.nextWorkerReportAction ?? "review"
        });
        const supervision = access.store.noteButlerSteer(typedParams.threadId);
        access.store.addEvent(typedParams.threadId, "butler.supervision.turn_spent", "Butler spent a private supervision turn on this job.");
        access.noteThreadFocus(typedParams.threadId, "message_job");
        return {
          content: [
            {
              type: "text",
              text: `Sent a private follow-up to job ${typedParams.threadId}. Butler budget: ${supervision.butlerTurnsUsed}/${supervision.maxButlerTurns ?? "∞"}. Next worker report action: ${typedParams.nextWorkerReportAction ?? "review"}.`
            }
          ],
          details: {
            checklist: refreshedChecklist,
            supervision,
            thread: access.store.getThread(typedParams.threadId) ?? null
          }
        };
      }
    }),
    access.defineButlerTool({
      name: "reply_to_operator",
      label: "Reply to operator",
      description: "Post the one operator-facing delegated-job update Butler has decided to surface.",
      promptSnippet:
        "reply_to_operator: use this only when Butler has decided the delegated job is finished, blocked, or needs operator input now.",
      parameters: Type.Object({
        threadId: Type.String(),
        text: Type.String({ minLength: 1 })
      }),
      uiEffects: access.getToolUiEffects("reply_to_operator"),
      execute: async (_toolCallId, params) => {
        const typedParams = params as { threadId: string; text: string };
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
      name: "delete_job",
      label: "Delete job",
      description: "Permanently delete one Codex job thread and its local session artifacts.",
      promptSnippet: "delete_job: remove one Codex job thread when the operator explicitly asks for deletion.",
      parameters: Type.Object({
        threadId: Type.String()
      }),
      uiEffects: access.getToolUiEffects("delete_job"),
      execute: async (_toolCallId, params) => {
        const typedParams = params as { threadId: string };
        const result = await access.codexClient.deleteThread(typedParams.threadId);
        return {
          content: [{ type: "text", text: `Deleted job ${typedParams.threadId}.` }],
          details: result
        };
      }
    }),
    access.defineButlerTool({
      name: "delete_all_jobs",
      label: "Delete all jobs",
      description: "Permanently delete all Codex job threads and their local session artifacts.",
      promptSnippet: "delete_all_jobs: remove all Codex job threads only when the operator explicitly asks for a full cleanup.",
      parameters: Type.Object({}),
      uiEffects: access.getToolUiEffects("delete_all_jobs"),
      execute: async () => {
        const result = await access.codexClient.deleteAllThreads();
        return {
          content: [{ type: "text", text: `Deleted ${result.deletedThreadIds.length} jobs.` }],
          details: result
        };
      }
    })
  ];
}
