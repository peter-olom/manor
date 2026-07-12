import { spawn } from "node:child_process";
import crypto from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

import { collectEmbeddableMemories, type EmbeddableMemory } from "./memory-embedding-backfill.js";
import { cosineSimilarity, decodeFloat32Vector, hashEmbeddingText } from "./memory-embedding-client.js";
import { ensureMemoryGraphNode } from "./memory-graph-nodes.js";
import { isUnsupportedCodexModelError, memoryCodexModelArgs } from "./memory-codex-model.js";
import { recordMemoryDebugTrace, type MemoryDebugTraceDecision } from "./memory-debug-traces.js";
import type { ButlerStateStore } from "./state-store.js";
import type { MemoryEmbeddingView, MemorySynthesisConfig } from "./types.js";

type SemanticPredicate = "supports" | "contradicts" | "supersedes" | "none";
type SemanticSide = "left" | "right";

export type MemorySemanticEdgeReviewPair = {
  pairId: string;
  projectId: string;
  left: EmbeddableMemory;
  right: EmbeddableMemory;
  hints: string[];
};

type SemanticEdgeDecision = {
  pairId: string;
  predicate: SemanticPredicate;
  sourceSide: SemanticSide;
  confidence: number;
  reason: string;
  provenance?: "model" | "structural_fallback";
};

type SemanticEdgeReviewOutput = {
  decisions: SemanticEdgeDecision[];
  rawOutput?: unknown;
  rawText?: string;
  validationIssues?: string[];
};

type SemanticEdgeReviewRunner = (input: { prompt: string; cwd: string; timeoutMs: number; config: MemorySynthesisConfig }) => Promise<unknown>;

class SemanticEdgeReviewOutputError extends Error {
  readonly issues: string[];

  constructor(issues: string[]) {
    super(`Invalid semantic edge review output: ${issues.join("; ")}`);
    this.name = "SemanticEdgeReviewOutputError";
    this.issues = issues;
  }
}

export const SEMANTIC_EDGE_REVIEW_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["decisions"],
  properties: {
    decisions: {
      type: "array",
      maxItems: 100,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["pairId", "predicate", "sourceSide", "confidence", "reason"],
        properties: {
          pairId: { type: "string" },
          predicate: { type: "string", enum: ["supports", "contradicts", "supersedes", "none"] },
          sourceSide: { type: "string", enum: ["left", "right"] },
          confidence: { type: "number", minimum: 0, maximum: 1 },
          reason: { type: "string", minLength: 1, maxLength: 600 }
        }
      }
    }
  }
};

function hash(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex").slice(0, 16);
}

function clean(value: string | null | undefined, limit = 1_500): string {
  return (value ?? "").replace(/\s+/g, " ").trim().slice(0, limit);
}

function valueKind(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return `array(length=${value.length})`;
  return typeof value;
}

function normalizeDecision(value: unknown, index: number, issues: string[]): SemanticEdgeDecision | null {
  const path = `output.decisions[${index}]`;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    issues.push(`${path} must be an object; received ${valueKind(value)}`);
    return null;
  }
  const decision = value as Record<string, unknown>;
  const pairId = typeof decision.pairId === "string" ? clean(decision.pairId, 200) : "";
  const reason = typeof decision.reason === "string"
    ? clean(decision.reason, 600)
    : typeof decision.rationale === "string"
      ? clean(decision.rationale, 600)
      : "";
  if (!pairId) issues.push(`${path}.pairId must be a non-empty string; received ${valueKind(decision.pairId)}`);
  if (!reason) issues.push(`${path}.reason must be a non-empty string; received ${valueKind(decision.reason)}`);
  else if (typeof decision.reason !== "string") issues.push(`${path}.reason was missing; used ${path}.rationale`);
  if (decision.predicate !== "supports" && decision.predicate !== "contradicts" && decision.predicate !== "supersedes" && decision.predicate !== "none") {
    issues.push(`${path}.predicate must be supports, contradicts, supersedes, or none; received ${valueKind(decision.predicate)}`);
  }
  if (decision.sourceSide !== "left" && decision.sourceSide !== "right") {
    issues.push(`${path}.sourceSide must be left or right; received ${valueKind(decision.sourceSide)}`);
  }
  if (typeof decision.confidence !== "number" || !Number.isFinite(decision.confidence) || decision.confidence < 0 || decision.confidence > 1) {
    issues.push(`${path}.confidence must be a finite number from 0 to 1; received ${valueKind(decision.confidence)}`);
  }
  if (!pairId || !reason) return null;
  if (decision.predicate !== "supports" && decision.predicate !== "contradicts" && decision.predicate !== "supersedes" && decision.predicate !== "none") return null;
  if (decision.sourceSide !== "left" && decision.sourceSide !== "right") return null;
  if (typeof decision.confidence !== "number" || !Number.isFinite(decision.confidence) || decision.confidence < 0 || decision.confidence > 1) return null;
  return { pairId, predicate: decision.predicate, sourceSide: decision.sourceSide, confidence: decision.confidence, reason };
}

