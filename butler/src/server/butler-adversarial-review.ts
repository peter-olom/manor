import crypto from "node:crypto";
import path from "node:path";

import { Type, type Api, type Model } from "@earendil-works/pi-ai";
import {
  AuthStorage,
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
  defineTool,
  type ExtensionAPI,
  type ModelRegistry
} from "@earendil-works/pi-coding-agent";

import { contentToText } from "./butler-agent-helpers.js";
import { formatProviderModelRef, modelToModelOption } from "./model-provider-config.js";
import { normalizeWorkerReviewResults } from "./butler-orchestration.js";
import { applyOpencodeGoNativeThinkingPayload } from "./pi-opencode-web-tools-extension.js";
import { piThinkingLevelForModelOption } from "./pi-thinking-levels.js";
import { buildReviewWorkspaceSnapshot, cleanupScopedReviewWorkspace, createNonGitReviewWorkspace, createScopedReviewWorkspace, resolveGitRoot, resolveReviewWorkspaceCwd } from "./git-review-scope.js";
import { isolatedModelResourceOptions } from "./isolated-model-resources.js";
import type { ButlerStateStore } from "./state-store.js";
import type { ButlerThinkingLevel, CodexThreadRecord, CodexWorkerReportView, WorkerReviewResultRecordView } from "./types.js";
import { workerExecutionEndAt } from "./worker-execution-window.js";
import { workerFileChangeAttribution } from "./worker-review-attribution.js";
import { redactSensitiveText } from "./redact-sensitive-text.js";
import { assertIsolatedPromptSucceeded } from "./isolated-prompt-outcome.js";
import type { ActivityWatchdogService } from "./activity-watchdog.js";
import { assertProviderPortableToolSchema } from "./butler-agent-tool-schemas.js";
import { formatResolvedJobOutputManifestForReview, inspectCurrentJobOutputForReview } from "./job-output-manifest.js";

export const ADVERSARIAL_REVIEW_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["findings"],
  properties: {
    findings: {
      type: "array",
      maxItems: 12,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["severity", "findingSummary", "blocking", "linkedClaimIds"],
        properties: {
          severity: { type: "string", enum: ["info", "low", "medium", "high", "critical"] },
          findingSummary: { type: "string", minLength: 1 },
          blocking: { type: "boolean" },
          linkedClaimIds: { type: "array", maxItems: 20, items: { type: "string", maxLength: 100 } }
        }
      }
    }
  }
};

const REVIEW_SEVERITIES = new Set(["info", "low", "medium", "high", "critical"]);
const PI_REVIEW_SUBMISSION_SCHEMA = Type.Object({
  findings: Type.Array(Type.Object({
    severity: Type.String({
      enum: ["info", "low", "medium", "high", "critical"],
      pattern: "^(?:info|low|medium|high|critical)$"
    }),
    findingSummary: Type.String({ minLength: 1 }),
    blocking: Type.Boolean(),
    linkedClaimIds: Type.Array(Type.String({ maxLength: 100 }), { maxItems: 20 })
  }, { additionalProperties: false }), { maxItems: 12 })
}, { additionalProperties: false });

export function createPiReviewSubmissionTool(onSubmit: (review: ReturnType<typeof validateAdversarialReviewOutput>) => void) {
  let accepted = false;
  assertProviderPortableToolSchema("submit_review", PI_REVIEW_SUBMISSION_SCHEMA);
  return defineTool({
    name: "submit_review",
    label: "Submit review",
    description: "Submit the final structured adversarial review. Call this exactly once after inspecting the work.",
    parameters: PI_REVIEW_SUBMISSION_SCHEMA,
    execute: async (_toolCallId, params) => {
      if (accepted) throw new Error("Adversarial review was already submitted.");
      const review = validateAdversarialReviewOutput(params);
      accepted = true;
      onSubmit(review);
      return {
        content: [{ type: "text" as const, text: "Review submitted. End the review now." }],
        details: { submitted: true }
      };
    }
  });
}

const PI_REVIEW_JOB_OUTPUT_SCHEMA = Type.Object({
  outputId: Type.String({ minLength: 1 })
}, { additionalProperties: false });

