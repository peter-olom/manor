import { spawn } from "node:child_process";
import crypto from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

import { Type, type Api, type Model } from "@mariozechner/pi-ai";
import {
  AuthStorage,
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
  defineTool,
  type ExtensionAPI,
  type ModelRegistry
} from "@mariozechner/pi-coding-agent";

import { contentToText } from "./butler-agent-helpers.js";
import { formatProviderModelRef, modelToModelOption } from "./model-provider-config.js";
import { normalizeWorkerReviewResults } from "./butler-orchestration.js";
import { applyOpencodeGoNativeThinkingPayload } from "./pi-opencode-web-tools-extension.js";
import { piThinkingLevelForModelOption } from "./pi-thinking-levels.js";
import { buildReviewWorkspaceSnapshot, cleanupScopedReviewWorkspace, createScopedReviewWorkspace, resolveReviewWorkspaceCwd } from "./git-review-scope.js";
import { isolatedModelResourceOptions } from "./isolated-model-resources.js";
import type { ButlerStateStore } from "./state-store.js";
import type { ButlerThinkingLevel, CodexThreadRecord, CodexWorkerReportView, WorkerReviewResultRecordView } from "./types.js";
import { workerExecutionEndAt } from "./worker-execution-window.js";
import { workerFileChangeAttribution, workerFileChangePaths } from "./worker-review-attribution.js";
import { redactSensitiveText } from "./redact-sensitive-text.js";
import { assertIsolatedPromptSucceeded } from "./isolated-prompt-outcome.js";

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
          findingSummary: { type: "string", minLength: 1, maxLength: 600 },
          blocking: { type: "boolean" },
          linkedClaimIds: { type: "array", maxItems: 20, items: { type: "string", maxLength: 100 } }
        }
      }
    }
  }
};

const REVIEW_SEVERITIES = new Set(["info", "low", "medium", "high", "critical"]);
const CODEX_REVIEW_TERMINATION_GRACE_MS = 250;
const PI_REVIEW_SUBMISSION_SCHEMA = Type.Object({
  findings: Type.Array(Type.Object({
    severity: Type.Union([Type.Literal("info"), Type.Literal("low"), Type.Literal("medium"), Type.Literal("high"), Type.Literal("critical")]),
    findingSummary: Type.String({ minLength: 1, maxLength: 600 }),
    blocking: Type.Boolean(),
    linkedClaimIds: Type.Array(Type.String({ maxLength: 100 }), { maxItems: 20 })
  }, { additionalProperties: false }), { maxItems: 12 })
}, { additionalProperties: false });

