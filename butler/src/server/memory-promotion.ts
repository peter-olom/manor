import { getActiveManorSettings } from "./manor-settings-runtime.js";
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
  private enabled: boolean;
  private timeoutMs: number;
  private maxInputChars: number;
  private batchSize: number;
  private maxBatchesPerRun: number;
  private intervalMs: number;
  private model: string | null;
  private readonly runner: PromotionRunner;
  private timer: NodeJS.Timeout | null = null;
  private inFlight = false;

  constructor(options: {
    store: ButlerStateStore;
    memoryScheduler: MemoryUpdateScheduler;
    stateDir: string;
    config: MemorySynthesisConfig;
    runner?: PromotionRunner;
  }) {
    this.store = options.store;
    this.memoryScheduler = options.memoryScheduler;
    this.enabled = options.config.enabled && options.config.promotionAutoResolve;
    this.timeoutMs = options.config.timeoutMs;
    this.maxInputChars = options.config.maxInputChars;
    this.batchSize = options.config.promotionBatchSize;
    this.maxBatchesPerRun = options.config.promotionMaxBatchesPerRun;
    this.intervalMs = options.config.promotionIntervalMs;
    this.model = resolveMemoryServiceModel(getActiveManorSettings().modelTasks.memoryPromotionModel, options.config.model);
    this.runner = options.runner ?? (async () => {
      throw new Error("Memory promotion model runner is unavailable.");
    });
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

  applyConfig(config: MemorySynthesisConfig, model: string | null): void {
    const wasRunning = Boolean(this.timer);
    this.stop();
    this.enabled = config.enabled && config.promotionAutoResolve;
    this.timeoutMs = config.timeoutMs;
    this.maxInputChars = config.maxInputChars;
    this.batchSize = config.promotionBatchSize;
    this.maxBatchesPerRun = config.promotionMaxBatchesPerRun;
    this.intervalMs = config.promotionIntervalMs;
    this.model = resolveMemoryServiceModel(model, config.model);
    if (wasRunning || this.enabled) this.start();
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

}