export function createPiReviewJobOutputTool(inspect: (outputId: string) => Promise<string>) {
  assertProviderPortableToolSchema("inspect_job_output", PI_REVIEW_JOB_OUTPUT_SCHEMA);
  return defineTool({
    name: "inspect_job_output",
    label: "Inspect job output",
    description: "Inspect one current-attempt durable output by manifest entry ID. Returns bounded extracted text for supported long text, PDF, Office, archive, and binary files without exposing filesystem paths.",
    parameters: PI_REVIEW_JOB_OUTPUT_SCHEMA,
    execute: async (_toolCallId, params) => ({
      content: [{ type: "text" as const, text: await inspect(params.outputId) }],
      details: { outputId: params.outputId }
    })
  });
}

export async function waitForPiReviewSubmission(input: {
  prompt: Promise<void>;
  submission: Promise<ReturnType<typeof validateAdversarialReviewOutput>>;
  abort: () => Promise<unknown>;
  timeoutMs: number;
  lastActivityAt?: () => number;
  isCurrent?: () => boolean;
  watchdogs: ActivityWatchdogService;
  watchdogId?: string;
}): Promise<ReturnType<typeof validateAdversarialReviewOutput> | null> {
  let watchdogId: string | null = null;
  try {
    const startedAt = Date.now();
    const timeoutOutcome = new Promise<never>((_resolve, reject) => {
      const check = () => {
        const now = Date.now();
        if (input.isCurrent?.() === false) {
          reject(new Error("adversarial review was superseded"));
          return;
        }
        const inactiveFor = now - (input.lastActivityAt?.() ?? startedAt);
        if (inactiveFor >= input.timeoutMs) {
          reject(new Error("adversarial review timed out"));
          return;
        }
      };
      watchdogId = input.watchdogId ?? `review-pi:${crypto.randomUUID()}`;
      input.watchdogs.register({
        id: watchdogId,
        policy: "review-activity",
        target: "Pi reviewer",
        maxIntervalMs: input.timeoutMs,
        callback: check
      });
    });
    const outcome = await Promise.race([
      input.prompt.then(() => ({ kind: "prompt" as const })),
      input.submission.then((review) => ({ kind: "submission" as const, review })),
      timeoutOutcome
    ]);
    if (outcome.kind === "prompt") return null;
    await input.abort().catch(() => undefined);
    return outcome.review;
  } finally {
    if (watchdogId) input.watchdogs.unregister(watchdogId);
  }
}

export function validateAdversarialReviewOutput(raw: unknown): { findings: Array<{ severity: string; findingSummary: string; blocking: boolean; linkedClaimIds: string[] }> } {
  if (!raw || typeof raw !== "object" || !Array.isArray((raw as { findings?: unknown }).findings)) {
    throw new Error("Adversarial reviewer returned invalid structured output: findings must be an array.");
  }
  if (Object.keys(raw).some((key) => key !== "findings")) throw new Error("Adversarial reviewer returned unsupported root fields.");
  const findings = (raw as { findings: unknown[] }).findings;
  if (findings.length > 12) throw new Error("Adversarial reviewer returned too many findings.");
  for (const finding of findings) {
    if (!finding || typeof finding !== "object") throw new Error("Adversarial reviewer returned an invalid finding.");
    const entry = finding as Record<string, unknown>;
    const keys = Object.keys(entry);
    if (keys.some((key) => !["severity", "findingSummary", "blocking", "linkedClaimIds"].includes(key))) throw new Error("Adversarial reviewer returned unsupported finding fields.");
    if (typeof entry.severity !== "string" || !REVIEW_SEVERITIES.has(entry.severity)) throw new Error("Adversarial reviewer returned an invalid finding severity.");
    if (typeof entry.findingSummary !== "string" || !entry.findingSummary.trim()) throw new Error("Adversarial reviewer returned an invalid finding summary.");
    if (typeof entry.blocking !== "boolean") throw new Error("Adversarial reviewer returned an invalid blocking value.");
    if (!Array.isArray(entry.linkedClaimIds) || entry.linkedClaimIds.length > 20 || entry.linkedClaimIds.some((id) => typeof id !== "string" || id.length > 100)) throw new Error("Adversarial reviewer returned invalid linked claim ids.");
  }
  return raw as { findings: Array<{ severity: string; findingSummary: string; blocking: boolean; linkedClaimIds: string[] }> };
}

type ReviewSelection = {
  model: Model<Api>;
  thinkingLevel: ButlerThinkingLevel;
};

