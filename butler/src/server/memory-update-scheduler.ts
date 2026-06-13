import { spawn } from "node:child_process";
import crypto from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

import type { ButlerStateStore } from "./state-store.js";
import type {
  ButlerMessageView,
  CodexThreadExecutionContractView,
  CodexThreadRecord,
  CodexWorkerReportView,
  JobMemoryEntryKind,
  MemoryObservationSourceKind,
  MemoryObservationView,
  MemorySynthesisConfig,
  MemorySynthesisQueueEntryView,
  MemorySynthesisPriority,
  MemoryTaskStatus,
  RuntimeCleanupTaskView
} from "./types.js";

type SemanticReview = "none" | "normal" | "high";

type RecordMemoryEventInput = {
  idempotencyKey: string;
  projectId?: string | null;
  projectLabel?: string | null;
  threadId?: string | null;
  sourceKind: MemoryObservationSourceKind;
  sourceId: string;
  summary: string;
  details?: string | null;
  payload?: Record<string, unknown>;
  observedAt?: number | null;
  durable?: boolean;
  task?: {
    status?: MemoryTaskStatus | null;
    title?: string | null;
    currentStep?: string | null;
    blocker?: string | null;
    eventType?: string | null;
  } | null;
};

type RecordMemoryEventOptions = {
  syncProjection?: boolean;
  semanticReview?: SemanticReview;
  reason?: string;
};

type ThreadDeleteContext = {
  threadId: string;
  cwd: string | null;
  threadCreatedAt: number | null;
  stacks: RuntimeCleanupTaskView["stacks"];
  previews: RuntimeCleanupTaskView["previews"];
  services: RuntimeCleanupTaskView["services"];
  proofArtifactPaths?: string[];
};

type SynthesisOutput = {
  candidates?: Array<{
    kind?: JobMemoryEntryKind;
    summary?: string;
    details?: string | null;
    confidence?: "high" | "medium" | "low";
    reason?: string;
  }>;
  entities?: Array<{ type?: string; name?: string; canonicalKey?: string; summary?: string | null }>;
  relationships?: Array<{ sourceName?: string; predicate?: string; targetName?: string; confidence?: number }>;
};

type SynthesisRunner = (input: { prompt: string; cwd: string; timeoutMs: number; config: MemorySynthesisConfig }) => Promise<SynthesisOutput>;

const DEFAULT_INTERVAL_MS = 30_000;
const RETRY_DELAY_MS = 5 * 60_000;
const MAX_ATTEMPTS = 3;
const SENSITIVE_MEMORY_PATTERN = /\b(sk-[A-Za-z0-9_-]{8,}|bearer\s+[A-Za-z0-9._-]+|api[_-]?key|password|secret|token)\b/i;
const OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    candidates: {
      type: "array",
      maxItems: 6,
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          kind: { type: "string", enum: ["checkpoint", "decision", "note"] },
          summary: { type: "string" },
          details: { type: ["string", "null"] },
          confidence: { type: "string", enum: ["high", "medium", "low"] },
          reason: { type: "string" }
        }
      }
    },
    entities: {
      type: "array",
      maxItems: 12,
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          type: { type: "string" },
          name: { type: "string" },
          canonicalKey: { type: "string" },
          summary: { type: ["string", "null"] }
        }
      }
    },
    relationships: {
      type: "array",
      maxItems: 12,
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          sourceName: { type: "string" },
          predicate: { type: "string" },
          targetName: { type: "string" },
          confidence: { type: "number" }
        }
      }
    }
  }
};

function clean(value: string | null | undefined): string {
  return (value ?? "").replace(/\s+/g, " ").trim();
}

function hash(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex").slice(0, 16);
}

function projectFromThread(thread: CodexThreadRecord | undefined): { projectId: string; projectLabel: string } {
  const projectId = clean(thread?.executionContract?.projectId) || clean(thread?.supervisor.projectId) || "unknown";
  const projectLabel = clean(thread?.executionContract?.projectLabel) || clean(thread?.supervisor.projectLabel) || projectId;
  return { projectId, projectLabel };
}

function boundedMessages(messages: ButlerMessageView[], limit = 12): Array<Pick<ButlerMessageView, "id" | "role" | "text" | "at">> {
  return messages.slice(-limit).map((message) => ({ id: message.id, role: message.role, text: clean(message.text).slice(0, 1_500), at: message.at }));
}

