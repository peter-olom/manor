import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { AgentSession } from "@mariozechner/pi-coding-agent";

import { ButlerStateStore } from "./state-store.js";
import type {
  ButlerThreadCallbackView,
  ButlerMessagePageView,
  ButlerMessageView,
  CodexThreadExecutionContractView,
  PreviewLeaseView,
  PreviewProofRecordView,
  PreviewVerificationArtifactView,
  PreviewVerificationView
} from "./types.js";

export type ProofScreenshotReview = {
  verdict: string;
  visibleState: string;
  evidence: string;
  concern: string;
  rawText: string;
  reviewedAt: number;
  modelId: string;
  modelProvider: string;
};

export type ResolvedPreviewProof = {
  preview: Pick<PreviewLeaseView, "id" | "threadId" | "projectId" | "projectLabel" | "title" | "stackId">;
  verification: PreviewVerificationView;
  primaryArtifact: PreviewVerificationArtifactView;
  primaryScreenshot: PreviewVerificationArtifactView | null;
  artifacts: PreviewVerificationArtifactView[];
  screenshots: PreviewVerificationArtifactView[];
  video: PreviewVerificationArtifactView | null;
  manifest: PreviewVerificationArtifactView | null;
  trace: PreviewVerificationArtifactView | null;
};

export type SupervisionSmokePlan = {
  threadId: string;
  totalFollowUps: number;
  followUpsSent: number;
};

export type PendingChatCallback = ButlerThreadCallbackView;
export type ButlerOperatorThreadGuard = {
  explicitThreadIds: string[];
  lockedThreadId: string | null;
  contextPrompt: string | null;
};

export const SNAPSHOT_MESSAGE_TAIL_LIMIT = 200;
export const MAX_HISTORY_PAGE_SIZE = 1000;
export const BUTLER_BACKGROUND_PROMPT_PREFIX = "[[BUTLER_BACKGROUND]]";
const THREAD_ID_PATTERN = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;

export function isButlerBackgroundPromptText(text: string | null | undefined): boolean {
  return typeof text === "string" && text.trimStart().startsWith(BUTLER_BACKGROUND_PROMPT_PREFIX);
}