export type ProviderAdversarialReviewInput = {
  cwd: string;
  piAuthPath: string;
  modelRegistry: ModelRegistry;
  selection: ReviewSelection;
  prompt: string;
  timeoutMs: number;
  onProgress?: (progress: AdversarialReviewProgress) => void;
  isCurrent?: () => boolean;
  watchdogs: ActivityWatchdogService;
  inspectJobOutput?: (outputId: string) => Promise<string>;
};

export type AdversarialReviewProgress = {
  stage: "preparing" | "reviewing_changes" | "supervising_closeout";
  message: string;
  at: number;
  toolName?: string | null;
  error?: string | null;
  deadlineAt?: number | null;
};

function reportReviewProgress(
  input: Pick<ProviderAdversarialReviewInput, "onProgress">,
  progress: Omit<AdversarialReviewProgress, "at">
): AdversarialReviewProgress {
  const next = { ...progress, at: Date.now() };
  input.onProgress?.(next);
  return next;
}

function reviewDiagnosticText(value: unknown): string {
  let text = "";
  if (value && typeof value === "object" && Array.isArray((value as { content?: unknown }).content)) {
    text = contentToText((value as { content: unknown[] }).content);
  } else if (typeof value === "string") {
    text = value;
  } else if (value !== undefined) {
    try { text = JSON.stringify(value); } catch { text = String(value); }
  }
  return redactSensitiveText(text).replace(/\s+/g, " ").trim().slice(0, 1200);
}

function reviewTimeoutError(input: ProviderAdversarialReviewInput, lastProgress: AdversarialReviewProgress | null): Error {
  const seconds = Math.round(input.timeoutMs / 1000);
  const model = formatProviderModelRef({ provider: input.selection.model.provider, model: input.selection.model.id }) ?? input.selection.model.id;
  const last = lastProgress
    ? ` Last activity ${Math.max(0, Math.round((Date.now() - lastProgress.at) / 1000))}s ago: ${lastProgress.message}`
    : " No reviewer activity was received.";
  return new Error(`Adversarial review was inactive for ${seconds}s using ${model}.${last}`);
}

function registerOpencodeGoRequestTransforms(pi: ExtensionAPI): void {
  pi.on("before_provider_request", (event) => applyOpencodeGoNativeThinkingPayload(event.payload));
}

function extractJson(text: string): string {
  const trimmed = text.trim();
  if (!trimmed.startsWith("```")) return trimmed;
  const match = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return match ? match[1]!.trim() : trimmed;
}