function sourceKindToQueueReason(sourceKind: MemoryObservationSourceKind): string {
  return sourceKind.replace(/_/g, " ");
}

function lookupKey(value: string | null | undefined): string {
  return clean(value).toLowerCase();
}

function safePromotionText(value: string | null | undefined, limit: number): string | null {
  const text = clean(value).slice(0, limit);
  return text && !SENSITIVE_MEMORY_PATTERN.test(text) ? text : null;
}

function fallbackCandidateKind(sourceKind: MemoryObservationSourceKind): JobMemoryEntryKind | null {
  if (sourceKind === "harness_decision" || sourceKind === "promotion_resolved") return "decision";
  if (sourceKind === "harness_checkpoint" || sourceKind === "harness_report" || sourceKind === "pre_delete_thread") return "checkpoint";
  if (sourceKind === "thread_contract" || sourceKind === "harness_note" || sourceKind === "artifact_saved" || sourceKind === "proof_saved" || sourceKind === "policy_saved") return "note";
  return null;
}

export class MemoryUpdateScheduler {
  private readonly store: ButlerStateStore;
  private readonly config: MemorySynthesisConfig;
  private readonly stateDir: string;
  private readonly codexHomeDir: string;
  private readonly runner: SynthesisRunner;
  private readonly intervalMs: number;
  private timer: NodeJS.Timeout | null = null;
  private inFlight = false;

  constructor(options: {
    store: ButlerStateStore;
    config: MemorySynthesisConfig;
    stateDir: string;
    codexHomeDir: string;
    intervalMs?: number;
    runner?: SynthesisRunner;
  }) {
    this.store = options.store;
    this.config = options.config;
    this.stateDir = options.stateDir;
    this.codexHomeDir = options.codexHomeDir;
    this.intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
    this.runner = options.runner ?? ((input) => this.runCodexExec(input));
  }

