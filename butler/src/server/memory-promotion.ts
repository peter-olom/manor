import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

import { isUnsupportedCodexModelError, memoryCodexModelArgs, normalizeMemoryCodexModel } from "./memory-codex-model.js";
import { resolveMemoryServiceModel } from "./memory-synthesis-config.js";
import type { MemoryUpdateScheduler } from "./memory-update-scheduler.js";
import type { ButlerStateStore } from "./state-store.js";
import type { JobMemoryPromotionCandidateView, MemorySynthesisConfig, ProjectMemoryView } from "./types.js";

type PromotionDecisionConfidence = "high" | "medium" | "low";

type PromotionDecision = {
  candidateId: string;
  accepted: boolean;
  confidence: PromotionDecisionConfidence;
  reason: string;
};

type PromotionReviewOutput = {
  decisions: PromotionDecision[];
  rawOutput?: unknown;
  rawText?: string;
};

type PromotionRunner = (input: { prompt: string; cwd: string; timeoutMs: number }) => Promise<PromotionReviewOutput>;

type PromotionResolutionStats = {
  reviewed: number;
  resolved: number;
  accepted: number;
  rejected: number;
};

export const MEMORY_PROMOTION_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["decisions"],
  properties: {
    decisions: {
      type: "array",
      maxItems: 50,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["candidateId", "accepted", "confidence", "reason"],
        properties: {
          candidateId: { type: "string" },
          accepted: { type: "boolean" },
          confidence: { type: "string", enum: ["high", "medium", "low"] },
          reason: { type: "string", minLength: 1, maxLength: 600 }
        }
      }
    }
  }
};

const PROMOTION_REVIEW_PROMPT = [
  "You are Manor's memory promotion resolver.",
  "Review each pending memory candidate and decide whether it should become accepted project memory.",
  "Return one decision for every candidateId in the payload.",
  "Accept durable project facts, repo decisions, deployment/runtime gotchas, accepted PR or merge facts, reusable constraints, and facts that future work should recall.",
  "Reject routine progress, one-off job instructions, temporary to-dos, completion checklist noise, secrets, sensitive credentials, and facts already covered by existing accepted project memory.",
  "When uncertain, reject the candidate. Do not preserve secrets. Do not ask the operator."
].join("\n");

function clean(value: string | null | undefined, limit = 2_000): string | null {
  const normalized = (value ?? "").replace(/\s+/g, " ").trim();
  return normalized ? normalized.slice(0, limit) : null;
}

function normalizeDecision(value: unknown): PromotionDecision | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Partial<PromotionDecision>;
  const candidateId = clean(candidate.candidateId, 200);
  const reason = clean(candidate.reason, 600);
  if (!candidateId || !reason || typeof candidate.accepted !== "boolean") return null;
  if (candidate.confidence !== "high" && candidate.confidence !== "medium" && candidate.confidence !== "low") return null;
  return { candidateId, accepted: candidate.accepted, confidence: candidate.confidence, reason };
}

function parsePromotionOutput(text: string): PromotionReviewOutput {
  const parsed = JSON.parse(text) as Partial<PromotionReviewOutput>;
  return {
    decisions: (Array.isArray(parsed.decisions) ? parsed.decisions : []).map(normalizeDecision).filter((entry): entry is PromotionDecision => Boolean(entry)),
    rawOutput: parsed,
    rawText: text
  };
}

function projectMemoryBrief(memory: ProjectMemoryView | null): Record<string, unknown> | null {
  if (!memory) return null;
  return {
    projectId: memory.projectId,
    summary: memory.summary,
    recentEntries: memory.entries.slice(-20).map((entry) => ({
      kind: entry.kind,
      summary: entry.summary,
      details: clean(entry.details, 800)
    }))
  };
}

export class CodexExecMemoryPromotionService {
  private readonly store: ButlerStateStore;
  private readonly memoryScheduler: MemoryUpdateScheduler;
  private readonly stateDir: string;
  private readonly codexHomeDir: string;
  private readonly enabled: boolean;
  private readonly timeoutMs: number;
  private readonly maxInputChars: number;
  private readonly batchSize: number;
  private readonly maxBatchesPerRun: number;
  private readonly intervalMs: number;
  private readonly model: string | null;
  private readonly runner: PromotionRunner;
  private timer: NodeJS.Timeout | null = null;
  private inFlight = false;