async function runPiReview(input: ProviderAdversarialReviewInput): Promise<unknown> {
  const nextDeadlineAt = () => Date.now() + input.timeoutMs;
  let lastProgress = reportReviewProgress(input, {
    stage: "reviewing_changes",
    message: "Reviewer session is starting.",
    deadlineAt: nextDeadlineAt()
  });
  let submitted: unknown = null;
  let resolveSubmission!: (review: ReturnType<typeof validateAdversarialReviewOutput>) => void;
  const submission = new Promise<ReturnType<typeof validateAdversarialReviewOutput>>((resolve) => { resolveSubmission = resolve; });
  const submitReview = createPiReviewSubmissionTool((review) => {
    submitted = review;
    resolveSubmission(review);
  });
  const inspectJobOutput = input.inspectJobOutput ? createPiReviewJobOutputTool(input.inspectJobOutput) : null;
  const settingsManager = SettingsManager.inMemory();
  const resourceLoader = new DefaultResourceLoader({
    cwd: input.cwd,
    agentDir: path.dirname(input.piAuthPath),
    settingsManager,
    ...isolatedModelResourceOptions(),
    extensionFactories: [registerOpencodeGoRequestTransforms],
    systemPromptOverride: () => [
      "You are Manor's isolated adversarial reviewer.",
      "Judge the completed work against its goal using evidence appropriate to the capability. Work may be code-changing, operational, observational, advisory, or artifact-producing.",
      "Use repository inspection only when it materially tests a claim. A valid result may have no repository change.",
      "Your working directory is the only filesystem review surface. Worker runtime paths and session logs may not be mounted here. Never guess paths or repeatedly probe unavailable surfaces; judge the supplied evidence or report a compact evidence gap when it matters.",
      "When a manifest output's complete contents matter, call inspect_job_output with its current manifest entry ID. This is the only artifact inspection surface; never infer another job ID or filesystem path.",
      "Find actionable correctness, regression, safety, proof, and task-fit issues.",
      "Do not modify files.",
      "You must finish by calling submit_review exactly once. Do not return the review as prose or raw JSON."
    ].join("\n")
  });
  await resourceLoader.reload();
  const { session } = await createAgentSession({
    cwd: input.cwd,
    authStorage: AuthStorage.create(input.piAuthPath),
    modelRegistry: input.modelRegistry,
    model: input.selection.model,
    thinkingLevel: piThinkingLevelForModelOption(input.selection.thinkingLevel, modelToModelOption(input.selection.model)),
    tools: ["read", "grep", "find", "ls", ...(inspectJobOutput ? ["inspect_job_output"] : []), "submit_review"],
    customTools: [...(inspectJobOutput ? [inspectJobOutput] : []), submitReview],
    sessionManager: SessionManager.inMemory(input.cwd),
    settingsManager,
    resourceLoader
  });
  let lastReasoningReportAt = 0;
  const unsubscribe = session.subscribe((event) => {
    if (event.type === "tool_execution_start") {
      lastProgress = reportReviewProgress(input, {
        stage: "reviewing_changes",
        message: `Running ${event.toolName}.`,
        toolName: event.toolName,
        deadlineAt: nextDeadlineAt()
      });
      return;
    }
    if (event.type === "tool_execution_end") {
      const detail = event.isError ? reviewDiagnosticText(event.result) : "";
      lastProgress = reportReviewProgress(input, {
        stage: "reviewing_changes",
        message: event.isError ? `Failed ${event.toolName}${detail ? `: ${detail}` : "."}` : `Finished ${event.toolName}.`,
        toolName: event.toolName,
        error: event.isError ? detail || `${event.toolName} failed.` : null,
        deadlineAt: nextDeadlineAt()
      });
      return;
    }
    if (event.type === "message_update" && Date.now() - lastReasoningReportAt >= 5000) {
      lastReasoningReportAt = Date.now();
      lastProgress = reportReviewProgress(input, {
        stage: "reviewing_changes",
        message: "Reviewer is reasoning over the change.",
        deadlineAt: nextDeadlineAt()
      });
    }
  });
  try {
    const earlySubmission = await waitForPiReviewSubmission({
      prompt: session.prompt(`${input.prompt}\n\nInspect the work, then call submit_review exactly once with the final findings.`),
      submission,
      abort: () => session.abort(),
      timeoutMs: input.timeoutMs,
      lastActivityAt: () => lastProgress.at,
      isCurrent: input.isCurrent,
      watchdogs: input.watchdogs,
      watchdogId: `review-pi:${crypto.randomUUID()}`
    });
    if (earlySubmission) return earlySubmission;
    assertPiReviewerPromptSucceeded(session.messages);
    if (submitted) return submitted;
    const message = [...session.messages].reverse().find((entry) => entry.role === "assistant");
    const text = message && "content" in message ? contentToText(message.content).trim() : "";
    if (!text) throw new Error("adversarial reviewer returned no result");
    return JSON.parse(extractJson(text));
  } catch (error) {
    await session.abort().catch(() => {});
    if (error instanceof Error && error.message === "adversarial review timed out") {
      throw reviewTimeoutError(input, lastProgress);
    }
    throw error;
  } finally {
    unsubscribe();
    session.dispose();
  }
}

export function assertPiReviewerPromptSucceeded(messages: readonly unknown[]): void {
  assertIsolatedPromptSucceeded(messages, "Adversarial reviewer");
}

export async function runProviderAdversarialReview(input: ProviderAdversarialReviewInput): Promise<unknown> {
  return runPiReview(input);
}

function clip(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  const half = Math.floor((maxLength - 80) / 2);
  return `${text.slice(0, half)}\n\n... review input clipped ...\n\n${text.slice(-half)}`;
}

