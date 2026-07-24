import crypto from "node:crypto";
import path from "node:path";
import { AuthStorage, createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

import type { ButlerAgentSessionAccess, ButlerCustomTool } from "./butler-agent-tool-access.js";
import { buildCallbackReviewPrompt, contentToText, isCallbackOutstanding, type PendingChatCallback } from "./butler-agent-helpers.js";
import { ensureButlerAdversarialReview, type AdversarialReviewProgress } from "./butler-adversarial-review.js";
import { getButlerShellSnapshot } from "./butler-agent-session.js";
import { isolatedModelResourceOptions } from "./isolated-model-resources.js";
import { runSerializedJobMutation, runWithCallbackReviewGuard } from "./butler-job-mutation-guard.js";
import { formatProviderModelRef, modelToModelOption } from "./model-provider-config.js";
import { applyOpencodeGoNativeThinkingPayload } from "./pi-opencode-web-tools-extension.js";
import { piThinkingLevelForModelOption } from "./pi-thinking-levels.js";
import type { ButlerStateStore } from "./state-store.js";
import { redactSensitiveText } from "./redact-sensitive-text.js";
import { assertIsolatedPromptSucceeded } from "./isolated-prompt-outcome.js";
import type { ActivityWatchdogService } from "./activity-watchdog.js";
import { formatResolvedJobOutputManifestForReview } from "./job-output-manifest.js";

const CALLBACK_REVIEW_RETRY_MS = 30_000;
const CALLBACK_REVIEW_MAX_ATTEMPTS = 3;
const CALLBACK_REVIEW_PAUSED_PREFIX = "Adversarial review paused";
const CALLBACK_REVIEW_OPERATOR_STOPPED_PREFIX = "Adversarial review stopped by the operator";
const CALLBACK_SUPERVISOR_TIMEOUT_MS = 90_000;
const CALLBACK_REVIEW_MAX_DURATION_MS = 5 * 60_000;

export function raceCallbackReviewAttempt<T>(work: Promise<T>, attemptHealth: Promise<never>): Promise<T> {
  return Promise.race([work, attemptHealth]);
}
const CALLBACK_REVIEW_TOOL_NAMES = new Set([
  "read_job",
  "read_supervision_checklist",
  "inspect_job_output",
  "review_acceptance_point",
  "disprove_review_finding",
  "flush_rejected_acceptance_points",
  "review_preview_proof",
  "confirm_worker_skill_operability",
  "request_self_improvement",
  "message_job",
  "reply_to_operator"
]);
const CALLBACK_SUPERVISOR_COMPLETION_TOOLS = new Set(["flush_rejected_acceptance_points", "confirm_worker_skill_operability", "message_job", "reply_to_operator"]);
const CALLBACK_BUTLER_EVIDENCE_TOOL_NAMES = new Set([
  "bash",
  "browser_session_action",
  "browser_session_state",
  "desktop_current_screen",
  "desktop_proof_status",
  "desktop_session_action",
  "desktop_session_state",
  "download_project_artifact",
  "exec_preview",
  "exec_service",
  "inspect_automation",
  "inspect_filesystem",
  "inspect_images",
  "inspect_preview",
  "inspect_service",
  "inspect_skills",
  "inspect_stack",
  "manor_browser_action",
  "manor_browser_start",
  "manor_browser_stop",
  "manor_preview_exec",
  "manor_preview_inspect",
  "manor_preview_logs",
  "manor_preview_start",
  "manor_preview_stop",
  "manor_preview_wait",
  "preview_logs",
  "preview_processes",
  "read_manor_restart_status",
  "read_manor_source_state",
  "record_file_proof",
  "review_preview_proof",
  "service_logs",
  "share_project_file",
  "start_browser_session",
  "start_desktop_session",
  "start_preview",
  "start_preview_browser_session",
  "start_service",
  "start_stack",
  "web_fetch",
  "web_search",
  "web_search_exa"
]);

export function assertCallbackSupervisorPromptSucceeded(
  messages: readonly unknown[],
  completedAction: boolean,
  modelLabel: string
): void {
  assertIsolatedPromptSucceeded(messages, "Isolated Butler supervision");
  if (!completedAction) {
    throw new Error(`Isolated Butler supervision ended without completing a closeout or Worker follow-up action using ${modelLabel}.`);
  }
}

export function beginCallbackReviewAttempt(callback: PendingChatCallback, priorFailures: number, now = Date.now()): void {
  callback.reviewState = "running";
  callback.reviewStage = "preparing";
  callback.reviewAttempt = priorFailures + 1;
  callback.reviewStartedAt = now;
  callback.reviewDeadlineAt = now + 120_000;
  callback.reviewNextAttemptAt = null;
  callback.reviewLastActivityAt = now;
  callback.reviewLastActivity = "Preparing adversarial review.";
  callback.reviewLastTool = null;
  callback.reviewLastError = null;
  callback.updatedAt = now;
}

function appendCallbackReviewError(callback: PendingChatCallback, input: { at: number; stage?: PendingChatCallback["reviewStage"]; tool?: string | null; message: string }): void {
  const message = input.message.trim().slice(0, 2000);
  if (!message) return;
  const next = { at: input.at, stage: input.stage ?? callback.reviewStage ?? "blocked", tool: input.tool?.trim().slice(0, 200) || null, message };
  const retained = callback.reviewErrors ?? [];
  const latest = retained.at(-1);
  callback.reviewErrors = latest && latest.message === next.message && latest.tool === next.tool ? retained : [...retained, next].slice(-12);
}

export function applyCallbackReviewProgress(callback: PendingChatCallback, progress: AdversarialReviewProgress): void {
  callback.reviewStage = progress.stage;
  callback.reviewLastActivityAt = progress.at;
  callback.reviewLastActivity = redactSensitiveText(progress.message).slice(0, 800);
  callback.reviewLastTool = progress.toolName?.slice(0, 200) ?? callback.reviewLastTool ?? null;
  callback.reviewLastError = progress.error ? redactSensitiveText(progress.error).slice(0, 2000) : null;
  if (progress.error) appendCallbackReviewError(callback, { at: progress.at, stage: progress.stage, tool: progress.toolName, message: redactSensitiveText(progress.error) });
  if (progress.deadlineAt !== undefined) callback.reviewDeadlineAt = progress.deadlineAt;
  callback.updatedAt = progress.at;
}

export function persistCallbackReviewProgress(input: {
  attempted: PendingChatCallback;
  progress: AdversarialReviewProgress;
  getCurrent: () => PendingChatCallback | undefined;
  save: () => Promise<void>;
  emit: () => void;
}): Promise<void> {
  return runSerializedJobMutation(input.attempted.threadId, async () => {
    const current = input.getCurrent();
    if (current !== input.attempted || current.reviewState !== "running" || !isCallbackOutstanding(current)) return;
    applyCallbackReviewProgress(current, input.progress);
    await input.save();
    input.emit();
  });
}

export function recoverOrphanedCallbackReviews(input: {
  callbacks: PendingChatCallback[];
  activeThreadIds: ReadonlySet<string>;
  now: number;
  store: ButlerStateStore;
  failureCount: Map<string, number>;
  notBefore: Map<string, number>;
}): { changed: boolean; retryAt: number | null } {
  let changed = false;
  let retryAt: number | null = null;
  for (const callback of input.callbacks) {
    if (input.activeThreadIds.has(callback.threadId) || callback.reviewState !== "running" || !callback.reviewDeadlineAt || callback.reviewDeadlineAt > input.now) continue;
    applyCallbackReviewFailure({
      callback,
      error: new Error("Adversarial review process ended without recording a terminal state."),
      store: input.store,
      failureCount: input.failureCount,
      notBefore: input.notBefore
    });
    const nextRetryAt = callback.reviewNextAttemptAt ?? null;
    if (nextRetryAt !== null) retryAt = retryAt === null ? nextRetryAt : Math.min(retryAt, nextRetryAt);
    input.store.addEvent(callback.threadId, "butler.adversarial_review.recovered", "Recovered an expired review whose runtime watchdog had already exited.");
    changed = true;
  }
  return { changed, retryAt };
}

export async function settleReviewMutationWithin<T>(promise: Promise<T>, timeoutMs: number): Promise<{ completed: true; value: T } | { completed: false }> {
  let timer: NodeJS.Timeout | null = null;
  try {
    return await Promise.race([
      promise.then((value) => ({ completed: true as const, value })),
      new Promise<{ completed: false }>((resolve) => {
        timer = setTimeout(() => resolve({ completed: false }), timeoutMs);
        timer.unref?.();
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function settleCallbackReviewFailure(input: {
  attempted: PendingChatCallback;
  error: unknown;
  store: ButlerStateStore;
  failureCount: Map<string, number>;
  notBefore: Map<string, number>;
  getCurrent: () => PendingChatCallback | undefined;
  save: () => Promise<void>;
  emit: () => void;
  timeoutMs?: number;
}) {
  return settleReviewMutationWithin(runSerializedJobMutation(input.attempted.threadId, async () => {
    const current = input.getCurrent();
    if (shouldIgnoreCallbackReviewFailure(input.attempted, current) || !current) return { failureApplied: false, retryAt: null };
    applyCallbackReviewFailure({ callback: current, error: input.error, store: input.store, failureCount: input.failureCount, notBefore: input.notBefore });
    const retryAt = current.reviewNextAttemptAt ?? null;
    await input.save();
    input.emit();
    return { failureApplied: true, retryAt };
  }), input.timeoutMs ?? 5_000);
}

export function prepareCallbackReviewRetry(
  callback: PendingChatCallback,
  selection: { provider: string | null; model: string | null; thinkingLevel: import("./types.js").ButlerThinkingLevel },
  now = Date.now()
): void {
  callback.reviewModelProvider = selection.provider;
  callback.reviewModelId = selection.model;
  callback.reviewReasoningLevel = selection.thinkingLevel;
  callback.reviewAttempt = 0;
  callback.reviewLastError = null;
  callback.reviewLastActivity = "Retry requested with the current Butler model.";
  callback.reviewLastActivityAt = now;
}

export function pauseCallbackReview(callback: PendingChatCallback, reportUpdatedAt: number | null, now = Date.now()): void {
  callback.reviewState = "blocked";
  callback.reviewStage = "blocked";
  callback.reviewStartedAt = null;
  callback.reviewDeadlineAt = null;
  callback.reviewNextAttemptAt = null;
  callback.reviewLastActivityAt = now;
  callback.reviewLastActivity = "Review stopped by the operator.";
  callback.blockedCloseoutReason = `${CALLBACK_REVIEW_OPERATOR_STOPPED_PREFIX}. Retry with the current Butler model when ready.`;
  callback.blockedCloseoutReportAt = reportUpdatedAt;
  callback.updatedAt = now;
}

function registerOpencodeGoRequestTransforms(pi: ExtensionAPI): void {
  pi.on("before_provider_request", (event) => applyOpencodeGoNativeThinkingPayload(event.payload));
}

export function buildCallbackAdversarialReviewBrief(store: ButlerStateStore, callback: PendingChatCallback): string {
  const thread = store.getThread(callback.threadId);
  const payload = store.getThreadJobPayload(callback.threadId);
  const currentReport = store.getWorkerReport(callback.threadId);
  const heldContext = thread?.eventLog
    .filter((entry) => entry.method === "butler.context.held" && entry.at >= callback.requestedAt - 1000)
    .slice(0, 5)
    .reverse()
    .map((entry) => entry.summary) ?? [];
  const unresolvedChecklist = thread?.supervisionChecklist?.items
    .filter((item) => item.status === "pending" || item.status === "rejected" || Boolean(item.queuedInstruction))
    .slice(0, 20)
    .map((item) => `${item.id} ${item.status}: ${item.text}${item.butlerNote ? ` | Butler note: ${item.butlerNote}` : ""}${item.queuedInstruction ? ` | required next step: ${item.queuedInstruction}` : ""}`) ?? [];
  const priorBlockingFindings = thread?.executionContract?.reviewResults
    ?.filter((finding) =>
      finding.blocking &&
      !finding.waived &&
      currentReport?.updatedAt === finding.reportUpdatedAt &&
      currentReport.turnId === finding.turnId
    )
    .slice(-10)
    .map((finding) => `${finding.id} ${finding.severity}: ${finding.findingSummary}`) ?? [];
  const operatorRequestText = callback.operatorRequestText?.trim() || null;
  const boundedSection = (value: string | null, maxChars: number): string | null => {
    if (!value || value.length <= maxChars) return value;
    const omission = "\n...[middle omitted]...\n";
    const retainedChars = maxChars - omission.length;
    const headChars = Math.ceil(retainedChars / 2);
    return `${value.slice(0, headChars)}${omission}${value.slice(-(retainedChars - headChars))}`;
  };
  return [
    boundedSection(operatorRequestText ? `Current operator request governing this callback:\n${operatorRequestText}` : null, 3_200),
    boundedSection(operatorRequestText ? "Review the new Worker report against this request while preserving the persisted checklist as the completion boundary." : null, 250),
    boundedSection(callback.lastPrivateSteerText ? `Latest Butler steer: ${callback.lastPrivateSteerText}` : null, 1_200),
    boundedSection(unresolvedChecklist.length > 0 ? `Unresolved or rejected checklist points:\n${unresolvedChecklist.join("\n")}` : null, 2_600),
    boundedSection(priorBlockingFindings.length > 0 ? `Prior blocking review findings being reworked:\n${priorBlockingFindings.join("\n")}` : null, 1_800),
    boundedSection(payload?.workerDirective && payload.kind !== "held_context" ? `Latest sent Worker directive: ${payload.workerDirective}` : null, 1_700),
    boundedSection(payload?.workerDirective && payload.kind === "held_context" ? `Held context awaiting Butler review; this was not sent to the Worker:\n${payload.workerDirective}` : null, 1_700),
    boundedSection(heldContext.length > 0 ? `Held operator context:\n${heldContext.join("\n")}` : null, 900)
  ].filter((entry): entry is string => Boolean(entry)).join("\n\n").slice(0, 12_000);
}

export function buildCurrentOperatorTurnContext(messages: readonly unknown[], operatorRequestText: string | null | undefined): string | null {
  const maxEntryChars = 2_000;
  const maxContextChars = 12_000;
  const request = operatorRequestText?.trim();
  if (!request) return null;

  let anchor = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message || typeof message !== "object") continue;
    const record = message as Record<string, unknown>;
    if (record.role !== "user" && record.role !== "user-with-attachments") continue;
    if (contentToText(record.content).trim() === request) {
      anchor = index;
      break;
    }
  }
  if (anchor < 0) return null;

  const lines: string[] = [];
  for (let index = anchor + 1; index < messages.length; index += 1) {
    const message = messages[index];
    if (!message || typeof message !== "object") continue;
    const record = message as Record<string, unknown>;
    const role = typeof record.role === "string" ? record.role : "";
    if (role === "user" || role === "user-with-attachments") break;
    if (role !== "assistant" && role !== "toolResult") continue;
    if (role === "toolResult" && (typeof record.toolName !== "string" || !CALLBACK_BUTLER_EVIDENCE_TOOL_NAMES.has(record.toolName))) continue;
    const text = contentToText(record.content).trim();
    if (!text) continue;
    const toolName = role === "toolResult" && typeof record.toolName === "string" ? ` (${record.toolName})` : "";
    const safeText = redactSensitiveText(text).trim();
    if (!safeText) continue;
    lines.push(`${role === "assistant" ? "Butler" : "Butler tool result"}${toolName}: ${safeText.slice(-maxEntryChars)}`);
  }
  const selected: string[] = [];
  let selectedChars = 0;
  for (const line of lines.reverse()) {
    const remaining = maxContextChars - selectedChars;
    if (remaining <= 0) break;
    selected.push(line.slice(-remaining));
    selectedChars += Math.min(line.length, remaining) + 2;
  }
  const context = selected.reverse().join("\n\n").trim();
  return context || null;
}

export function isCurrentCallbackReview(attempted: PendingChatCallback, current: PendingChatCallback | undefined): current is PendingChatCallback {
  return attempted === current;
}

export function shouldIgnoreCallbackReviewFailure(attempted: PendingChatCallback, current: PendingChatCallback | undefined): boolean {
  return !isCurrentCallbackReview(attempted, current) || current.reviewState !== "running" || !isCallbackOutstanding(current);
}

export function buildGuardedCallbackReviewTools(input: {
  tools: ButlerCustomTool[];
  callback: PendingChatCallback;
  isCurrent: () => boolean;
  reviewSelection?: { modelProvider: string; modelId: string; reasoningLevel: import("./types.js").ButlerThinkingLevel };
}): ButlerCustomTool[] {
  return input.tools
    .filter((tool) => CALLBACK_REVIEW_TOOL_NAMES.has(tool.name))
    .map((tool) => ({
      ...tool,
      execute: async (toolCallId, params, signal, onUpdate, context) => {
        if (!input.isCurrent()) throw new Error("This callback review was superseded by newer Butler context.");
        const record = params && typeof params === "object" ? params as Record<string, unknown> : {};
        const targetThreadId = typeof record.threadId === "string"
          ? record.threadId
          : typeof record.sourceThreadId === "string"
            ? record.sourceThreadId
            : null;
        if (targetThreadId && targetThreadId !== input.callback.threadId) {
          throw new Error(`This isolated review can only act on job ${input.callback.threadId}.`);
        }
        const scopedParams = (tool.name === "review_preview_proof" || tool.name === "inspect_job_output") && !targetThreadId
          ? { ...record, threadId: input.callback.threadId }
          : params;
        const result = await runWithCallbackReviewGuard(
          { threadId: input.callback.threadId, isCurrent: input.isCurrent, ...input.reviewSelection },
          () => tool.execute(toolCallId, scopedParams as never, signal, onUpdate, context)
        );
        return result;
      }
    })) as ButlerCustomTool[];
}

export class CallbackReviewScheduler {
  private inFlight = false;
  private queued = false;
  private disposed = false;
  private retryTimer: NodeJS.Timeout | null = null;
  private retryAt: number | null = null;

  constructor(private readonly run: () => Promise<void>, private readonly onError: (error: unknown) => void) {}

  schedule(): void {
    if (this.disposed) return;
    if (this.inFlight) {
      this.queued = true;
      return;
    }
    this.inFlight = true;
    void this.run().catch(this.onError).finally(() => {
      this.inFlight = false;
      if (this.queued) {
        this.queued = false;
        this.schedule();
      }
    });
  }

  scheduleAt(at: number): void {
    if (this.disposed) return;
    if (this.retryTimer && this.retryAt !== null && this.retryAt <= at) return;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryAt = at;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.retryAt = null;
      this.schedule();
    }, Math.max(1, at - Date.now()));
  }

  dispose(): void {
    this.disposed = true;
    this.queued = false;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.retryAt = null;
  }
}

export function selectRunnableCallbackReviews(
  callbacks: Iterable<PendingChatCallback>,
  notBefore: Map<string, number>,
  now = Date.now()
): { pendingReviews: PendingChatCallback[]; retryAt: number | null } {
  const queued = [...callbacks].filter((callback) => isCallbackOutstanding(callback) && callback.dispatchState !== "reserving" && callback.reviewState === "queued");
  const pendingReviews = queued
    .filter((callback) => (notBefore.get(callback.threadId) ?? 0) <= now)
    .sort((left, right) => left.updatedAt - right.updatedAt);
  const retryAt = queued.reduce<number | null>((earliest, callback) => {
    const candidate = notBefore.get(callback.threadId) ?? 0;
    if (candidate <= now) return earliest;
    return earliest === null ? candidate : Math.min(earliest, candidate);
  }, null);
  return { pendingReviews, retryAt };
}

export async function runCallbackAdversarialReview(input: {
  callback: PendingChatCallback;
  sessionAccess: ButlerAgentSessionAccess;
  store: ButlerStateStore;
  piAuthPath: string;
  watchdogs: ActivityWatchdogService;
  isCurrent?: () => boolean;
  supervisorTimeoutMs?: number;
  maxDurationMs?: number;
  onProgress?: (progress: AdversarialReviewProgress) => void;
}): Promise<void> {
  const { callback, sessionAccess } = input;
  let attemptActive = true;
  const isCurrent = () => attemptActive && (input.isCurrent?.() ?? true);
  if (!isCurrent()) return;
  if (!sessionAccess.session || !sessionAccess.modelRegistry) throw new Error("Butler is not ready to supervise this review.");
  const pinnedModel = callback.reviewModelId
    ? sessionAccess.modelRegistry.getAvailable().find((entry) =>
        entry.id === callback.reviewModelId && (!callback.reviewModelProvider || entry.provider === callback.reviewModelProvider)
      ) ?? null
    : null;
  const model = callback.reviewModelId ? pinnedModel : sessionAccess.session.model;
  const thinkingLevel = callback.reviewReasoningLevel ?? getButlerShellSnapshot(sessionAccess).compose?.thinkingLevel ?? "off";
  if (!model) throw new Error("The Butler model selected for this review is no longer available. Open Settings → Providers to reconnect it, then retry.");
  const attemptStartedAt = callback.reviewStartedAt ?? Date.now();
  const attemptDeadlineAt = attemptStartedAt + (input.maxDurationMs ?? CALLBACK_REVIEW_MAX_DURATION_MS);
  if (attemptDeadlineAt <= Date.now()) throw new Error("Adversarial review exceeded its maximum runtime before it could start.");
  let activeAbort: (() => Promise<unknown>) | null = null;
  let attemptWatchdogId: string | null = null;
  let attemptRejected = false;
  const attemptHealth = new Promise<never>((_resolve, reject) => {
    const check = () => {
      if (attemptRejected) return;
      if (!(input.isCurrent?.() ?? true)) {
        attemptRejected = true;
        attemptActive = false;
        if (activeAbort) void activeAbort().catch(() => undefined);
        reject(new Error("This callback review was superseded by newer Butler context."));
        return;
      }
      if (Date.now() < attemptDeadlineAt) return;
      attemptRejected = true;
      attemptActive = false;
      if (activeAbort) void activeAbort().catch(() => undefined);
      reject(new Error(`Adversarial review exceeded its ${Math.round((input.maxDurationMs ?? CALLBACK_REVIEW_MAX_DURATION_MS) / 1000)}s maximum runtime.`));
    };
    attemptWatchdogId = `review-attempt:${callback.threadId}:${callback.reviewAttempt ?? 0}:${crypto.randomUUID()}`;
    input.watchdogs.register({
      id: attemptWatchdogId,
      policy: "review-activity",
      target: callback.threadId,
      maxIntervalMs: Math.max(1, attemptDeadlineAt - Date.now()),
      callback: check
    });
  });
  try {
  await raceCallbackReviewAttempt(ensureButlerAdversarialReview({
    store: input.store,
    threadId: callback.threadId,
    model,
    modelRegistry: sessionAccess.modelRegistry,
    piAuthPath: input.piAuthPath,
    thinkingLevel,
    minimumReportUpdatedAt: callback.requestedAt,
    expectedReportTurnId: callback.acceptedWorkerTurnId,
    reviewBrief: buildCallbackAdversarialReviewBrief(input.store, callback),
    watchdogs: input.watchdogs,
    absoluteDeadlineAt: attemptDeadlineAt,
    isCurrent,
    onProgress: input.onProgress
  }), attemptHealth);
  if (!isCurrent()) return;

  const supervisorTimeoutMs = input.supervisorTimeoutMs ?? CALLBACK_SUPERVISOR_TIMEOUT_MS;
  const supervisorStartedAt = Date.now();
  const nextSupervisorDeadlineAt = (activityAt = Date.now()) => Math.min(activityAt + supervisorTimeoutMs, attemptDeadlineAt);
  let lastProgress: AdversarialReviewProgress = {
    stage: "supervising_closeout",
    message: "Adversarial findings are ready. Butler is deciding the closeout action.",
    at: supervisorStartedAt,
    deadlineAt: nextSupervisorDeadlineAt(supervisorStartedAt)
  };
  input.onProgress?.(lastProgress);

  const settingsManager = SettingsManager.inMemory();
  const resourceLoader = new DefaultResourceLoader({
    cwd: "/repos",
    agentDir: path.dirname(input.piAuthPath),
    settingsManager,
    ...isolatedModelResourceOptions(),
    extensionFactories: [registerOpencodeGoRequestTransforms],
    systemPromptOverride: () => sessionAccess.session?.systemPrompt ?? "You are Butler supervising an isolated Worker review."
  });
  await raceCallbackReviewAttempt(resourceLoader.reload(), attemptHealth);
  const { session } = await raceCallbackReviewAttempt(createAgentSession({
    cwd: "/repos",
    authStorage: AuthStorage.create(input.piAuthPath),
    modelRegistry: sessionAccess.modelRegistry,
    model,
    thinkingLevel: piThinkingLevelForModelOption(thinkingLevel, modelToModelOption(model)),
    noTools: "builtin",
    customTools: buildGuardedCallbackReviewTools({
      tools: sessionAccess.buildCustomTools(),
      callback,
      isCurrent,
      reviewSelection: { modelProvider: model.provider, modelId: model.id, reasoningLevel: thinkingLevel }
    }),
    sessionManager: SessionManager.inMemory("/repos"),
    settingsManager,
    resourceLoader
  }), attemptHealth);
  activeAbort = () => session.abort();
  let lastReasoningReportAt = 0;
  let completedSupervisorAction = false;
  const unsubscribe = session.subscribe((event) => {
    if (event.type === "tool_execution_start") {
      const at = Date.now();
      lastProgress = {
        ...lastProgress,
        message: `Running ${event.toolName}.`,
        at,
        deadlineAt: nextSupervisorDeadlineAt(at),
        toolName: event.toolName,
        error: null
      };
      input.onProgress?.(lastProgress);
      return;
    }
    if (event.type === "tool_execution_end") {
      if (!event.isError && CALLBACK_SUPERVISOR_COMPLETION_TOOLS.has(event.toolName)) {
        completedSupervisorAction = true;
      }
      let detail = "";
      if (event.isError) {
        try { detail = redactSensitiveText(JSON.stringify(event.result)).replace(/\s+/g, " ").slice(0, 1200); } catch { detail = redactSensitiveText(String(event.result)).slice(0, 1200); }
      }
      const at = Date.now();
      lastProgress = {
        ...lastProgress,
        message: event.isError ? `Failed ${event.toolName}${detail ? `: ${detail}` : "."}` : `Finished ${event.toolName}.`,
        at,
        deadlineAt: nextSupervisorDeadlineAt(at),
        toolName: event.toolName,
        error: event.isError ? detail || `${event.toolName} failed.` : null
      };
      input.onProgress?.(lastProgress);
      return;
    }
    if (event.type === "message_update" && Date.now() - lastReasoningReportAt >= 1000) {
      lastReasoningReportAt = Date.now();
      lastProgress = { ...lastProgress, message: "Butler is reasoning over the review findings.", at: lastReasoningReportAt, deadlineAt: nextSupervisorDeadlineAt(lastReasoningReportAt) };
      input.onProgress?.(lastProgress);
    }
  });
  let watchdogId: string | null = null;
  try {
    const reviewHealth = new Promise<never>((_resolve, reject) => {
      const check = () => {
        if (!isCurrent()) {
          void session.abort();
          reject(new Error("This callback review was superseded by newer Butler context."));
          return;
        }
        const inactiveFor = Date.now() - lastProgress.at;
        if (inactiveFor < supervisorTimeoutMs) return;
        attemptActive = false;
        void session.abort();
        const modelLabel = formatProviderModelRef({ provider: model.provider, model: model.id }) ?? model.id;
        reject(new Error(`Isolated Butler supervision was inactive for ${Math.round(supervisorTimeoutMs / 1000)}s using ${modelLabel}. Last activity ${Math.max(0, Math.round(inactiveFor / 1000))}s ago: ${lastProgress.message}`));
      };
      watchdogId = `review-supervisor:${callback.threadId}:${callback.reviewAttempt ?? 0}:${crypto.randomUUID()}`;
      input.watchdogs.register({
        id: watchdogId,
        policy: "review-activity",
        target: callback.threadId,
        maxIntervalMs: supervisorTimeoutMs,
        callback: check
      });
    });
    const payload = input.store.getThreadJobPayload(callback.threadId);
    const outputManifest = await raceCallbackReviewAttempt(payload
      ? formatResolvedJobOutputManifestForReview(payload, input.store)
      : Promise.resolve("No durable outputs are registered for the current job attempt."), attemptHealth);
    await Promise.race([
      session.prompt(buildCallbackReviewPrompt(input.store, callback, {
        butlerTurnContext: buildCurrentOperatorTurnContext(sessionAccess.session.messages, callback.operatorRequestText),
        outputManifest
      })),
      reviewHealth,
      attemptHealth
    ]);
    assertCallbackSupervisorPromptSucceeded(session.messages, completedSupervisorAction, formatProviderModelRef({ provider: model.provider, model: model.id }) ?? model.id);
  } finally {
    attemptActive = false;
    if (watchdogId) input.watchdogs.unregister(watchdogId);
    unsubscribe();
    session.dispose();
  }
  } finally {
    attemptActive = false;
    if (attemptWatchdogId) input.watchdogs.unregister(attemptWatchdogId);
  }
}

export function applyCallbackReviewFailure(input: {
  callback: PendingChatCallback;
  error: unknown;
  store: ButlerStateStore;
  failureCount: Map<string, number>;
  notBefore: Map<string, number>;
}): void {
  const { callback } = input;
  const failures = (input.failureCount.get(callback.threadId) ?? 0) + 1;
  const failureMessage = redactSensitiveText(input.error instanceof Error ? input.error.message : String(input.error));
  appendCallbackReviewError(callback, { at: Date.now(), message: failureMessage });
  input.failureCount.set(callback.threadId, failures);
  if (failures >= CALLBACK_REVIEW_MAX_ATTEMPTS) {
    const message = failureMessage;
    callback.reviewState = "blocked";
    callback.reviewStage = "blocked";
    callback.reviewLastError = message.slice(0, 2000);
    callback.reviewNextAttemptAt = null;
    callback.reviewDeadlineAt = null;
    callback.blockedCloseoutReason = `${CALLBACK_REVIEW_PAUSED_PREFIX} after ${failures} failed attempts: ${message}`.slice(0, 800);
    callback.blockedCloseoutReportAt = input.store.getWorkerReport(callback.threadId)?.updatedAt ?? null;
  } else {
    callback.reviewState = "queued";
    callback.reviewStage = "retry_wait";
    callback.reviewLastError = failureMessage.slice(0, 2000);
    callback.reviewDeadlineAt = null;
    const nextAttemptAt = Date.now() + CALLBACK_REVIEW_RETRY_MS * 2 ** (failures - 1);
    callback.reviewNextAttemptAt = nextAttemptAt;
    input.notBefore.set(callback.threadId, nextAttemptAt);
  }
  callback.updatedAt = Date.now();
}

export function isCallbackReviewAutomationPause(callback: PendingChatCallback, reportUpdatedAt?: number | null): boolean {
  return callback.reviewState === "blocked" &&
    callback.blockedCloseoutReason?.startsWith(CALLBACK_REVIEW_PAUSED_PREFIX) === true &&
    (reportUpdatedAt === undefined || callback.blockedCloseoutReportAt === reportUpdatedAt);
}

export function isCallbackReviewOperatorPause(callback: PendingChatCallback, reportUpdatedAt?: number | null): boolean {
  return callback.reviewState === "blocked" &&
    callback.blockedCloseoutReason?.startsWith(CALLBACK_REVIEW_OPERATOR_STOPPED_PREFIX) === true &&
    (reportUpdatedAt === undefined || callback.blockedCloseoutReportAt === reportUpdatedAt);
}

export function isCallbackReviewRetryablePause(callback: PendingChatCallback, reportUpdatedAt?: number | null): boolean {
  return isCallbackReviewAutomationPause(callback, reportUpdatedAt) || isCallbackReviewOperatorPause(callback, reportUpdatedAt);
}
