import path from "node:path";
import { AuthStorage, createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager, type ExtensionAPI } from "@mariozechner/pi-coding-agent";

import type { ButlerAgentSessionAccess, ButlerCustomTool } from "./butler-agent-tool-access.js";
import { buildCallbackReviewPrompt, isCallbackOutstanding, type PendingChatCallback } from "./butler-agent-helpers.js";
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

const CALLBACK_REVIEW_RETRY_MS = 30_000;
const CALLBACK_REVIEW_MAX_ATTEMPTS = 3;
const CALLBACK_REVIEW_PAUSED_PREFIX = "Adversarial review paused";
const CALLBACK_REVIEW_OPERATOR_STOPPED_PREFIX = "Adversarial review stopped by the operator";
const CALLBACK_SUPERVISOR_TIMEOUT_MS = 90_000;
const CALLBACK_REVIEW_TOOL_NAMES = new Set([
  "read_job",
  "read_supervision_checklist",
  "review_acceptance_point",
  "disprove_review_finding",
  "flush_rejected_acceptance_points",
  "review_preview_proof",
  "request_self_improvement",
  "message_job",
  "reply_to_operator"
]);
const CALLBACK_SUPERVISOR_COMPLETION_TOOLS = new Set(["flush_rejected_acceptance_points", "message_job", "reply_to_operator"]);

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
    ?.filter((finding) => finding.blocking && !finding.waived)
    .slice(-10)
    .map((finding) => `${finding.id} ${finding.severity}: ${finding.findingSummary}`) ?? [];
  return [
    callback.lastPrivateSteerText ? `Latest Butler steer: ${callback.lastPrivateSteerText}` : null,
    payload?.workerDirective && payload.kind !== "held_context" ? `Latest sent Worker directive: ${payload.workerDirective}` : null,
    payload?.workerDirective && payload.kind === "held_context" ? `Held context awaiting Butler review; this was not sent to the Worker:\n${payload.workerDirective}` : null,
    heldContext.length > 0 ? `Held operator context:\n${heldContext.join("\n")}` : null,
    unresolvedChecklist.length > 0 ? `Unresolved or rejected checklist points:\n${unresolvedChecklist.join("\n")}` : null,
    priorBlockingFindings.length > 0 ? `Prior blocking review findings being reworked:\n${priorBlockingFindings.join("\n")}` : null
  ].filter((entry): entry is string => Boolean(entry)).join("\n\n").slice(0, 12_000);
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
        const scopedParams = tool.name === "review_preview_proof" && !targetThreadId
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
  codexHomeDir: string;
  piAuthPath: string;
  scratchDir: string;
  codexAuthenticated: boolean;
  isCurrent?: () => boolean;
  supervisorTimeoutMs?: number;
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
  await ensureButlerAdversarialReview({
    store: input.store,
    threadId: callback.threadId,
    model,
    modelRegistry: sessionAccess.modelRegistry,
    codexHomeDir: input.codexHomeDir,
    piAuthPath: input.piAuthPath,
    scratchDir: input.scratchDir,
    thinkingLevel,
    minimumReportUpdatedAt: callback.requestedAt,
    reviewBrief: buildCallbackAdversarialReviewBrief(input.store, callback),
    codexAuthenticated: input.codexAuthenticated,
    isCurrent,
    onProgress: input.onProgress
  });
  if (!isCurrent()) return;

  const supervisorTimeoutMs = input.supervisorTimeoutMs ?? CALLBACK_SUPERVISOR_TIMEOUT_MS;
  const supervisorStartedAt = Date.now();
  const nextSupervisorDeadlineAt = (activityAt = Date.now()) => activityAt + supervisorTimeoutMs;
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
  await resourceLoader.reload();
  const { session } = await createAgentSession({
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
  });
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
  let timeout: ReturnType<typeof setTimeout> | null = null;
  let superseded: ReturnType<typeof setInterval> | null = null;
  try {
    await Promise.race([
      session.prompt(buildCallbackReviewPrompt(input.store, callback)),
      new Promise<never>((_resolve, reject) => {
        const check = () => {
          const now = Date.now();
          const inactiveFor = now - lastProgress.at;
          if (inactiveFor >= supervisorTimeoutMs) {
            attemptActive = false;
            void session.abort();
            const modelLabel = formatProviderModelRef({ provider: model.provider, model: model.id }) ?? model.id;
            reject(new Error(`Isolated Butler supervision was inactive for ${Math.round(supervisorTimeoutMs / 1000)}s using ${modelLabel}. Last activity ${Math.max(0, Math.round(inactiveFor / 1000))}s ago: ${lastProgress.message}`));
            return;
          }
          timeout = setTimeout(check, Math.max(1, Math.min(supervisorTimeoutMs - inactiveFor, 1_000)));
        };
        timeout = setTimeout(check, Math.min(supervisorTimeoutMs, 1_000));
      }),
      new Promise<never>((_resolve, reject) => {
        superseded = setInterval(() => {
          if (isCurrent()) return;
          void session.abort();
          reject(new Error("This callback review was superseded by newer Butler context."));
        }, 50);
      })
    ]);
    assertCallbackSupervisorPromptSucceeded(session.messages, completedSupervisorAction, formatProviderModelRef({ provider: model.provider, model: model.id }) ?? model.id);
  } finally {
    attemptActive = false;
    if (timeout) clearTimeout(timeout);
    if (superseded) clearInterval(superseded);
    unsubscribe();
    session.dispose();
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