export function buildAdversarialReviewPrompt(input: {
  thread: CodexThreadRecord;
  report: CodexWorkerReportView;
  workspaceSnapshot: string;
  outputManifest?: string | null;
  reviewBrief?: string | null;
}): string {
  const contract = input.thread.executionContract;
  return [
    "Review this completed Manor worker job adversarially.",
    "Treat the worker's claims as hypotheses. Decide what proof shape fits the requested outcome, then check the actual work and evidence.",
    "For code-changing work, inspect the workspace snapshot and relevant files. For operational, verification, observational, advisory, or artifact work, judge the supplied runtime evidence and outcome; do not invent a repository-change requirement.",
    "The reviewer can read only its current review workspace. Paths quoted from the Worker may belong to the Worker's runtime and may be unavailable here. Do not guess alternate paths or search for Worker session logs. Missing reviewer access is not itself a Worker defect; return a finding only when the supplied evidence is insufficient for the goal.",
    "Prioritize bugs, regressions, missing proof, unsafe data/API/deploy behavior, and mismatches with the requested outcome.",
    "Mark blocking=true only for a serious actionable issue Butler must send back before acceptance.",
    "Keep findings compact so only the final structured result is passed back to Butler.",
    "",
    `Task: ${contract?.requestedTask ?? input.thread.supervisor.latestUserPrompt ?? ""}`,
    `Task category hint: ${contract?.taskCategory ?? "unknown"}. Use this only as context; infer the appropriate review approach from the actual goal and evidence.`,
    `Acceptance points: ${(contract?.acceptancePoints ?? []).join(" | ")}`,
    `Critic checks: ${(contract?.mission?.criticChecks ?? []).join(" | ")}`,
    input.reviewBrief?.trim() ? `Current Butler review brief:\n${clip(input.reviewBrief.trim(), 12_000)}` : "Current Butler review brief: none.",
    `Worker summary: ${input.report.summary}`,
    `Worker details: ${input.report.details ?? ""}`,
    `Worker claims: ${clip(JSON.stringify(input.report.claims ?? null), 16_000)}`,
    `Worker evidence: ${clip(JSON.stringify(input.report.evidence ?? []), 16_000)}`,
    "",
    "Durable outputs registered for this exact job attempt:",
    clip(input.outputManifest?.trim() || "No durable outputs are registered for the current job attempt.", 40_000),
    "Use these resolved records directly. Never search the filesystem for an artifact or proof identifier. Call inspect_job_output with a current manifest entry ID whenever complete long-text, PDF, Office, archive, or binary-derived evidence matters to the review.",
    "",
    "Workspace evidence snapshot:",
    clip(input.workspaceSnapshot, 60_000)
  ].join("\n");
}

function concurrentReviewThreads(
  store: ButlerStateStore,
  thread: CodexThreadRecord,
  reviewCwd: string,
  reportUpdatedAt: number
): CodexThreadRecord[] {
  return store.listThreads().flatMap((candidate) => {
    const record = store.getThread(candidate.id);
    if (
      !record ||
      candidate.id === thread.id ||
      !candidate.executionContract?.reviewBaselineCwd ||
      path.resolve(candidate.executionContract.reviewBaselineCwd) !== path.resolve(reviewCwd) ||
      candidate.createdAt > reportUpdatedAt ||
      workerExecutionEndAt(record) < thread.createdAt
    ) return [];
    return [record];
  });
}