function normalizeOutput(value: unknown): SemanticEdgeReviewOutput {
  if (!value || typeof value !== "object") {
    throw new SemanticEdgeReviewOutputError([`output must be an object; received ${valueKind(value)}`]);
  }
  const topLevelArray = Array.isArray(value);
  const output = topLevelArray ? { decisions: value } : value as Record<string, unknown>;
  if (!Array.isArray(output.decisions)) {
    const keys = Object.keys(output).sort().slice(0, 12);
    throw new SemanticEdgeReviewOutputError([
      `output.decisions must be an array; received ${valueKind(output.decisions)}${keys.length > 0 ? ` (output keys: ${keys.join(", ")})` : ""}`
    ]);
  }
  if (output.decisions.length > 100) {
    throw new SemanticEdgeReviewOutputError([`output.decisions must contain at most 100 items; received ${output.decisions.length}`]);
  }
  const issues: string[] = topLevelArray ? ["output was an array; treated it as output.decisions"] : [];
  const decisions = output.decisions
    .map((entry, index) => normalizeDecision(entry, index, issues))
    .filter((entry): entry is SemanticEdgeDecision => Boolean(entry));
  return {
    decisions,
    rawOutput: !topLevelArray && Object.prototype.hasOwnProperty.call(output, "rawOutput") ? output.rawOutput : value,
    rawText: typeof output.rawText === "string" ? output.rawText : undefined,
    validationIssues: issues.slice(0, 12)
  };
}

function sourceKey(memory: Pick<EmbeddableMemory, "sourceKind" | "sourceId">): string {
  return `${memory.sourceKind}:${memory.sourceId}`;
}

function pairId(left: EmbeddableMemory, right: EmbeddableMemory): string {
  return hash([
    sourceKey(left),
    sourceKey(right),
    left.contentVersion,
    right.contentVersion,
    hashEmbeddingText(left.text),
    hashEmbeddingText(right.text)
  ].join("\n"));
}

function reviewKey(pair: Pick<MemorySemanticEdgeReviewPair, "pairId">): string {
  return `semantic-edge-review:${pair.pairId}`;
}

function tokenize(value: string): Set<string> {
  return new Set((value.toLowerCase().match(/[a-z0-9_:-]+/g) ?? []).filter((entry) => entry.length > 2));
}

function relatedByTokens(left: string, right: string): boolean {
  const leftTokens = tokenize(left);
  const rightTokens = tokenize(right);
  if (leftTokens.size === 0 || rightTokens.size === 0) return true;
  let overlap = 0;
  for (const token of leftTokens) if (rightTokens.has(token)) overlap += 1;
  return overlap / Math.min(leftTokens.size, rightTokens.size) >= 0.18;
}

function embeddingKey(entry: Pick<MemoryEmbeddingView, "sourceKind" | "sourceId">): string {
  return `${entry.sourceKind}:${entry.sourceId}`;
}

