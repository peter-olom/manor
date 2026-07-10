import { spawn } from "node:child_process";
import crypto from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

import type { Api, Model } from "@mariozechner/pi-ai";
import {
  AuthStorage,
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
  type ExtensionAPI,
  type ModelRegistry
} from "@mariozechner/pi-coding-agent";

import { contentToText } from "./butler-agent-helpers.js";
import { modelToModelOption } from "./model-provider-config.js";
import { normalizeWorkerReviewResults } from "./butler-orchestration.js";
import { applyOpencodeGoNativeThinkingPayload } from "./pi-opencode-web-tools-extension.js";
import { piThinkingLevelForModelOption } from "./pi-thinking-levels.js";
import { buildReviewWorkspaceSnapshot, cleanupScopedReviewWorkspace, createScopedReviewWorkspace, resolveReviewWorkspaceCwd } from "./git-review-scope.js";
import { isolatedModelResourceOptions } from "./isolated-model-resources.js";
import type { ButlerStateStore } from "./state-store.js";
import type { ButlerThinkingLevel, CodexThreadRecord, CodexWorkerReportView, WorkerReviewResultRecordView } from "./types.js";
import { workerExecutionEndAt } from "./worker-execution-window.js";
import { workerFileChangeAttribution, workerFileChangePaths } from "./worker-review-attribution.js";

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
};

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
    const args = buildCodexAdversarialReviewArgs({
      schemaPath,
      outputPath,
      modelId: input.selection.model.id,
      thinkingLevel: input.selection.thinkingLevel
    });
    await new Promise<void>((resolve, reject) => {
      const child = spawn("codex", args, {
        cwd: input.cwd,
        env: { ...process.env, CODEX_HOME: input.codexHomeDir, NO_COLOR: "1" },
        stdio: ["pipe", "pipe", "pipe"]
      });
      let stderr = "";
      let stdout = "";
      const timeout = setTimeout(() => {
        child.kill("SIGTERM");
        reject(new Error("adversarial review timed out"));
      }, input.timeoutMs);
      child.stdout.on("data", (chunk: Buffer) => { stdout = `${stdout}${chunk.toString("utf8")}`.slice(-16_000); });
      child.stderr.on("data", (chunk: Buffer) => { stderr = `${stderr}${chunk.toString("utf8")}`.slice(-16_000); });
      child.on("error", (error) => { clearTimeout(timeout); reject(error); });
      child.on("close", (code) => {
        clearTimeout(timeout);
        code === 0 ? resolve() : reject(new Error(`Codex adversarial review exited with ${code}: ${stderr || stdout}`.trim()));
      });
      child.stdin.end(input.prompt);
    });
    return JSON.parse(await fs.readFile(outputPath, "utf8"));
  } finally {
    await Promise.all([schemaPath, outputPath].map((filePath) => fs.rm(filePath, { force: true }).catch(() => {})));
  }
}

async function runPiReview(input: ProviderAdversarialReviewInput): Promise<unknown> {
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
      "Do not modify files. Return valid JSON matching the requested schema and no other prose."
    ].join("\n")
  });
  await resourceLoader.reload();
  const { session } = await createAgentSession({
    cwd: input.cwd,
    authStorage: AuthStorage.create(input.piAuthPath),
    modelRegistry: input.modelRegistry,
    model: input.selection.model,
    thinkingLevel: piThinkingLevelForModelOption(input.selection.thinkingLevel, modelToModelOption(input.selection.model)),
    tools: ["read", "grep", "find", "ls"],
    sessionManager: SessionManager.inMemory(input.cwd),
    settingsManager,
    resourceLoader
  });
  let timeout: ReturnType<typeof setTimeout> | null = null;
  try {
    await Promise.race([
      session.prompt(`${input.prompt}\n\nOutput schema:\n${JSON.stringify(ADVERSARIAL_REVIEW_OUTPUT_SCHEMA)}`),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error("adversarial review timed out")), input.timeoutMs);
      })
    ]);
    const message = [...session.messages].reverse().find((entry) => entry.role === "assistant");
    const text = message && "content" in message ? contentToText(message.content).trim() : "";
    if (!text) throw new Error("adversarial reviewer returned no result");
    return JSON.parse(extractJson(text));
  } catch (error) {
    await session.abort().catch(() => {});
    throw error;
  } finally {
    if (timeout) clearTimeout(timeout);
    session.dispose();
  }
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
    `Worker claims: ${JSON.stringify(input.report.claims ?? null)}`,
    `Worker evidence: ${JSON.stringify(input.report.evidence ?? [])}`,
    "",
    "Workspace change snapshot:",
    clip(input.workspaceSnapshot, 120_000)
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
    const raw = validateAdversarialReviewOutput(await (input.runReview ?? runProviderAdversarialReview)({
      cwd: effectiveReviewCwd,
      codexHomeDir: input.codexHomeDir,
      piAuthPath: input.piAuthPath,
      scratchDir: input.scratchDir,
      modelRegistry: input.modelRegistry,
      selection: { model, thinkingLevel: input.thinkingLevel },
      codexNativeAvailable: input.codexAuthenticated !== false,
      prompt,
      timeoutMs: input.timeoutMs ?? 120_000
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
      ? `Adversarial review could not authenticate ${model.provider}/${model.id}. Open Settings → Providers and reconnect that provider, then retry.`
      : rawMessage.slice(0, 800);
    input.store.addEvent(input.threadId, "adversarial/review/failed", `Adversarial review failed: ${message}`);
    throw new Error(message);
  } finally {
    await cleanupScopedReviewWorkspace(scopedReview?.cwd);
  }
}