export async function ensureButlerAdversarialReview(input: {
  store: ButlerStateStore;
  threadId: string;
  model: Model<Api>;
  modelRegistry: ModelRegistry;
  piAuthPath: string;
  thinkingLevel: ButlerThinkingLevel;
  minimumReportUpdatedAt?: number | null;
  reviewBrief?: string | null;
  timeoutMs?: number;
  watchdogs: ActivityWatchdogService;
  runReview?: typeof runProviderAdversarialReview;
  buildWorkspaceSnapshot?: (cwd: string, baselineSha?: string | null, baselineTreeSha?: string | null, baselineObjectDir?: string | null) => Promise<string>;
  createScopedWorkspace?: typeof createScopedReviewWorkspace;
  isCurrent?: () => boolean;
  onProgress?: (progress: AdversarialReviewProgress) => void;
}): Promise<WorkerReviewResultRecordView[]> {
  const thread = input.store.getThread(input.threadId);
  const report = input.store.getWorkerReport(input.threadId);
  const model = input.model;
  if (input.isCurrent?.() === false ||
    !thread ||
    !report ||
    report.status !== "completed" ||
    !model ||
    (typeof input.minimumReportUpdatedAt === "number" && report.updatedAt < input.minimumReportUpdatedAt)
  ) return [];

  const existing = (thread.executionContract?.reviewResults ?? []).filter((result) =>
    result.turnId === report.turnId &&
    result.reportUpdatedAt === report.updatedAt &&
    result.automationFailure !== true &&
    result.modelProvider === model.provider &&
    result.modelId === model.id &&
    result.reasoningLevel === input.thinkingLevel
  );
  if (existing.length > 0) return existing;

  if (thread.executionContract?.reviewBaselineCaptureFailed) {
    throw new Error("Worker review isolation was not captured at delegation. Butler will retry instead of reviewing an unsafe shared checkout.");
  }

  input.onProgress?.({
    stage: "preparing",
    message: "Preparing an isolated workspace for adversarial review.",
    at: Date.now(),
    deadlineAt: null
  });

  const preferredCwd = thread.executionContract?.workspaceCwd || thread.cwd || process.cwd();
  const workerAttribution = workerFileChangeAttribution(thread);
  const workerAttributionText = JSON.stringify({ paths: workerAttribution.paths, attributionUnknown: workerAttribution.overflow });
  const reviewCwd = await resolveReviewWorkspaceCwd({
    preferredCwd
  });
  const reviewGitRoot = await resolveGitRoot(reviewCwd);
  const baselineSha = thread.executionContract?.reviewBaselineCwd && path.resolve(thread.executionContract.reviewBaselineCwd) === path.resolve(reviewCwd)
    ? thread.executionContract.reviewBaselineSha ?? null
    : null;
  const baselineTreeSha = thread.executionContract?.reviewBaselineCwd && path.resolve(thread.executionContract.reviewBaselineCwd) === path.resolve(reviewCwd)
    ? thread.executionContract.reviewBaselineTreeSha ?? null
    : null;
  const baselineObjectDir = thread.executionContract?.reviewBaselineCwd && path.resolve(thread.executionContract.reviewBaselineCwd) === path.resolve(reviewCwd)
    ? thread.executionContract.reviewBaselineObjectDir ?? null
    : null;
  const concurrentWorkers = baselineTreeSha && baselineObjectDir
    ? concurrentReviewThreads(input.store, thread, reviewCwd, report.updatedAt)
    : [];
  const concurrentAttributions = concurrentWorkers.map((candidate) => workerFileChangeAttribution(candidate));
  const deletedPeerContexts = (thread.executionContract?.reviewPeerContexts ?? [])
    .filter((entry) => entry.baselineTreeSha === baselineTreeSha);
  const attributeAllChangedPaths = concurrentWorkers.length === 0 && deletedPeerContexts.length === 0;
  const ownershipAttributionUnknown = !attributeAllChangedPaths && (
    workerAttribution.overflow ||
    concurrentAttributions.some((attribution) => attribution.overflow || attribution.paths.length === 0) ||
    deletedPeerContexts.some((entry) => entry.attributionUnknown === true)
  );
  const scopedReview = baselineTreeSha && baselineObjectDir
    ? await (input.createScopedWorkspace ?? createScopedReviewWorkspace)({
        cwd: reviewCwd,
        baselineTreeSha,
        baselineObjectDir,
        workerContextText: workerAttributionText,
        otherWorkerContextTexts: [
          ...concurrentAttributions.map((attribution) => JSON.stringify({ paths: attribution.paths, attributionUnknown: attribution.overflow })),
          ...deletedPeerContexts.map((entry) => JSON.stringify({ paths: entry.paths, attributionUnknown: entry.attributionUnknown === true }))
        ],
        attributeAllChangedPaths,
        ownershipAttributionUnknown
      })
    : null;
  if (baselineTreeSha && baselineObjectDir && !scopedReview) {
    throw new Error("Worker review isolation could not be created safely. Butler will retry without reviewing the shared checkout.");
  }
  const nonGitReviewCwd = reviewGitRoot ? null : await createNonGitReviewWorkspace();
  const effectiveReviewCwd = scopedReview?.cwd ?? nonGitReviewCwd ?? reviewCwd;
  try {
    const rawWorkspaceSnapshot = await (input.buildWorkspaceSnapshot ?? buildReviewWorkspaceSnapshot)(
      effectiveReviewCwd,
      scopedReview?.baselineSha ?? baselineSha,
      scopedReview ? null : baselineTreeSha,
      scopedReview ? null : baselineObjectDir
    );
    if (input.isCurrent?.() === false) return [];
    const workspaceSnapshot = scopedReview ? `${scopedReview.scopeNote}\n\n${rawWorkspaceSnapshot}` : rawWorkspaceSnapshot;
    const payload = input.store.getThreadJobPayload(input.threadId);
    const outputManifest = payload ? await formatResolvedJobOutputManifestForReview(payload, input.store) : null;
    const inspectJobOutput = payload
      ? (outputId: string) => inspectCurrentJobOutputForReview({ payload, store: input.store, outputId })
      : undefined;
    const prompt = buildAdversarialReviewPrompt({ thread, report, workspaceSnapshot, outputManifest, reviewBrief: input.reviewBrief });
    input.onProgress?.({
      stage: "reviewing_changes",
      message: "Workspace snapshot is ready. Starting the adversarial reviewer.",
      at: Date.now(),
      deadlineAt: Date.now() + (input.timeoutMs ?? 120_000)
    });
    const raw = validateAdversarialReviewOutput(await (input.runReview ?? runProviderAdversarialReview)({
      cwd: effectiveReviewCwd,
      piAuthPath: input.piAuthPath,
      modelRegistry: input.modelRegistry,
      selection: { model, thinkingLevel: input.thinkingLevel },
      prompt,
      timeoutMs: input.timeoutMs ?? 120_000,
      watchdogs: input.watchdogs,
      onProgress: input.onProgress,
      isCurrent: input.isCurrent,
      inspectJobOutput
    }));
    if (input.isCurrent?.() === false) return [];
    let results = normalizeWorkerReviewResults({
      raw,
      threadId: input.threadId,
      turnId: report.turnId,
      reportUpdatedAt: report.updatedAt,
      modelProvider: model.provider,
      modelId: model.id,
      reasoningLevel: input.thinkingLevel
    });
    if (scopedReview?.ownershipAmbiguous || thread.executionContract?.reviewPeerContextOverflow) {
      const now = Date.now();
      results.push({
        id: `review-${report.turnId}-ownership-${crypto.randomUUID().slice(0, 8)}`,
        reviewSource: "adversarial_review",
        turnId: report.turnId,
        reportUpdatedAt: report.updatedAt,
        severity: "high",
        findingSummary: scopedReview?.ownershipAmbiguous
          ? `Butler could not safely attribute the shared-checkout changes to this Worker (${scopedReview.attributedPaths.length}/${scopedReview.changedPathCount} paths attributed; ${scopedReview.ambiguousPathCount} conflicting). The Worker must report exact changed paths or rerun in an isolated workspace.`
          : "Butler's deleted-Worker attribution exceeded its safe retained scope. The Worker must rerun in an isolated workspace before acceptance.",
        blocking: true,
        waived: false,
        waiverReason: null,
        automationFailure: false,
        linkedClaimIds: [],
        modelProvider: model.provider,
        modelId: model.id,
        reasoningLevel: input.thinkingLevel,
        createdAt: now,
        updatedAt: now
      });
    }
    if (results.length === 0) {
      const now = Date.now();
      results = [{
        id: `review-${report.turnId}-none-${crypto.randomUUID().slice(0, 8)}`,
        reviewSource: "adversarial_review",
        turnId: report.turnId,
        reportUpdatedAt: report.updatedAt,
        severity: "info",
        findingSummary: "Adversarial review found no actionable findings.",
        blocking: false,
        waived: false,
        waiverReason: null,
        automationFailure: false,
        linkedClaimIds: [],
        modelProvider: model.provider,
        modelId: model.id,
        reasoningLevel: input.thinkingLevel,
        createdAt: now,
        updatedAt: now
      }];
    }
    if (input.isCurrent?.() === false) return [];
    input.store.recordWorkerReviewResults(input.threadId, results);
    return results;
  } catch (error) {
    if (input.isCurrent?.() === false) return [];
    const rawMessage = error instanceof Error ? error.message : String(error);
    const message = /auth|log.?in|sign.?in|unauthori[sz]ed|\b401\b|\b403\b/i.test(rawMessage)
      ? `Adversarial review could not authenticate ${formatProviderModelRef({ provider: model.provider, model: model.id }) ?? model.id}. Open Settings → Providers and reconnect that provider, then retry.`
      : rawMessage.slice(0, 800);
    input.store.addEvent(input.threadId, "adversarial/review/failed", `Adversarial review failed: ${message}`);
    throw new Error(message);
  } finally {
    await cleanupScopedReviewWorkspace(scopedReview?.cwd);
    await cleanupScopedReviewWorkspace(nonGitReviewCwd);
  }
}