function latestEmbeddingsByMemory(store: ButlerStateStore): Map<string, MemoryEmbeddingView> {
  const entries = new Map<string, MemoryEmbeddingView>();
  for (const embedding of store.listMemoryEmbeddings()) {
    const key = embeddingKey(embedding);
    const existing = entries.get(key);
    if (!existing || embedding.embeddedAt > existing.embeddedAt) entries.set(key, embedding);
  }
  return entries;
}

function addPair(
  pairs: Map<string, MemorySemanticEdgeReviewPair>,
  reviewed: Set<string>,
  left: EmbeddableMemory | undefined,
  right: EmbeddableMemory | undefined,
  hints: string[]
): void {
  if (!left || !right || sourceKey(left) === sourceKey(right)) return;
  const projectId = left.projectId ?? right.projectId ?? "global";
  if ((left.projectId ?? projectId) !== (right.projectId ?? projectId)) return;
  const next: MemorySemanticEdgeReviewPair = { pairId: pairId(left, right), projectId, left, right, hints };
  if (reviewed.has(reviewKey(next))) return;
  const existing = pairs.get(next.pairId);
  pairs.set(next.pairId, existing ? { ...existing, hints: [...new Set([...existing.hints, ...hints])] } : next);
}

export function collectSemanticEdgeReviewPairs(store: ButlerStateStore, limit = 24): MemorySemanticEdgeReviewPair[] {
  const graph = store.listMemoryGraph();
  const reviewed = new Set(graph.observations.map((entry) => entry.idempotencyKey));
  const memories = collectEmbeddableMemories(store);
  const bySource = new Map(memories.map((entry) => [sourceKey(entry), entry]));
  const pairs = new Map<string, MemorySemanticEdgeReviewPair>();

  for (const project of store.listProjectMemories()) {
    const projectMemory = bySource.get(`project_memory:${project.projectId}`);
    for (const entry of project.entries) {
      const jobMemory = bySource.get(`job_memory:${entry.sourceThreadId}`);
      addPair(pairs, reviewed, jobMemory, projectMemory, ["job_entry_supports_project_memory"]);
      const job = store.getJobMemory(entry.sourceThreadId);
      for (const candidate of job?.promotionCandidates ?? []) {
        if (candidate.projectId !== project.projectId || candidate.status === "accepted") continue;
        const candidateMemory = bySource.get(`promotion_candidate:${candidate.id}`);
        if (!relatedByTokens(`${entry.summary} ${entry.details ?? ""}`, `${candidate.summary} ${candidate.details ?? ""}`)) continue;
        addPair(pairs, reviewed, projectMemory, candidateMemory, ["accepted_project_memory_may_resolve_candidate"]);
      }
    }
  }

  const embeddings = latestEmbeddingsByMemory(store);
  const vectorCandidates = memories
    .map((memory) => ({ memory, embedding: embeddings.get(sourceKey(memory)) ?? null }))
    .filter((entry): entry is { memory: EmbeddableMemory; embedding: MemoryEmbeddingView } => Boolean(entry.embedding));
  const vectorPairs: Array<{ left: EmbeddableMemory; right: EmbeddableMemory; score: number }> = [];
  for (let leftIndex = 0; leftIndex < vectorCandidates.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < vectorCandidates.length; rightIndex += 1) {
      const left = vectorCandidates[leftIndex];
      const right = vectorCandidates[rightIndex];
      if ((left.memory.projectId ?? "global") !== (right.memory.projectId ?? "global")) continue;
      const score = cosineSimilarity(
        decodeFloat32Vector(left.embedding.vectorBase64, left.embedding.dimension),
        decodeFloat32Vector(right.embedding.vectorBase64, right.embedding.dimension)
      );
      if (score >= 0.62) vectorPairs.push({ left: left.memory, right: right.memory, score });
    }
  }
  vectorPairs
    .sort((left, right) => right.score - left.score)
    .slice(0, Math.max(limit, limit * 3))
    .forEach((entry) => addPair(pairs, reviewed, entry.left, entry.right, [`vector_neighbor:${entry.score.toFixed(3)}`]));

  return [...pairs.values()].slice(0, Math.max(1, limit));
}