  start(): void {
    if (this.timer || !this.config.enabled) return;
    this.timer = setInterval(() => void this.processDueQueue(), this.intervalMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  recordMemoryEvent(input: RecordMemoryEventInput, options: RecordMemoryEventOptions = {}): MemoryObservationView {
    const observation = this.store.recordMemoryObservation(input, options.syncProjection === false ? null : input.task ?? null);
    const review = options.semanticReview ?? "none";
    if (review !== "none" && this.config.enabled) {
      this.store.enqueueMemorySynthesis({
        idempotencyKey: `synthesis:${input.idempotencyKey}:${review}`,
        projectId: observation.projectId,
        threadId: observation.threadId,
        sourceObservationId: observation.id,
        reason: options.reason || sourceKindToQueueReason(input.sourceKind),
        priority: review === "high" ? "high" : "normal"
      });
      void this.processDueQueue();
    }
    return observation;
  }

  observeOperatorMessage(input: { text: string; messageId?: string | null; threadId?: string | null; projectId?: string | null; projectLabel?: string | null; at?: number | null }): MemoryObservationView {
    const summary = clean(input.text).slice(0, 240) || "Operator message received.";
    return this.recordMemoryEvent({
      idempotencyKey: `operator:${input.messageId ?? hash(`${input.at ?? Date.now()}:${summary}`)}`,
      projectId: input.projectId ?? "global",
      projectLabel: input.projectLabel ?? "Global",
      threadId: input.threadId ?? null,
      sourceKind: "operator_message",
      sourceId: input.messageId ?? "operator-message",
      summary,
      details: clean(input.text).slice(0, 4_000),
      payload: { text: clean(input.text).slice(0, 4_000) },
      observedAt: input.at ?? Date.now()
    }, { semanticReview: "normal", reason: "operator message" });
  }

  observeThreadCreated(threadId: string): MemoryObservationView {
    const thread = this.store.getThread(threadId);
    const project = projectFromThread(thread);
    return this.recordMemoryEvent({
      idempotencyKey: `thread-created:${threadId}`,
      ...project,
      threadId,
      sourceKind: "thread_created",
      sourceId: threadId,
      summary: `Thread ${threadId.slice(0, 8)} was created or observed.`,
      payload: { cwd: thread?.cwd ?? null, status: thread?.status ?? null },
      observedAt: thread?.createdAt ?? Date.now(),
      task: { status: "queued", title: thread?.executionContract?.requestedTask ?? thread?.supervisor.latestUserPrompt ?? null, eventType: "thread_created" }
    }, { semanticReview: "none" });
  }

  observeThreadContract(threadId: string, contract: CodexThreadExecutionContractView): MemoryObservationView {
    return this.recordMemoryEvent({
      idempotencyKey: `thread-contract:${threadId}:${hash(JSON.stringify(contract))}`,
      projectId: contract.projectId,
      projectLabel: contract.projectLabel,
      threadId,
      sourceKind: "thread_contract",
      sourceId: threadId,
      summary: contract.requestedTask,
      details: contract.operatorGoal,
      payload: { requestedTask: contract.requestedTask, operatorGoal: contract.operatorGoal, acceptancePoints: contract.acceptancePoints, branch: contract.branch },
      task: { status: "queued", title: contract.requestedTask, currentStep: contract.operatorGoal, eventType: "thread_contract" }
    }, { semanticReview: "normal", reason: "thread contract" });
  }

  observeHarnessMemory(input: {
    threadId: string;
    kind: "checkpoint" | "decision" | "note";
    summary: string;
    details?: string | null;
    payload?: Record<string, unknown>;
  }): MemoryObservationView {
    const thread = this.store.getThread(input.threadId);
    const project = projectFromThread(thread);
    const sourceKind = input.kind === "checkpoint" ? "harness_checkpoint" : input.kind === "decision" ? "harness_decision" : "harness_note";
    const blockers = Array.isArray(input.payload?.blockers) ? input.payload?.blockers.filter((entry) => typeof entry === "string") as string[] : [];
    return this.recordMemoryEvent({
      idempotencyKey: `${sourceKind}:${input.threadId}:${hash(`${input.summary}:${input.details ?? ""}`)}`,
      ...project,
      threadId: input.threadId,
      sourceKind,
      sourceId: input.kind,
      summary: input.summary,
      details: input.details,
      payload: input.payload,
      task: {
        status: blockers.length > 0 ? "blocked" : "in_progress",
        currentStep: typeof input.payload?.nextAction === "string" ? input.payload.nextAction : null,
        blocker: blockers.join(" | ") || null,
        eventType: sourceKind
      }
    }, { semanticReview: input.kind === "decision" ? "high" : "normal", reason: sourceKindToQueueReason(sourceKind) });
  }

  observeWorkerReport(report: CodexWorkerReportView): MemoryObservationView {
    const thread = this.store.getThread(report.threadId);
    const project = projectFromThread(thread);
    return this.recordMemoryEvent({
      idempotencyKey: `worker-report:${report.threadId}:${report.turnId}:${report.updatedAt}`,
      ...project,
      threadId: report.threadId,
      sourceKind: "harness_report",
      sourceId: report.turnId,
      summary: report.summary,
      details: report.details,
      observedAt: report.updatedAt,
      payload: { status: report.status, turnId: report.turnId },
      task: {
        status: report.status === "blocked" ? "blocked" : "completed_pending_review",
        blocker: report.status === "blocked" ? report.details ?? report.summary : null,
        eventType: `report_${report.status}`
      }
    }, { semanticReview: "high", reason: "worker report" });
  }

  observePromotionResolved(input: { candidateId: string; accepted: boolean; projectId: string; projectLabel: string; threadId: string; summary: string; details?: string | null }): MemoryObservationView {
    return this.recordMemoryEvent({
      idempotencyKey: `promotion:${input.candidateId}:${input.accepted ? "accepted" : "rejected"}`,
      projectId: input.projectId,
      projectLabel: input.projectLabel,
      threadId: input.threadId,
      sourceKind: "promotion_resolved",
      sourceId: input.candidateId,
      summary: `${input.accepted ? "Accepted" : "Rejected"} memory promotion: ${input.summary}`,
      details: input.details,
      payload: { accepted: input.accepted, candidateId: input.candidateId }
    }, { semanticReview: input.accepted ? "high" : "none", reason: "promotion resolved" });
  }

  async beforeThreadDelete(context: ThreadDeleteContext, reason = "operator_delete"): Promise<MemoryObservationView> {
    const thread = this.store.getThread(context.threadId);
    const project = projectFromThread(thread);
    const report = this.store.getWorkerReport(context.threadId);
    const memory = this.store.getJobMemory(context.threadId);
    return this.recordMemoryEvent({
      idempotencyKey: `predelete:thread:${context.threadId}:${thread?.updatedAt ?? report?.updatedAt ?? Date.now()}`,
      ...project,
      threadId: context.threadId,
      sourceKind: "pre_delete_thread",
      sourceId: context.threadId,
      summary: `Thread ${context.threadId.slice(0, 8)} queued for deletion; durable memory preflight captured.`,
      details: report ? [report.summary, report.details].filter(Boolean).join(" | ") : memory?.latestCheckpoint ?? null,
      payload: { reason, cwd: context.cwd, threadCreatedAt: context.threadCreatedAt, report, memory, cleanup: { stacks: context.stacks.length, previews: context.previews.length, services: context.services.length, proofArtifactPaths: context.proofArtifactPaths ?? [] } },
      task: { status: "deleted", eventType: "pre_delete_thread" }
    }, { semanticReview: "high", reason: "pre-delete thread synthesis" });
  }

  async beforeThreadsDelete(contexts: ThreadDeleteContext[], reason = "operator_delete_all"): Promise<MemoryObservationView | null> {
    if (contexts.length === 0) return null;
    const ids = contexts.map((context) => context.threadId).sort();
    const projectId = "global";
    const latest = Math.max(...contexts.map((context) => this.store.getThread(context.threadId)?.updatedAt ?? Date.now()));
    return this.recordMemoryEvent({
      idempotencyKey: `predelete:threads:${hash(`${ids.join(",")}:${latest}`)}`,
      projectId,
      projectLabel: "Global",
      threadId: null,
      sourceKind: "pre_delete_threads",
      sourceId: hash(ids.join(",")),
      summary: `Delete-all requested for ${contexts.length} thread${contexts.length === 1 ? "" : "s"}; durable memory preflight captured.`,
      payload: { reason, threadIds: ids, contexts: contexts.map((context) => ({ threadId: context.threadId, cwd: context.cwd, threadCreatedAt: context.threadCreatedAt })) },
      durable: true
    }, { semanticReview: "high", reason: "pre-delete threads synthesis" });
  }

  async beforeButlerChatClear(messages: ButlerMessageView[], reason = "operator_clear_chat"): Promise<MemoryObservationView> {
    const last = messages.at(-1);
    return this.recordMemoryEvent({
      idempotencyKey: `preclear:butler:${last?.id ?? "none"}:${messages.length}`,
      projectId: "global",
      projectLabel: "Global",
      threadId: null,
      sourceKind: "pre_clear_chat",
      sourceId: last?.id ?? "empty-chat",
      summary: `Butler chat clear requested; durable memory preflight captured for ${messages.length} message${messages.length === 1 ? "" : "s"}.`,
      payload: { reason, messageCount: messages.length, lastMessageId: last?.id ?? null, messages: boundedMessages(messages) },
      durable: true
    }, { semanticReview: "high", reason: "pre-clear chat synthesis" });
  }

  async beforeButlerChatDeleteFrom(input: { messageId: string; deleteFromTimestamp: number | null; messages: ButlerMessageView[] }): Promise<MemoryObservationView> {
    const suffix = input.deleteFromTimestamp === null ? input.messages : input.messages.filter((message) => (message.at ?? 0) >= input.deleteFromTimestamp!);
    const last = input.messages.at(-1);
    return this.recordMemoryEvent({
      idempotencyKey: `predeletefrom:butler:${input.messageId}:${input.deleteFromTimestamp ?? "unknown"}:${last?.id ?? "none"}`,
      projectId: "global",
      projectLabel: "Global",
      threadId: null,
      sourceKind: "pre_delete_chat_suffix",
      sourceId: input.messageId,
      summary: `Butler chat delete-from requested at ${input.messageId}; durable suffix preflight captured.`,
      payload: { messageId: input.messageId, deleteFromTimestamp: input.deleteFromTimestamp, deletedMessageCount: suffix.length, messages: boundedMessages(suffix) },
      durable: true
    }, { semanticReview: "high", reason: "pre-delete chat suffix synthesis" });
  }

  async processDueQueue(limit = 3): Promise<void> {
    if (this.inFlight || !this.config.enabled) return;
    this.inFlight = true;
    try {
      for (const entry of this.store.listDueMemorySynthesis(limit)) {
        await this.processQueueEntry(entry);
      }
    } finally {
      this.inFlight = false;
    }
  }

  private async processQueueEntry(entry: MemorySynthesisQueueEntryView): Promise<void> {
    const running = this.store.updateMemorySynthesisQueueEntry(entry.id, { status: "running", attempts: entry.attempts + 1, lastError: null });
    if (!running) return;
    try {
      const graph = this.store.searchMemoryGraph({ projectId: entry.projectId === "global" ? null : entry.projectId, threadId: entry.threadId, limit: 12 });
      const prompt = this.buildSynthesisPrompt(entry, graph.observations, graph.tasks);
      const output = await this.runner({ prompt, cwd: this.store.getThread(entry.threadId ?? "")?.cwd ?? "/repos", timeoutMs: this.config.timeoutMs, config: this.config });
      this.applySynthesisOutput(entry, output);
      this.store.updateMemorySynthesisQueueEntry(entry.id, { status: "completed", completedAt: Date.now(), lastError: null });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const attempts = running.attempts;
      this.store.updateMemorySynthesisQueueEntry(entry.id, {
        status: attempts >= MAX_ATTEMPTS ? "failed" : "pending",
        attempts,
        lastError: message,
        runAfter: Date.now() + RETRY_DELAY_MS
      });
    }
  }

  private buildSynthesisPrompt(entry: MemorySynthesisQueueEntryView, observations: MemoryObservationView[], tasks: Array<{ title: string; status: string; currentStep: string | null; blocker: string | null }>): string {
    const payload = {
      reason: entry.reason,
      projectId: entry.projectId,
      threadId: entry.threadId,
      observations: observations.map((observation) => ({ sourceKind: observation.sourceKind, sourceId: observation.sourceId, summary: observation.summary, details: observation.details, payload: observation.payload })).slice(-12),
      tasks
    };
    return [
      "You are Manor's bounded memory synthesis module.",
      "Return only durable project memory candidates/entities/relationships that help future work.",
      "Do not preserve full deleted transcripts or secrets. Prefer decisions, blockers, dependencies, next actions, repo/runtime gotchas, and durable project facts.",
      "If the payload contains a durable decision, checkpoint, report, accepted promotion, or delete preflight, include at least one promotion candidate.",
      `Return at most ${this.config.maxCandidatesPerRun} candidates.`,
      "Payload:",
      JSON.stringify(payload, null, 2).slice(0, this.config.maxInputChars)
    ].join("\n");
  }

  private applySynthesisOutput(entry: MemorySynthesisQueueEntryView, output: SynthesisOutput): void {
    const sourceObservation = this.store.listMemoryGraph().observations.find((item) => item.id === entry.sourceObservationId) ?? null;
    const observation = this.store.recordMemoryObservation({
      idempotencyKey: `synthesis-result:${entry.id}`,
      projectId: entry.projectId,
      threadId: entry.threadId,
      sourceKind: "synthesis_result",
      sourceId: entry.id,
      summary: `Memory synthesis completed for ${entry.reason}.`,
      payload: { queueEntryId: entry.id }
    });
    const entityIdsByName = new Map<string, string>();
    const indexEntity = (entity: { id: string; name: string; canonicalKey?: string | null; aliases?: string[] }): void => {
      for (const value of [entity.name, entity.canonicalKey ?? "", ...(entity.aliases ?? [])]) {
        const key = lookupKey(value);
        if (key && !entityIdsByName.has(key)) entityIdsByName.set(key, entity.id);
      }
    };
    for (const entity of output.entities ?? []) {
      const name = clean(entity.name);
      if (!name) continue;
      const saved = this.store.upsertMemoryEntity({
        projectId: entry.projectId,
        type: entity.type === "decision" || entity.type === "task" || entity.type === "repo" || entity.type === "service" || entity.type === "feature" ? entity.type : "unknown",
        name,
        canonicalKey: clean(entity.canonicalKey) || undefined,
        summary: clean(entity.summary) || null,
        sourceObservationId: observation.id
      });
      indexEntity(saved);
    }
    for (const entity of this.store.listMemoryGraph().entities.filter((item) => item.projectId === entry.projectId)) indexEntity(entity);
    for (const relationship of output.relationships ?? []) {
      const sourceId = entityIdsByName.get(lookupKey(relationship.sourceName));
      const targetId = entityIdsByName.get(lookupKey(relationship.targetName));
      if (!sourceId || !targetId || !clean(relationship.predicate)) continue;
      this.store.upsertMemoryRelationship({ projectId: entry.projectId, sourceEntityId: sourceId, predicate: clean(relationship.predicate), targetEntityId: targetId, sourceObservationId: observation.id, confidence: relationship.confidence });
    }
    let submittedCandidates = 0;
    for (const candidate of (output.candidates ?? []).slice(0, this.config.maxCandidatesPerRun)) {
      const summary = clean(candidate.summary);
      const kind = candidate.kind === "checkpoint" || candidate.kind === "decision" || candidate.kind === "note" ? candidate.kind : "note";
      if (!summary || !entry.threadId) continue;
      this.store.submitJobMemoryPromotionCandidate(entry.threadId, {
        kind,
        summary,
        details: [clean(candidate.details), clean(candidate.reason), candidate.confidence ? `Synthesis confidence: ${candidate.confidence}.` : null].filter(Boolean).join("\n") || null,
        sourceEntryId: `synthesis:${entry.id}:${hash(`${kind}:${summary}`)}`
      });
      submittedCandidates += 1;
    }
    if (submittedCandidates === 0) this.submitFallbackCandidate(entry, sourceObservation, output);
  }

  private submitFallbackCandidate(entry: MemorySynthesisQueueEntryView, sourceObservation: MemoryObservationView | null, output: SynthesisOutput): void {
    if (!entry.threadId || !sourceObservation || ((output.entities ?? []).length === 0 && (output.relationships ?? []).length === 0)) return;
    const kind = fallbackCandidateKind(sourceObservation.sourceKind);
    const summary = safePromotionText(sourceObservation.summary, 240);
    const sourceEntryId = `synthesis-fallback:${entry.id}`;
    if (!kind || !summary || this.store.getJobMemory(entry.threadId)?.promotionCandidates.some((candidate) => candidate.sourceEntryId === sourceEntryId)) return;
    const details = [
      sourceObservation.sourceKind.startsWith("pre_") ? null : safePromotionText(sourceObservation.details, 1_000),
      `Conservative fallback: synthesis returned entities/relationships but no promotion candidates for ${entry.reason}.`
    ].filter(Boolean).join("\n") || null;
    this.store.submitJobMemoryPromotionCandidate(entry.threadId, { kind, summary, details, sourceEntryId });
  }

  private async runCodexExec(input: { prompt: string; cwd: string; timeoutMs: number; config: MemorySynthesisConfig }): Promise<SynthesisOutput> {
    const scratchDir = path.join(this.stateDir, "memory-synthesis");
    await fs.mkdir(scratchDir, { recursive: true });
    const runId = crypto.randomUUID();
    const schemaPath = path.join(scratchDir, `${runId}.schema.json`);
    const outputPath = path.join(scratchDir, `${runId}.output.json`);
    await fs.writeFile(schemaPath, JSON.stringify(OUTPUT_SCHEMA, null, 2), "utf8");
    const effortArgs = input.config.effort ? ["--reasoning-effort", input.config.effort] : [];
    const args = ["exec", "--ephemeral", "--sandbox", "read-only", "--skip-git-repo-check", "--ignore-rules", "--model", input.config.model, "--output-schema", schemaPath, "--output-last-message", outputPath, "--cd", input.cwd || "/repos", ...effortArgs, "-"];
    try {
      await new Promise<void>((resolve, reject) => {
        const child = spawn("codex", args, { env: { ...process.env, CODEX_HOME: this.codexHomeDir, NO_COLOR: "1" }, stdio: ["pipe", "pipe", "pipe"] });
        let stderr = "";
        const timeout = setTimeout(() => {
          child.kill("SIGTERM");
          reject(new Error("codex exec memory synthesis timed out"));
        }, input.timeoutMs);
        child.stderr.on("data", (chunk: Buffer) => { stderr = `${stderr}${chunk.toString("utf8")}`.slice(-8_000); });
        child.on("error", (error) => { clearTimeout(timeout); reject(error); });
        child.on("close", (code) => {
          clearTimeout(timeout);
          code === 0 ? resolve() : reject(new Error(`codex exec exited with ${code}: ${stderr}`.trim()));
        });
        child.stdin.end(input.prompt);
      });
      const parsed = JSON.parse(await fs.readFile(outputPath, "utf8")) as SynthesisOutput;
      return parsed && typeof parsed === "object" ? parsed : {};
    } finally {
      await Promise.all([schemaPath, outputPath].map((filePath) => fs.rm(filePath, { force: true }).catch(() => {})));
    }
  }
}