  constructor(options: {
    store: ButlerStateStore;
    memoryScheduler: MemoryUpdateScheduler;
    stateDir: string;
    codexHomeDir: string;
    config: MemorySynthesisConfig;
    runner?: PromotionRunner;
  }) {
    this.store = options.store;
    this.memoryScheduler = options.memoryScheduler;
    this.stateDir = options.stateDir;
    this.codexHomeDir = options.codexHomeDir;
    this.enabled = options.config.enabled && options.config.promotionAutoResolve;
    this.timeoutMs = options.config.timeoutMs;
    this.maxInputChars = options.config.maxInputChars;
    this.batchSize = options.config.promotionBatchSize;
    this.maxBatchesPerRun = options.config.promotionMaxBatchesPerRun;
    this.intervalMs = options.config.promotionIntervalMs;
    this.model = resolveMemoryServiceModel(process.env.MANOR_MEMORY_PROMOTION_MODEL, options.config.model);
    this.runner = options.runner ?? ((input) => this.runCodexExec(input));
  }

  start(): void {
    if (!this.enabled || this.timer) return;
    this.timer = setInterval(() => this.resolvePendingCandidatesAsync(), this.intervalMs);
    this.resolvePendingCandidatesAsync();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  resolvePendingCandidatesAsync(): void {
    if (!this.enabled || this.inFlight) return;
    this.inFlight = true;
    void this.drainPendingCandidates()
      .catch((error) => this.recordBatchError(this.store.listPendingPromotionCandidates().slice(0, this.batchSize), error instanceof Error ? error.message : String(error)))
      .finally(() => {
        this.inFlight = false;
      });
  }

  async drainPendingCandidates(): Promise<PromotionResolutionStats> {
    const total: PromotionResolutionStats = { reviewed: 0, resolved: 0, accepted: 0, rejected: 0 };
    for (let batch = 0; batch < this.maxBatchesPerRun; batch += 1) {
      const result = await this.resolvePendingCandidateBatch(this.batchSize);
      total.reviewed += result.reviewed;
      total.resolved += result.resolved;
      total.accepted += result.accepted;
      total.rejected += result.rejected;
      if (result.reviewed === 0 || result.resolved === 0 || this.store.listPendingPromotionCandidates().length === 0) break;
    }
    return total;
  }

  async resolvePendingCandidateBatch(limit = this.batchSize): Promise<PromotionResolutionStats> {
    const candidates = this.store
      .listPendingPromotionCandidates()
      .sort((left, right) => left.createdAt - right.createdAt)
      .slice(0, Math.max(1, Math.min(50, Math.trunc(limit))));
    const stats: PromotionResolutionStats = { reviewed: candidates.length, resolved: 0, accepted: 0, rejected: 0 };
    if (candidates.length === 0) return stats;
    const prompt = this.buildPromotionPrompt(candidates);
    const output = await this.runner({ prompt, cwd: "/repos", timeoutMs: this.timeoutMs });
    const candidatesById = new Map(candidates.map((candidate) => [candidate.id, candidate]));
    const seenDecisionIds = new Set<string>();

    for (const decision of output.decisions) {
      if (seenDecisionIds.has(decision.candidateId)) continue;
      seenDecisionIds.add(decision.candidateId);
      const candidate = candidatesById.get(decision.candidateId);
      if (!candidate) continue;
      const resolved = this.store.resolvePromotionCandidate(candidate.id, decision.accepted);
      if (!resolved) continue;
      this.memoryScheduler.observePromotionResolved({
        candidateId: resolved.id,
        accepted: decision.accepted,
        projectId: resolved.projectId,
        projectLabel: resolved.projectLabel,
        threadId: resolved.threadId,
        summary: resolved.summary,
        details: [resolved.details, `Auto promotion confidence: ${decision.confidence}.`, `Auto promotion reason: ${decision.reason}`].filter(Boolean).join("\n") || null
      });
      this.store.addEvent(resolved.threadId, decision.accepted ? "memory/promotion/accepted" : "memory/promotion/rejected", `Memory promotion auto-${decision.accepted ? "accepted" : "rejected"}: ${resolved.summary}`);
      stats.resolved += 1;
      if (decision.accepted) stats.accepted += 1;
      else stats.rejected += 1;
    }

    return stats;
  }

  private buildPromotionPrompt(candidates: JobMemoryPromotionCandidateView[]): string {
    const projectIds = [...new Set(candidates.map((candidate) => candidate.projectId))];
    const payload = {
      candidates: candidates.map((candidate) => ({
        candidateId: candidate.id,
        projectId: candidate.projectId,
        projectLabel: candidate.projectLabel,
        threadId: candidate.threadId,
        kind: candidate.kind,
        summary: candidate.summary,
        details: clean(candidate.details, 1_200),
        sourceEntryId: candidate.sourceEntryId,
        createdAt: candidate.createdAt
      })),
      existingProjectMemory: projectIds.map((projectId) => projectMemoryBrief(this.store.getProjectMemory(projectId))).filter(Boolean)
    };
    return [PROMOTION_REVIEW_PROMPT, "Payload:", JSON.stringify(payload, null, 2).slice(0, this.maxInputChars)].join("\n");
  }

  private recordBatchError(candidates: JobMemoryPromotionCandidateView[], message: string): void {
    const threadIds = [...new Set(candidates.map((candidate) => candidate.threadId))].slice(0, 5);
    for (const threadId of threadIds) this.store.addEvent(threadId, "memory/promotion/failed", `Memory promotion auto-resolution failed: ${message}`);
  }

  private async runCodexExec(input: { prompt: string; cwd: string; timeoutMs: number }): Promise<PromotionReviewOutput> {
    const scratchDir = path.join(this.stateDir, "memory-promotion");
    await fs.mkdir(scratchDir, { recursive: true });
    const runId = crypto.randomUUID();
    const schemaPath = path.join(scratchDir, `${runId}.schema.json`);
    const outputPath = path.join(scratchDir, `${runId}.output.json`);
    await fs.writeFile(schemaPath, JSON.stringify(MEMORY_PROMOTION_OUTPUT_SCHEMA, null, 2), "utf8");
    const baseArgs = ["exec", "--ephemeral", "--sandbox", "read-only", "--skip-git-repo-check", "--ignore-rules", "--output-schema", schemaPath, "--output-last-message", outputPath, "--cd", input.cwd || "/repos"];
    const run = async (model: string | null): Promise<void> => {
      const args = [...baseArgs, ...memoryCodexModelArgs(model), "-"];
      await new Promise<void>((resolve, reject) => {
        const child = spawn("codex", args, { env: { ...process.env, CODEX_HOME: this.codexHomeDir, NO_COLOR: "1" }, stdio: ["pipe", "pipe", "pipe"] });
        let stderr = "";
        const timeout = setTimeout(() => {
          child.kill("SIGTERM");
          reject(new Error("codex exec memory promotion timed out"));
        }, input.timeoutMs);
        child.stderr.on("data", (chunk: Buffer) => { stderr = `${stderr}${chunk.toString("utf8")}`.slice(-8_000); });
        child.on("error", (error) => { clearTimeout(timeout); reject(error); });
        child.on("close", (code) => {
          clearTimeout(timeout);
          code === 0 ? resolve() : reject(new Error(`codex exec exited with ${code}: ${stderr}`.trim()));
        });
        child.stdin.end(input.prompt);
      });
    };
    try {
      if (this.model) {
        try {
          await run(this.model);
        } catch (error) {
          if (!isUnsupportedCodexModelError(error)) throw error;
          await fs.rm(outputPath, { force: true }).catch(() => {});
          await run(null);
        }
      } else {
        await run(null);
      }
      const text = await fs.readFile(outputPath, "utf8");
      return parsePromotionOutput(text);
    } finally {
      await Promise.all([fs.rm(schemaPath, { force: true }).catch(() => {}), fs.rm(outputPath, { force: true }).catch(() => {})]);
    }
  }
}