function parseOutput(text: string): SemanticEdgeReviewOutput {
  const output = normalizeOutput(JSON.parse(text));
  return { ...output, rawText: text };
}

function directedDecisionMemories(pair: MemorySemanticEdgeReviewPair, decision: SemanticEdgeDecision): { source: EmbeddableMemory; target: EmbeddableMemory } {
  if ((decision.predicate === "supersedes" || decision.predicate === "contradicts") && pair.left.sourceKind === "project_memory" && pair.right.sourceKind === "promotion_candidate") {
    return { source: pair.left, target: pair.right };
  }
  if ((decision.predicate === "supersedes" || decision.predicate === "contradicts") && pair.right.sourceKind === "project_memory" && pair.left.sourceKind === "promotion_candidate") {
    return { source: pair.right, target: pair.left };
  }
  if (decision.predicate === "supports" && pair.left.sourceKind === "job_memory" && pair.right.sourceKind === "project_memory") {
    return { source: pair.left, target: pair.right };
  }
  if (decision.predicate === "supports" && pair.right.sourceKind === "job_memory" && pair.left.sourceKind === "project_memory") {
    return { source: pair.right, target: pair.left };
  }
  const source = decision.sourceSide === "right" ? pair.right : pair.left;
  const target = decision.sourceSide === "right" ? pair.left : pair.right;
  return { source, target };
}

function fallbackDecisions(pair: MemorySemanticEdgeReviewPair): SemanticEdgeDecision[] {
  const decisions: SemanticEdgeDecision[] = [];
  if (pair.hints.includes("job_entry_supports_project_memory")) {
    decisions.push({
      pairId: pair.pairId,
      predicate: "supports",
      sourceSide: pair.left.sourceKind === "job_memory" ? "left" : "right",
      confidence: 0.68,
      reason: "Structural fallback: job memory is the source thread for accepted project memory, and the model omitted this pair.",
      provenance: "structural_fallback"
    });
  }
  if (pair.hints.includes("accepted_project_memory_may_resolve_candidate")) {
    const projectSide: SemanticSide = pair.left.sourceKind === "project_memory" ? "left" : "right";
    decisions.push({
      pairId: pair.pairId,
      predicate: "supersedes",
      sourceSide: projectSide,
      confidence: 0.72,
      reason: "Structural fallback: accepted project memory is canonical over an unresolved promotion candidate, and the model omitted this pair.",
      provenance: "structural_fallback"
    });
    const combined = `${pair.left.text}\n${pair.right.text}`.toLowerCase();
    if (/\b(contradict|conflict|outdated|stale|older|supersede|supersedes|superseded)\b/.test(combined)) {
      decisions.push({
        pairId: pair.pairId,
        predicate: "contradicts",
        sourceSide: projectSide,
        confidence: 0.66,
        reason: "Structural fallback: the memory text explicitly marks the candidate as stale, contradicted, or superseded.",
        provenance: "structural_fallback"
      });
    }
  }
  return decisions.length > 0 ? decisions : [{ pairId: pair.pairId, predicate: "none", sourceSide: "left", confidence: 0, reason: "No relationship returned.", provenance: "structural_fallback" }];
}

export class MemorySemanticEdgeReviewService {
  private readonly store: ButlerStateStore;
  private config: MemorySynthesisConfig;
  private readonly stateDir: string;
  private readonly codexHomeDir: string;
  private readonly runner: SemanticEdgeReviewRunner;
  private readonly onResult?: (result: { reviewed: number; relationships: number }, reason: string) => void;
  private readonly onError?: (error: unknown, reason: string) => void;
  private timer: NodeJS.Timeout | null = null;
  private inFlight = false;

  constructor(options: {
    store: ButlerStateStore;
    config: MemorySynthesisConfig;
    stateDir: string;
    codexHomeDir: string;
    runner?: SemanticEdgeReviewRunner;
    onResult?: (result: { reviewed: number; relationships: number }, reason: string) => void;
    onError?: (error: unknown, reason: string) => void;
  }) {
    this.store = options.store;
    this.config = options.config;
    this.stateDir = options.stateDir;
    this.codexHomeDir = options.codexHomeDir;
    this.runner = options.runner ?? ((input) => this.runCodexExec(input));
    this.onResult = options.onResult;
    this.onError = options.onError;
  }