export function contentToText(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }

  if (Array.isArray(content)) {
    return content
      .map((entry) => {
        if (entry && typeof entry === "object" && "text" in entry && typeof entry.text === "string") {
          return entry.text;
        }
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }

  return "";
}

export function extractMessageTimestamp(message: Record<string, unknown>): number | null {
  const candidates = [message.timestamp, message.createdAt, message.at];

  for (const candidate of candidates) {
    if (typeof candidate === "number" && Number.isFinite(candidate)) {
      return candidate;
    }

    if (typeof candidate === "string") {
      const parsed = Date.parse(candidate);
      if (Number.isFinite(parsed)) {
        return parsed;
      }
    }
  }

  return null;
}

export function extractWorkspaceMentions(text: string): string[] {
  const matches = text.match(/\/repos(?:\/\.manor-worktrees)?\/[^\s`"'()<>{}\]]+/g) ?? [];
  return [...new Set(matches.map((entry) => entry.replace(/[.,;:!?]+$/g, "")))];
}

export function extractReferencedThreadIds(text: string): string[] {
  const matches = text.match(THREAD_ID_PATTERN) ?? [];
  return [...new Set(matches.map((entry) => entry.toLowerCase()))];
}

function looksLikeThreadFollowUp(text: string): boolean {
  const normalized = text.trim().toLowerCase();
  if (!normalized) {
    return false;
  }

  const explicitFollowUpPatterns = [
    /\bthat (job|thread|run|workstream)\b/,
    /\bthis (job|thread|run|workstream)\b/,
    /\bsame (job|thread|run|workstream)\b/,
    /\bcontinue (it|that|this|the job|the thread)\b/,
    /\breuse (it|that|this|the job|the thread)\b/,
    /\bswitch (it|that|this|the job|the thread)\b/,
    /\bopen (a )?pr\b/,
    /\bcreate (a )?pr\b/,
    /\bpush it\b/,
    /\bdo that\b/,
    /\bgo ahead\b/,
    /\bfix it\b/,
    /\b(actually|also|btw|one more thing|new context|new info|update|correction)\b/,
    /\b(for|on) (that|this|the same)\b/
  ];

  return explicitFollowUpPatterns.some((pattern) => pattern.test(normalized));
}

export function buildOperatorThreadGuard(
  store: ButlerStateStore,
  text: string,
  recentFocusedThreadId: string | null
): ButlerOperatorThreadGuard {
  const referencedIds = extractReferencedThreadIds(text);
  const explicitThreadIds = referencedIds.filter((threadId) => Boolean(store.getThread(threadId)));
  const contextLines: string[] = [];
  let lockedThreadId: string | null = explicitThreadIds.length === 1 ? explicitThreadIds[0]! : null;

  if (referencedIds.length > 0) {
    if (explicitThreadIds.length > 0) {
      contextLines.push(
        "Operator referenced these exact tracked job ids in the latest turn. Treat them as authoritative and do not silently substitute a different job."
      );
    } else {
      contextLines.push(
        "The latest operator turn contains UUID-like references, but none resolve to tracked Codex jobs. Treat them as files, images, or artifacts unless the operator explicitly clarifies they are job ids."
      );
    }

    for (const threadId of referencedIds) {
      const thread = store.getThread(threadId);
      if (!thread) {
        contextLines.push(`- ${threadId} | not currently tracked as a Codex job`);
        continue;
      }

      contextLines.push(
        `- ${thread.id} | project=${thread.supervisor.projectLabel} | status=${thread.status} | summary=${thread.supervisor.summary}`
      );
    }
  }

  if (explicitThreadIds.length === 0 && recentFocusedThreadId && looksLikeThreadFollowUp(text)) {
    const thread = store.getThread(recentFocusedThreadId);
    if (thread) {
      lockedThreadId = thread.id;
      contextLines.push("The latest operator message looks like a follow-up to the job currently in active discussion.");
      contextLines.push(
        `- ${thread.id} | project=${thread.supervisor.projectLabel} | status=${thread.status} | summary=${thread.supervisor.summary}`
      );
      contextLines.push("Unless the operator clearly switches jobs, keep this follow-up bound to that same job.");
    }
  }

  return {
    explicitThreadIds,
    lockedThreadId,
    contextPrompt: contextLines.length > 0 ? contextLines.join("\n") : null
  };
}

export function serializeMessages(session: AgentSession): ButlerMessageView[] {
  const serialized: ButlerMessageView[] = [];
  let hideAssistantReply = false;

  for (let index = 0; index < session.messages.length; index += 1) {
    const message = session.messages[index];
    const role = "role" in message && typeof message.role === "string" ? message.role : "unknown";
    const record = message as unknown as Record<string, unknown>;
    const text =
      "content" in message && contentToText(message.content).trim()
        ? contentToText(message.content)
        : typeof record.errorMessage === "string"
          ? record.errorMessage
          : "";

    if (role === "user") {
      hideAssistantReply = isButlerBackgroundPromptText(text);
      if (hideAssistantReply) {
        continue;
      }
    } else if (hideAssistantReply && role === "assistant") {
      continue;
    }

    const nextMessage = {
      id: `message-${index}`,
      role,
      text,
      at: extractMessageTimestamp(record),
      kind: "message" as const
    };

    if (!(nextMessage.role === "user" || nextMessage.role === "assistant" || nextMessage.role === "user-with-attachments")) {
      continue;
    }

    if (nextMessage.role === "assistant" && !nextMessage.text.trim()) {
      continue;
    }

    serialized.push(nextMessage);
  }

  return serialized;
}

export function isAssistantFailureMessage(message: unknown): message is Record<string, unknown> & {
  role: "assistant";
  stopReason: "error" | "aborted";
  errorMessage?: string;
} {
  if (!message || typeof message !== "object") {
    return false;
  }

  const record = message as Record<string, unknown>;
  return (
    record.role === "assistant" &&
    (record.stopReason === "error" || record.stopReason === "aborted") &&
    (typeof record.errorMessage === "string" || !("errorMessage" in record))
  );
}

export function sanitizeHistoryMessage(message: unknown): { message: unknown; changed: boolean } {
  if (!message || typeof message !== "object") {
    return { message, changed: false };
  }

  const record = message as Record<string, unknown>;
  const role = typeof record.role === "string" ? record.role : null;
  if (role !== "user" && role !== "user-with-attachments") {
    return { message, changed: false };
  }

  const content = record.content;
  if (!Array.isArray(content)) {
    return { message, changed: false };
  }

  let removedImage = false;
  const nextContent: Record<string, unknown>[] = [];
  for (const entry of content) {
    if (!entry || typeof entry !== "object") {
      nextContent.push({ type: "text", text: String(entry ?? "") });
      continue;
    }

    const part = entry as Record<string, unknown>;
    if (part.type === "image") {
      removedImage = true;
      continue;
    }

    nextContent.push({ ...part });
  }

  if (!removedImage) {
    return { message, changed: false };
  }

  nextContent.push({
    type: "text",
    text: "[Attached image omitted from persisted Butler history.]"
  });

  return {
    changed: true,
    message: {
      ...record,
      role: "user",
      content: nextContent
    }
  };
}

export function sanitizeHistoryMessages(messages: AgentMessage[]): { messages: AgentMessage[]; changed: boolean } {
  let changed = false;
  const nextMessages = messages.map((message) => {
    const sanitized = sanitizeHistoryMessage(message);
    if (sanitized.changed) {
      changed = true;
    }
    return sanitized.message as AgentMessage;
  });

  return { messages: changed ? nextMessages : messages, changed };
}

export function buildJobsSummary(store: ButlerStateStore, limit: number, status?: string): string {
  const jobs = store
    .listThreads()
    .filter((thread) => !status || thread.status === status)
    .slice(0, limit);

  if (jobs.length === 0) {
    return "No jobs matched that filter.";
  }

  return jobs
    .map(
      (thread, index) =>
        `${index + 1}. ${thread.id} | project=${thread.supervisor.projectLabel} | status=${thread.status} | source=${thread.source} | updated=${new Date(thread.updatedAt).toISOString()} | task=${thread.supervisor.latestUserPrompt ?? thread.executionContract?.requestedTask ?? "(empty)"} | contract=${thread.executionContract ? "present" : "none"} | summary=${thread.supervisor.summary}`
    )
    .join("\n");
}

export function shouldAllowLocalThreadFallback(store: ButlerStateStore, threadId: string, error: unknown): boolean {
  const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  const retryable = message.includes("failed to locate rollout") || message.includes("thread not found") || message.includes("thread not loaded");
  return retryable && Boolean(store.getThread(threadId));
}

export function buildJobDetail(store: ButlerStateStore, threadId: string): string {
  const thread = store.getThread(threadId);
  if (!thread) {
    return `Job ${threadId} was not found.`;
  }
  const lease = store.getThreadPreviewLease(threadId);
  const jobMemory = store.getJobMemory(threadId);
  const checklist = store.getSupervisionChecklist(threadId);
  const checklistSummary = checklist
    ? checklist.items.map((item) => `${item.id}:${item.status}:${item.text}`).join(" | ")
    : "(none)";

  const turns = thread.turns
    .map((turn, turnIndex) => {
      const items = turn.items
        .map((item, itemIndex) => `${turnIndex + 1}.${itemIndex + 1} ${item.type} (${item.status}) ${item.text}`.trim())
        .join("\n");
      return `Turn ${turnIndex + 1} | id=${turn.id} | status=${turn.status}\n${items}`;
    })
    .join("\n\n");

  return [
    `Job ${thread.id}`,
    `project=${thread.supervisor.projectLabel}`,
    `status=${thread.status}`,
    `source=${thread.source}`,
    `task=${thread.supervisor.latestUserPrompt ?? thread.executionContract?.requestedTask ?? "(empty)"}`,
    `contract=${thread.executionContract ? "present" : "none"}`,
    `checklist=${checklistSummary}`,
    lease ? `operator_preview=${lease.operatorUrl}` : "operator_preview=(none)",
    `summary=${thread.supervisor.summary}`,
    jobMemory?.latestCheckpoint ? `latest_checkpoint=${jobMemory.latestCheckpoint}` : "latest_checkpoint=(none)",
    jobMemory?.nextAction ? `next_action=${jobMemory.nextAction}` : "next_action=(none)",
    jobMemory && jobMemory.blockers.length > 0 ? `blockers=${jobMemory.blockers.join(" | ")}` : "blockers=(none)",
    jobMemory && jobMemory.promotionCandidates.length > 0
      ? `promotion_candidates=${jobMemory.promotionCandidates
          .map((candidate) => `${candidate.kind}:${candidate.status}:${candidate.summary}`)
          .join(" | ")}`
      : "promotion_candidates=(none)",
    turns || "No turn details loaded yet."
  ].join("\n");
}

export function buildProjectsSummary(store: ButlerStateStore, limit: number): string {
  const projects = store.listProjectSummaries().slice(0, limit);
  if (projects.length === 0) {
    return "No projects are active yet.";
  }

  return projects
    .map(
      (project, index) =>
        `${index + 1}. ${project.label} | threads=${project.threadCount} | active=${project.activeCount} | blocked=${project.blockedCount} | updated=${new Date(project.updatedAt).toISOString()} | summary=${project.summary}`
    )
    .join("\n");
}

export function buildProjectDetail(store: ButlerStateStore, projectId: string): string {
  const project = store.getProjectSummary(projectId);
  if (!project) {
    return `Project ${projectId} was not found.`;
  }
  const projectMemory = store.getProjectMemory(projectId);
  const pendingPromotions = store.listPendingPromotionCandidates(projectId);

  const threadLines = project.threadIds
    .map((threadId, index) => {
      const thread = store.getThread(threadId);
      if (!thread) {
        return null;
      }

      return `${index + 1}. ${thread.id} | status=${thread.status} | summary=${thread.supervisor.summary}`;
    })
    .filter(Boolean)
    .join("\n");

  return [
    `Project ${project.label}`,
    `threads=${project.threadCount}`,
    `active=${project.activeCount}`,
    `blocked=${project.blockedCount}`,
    `idle=${project.completedCount}`,
    `summary=${project.summary}`,
    projectMemory?.summary ? `project_memory=${projectMemory.summary}` : "project_memory=(none)",
    projectMemory && projectMemory.entries.length > 0
      ? `project_entries=${projectMemory.entries
          .slice(-5)
          .map((entry) => `${entry.kind}:${entry.summary}`)
          .join(" | ")}`
      : "project_entries=(none)",
    pendingPromotions.length > 0
      ? `pending_promotions=${pendingPromotions.map((entry) => `${entry.kind}:${entry.summary}`).join(" | ")}`
      : "pending_promotions=(none)",
    threadLines || "No thread details loaded yet."
  ].join("\n");
}

export function buildSupervisorOverview(store: ButlerStateStore): string {
  const summary = store.getSupervisorSummary();
  const leadProjects = store
    .listProjectSummaries()
    .slice(0, 5)
    .map((project, index) => `${index + 1}. ${project.label} | ${project.summary}`)
    .join("\n");

  return [summary.summary, leadProjects].filter(Boolean).join("\n");
}

export function normalizeNoticeText(value: string | null | undefined): string | null {
  if (!value) {
    return null;
  }

  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized || null;
}

export function summarizeNoticeResult(value: string | null | undefined): string | null {
  const normalized = normalizeNoticeText(value);
  if (!normalized) {
    return null;
  }

  const sentences = normalized
    .split(/(?<=[.!?])\s+/)
    .map((entry) => entry.trim())
    .filter(Boolean);

  if (sentences.length === 0) {
    return normalized;
  }

  const first = sentences[0];
  if (first.length >= 24 || sentences.length === 1) {
    return first;
  }

  return `${first} ${sentences[1] ?? ""}`.trim();
}

export function extractLatestNoticeTexts(thread: ReturnType<ButlerStateStore["getThread"]>) {
  if (!thread) {
    return {
      latestUserPrompt: null as string | null,
      latestAgentReply: null as string | null
    };
  }

  const flattenedItems = thread.turns.flatMap((turn) => turn.items);
  const latestUserPrompt =
    normalizeNoticeText([...flattenedItems].reverse().find((item) => item.type === "userMessage" && item.text.trim())?.text) ?? null;
  const latestAgentReply =
    normalizeNoticeText([...flattenedItems].reverse().find((item) => item.type === "agentMessage" && item.text.trim())?.text) ?? null;

  return { latestUserPrompt, latestAgentReply };
}

export function isCallbackClosed(callback: PendingChatCallback): boolean {
  return callback.callbackState === "closed";
}

export function isCallbackOutstanding(callback: PendingChatCallback): boolean {
  return callback.owesOperatorReply && !isCallbackClosed(callback);
}

export function buildCloseoutId(threadId: string, turnId: string): string {
  return `${threadId}:${turnId}`;
}

export function getFallbackTurnId(thread: ReturnType<ButlerStateStore["getThread"]>): string | null {
  const latestTurnId = thread?.turns.at(-1)?.id ?? null;
  return typeof latestTurnId === "string" && latestTurnId.trim() ? latestTurnId : null;
}

export function buildChatCallbackText(
  thread: ReturnType<ButlerStateStore["getThread"]>,
  workerReport: ReturnType<ButlerStateStore["getWorkerReport"]>
): string | null {
  if (!thread || !workerReport) {
    return null;
  }

  const lead =
    workerReport.status === "completed"
      ? `Update on ${thread.supervisor.projectLabel}.`
      : `${thread.supervisor.projectLabel} needs attention.`;
  return [lead, workerReport.summary, workerReport.details].filter(Boolean).join("\n\n");
}

export function buildFallbackChatCallbackText(thread: ReturnType<ButlerStateStore["getThread"]>): string | null {
  if (!thread || thread.status !== "idle") {
    return null;
  }

  const latestReply = thread.supervisor.latestAgentReply?.trim();
  if (!latestReply) {
    return null;
  }

  return [
    `Update on ${thread.supervisor.projectLabel}.`,
    "I never got feedback from the worker, so I checked the thread directly.",
    latestReply
  ].join("\n\n");
}

export function describePendingCallbacks(store: ButlerStateStore, callbacks: PendingChatCallback[]): string {
  const outstandingCallbacks = callbacks.filter(isCallbackOutstanding);
  if (outstandingCallbacks.length === 0) {
    return "Delegated callback state: none pending.";
  }

  const lines = outstandingCallbacks
    .map((callback) => {
      const thread = store.getThread(callback.threadId);
      const projectLabel = thread?.supervisor.projectLabel ?? "unknown";
      const status = callback.lastWorkerStatusSeen ?? thread?.status ?? "unknown";
      const workerReport = callback.lastTerminalReportAt !== null ? store.getWorkerReport(callback.threadId) : null;
      if (callback.callbackState === "missing_worker_callback") {
        return `- job ${callback.threadId} on ${projectLabel}: no worker callback received; latest known thread status is ${status}. Butler still owes one operator reply and may need to inspect the thread directly before replying.`;
      }
      if (callback.callbackState === "received_worker_callback" && workerReport) {
        const details = [workerReport.summary, workerReport.details].filter(Boolean).join(" | ");
        return `- job ${callback.threadId} on ${projectLabel}: worker callback received (${workerReport.status}). Butler still owes one operator reply. Latest report: ${details}`;
      }
      return `- job ${callback.threadId} on ${projectLabel}: waiting on worker callback; latest known thread status is ${status}.`;
    })
    .join("\n");

  return ["Delegated callback state:", lines].join("\n");
}

export function buildCallbackReviewPrompt(store: ButlerStateStore, callback: PendingChatCallback): string {
  const thread = store.getThread(callback.threadId);
  const workerReport = store.getWorkerReport(callback.threadId);
  const relevantWorkerReport = workerReport && workerReport.updatedAt >= callback.requestedAt ? workerReport : null;
  const latestReply = thread?.supervisor.latestAgentReply?.trim() ?? "";
  const contract = thread?.executionContract ?? null;
  const acceptancePoints = Array.isArray(contract?.acceptancePoints) ? contract.acceptancePoints : [];
  const heldContextLines =
    thread?.eventLog
      .filter((entry) => entry.method === "butler.context.held" && entry.at >= callback.requestedAt - 1000)
      .slice(0, 5)
      .reverse()
      .map((entry, index) => `${index + 1}. ${entry.summary}`) ?? [];
  const checklist = thread?.supervisionChecklist ?? null;
  const checklistLines =
    checklist?.items.map((item) => {
      const latestEvidence = item.evidence.at(-1);
      return `${item.id}: ${item.status} - ${item.text}${latestEvidence ? ` | latest evidence: ${latestEvidence.summary}` : ""}${item.butlerNote ? ` | Butler note: ${item.butlerNote}` : ""}${item.queuedInstruction ? ` | queued instruction: ${item.queuedInstruction}` : ""}`;
    }) ?? [];

  return [
    BUTLER_BACKGROUND_PROMPT_PREFIX,
    "This is an internal delegated-job supervision event, not an operator turn.",
    "Do not write a normal Butler chat reply.",
    "If checklist points are rejected, use review_acceptance_point with nextInstruction, then flush_rejected_acceptance_points once after all rejected points are marked.",
    "Use message_job only for private follow-ups that are not rejected-checklist steering.",
    "If the job is done, blocked, or needs operator input now, use reply_to_operator exactly once.",
    "You may use read_job first if you need transcript context.",
    `Job id: ${callback.threadId}`,
    `Project: ${thread?.supervisor.projectLabel ?? "unknown"}`,
    `Current thread status: ${thread?.status ?? "unknown"}`,
    `Callback state: ${callback.callbackState}`,
    contract ? `Requested task: ${contract.requestedTask}` : "Requested task: unknown",
    acceptancePoints.length > 0
      ? `Acceptance points:\n${acceptancePoints.map((point, index) => `${index + 1}. ${point}`).join("\n")}`
      : "Acceptance points: none recorded; infer the operator-visible outcome from the requested task.",
    checklist
      ? `Structured supervision checklist:\n${checklistLines.join("\n")}\nHeartbeat: ${checklist.heartbeat.lastKnownThreadStatus}${checklist.heartbeat.stale ? " stale" : ""}. Review state: ${checklist.reviewState}.`
      : "Structured supervision checklist: none.",
    contract ? `Proof expectation: ${contract.proofExpectationLabel}` : "Proof expectation: unknown",
    callback.reviewReason === "thread_recovery"
      ? "Review source: Butler did not get a worker callback and recovered the job from thread state."
      : "Review source: Butler received a worker callback and must decide what to do next.",
    callback.lastPrivateSteerText ? `Latest private Butler steer already sent: ${callback.lastPrivateSteerText}` : "Latest private Butler steer already sent: none",
    heldContextLines.length > 0
      ? `Held operator context to consider before closing or steering:\n${heldContextLines.join("\n")}`
      : "Held operator context to consider before closing or steering: none",
    `Current next worker report action: ${callback.nextWorkerReportAction}.`,
    "Do not send the same private steer twice.",
    "Prefer concise outcome-based follow-ups over re-sending the whole job brief.",
    "Use nextWorkerReportAction=review when Butler should inspect the next worker report before deciding what to surface.",
    "Use nextWorkerReportAction=reply_to_operator only when the next terminal worker report should be posted straight to the operator without another Butler review.",
    "Decide from the job context and thread state, not from worker phrasing heuristics.",
    "Review the worker report and available proof against every acceptance point.",
    "Use review_acceptance_point to record accepted, rejected, or waived decisions in the structured checklist. Workers only submit evidence; Butler owns acceptance.",
    "For each rejected point, include nextInstruction. If multiple points are rejected, mark them all first, then use flush_rejected_acceptance_points once to send one batched worker follow-up.",
    "Use review_preview_proof when proof is available or when the worker references screenshots, video, trace, browser proof, desktop proof, logs, or file proof.",
    "If any acceptance point lacks convincing evidence or appears incomplete, reject it with nextInstruction instead of writing the rejected-point steering directly in operator chat.",
    "Use reply_to_operator only when all acceptance points are accepted, the job is genuinely blocked, or operator input is needed.",
    relevantWorkerReport ? `Worker report status: ${relevantWorkerReport.status}` : "Worker report status: none",
    relevantWorkerReport ? `Worker report summary: ${relevantWorkerReport.summary}` : "Worker report summary: none",
    relevantWorkerReport && relevantWorkerReport.details ? `Worker report details: ${relevantWorkerReport.details}` : "Worker report details: none",
    latestReply ? `Latest worker reply: ${latestReply}` : "Latest worker reply: none",
    "After you act, reply with exactly INTERNAL_REVIEW_COMPLETE."
  ].join("\n");
}

export function buildSystemPrompt(store: ButlerStateStore, callbackSummary: string): string {
  const supervisor = store.getSupervisorSummary();
  const projects = store.listProjectSummaries().slice(0, 8);
  const butlerMemory = store.listButlerMemory().slice(-8);

  return [
    "You are Butler, the supervisor inside Manor.",
    "Keep the main Butler chat operator-facing and concise.",
    "Use Codex project and thread summaries as your background memory.",
    butlerMemory.length > 0
      ? `Butler durable memory:\n${butlerMemory.map((entry, index) => `${index + 1}. ${entry.summary}${entry.details ? ` - ${entry.details}` : ""}`).join("\n")}`
      : "Butler durable memory: none.",
    "Use remember_insight when the operator asks you to remember something or when a reusable chat insight should survive chat cleanup.",
    "Use retrieve_memory when the operator asks a stateful project question, references prior work, follows up across jobs, or asks about remembered decisions. Skip memory retrieval for casual chat unless the answer depends on durable state.",
    "Treat retrieve_memory output as a scoped working brief. Do not merge broad memory directly into the conversation, and surface pending outcomes or missing rollups when they affect correctness.",
    "You have real callable tools. A tool is used only when you emit a structured tool call to the harness; writing a tool name, JSON, or function-call-looking text in chat is not tool use.",
    "Use your judgment to decide whether to answer directly, inspect Butler state with tools, message an existing Codex job, or delegate a new Codex workstream.",
    "Tool selection guide: use list_jobs for broad Codex job/thread checks, counts, status summaries, or project filtering; use read_job only when inspecting one specific job by id.",
    "Use read_supervision_checklist to inspect a delegated job's structured acceptance points and evidence; use review_acceptance_point when you have reviewed evidence and are accepting, rejecting, or waiving one point; use flush_rejected_acceptance_points after marking all rejected points.",
    "After delegate_to_codex returns, use its real result to acknowledge the real job id. Never invent or predict a job id.",
    "When using delegate_to_codex, set thinkingBudget deliberately: low is the default for most execution and coding; medium is for jobs needing extra agency, planning, ambiguity handling, or product judgment; high is for tough issues, usually after medium has not produced the right outcome or for clearly hard incidents; xhigh is exceptional and should be used for fewer than 1% of jobs.",
    "For operator follow-up on an existing valid Codex job, consider message_job when the job needs new instructions outside checklist rejection review; answer directly when the request can be handled from existing state.",
    "When new work arrives for an existing job and the visible checklist is already fully accepted or waived, use message_job with refreshChecklist so the new work gets a clear focused checklist.",
    "When the operator gives newer context for an active job, choose deliberately: use message_job immediately if the worker should change course now, or hold_job_context if Butler should wait for the current turn and apply that context during review.",
    "Do not merely acknowledge newer active-job context unless no valid job can be identified or the context is already satisfied by known state.",
    "Do not refresh a checklist for small clarifications, thank-you messages, or rejected-checklist follow-up; only refresh it for a genuine new slice of work.",
    "Never say you delegated, started, asked, messaged, or handed off work unless the corresponding tool call has completed successfully.",
    "Do not expose private Butler-to-Codex steering verbatim in the Butler chat.",
    "Worker callbacks and thread recovery are background supervision signals, not operator-visible chat by themselves.",
    "If the operator asks for real execution, project setup, repository cloning, coding work, or shell work, consider whether delegate_to_codex is the right tool instead of giving manual shell instructions.",
    "When Codex work changes state, summarize the outcome rather than replaying the full back-and-forth.",
    "Every operator-originated delegation must get one promise message immediately and one terminal reply when the delegated task completes or blocks.",
    "When the operator privately steers an existing job, renew the terminal reply obligation and do not treat an older worker report as the final answer for that newer operator turn.",
    "When you use message_job, set nextWorkerReportAction explicitly. Default to review unless the next worker report should go straight to the operator.",
    "When an internal supervision event arrives, decide privately whether to accept, waive, reject-and-flush checklist points, otherwise steer the worker, or post the final operator update with reply_to_operator.",
    "When you steer Codex privately, prefer concise outcome-based follow-ups over replaying the whole plan or tool sequence.",
    "Only restate detailed method guidance when the operator explicitly constrained the method or the previous attempt failed because the worker chose poorly.",
    "Each supervised Codex thread has a Butler steering budget. Default to 20 Butler-driven turns per thread unless that thread is explicitly overridden.",
    "Do not create a new branch or managed worktree unless the operator explicitly asks for branch isolation.",
    "For read-only repo inspection, questions, or report-only tasks, do not force a new branch or managed worktree.",
    "Do not run two parallel Codex workstreams on the same repo branch.",
    "For repository bootstrap tasks like cloning into /repos and creating the first branch, use Codex-shell first. Bring up preview runtime only once the task actually needs execution or proof.",
    "When a task needs multiple cooperating previews or disposable services, create a stack lease first so Butler can keep the whole environment under one isolated network and lifecycle.",
    "When you decide the operator is asking to verify Butler supervision itself, use the dedicated supervision smoke-test tool. Do not infer smoke-test mode from keywords inside ordinary implementation or verification tasks.",
    "For recurring mutable databases or object stores, prefer job-scoped stateful stacks so each job gets its own retained writable copy forked from the project base by default.",
    "Reserve base-mode stacks for intentional seed or snapshot refresh work. Do not let multiple jobs share one writable database volume.",
    "When a local task needs app review, prefer a preview lease on an isolated runtime instead of telling the operator to bind a raw host port.",
    "When the target is already online, keep the job in preview runtime and use direct browser verification instead of creating a local preview just for proof.",
    "When preview bootstrap is unclear, inspect the workspace bootstrap hints before deciding on image, egress, or install steps.",
    "Once Codex is inside a repo with its own AGENTS guidance, let that repo-specific install and runtime guidance override generic Manor defaults unless it would violate the Butler job brief, callback, or reporting obligations.",
    "When a project needs backing dependencies like Postgres, Redis, MySQL, MSSQL, RabbitMQ, MinIO, Mailpit, or SQLite, prefer registered service templates instead of ad hoc install steps. If the dependency is missing, register it once and reuse it later.",
    "A preview runs the app or job code. A service provides supporting infrastructure only. Do not run the main app inside a service.",
    "Treat Codex-shell as the place for repository, git, and code-editing work. Treat Manor previews, stacks, and services as the execution tools when the task needs a running process, logs, browser work, or direct target verification.",
    "Do not treat 'use Codex-shell' in the operator ask as a ban on previews. It is a preference, not a strict permission model.",
    "When the operator asks to check out a branch, worktree, or repo, start in Codex-shell. Bring up Manor runtime only when the task actually needs execution or proof.",
    "Example: if the operator says 'clone and run this project', keep it in one job. Let Codex clone in Codex-shell, then use Manor runtime for execution and verification.",
    "Example: if the operator says 'pull latest main and tell me what changed', keep it repo-only in Codex-shell.",
    "Example: if the operator says 'open this already-online URL and verify login works', keep the same job and use direct browser verification instead of a local preview.",
    "Do not silently substitute runtime verification for repo-only work, or repo-only checks for runtime verification.",
    "If an existing thread later needs execution, send a concise follow-up in that same thread instead of replaying the full job brief.",
    "For local Manor runtime tasks that involve signup or email flows, prefer local dependency services like Mailpit when the app under test is running inside Manor.",
    "Codex may operate inside attached isolates through manor-harness for inspect, logs, processes, and shell exec, but Butler still owns isolate lifecycle and policy.",
    "When the operator provides reference images or files, keep track of the stored reference ids so you can pass them to Codex later and reuse them during verification.",
    "Use the image reference tools whenever visual requirements depend on an uploaded image.",
    "When proof of frontend execution is requested, do not accept artifact existence alone as proof. Run headed verification when needed, inspect the screenshot with the proof review tool, and make sure the recorded session was persisted for later review.",
    "For Electron, native app, or VNC-visible headed proof, steer Codex to the desktop proof tools. Do not let a worker satisfy that request with a private Xvfb display that the operator cannot see.",
    "Never reuse or mention a deleted, unknown, or cwd-less Codex thread as if it were a valid workstream.",
    "If the operator names a specific job id, verify and reason about that exact job. Do not answer as if a different job were the same one.",
    "",
    `Supervisor state: ${supervisor.summary}`,
    callbackSummary,
    projects.length > 0 ? "Project summaries:" : "Project summaries: none yet.",
    ...projects.map((project) => `- ${project.label}: ${project.summary}`)
  ].join("\n");
}

export function findVerificationArtifact(
  verification: PreviewVerificationView | null | undefined,
  kind: PreviewVerificationArtifactView["kind"]
): PreviewVerificationArtifactView | null {
  return findVerificationArtifacts(verification, kind)[0] ?? null;
}

export function findVerificationArtifacts(
  verification: PreviewVerificationView | null | undefined,
  kind: PreviewVerificationArtifactView["kind"]
): PreviewVerificationArtifactView[] {
  if (!verification) {
    return [];
  }

  const artifacts = verification.artifacts.filter((artifact) => artifact.kind === kind);
  if (kind !== "screenshot") {
    return artifacts;
  }

  return [...artifacts].sort((left, right) => {
    const rank = (artifact: PreviewVerificationArtifactView) => {
      const label = artifact.label.toLowerCase();
      if (label.includes("final")) {
        return 0;
      }
      if (label.includes("after script")) {
        return 1;
      }
      if (label.includes("ready")) {
        return 2;
      }
      return 3;
    };

    const delta = rank(left) - rank(right);
    if (delta !== 0) {
      return delta;
    }
    return left.label.localeCompare(right.label);
  });
}

export function stripMarkdownCodeFence(text: string): string {
  const trimmed = text.trim();
  if (!trimmed.startsWith("```")) {
    return trimmed;
  }

  return trimmed.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
}

export function parseProofScreenshotReview(rawText: string): ProofScreenshotReview | null {
  const payload = stripMarkdownCodeFence(rawText);
  if (!payload) {
    return null;
  }

  try {
    const parsed = JSON.parse(payload) as Partial<ProofScreenshotReview>;
    const parsedEvidence = (parsed as { evidence?: unknown }).evidence;
    const evidence =
      typeof parsedEvidence === "string"
        ? parsedEvidence
        : Array.isArray(parsedEvidence)
          ? parsedEvidence
              .map((entry: unknown) => (typeof entry === "string" ? entry.trim() : ""))
              .filter(Boolean)
              .join(" ")
          : null;
    if (
      typeof parsed.verdict !== "string" ||
      typeof parsed.visibleState !== "string" ||
      typeof evidence !== "string" ||
      typeof parsed.concern !== "string"
    ) {
      return null;
    }

    return {
      verdict: parsed.verdict.trim(),
      visibleState: parsed.visibleState.trim(),
      evidence: evidence.trim(),
      concern: parsed.concern.trim(),
      rawText: payload,
      reviewedAt: Date.now(),
      modelId: "",
      modelProvider: ""
    };
  } catch {
    return null;
  }
}

export function mergeVisibleMessages(sessionMessages: ButlerMessageView[], extraMessages: ButlerMessageView[]): ButlerMessageView[] {
  return [...sessionMessages, ...extraMessages].sort((left, right) => {
    const leftAt = left.at ?? 0;
    const rightAt = right.at ?? 0;
    if (leftAt === rightAt) {
      return left.id.localeCompare(right.id);
    }
    return leftAt - rightAt;
  });
}

export function collapseCallbackDuplicateMessages(messages: ButlerMessageView[]): ButlerMessageView[] {
  const collapsed: ButlerMessageView[] = [];
  let delegationAcknowledged = false;
  let callbackDelivered = false;

  for (const message of messages) {
    if (message.role === "user" || message.role === "user-with-attachments") {
      delegationAcknowledged = false;
      callbackDelivered = false;
      collapsed.push(message);
      continue;
    }

    if (message.id.startsWith("delegation-ack-")) {
      delegationAcknowledged = true;
      collapsed.push(message);
      continue;
    }

    if (message.id.startsWith("callback-") || message.id.startsWith("callback-fallback-")) {
      callbackDelivered = true;
      collapsed.push(message);
      continue;
    }

    if ((delegationAcknowledged || callbackDelivered) && message.kind === "message" && message.role === "assistant") {
      continue;
    }

    collapsed.push(message);
  }

  return collapsed;
}

export function buildMessagePage(
  visibleMessages: ButlerMessageView[],
  before: number | null,
  limit: number
): ButlerMessagePageView {
  const totalCount = visibleMessages.length;
  const cappedLimit = Math.max(1, Math.min(Number.isFinite(limit) ? Math.trunc(limit) : SNAPSHOT_MESSAGE_TAIL_LIMIT, MAX_HISTORY_PAGE_SIZE));
  const safeBefore =
    typeof before === "number" && Number.isFinite(before)
      ? Math.max(0, Math.min(Math.trunc(before), totalCount))
      : totalCount;
  const startIndex = Math.max(0, safeBefore - cappedLimit);

  return {
    messages: visibleMessages.slice(startIndex, safeBefore),
    startIndex,
    endIndex: safeBefore,
    totalCount,
    hasMore: startIndex > 0
  };
}

export function buildLatestProofMap(proofs: PreviewProofRecordView[]): Record<string, PreviewProofRecordView> {
  return Object.fromEntries(
    getVisibleThreadProofs(proofs)
      .reduce((accumulator, proof) => {
        if (!proof.threadId || accumulator.has(proof.threadId)) {
          return accumulator;
        }
        accumulator.set(proof.threadId, proof);
        return accumulator;
      }, new Map<string, PreviewProofRecordView>())
      .entries()
  );
}

export function buildProofsByThreadMap(proofs: PreviewProofRecordView[]): Record<string, PreviewProofRecordView[]> {
  return Object.fromEntries(
    getVisibleThreadProofs(proofs)
      .reduce((accumulator, proof) => {
        if (!proof.threadId) {
          return accumulator;
        }
        const entries = accumulator.get(proof.threadId) ?? [];
        entries.push(proof);
        accumulator.set(proof.threadId, entries);
        return accumulator;
      }, new Map<string, PreviewProofRecordView[]>())
      .entries()
  );
}

function getVisibleThreadProofs(proofs: PreviewProofRecordView[]): PreviewProofRecordView[] {
  const byThread = proofs
    .filter((proof) => Boolean(proof.threadId))
    .reduce((accumulator, proof) => {
      if (!proof.threadId) {
        return accumulator;
      }
      const entries = accumulator.get(proof.threadId) ?? [];
      entries.push(proof);
      accumulator.set(proof.threadId, entries);
      return accumulator;
    }, new Map<string, PreviewProofRecordView[]>());

  return [...byThread.values()].flatMap((threadProofs) => collapseSupersededThreadProofs(threadProofs));
}

function collapseSupersededThreadProofs(threadProofs: PreviewProofRecordView[]): PreviewProofRecordView[] {
  const sorted = [...threadProofs].sort((left, right) => {
    const leftAt = left.verification.checkedAt || left.updatedAt || left.createdAt;
    const rightAt = right.verification.checkedAt || right.updatedAt || right.createdAt;
    return rightAt - leftAt;
  });

  const visible: PreviewProofRecordView[] = [];
  const seenKeys = new Set<string>();

  for (const proof of sorted) {
    const key = getProofTargetKey(proof);
    if (key) {
      if (seenKeys.has(key)) {
        continue;
      }
      seenKeys.add(key);
      visible.push(proof);
      continue;
    }

    visible.push(proof);
  }

  return visible;
}

function getProofTargetKey(proof: PreviewProofRecordView): string | null {
  const fromError = parseCheckedUrlFromProofError(proof.verification.error);
  const candidates = [
    fromError,
    proof.verification.url,
    proof.verification.readiness.finalUrl
  ];

  for (const candidate of candidates) {
    const normalized = normalizeProofTargetUrl(candidate);
    if (normalized) {
      return normalized;
    }
  }

  return null;
}

export function resolveProofBundleKey(proof: PreviewProofRecordView): string | null {
  return getProofTargetKey(proof);
}

function parseCheckedUrlFromProofError(errorText: string | null): string | null {
  if (!errorText || !errorText.includes("LIVE_CHECK_RESULT")) {
    return null;
  }

  const match = errorText.match(/"checkedUrl":"([^"]+)"/);
  return match?.[1] ?? null;
}

function normalizeProofTargetUrl(rawUrl: string | null | undefined): string | null {
  if (!rawUrl) {
    return null;
  }

  try {
    const parsed = new URL(rawUrl);
    if (parsed.pathname.startsWith("/preview/")) {
      return null;
    }
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return null;
  }
}