export function createPiReviewSubmissionTool(onSubmit: (review: ReturnType<typeof validateAdversarialReviewOutput>) => void) {
  let accepted = false;
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

export async function waitForPiReviewSubmission(input: {
  prompt: Promise<void>;
  submission: Promise<ReturnType<typeof validateAdversarialReviewOutput>>;
  abort: () => Promise<unknown>;
  timeoutMs: number;
  lastActivityAt?: () => number;
  isCurrent?: () => boolean;
}): Promise<ReturnType<typeof validateAdversarialReviewOutput> | null> {
  let timeout: ReturnType<typeof setTimeout> | null = null;
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
        const untilInactive = Math.max(1, input.timeoutMs - inactiveFor);
        timeout = setTimeout(check, Math.min(untilInactive, input.isCurrent ? 100 : Number.POSITIVE_INFINITY));
      };
      timeout = setTimeout(check, Math.min(input.timeoutMs, input.isCurrent ? 100 : Number.POSITIVE_INFINITY));
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
    if (timeout) clearTimeout(timeout);
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
    if (typeof entry.findingSummary !== "string" || !entry.findingSummary.trim() || entry.findingSummary.length > 600) throw new Error("Adversarial reviewer returned an invalid finding summary.");
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
  codexHomeDir: string;
  piAuthPath: string;
  scratchDir: string;
  modelRegistry: ModelRegistry;
  selection: ReviewSelection;
  codexNativeAvailable: boolean;
  prompt: string;
  timeoutMs: number;
  codexExecutable?: string;
  onProgress?: (progress: AdversarialReviewProgress) => void;
  isCurrent?: () => boolean;
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

function codexReasoningArgs(level: ButlerThinkingLevel): string[] {
  if (level === "default") return [];
  const effort = level === "off" ? "none" : level === "thinking" ? "xhigh" : level;
  return ["--config", `model_reasoning_effort="${effort}"`];
}

export function buildCodexAdversarialReviewArgs(input: {
  schemaPath: string;
  outputPath: string;
  modelId: string;
  thinkingLevel: ButlerThinkingLevel;
}): string[] {
  return [
    "exec",
    "--sandbox",
    "read-only",
    "--ephemeral",
    "--ignore-user-config",
    "--skip-git-repo-check",
    "--ignore-rules",
    "--output-schema",
    input.schemaPath,
    "--output-last-message",
    input.outputPath,
    "--model",
    input.modelId,
    ...codexReasoningArgs(input.thinkingLevel),
    "review",
    "-"
  ];
}

async function runCodexReview(input: ProviderAdversarialReviewInput): Promise<unknown> {
  await fs.mkdir(input.scratchDir, { recursive: true });
  const runId = crypto.randomUUID();
  const schemaPath = path.join(input.scratchDir, `${runId}.schema.json`);
  const outputPath = path.join(input.scratchDir, `${runId}.output.json`);
  await fs.writeFile(schemaPath, JSON.stringify(ADVERSARIAL_REVIEW_OUTPUT_SCHEMA, null, 2), "utf8");

  try {
    let lastActivityAt = Date.now();
    const nextDeadlineAt = () => lastActivityAt + input.timeoutMs;
    let lastProgress = reportReviewProgress(input, {
      stage: "reviewing_changes",
      message: "Codex reviewer started.",
      deadlineAt: nextDeadlineAt()
    });
    const args = buildCodexAdversarialReviewArgs({
      schemaPath,
      outputPath,
      modelId: input.selection.model.id,
      thinkingLevel: input.selection.thinkingLevel
    });
    await new Promise<void>((resolve, reject) => {
      const child = spawn(input.codexExecutable ?? "codex", args, {
        cwd: input.cwd,
        env: { ...process.env, CODEX_HOME: input.codexHomeDir, NO_COLOR: "1" },
        stdio: ["pipe", "pipe", "pipe"]
      });
      let stderr = "";
      let stdout = "";
      let timeout: ReturnType<typeof setTimeout> | null = null;
      let forceKill: ReturnType<typeof setTimeout> | null = null;
      let superseded: ReturnType<typeof setInterval> | null = null;
      let shutdownError: Error | null = null;
      let settled = false;
      const clearWatchers = () => {
        if (timeout) clearTimeout(timeout);
        if (superseded) clearInterval(superseded);
        timeout = null;
        superseded = null;
      };
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearWatchers();
        if (forceKill) clearTimeout(forceKill);
        error ? reject(error) : resolve();
      };
      const shutdown = (error: Error) => {
        if (shutdownError || settled) return;
        shutdownError = error;
        clearWatchers();
        child.kill("SIGTERM");
        forceKill = setTimeout(() => child.kill("SIGKILL"), CODEX_REVIEW_TERMINATION_GRACE_MS);
      };
      const checkTimeout = () => {
        const now = Date.now();
        const inactiveFor = now - lastActivityAt;
        if (inactiveFor >= input.timeoutMs) {
          shutdown(reviewTimeoutError(input, lastProgress));
          return;
        }
        timeout = setTimeout(checkTimeout, Math.max(1, Math.min(input.timeoutMs - inactiveFor, 1_000)));
      };
      timeout = setTimeout(checkTimeout, Math.min(input.timeoutMs, 1_000));
      superseded = input.isCurrent ? setInterval(() => {
        if (input.isCurrent?.() !== false) return;
        shutdown(new Error("adversarial review was superseded"));
      }, 100) : null;
      let lastOutputReportAt = 0;
      const noteOutput = (stream: "stdout" | "stderr", chunk: Buffer) => {
        const now = Date.now();
        lastActivityAt = now;
        if (now - lastOutputReportAt < 1000) return;
        lastOutputReportAt = now;
        if (chunk.length === 0) return;
        lastProgress = reportReviewProgress(input, {
          stage: "reviewing_changes",
          message: `Codex reviewer produced ${stream} output.`,
          deadlineAt: nextDeadlineAt()
        });
      };
      child.stdout.on("data", (chunk: Buffer) => { stdout = `${stdout}${chunk.toString("utf8")}`.slice(-16_000); noteOutput("stdout", chunk); });
      child.stderr.on("data", (chunk: Buffer) => { stderr = `${stderr}${chunk.toString("utf8")}`.slice(-16_000); noteOutput("stderr", chunk); });
      child.on("error", (error) => child.pid ? shutdown(error) : finish(error));
      child.on("close", (code) => {
        if (shutdownError) finish(shutdownError);
        else if (code === 0) finish();
        else finish(new Error(`Codex CLI adversarial review exited with ${code}: ${redactSensitiveText(stderr || stdout)}`.trim()));
      });
      child.stdin.end(input.prompt);
    });
    return JSON.parse(await fs.readFile(outputPath, "utf8"));
  } finally {
    await Promise.all([schemaPath, outputPath].map((filePath) => fs.rm(filePath, { force: true }).catch(() => {})));
  }
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
  const settingsManager = SettingsManager.inMemory();
  const resourceLoader = new DefaultResourceLoader({
    cwd: input.cwd,
    agentDir: path.dirname(input.piAuthPath),
    settingsManager,
    ...isolatedModelResourceOptions(),
    extensionFactories: [registerOpencodeGoRequestTransforms],
    systemPromptOverride: () => [
      "You are Manor's isolated adversarial code reviewer.",
      "Inspect the supplied change and related files with read-only tools.",
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
    tools: ["read", "grep", "find", "ls", "submit_review"],
    customTools: [submitReview],
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
      isCurrent: input.isCurrent
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
  return shouldUseNativeCodexReview(input.selection.model.provider, input.codexNativeAvailable)
    ? runCodexReview(input)
    : runPiReview(input);
}

export function shouldUseNativeCodexReview(provider: string | null | undefined, nativeAvailable: boolean): boolean {
  return nativeAvailable && (provider === "openai-codex" || provider === "codex");
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
  reviewBrief?: string | null;
}): string {
  const contract = input.thread.executionContract;
  return [
    "Review this completed Manor worker job adversarially.",
    "Treat the worker's claims as hypotheses. Check the actual change and evidence.",
    "Prioritize bugs, regressions, missing proof, unsafe data/API/deploy behavior, and mismatches with the requested outcome.",
    "Mark blocking=true only for a serious actionable issue Butler must send back before acceptance.",
    "Keep findings compact so only the final structured result is passed back to Butler.",
    "",
    `Task: ${contract?.requestedTask ?? input.thread.supervisor.latestUserPrompt ?? ""}`,
    `Acceptance points: ${(contract?.acceptancePoints ?? []).join(" | ")}`,
    `Critic checks: ${(contract?.mission?.criticChecks ?? []).join(" | ")}`,
    input.reviewBrief?.trim() ? `Current Butler review brief:\n${clip(input.reviewBrief.trim(), 12_000)}` : "Current Butler review brief: none.",
    `Worker summary: ${input.report.summary}`,
    `Worker details: ${input.report.details ?? ""}`,
    `Worker claims: ${clip(JSON.stringify(input.report.claims ?? null), 16_000)}`,
    `Worker evidence: ${clip(JSON.stringify(input.report.evidence ?? []), 16_000)}`,
    "",
    "Workspace change snapshot:",
    clip(input.workspaceSnapshot, 60_000)
  ].join("\n");
}

function workerWorkspaceContext(thread: CodexThreadRecord, report: CodexWorkerReportView | null): string {
  return JSON.stringify({ report, changedPaths: workerFileChangePaths(thread) });
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
  codexHomeDir: string;
  piAuthPath: string;
  scratchDir: string;
  thinkingLevel: ButlerThinkingLevel;
  minimumReportUpdatedAt?: number | null;
  reviewBrief?: string | null;
  codexAuthenticated?: boolean;
  timeoutMs?: number;
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
  const workerContextText = workerWorkspaceContext(thread, report);
  const reviewCwd = await resolveReviewWorkspaceCwd({
    preferredCwd,
    startedAt: thread.createdAt,
    contextText: workerContextText
  });
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
  const effectiveReviewCwd = scopedReview?.cwd ?? reviewCwd;
  try {
    const rawWorkspaceSnapshot = await (input.buildWorkspaceSnapshot ?? buildReviewWorkspaceSnapshot)(
      effectiveReviewCwd,
      scopedReview?.baselineSha ?? baselineSha,
      scopedReview ? null : baselineTreeSha,
      scopedReview ? null : baselineObjectDir
    );
    if (input.isCurrent?.() === false) return [];
    const workspaceSnapshot = scopedReview ? `${scopedReview.scopeNote}\n\n${rawWorkspaceSnapshot}` : rawWorkspaceSnapshot;
    const prompt = buildAdversarialReviewPrompt({ thread, report, workspaceSnapshot, reviewBrief: input.reviewBrief });
    input.onProgress?.({
      stage: "reviewing_changes",
      message: "Workspace snapshot is ready. Starting the adversarial reviewer.",
      at: Date.now(),
      deadlineAt: Date.now() + (input.timeoutMs ?? 120_000)
    });
    const raw = validateAdversarialReviewOutput(await (input.runReview ?? runProviderAdversarialReview)({
      cwd: effectiveReviewCwd,
      codexHomeDir: input.codexHomeDir,
      piAuthPath: input.piAuthPath,
      scratchDir: input.scratchDir,
      modelRegistry: input.modelRegistry,
      selection: { model, thinkingLevel: input.thinkingLevel },
      codexNativeAvailable: input.codexAuthenticated !== false,
      prompt,
      timeoutMs: input.timeoutMs ?? 120_000,
      onProgress: input.onProgress,
      isCurrent: input.isCurrent
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
  }
}