  start(): void {
    if (this.timer || !this.config.enabled || !this.config.semanticEdgeReviewEnabled) return;
    this.timer = setInterval(() => void this.reviewNextBatch("interval"), this.config.semanticEdgeReviewIntervalMs);
    void this.reviewNextBatch("startup");
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  applyConfig(config: MemorySynthesisConfig): void {
    const wasRunning = Boolean(this.timer);
    this.stop();
    this.config = config;
    if (wasRunning || (config.enabled && config.semanticEdgeReviewEnabled)) this.start();
  }

  async reviewNextBatch(reason = "manual"): Promise<{ reviewed: number; relationships: number }> {
    if (this.inFlight || !this.config.enabled || !this.config.semanticEdgeReviewEnabled) return { reviewed: 0, relationships: 0 };
    this.inFlight = true;
    const startedAt = Date.now();
    let pairs: MemorySemanticEdgeReviewPair[] = [];
    let prompt: string | null = null;
    let rawOutput: unknown = null;
    try {
      pairs = collectSemanticEdgeReviewPairs(this.store, this.config.semanticEdgeReviewBatchSize);
      if (pairs.length === 0) return { reviewed: 0, relationships: 0 };
      prompt = this.buildPrompt(pairs);
      rawOutput = await this.runner({ prompt, cwd: process.cwd(), timeoutMs: this.config.timeoutMs, config: this.config });
      const output = normalizeOutput(rawOutput);
      const applied = this.applyOutput(pairs, output);
      const completedAt = Date.now();
      recordMemoryDebugTrace(this.store, {
        kind: "synthesis",
        status: "completed",
        projectId: pairs[0]?.projectId ?? "global",
        projectLabel: pairs[0]?.projectId ?? "global",
        threadId: null,
        sourceId: `semantic-edge-review:${startedAt}`,
        reason: `semantic edge review ${reason}`,
        promptVersion: "memory-semantic-edge-review-v1",
        model: this.config.model,
        createdAt: startedAt,
        completedAt,
        durationMs: completedAt - startedAt,
        prompt,
        input: { pairs: pairs.map((pair) => pair.pairId), config: this.config },
        rawOutput: output.rawOutput ?? output.rawText ?? rawOutput,
        normalizedOutput: output,
        decisions: applied.decisions,
        persisted: { observationIds: applied.observationIds, candidateIds: [], entityIds: [], relationshipIds: applied.relationshipIds, jobEntryIds: [] },
        error: null,
        warnings: output.validationIssues ?? []
      });
      const result = { reviewed: pairs.length, relationships: applied.relationshipIds.length };
      this.onResult?.(result, reason);
      return result;
    } catch (error) {
      const completedAt = Date.now();
      if (pairs.length > 0 && prompt) {
        recordMemoryDebugTrace(this.store, {
          kind: "synthesis",
          status: "failed",
          projectId: pairs[0]?.projectId ?? "global",
          projectLabel: pairs[0]?.projectId ?? "global",
          threadId: null,
          sourceId: `semantic-edge-review:${startedAt}`,
          reason: `semantic edge review ${reason}`,
          promptVersion: "memory-semantic-edge-review-v1",
          model: this.config.model,
          createdAt: startedAt,
          completedAt,
          durationMs: completedAt - startedAt,
          prompt,
          input: { pairs: pairs.map((pair) => pair.pairId), config: this.config },
          rawOutput: rawOutput ?? null,
          normalizedOutput: null,
          decisions: [],
          persisted: { observationIds: [], candidateIds: [], entityIds: [], relationshipIds: [], jobEntryIds: [] },
          error: error instanceof Error ? error.message : String(error),
          warnings: error instanceof SemanticEdgeReviewOutputError ? error.issues : []
        });
      }
      this.onError?.(error, reason);
      return { reviewed: 0, relationships: 0 };
    } finally {
      this.inFlight = false;
    }
  }

  private buildPrompt(pairs: MemorySemanticEdgeReviewPair[]): string {
    const payload = {
      pairs: pairs.map((pair) => ({
        pairId: pair.pairId,
        hints: pair.hints,
        left: this.memoryPayload(pair.left),
        right: this.memoryPayload(pair.right)
      }))
    };
    return [
      "You are Manor's semantic memory edge classifier.",
      "Classify only durable semantic relationships between the two memory nodes in each pair.",
      "Use supports when one memory is evidence for, explains, or materially led to the other.",
      "Use supersedes when the source is the newer/current/canonical memory and should outrank the target.",
      "Use contradicts when the source conflicts with the target. Prefer accepted/current project memory as the source when present.",
      "Use none when the memories are merely topically similar, weakly related, or too ambiguous.",
      "Return one or more decisions per pair only when justified. Return predicate=none for reviewed pairs with no durable edge.",
      "Payload:",
      JSON.stringify(payload, null, 2).slice(0, this.config.maxInputChars)
    ].join("\n");
  }

  private memoryPayload(memory: EmbeddableMemory): Record<string, unknown> {
    return {
      sourceKind: memory.sourceKind,
      sourceId: memory.sourceId,
      memoryType: memory.memoryType,
      projectId: memory.projectId,
      threadId: memory.threadId,
      provenance: memory.provenance,
      text: clean(memory.text, 2_500)
    };
  }

  private applyOutput(pairs: MemorySemanticEdgeReviewPair[], output: SemanticEdgeReviewOutput): { decisions: MemoryDebugTraceDecision[]; observationIds: string[]; relationshipIds: string[] } {
    const pairsById = new Map(pairs.map((pair) => [pair.pairId, pair]));
    const decisions: MemoryDebugTraceDecision[] = [];
    const observationIds: string[] = [];
    const relationshipIds: string[] = [];
    const decisionsByPair = new Map<string, SemanticEdgeDecision[]>();
    for (const decision of output.decisions) decisionsByPair.set(decision.pairId, [...(decisionsByPair.get(decision.pairId) ?? []), decision]);

    for (const pair of pairs) {
      const modelDecisions = decisionsByPair.get(pair.pairId);
      const fallback = fallbackDecisions(pair);
      const fallbackEdges = fallback.filter((decision) => decision.predicate !== "none");
      const pairDecisions = modelDecisions
        ? modelDecisions.every((decision) => decision.predicate === "none" || decision.confidence < 0.55) && fallbackEdges.length > 0
          ? [...modelDecisions, ...fallbackEdges]
          : modelDecisions
        : fallback;
      const observation = this.store.recordMemoryObservation({
        idempotencyKey: reviewKey(pair),
        projectId: pair.projectId,
        threadId: pair.left.threadId ?? pair.right.threadId,
        sourceKind: "synthesis_result",
        sourceId: pair.pairId,
        summary: `Semantic edge review for ${sourceKey(pair.left)} and ${sourceKey(pair.right)}.`,
        details: pairDecisions.map((decision) => `${decision.predicate}: ${decision.reason}`).join("\n"),
        payload: { kind: "semantic_edge_review", pairId: pair.pairId, hints: pair.hints, decisions: pairDecisions },
        durable: true
      });
      observationIds.push(observation.id);
      for (const decision of pairDecisions) {
        const saved = this.applyDecision(pairsById, decision);
        decisions.push(saved.decision);
        if (saved.relationshipId) relationshipIds.push(saved.relationshipId);
      }
    }
    return { decisions, observationIds, relationshipIds };
  }

  private applyDecision(pairsById: Map<string, MemorySemanticEdgeReviewPair>, decision: SemanticEdgeDecision): { decision: MemoryDebugTraceDecision; relationshipId: string | null } {
    const pair = pairsById.get(decision.pairId);
    if (!pair) return { relationshipId: null, decision: { stage: "semantic_edge", outcome: "dropped", summary: decision.predicate, reason: "unknown_pair" } };
    if (decision.predicate === "none" || decision.confidence < 0.55) {
      return { relationshipId: null, decision: { stage: "semantic_edge", outcome: "skipped", summary: decision.predicate, reason: decision.reason } };
    }
    const { source, target } = directedDecisionMemories(pair, decision);
    const sourceEntityId = ensureMemoryGraphNode(this.store, { sourceKind: source.sourceKind, sourceId: source.sourceId, text: source.text, memoryType: source.memoryType, projectId: source.projectId, threadId: source.threadId });
    const targetEntityId = ensureMemoryGraphNode(this.store, { sourceKind: target.sourceKind, sourceId: target.sourceId, text: target.text, memoryType: target.memoryType, projectId: target.projectId, threadId: target.threadId });
    const relationship = this.store.upsertMemoryRelationship({
      projectId: pair.projectId,
      sourceEntityId,
      predicate: decision.predicate,
      targetEntityId,
      sourceObservationId: `${decision.provenance === "structural_fallback" ? "fallback" : "model"}:semantic-edge:${pair.pairId}:${decision.predicate}:${decision.sourceSide}`,
      confidence: decision.confidence
    });
    return {
      relationshipId: relationship.id,
      decision: { stage: "semantic_edge", outcome: "saved", summary: decision.predicate, reason: decision.reason, persistedId: relationship.id }
    };
  }

  private async runCodexExec(input: { prompt: string; cwd: string; timeoutMs: number; config: MemorySynthesisConfig }): Promise<SemanticEdgeReviewOutput> {
    const scratchDir = path.join(this.stateDir, "memory-semantic-edges");
    await fs.mkdir(scratchDir, { recursive: true });
    const runId = crypto.randomUUID();
    const schemaPath = path.join(scratchDir, `${runId}.schema.json`);
    const outputPath = path.join(scratchDir, `${runId}.output.json`);
    await fs.writeFile(schemaPath, JSON.stringify(SEMANTIC_EDGE_REVIEW_OUTPUT_SCHEMA, null, 2), "utf8");
    const effortArgs = input.config.effort ? ["--reasoning-effort", input.config.effort] : [];
    const baseArgs = ["exec", "--ephemeral", "--sandbox", "read-only", "--skip-git-repo-check", "--ignore-rules", "--output-schema", schemaPath, "--output-last-message", outputPath, "--cd", input.cwd || "/repos", ...effortArgs];
    const run = async (model: string | null): Promise<void> => {
      const args = [...baseArgs, ...memoryCodexModelArgs(model), "-"];
      await new Promise<void>((resolve, reject) => {
        const child = spawn("codex", args, { env: { ...process.env, CODEX_HOME: this.codexHomeDir, NO_COLOR: "1" }, stdio: ["pipe", "pipe", "pipe"] });
        let stderr = "";
        const timeout = setTimeout(() => { child.kill("SIGTERM"); reject(new Error("codex exec semantic edge review timed out")); }, input.timeoutMs);
        child.stderr.on("data", (chunk: Buffer) => { stderr = `${stderr}${chunk.toString("utf8")}`.slice(-8_000); });
        child.on("error", (error) => { clearTimeout(timeout); reject(error); });
        child.on("close", (code) => { clearTimeout(timeout); code === 0 ? resolve() : reject(new Error(`codex exec exited with ${code}: ${stderr}`.trim())); });
        child.stdin.end(input.prompt);
      });
    };
    try {
      if (input.config.model) {
        try {
          await run(input.config.model);
        } catch (error) {
          if (!isUnsupportedCodexModelError(error)) throw error;
          await fs.rm(outputPath, { force: true }).catch(() => {});
          await run(null);
        }
      } else {
        await run(null);
      }
      return parseOutput(await fs.readFile(outputPath, "utf8"));
    } finally {
      await Promise.all([schemaPath, outputPath].map((filePath) => fs.rm(filePath, { force: true }).catch(() => {})));
    }
  }
}
