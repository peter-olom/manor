import { spawn } from "node:child_process";
import crypto from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

import type { ButlerStateStore } from "./state-store.js";
import type { CodexWorkerReportView, JobMemoryEntryKind } from "./types.js";

type MemoryReviewConfidence = "high" | "medium" | "low";

type MemoryReviewCandidate = {
  kind: JobMemoryEntryKind;
  summary: string;
  details: string | null;
  confidence: MemoryReviewConfidence;
  reason: string;
};

type MemoryReviewOutput = {
  candidates: MemoryReviewCandidate[];
};

type MemoryReviewRunner = (input: { cwd: string; prompt: string; timeoutMs: number }) => Promise<MemoryReviewOutput>;
type PendingReviewSource = { turnId: string };
type MemoryReviewContext = {
  report: CodexWorkerReportView;
  cwd: string;
  projectId: string;
  projectLabel: string;
  operatorGoal: string | null;
  requestedTask: string | null;
  proofRequirements: string[];
  checklist: {
    reviewState: string;
    items: { text: string; status: string }[];
  } | null;
};

const OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["candidates"],
  properties: {
    candidates: {
      type: "array",
      maxItems: 6,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["kind", "summary", "details", "confidence", "reason"],
        properties: {
          kind: { type: "string", enum: ["checkpoint", "decision", "note"] },
          summary: { type: "string", minLength: 1, maxLength: 180 },
          details: { type: ["string", "null"], maxLength: 1200 },
          confidence: { type: "string", enum: ["high", "medium", "low"] },
          reason: { type: "string", minLength: 1, maxLength: 600 }
        }
      }
    }
  }
};

const DURABLE_REVIEW_PROMPT = [
  "You are Manor's memory-review agent.",
  "Review the provided job outcome and decide what is worth preserving as durable project memory.",
  "Return only candidates that will help future work. Do not persist memory yourself.",
  "Good candidates include operator decisions, architecture choices, PR review verdicts, merge blockers, repo state changes, deployment/runtime gotchas, reusable fixes, or durable project facts.",
  "Exclude routine execution noise, ordinary test pass/fail output, generic completion summaries, temporary paths, and facts that are useful only inside this single job.",
  "Use confidence=high only when the fact is clearly reusable. Use confidence=medium for useful but context-dependent facts. Use confidence=low for borderline candidates.",
  "If nothing is worth keeping, return an empty candidates array."
].join("\n");

function reviewSourcePrefix(report: CodexWorkerReportView): string {
  return `worker-report:${report.turnId}:${report.updatedAt}:`;
}

function reviewCandidateKey(candidate: Pick<MemoryReviewCandidate, "kind" | "summary">): string {
  return JSON.stringify({
    kind: candidate.kind,
    summary: candidate.summary
  });
}

function reviewCandidateSourceId(report: CodexWorkerReportView, candidate: MemoryReviewCandidate): string {
  const hash = crypto.createHash("sha256").update(reviewCandidateKey(candidate)).digest("hex").slice(0, 16);
  return `${reviewSourcePrefix(report)}candidate:${hash}`;
}

function reviewStateSourceId(report: CodexWorkerReportView): string {
  return `${reviewSourcePrefix(report)}review-state`;
}

function reviewPendingSourceId(report: CodexWorkerReportView): string {
  return `${reviewSourcePrefix(report)}review-pending`;
}

function parseReviewPendingSourceId(sourceId: string): PendingReviewSource | null {
  const versionedMatch = /^worker-report:([^:]+):\d+:review-pending$/.exec(sourceId);
  if (versionedMatch) {
    return { turnId: versionedMatch[1] };
  }
  const legacyMatch = /^worker-report:(.+):review-pending$/.exec(sourceId);
  return legacyMatch ? { turnId: legacyMatch[1] } : null;
}

function normalizeText(value: string | null | undefined, maxLength: number): string | null {
  const normalized = (value ?? "").replace(/\s+/g, " ").trim();
  if (!normalized) {
    return null;
  }
  return normalized.length > maxLength ? normalized.slice(0, maxLength - 1).trimEnd() : normalized;
}

function normalizeCandidate(candidate: MemoryReviewCandidate): MemoryReviewCandidate | null {
  const summary = normalizeText(candidate.summary, 180);
  const reason = normalizeText(candidate.reason, 600);
  if (!summary || !reason) {
    return null;
  }
  if (candidate.kind !== "checkpoint" && candidate.kind !== "decision" && candidate.kind !== "note") {
    return null;
  }
  if (candidate.confidence !== "high" && candidate.confidence !== "medium" && candidate.confidence !== "low") {
    return null;
  }
  return {
    kind: candidate.kind,
    summary,
    details: normalizeText(candidate.details, 1200),
    confidence: candidate.confidence,
    reason
  };
}

function shouldSubmitCandidate(candidate: MemoryReviewCandidate): boolean {
  return candidate.confidence === "high" || candidate.confidence === "medium";
}

function parseReviewOutput(text: string): MemoryReviewOutput {
  const parsed = JSON.parse(text) as Partial<MemoryReviewOutput>;
  const candidates = Array.isArray(parsed.candidates)
    ? parsed.candidates
        .map((candidate) => normalizeCandidate(candidate as MemoryReviewCandidate))
        .filter((candidate): candidate is MemoryReviewCandidate => Boolean(candidate))
    : [];
  return { candidates };
}

export class CodexExecMemoryReviewService {
  private readonly store: ButlerStateStore;
  private readonly stateDir: string;
  private readonly codexHomeDir: string;
  private readonly enabled: boolean;
  private readonly timeoutMs: number;
  private readonly model: string;
  private readonly runner: MemoryReviewRunner;
  private readonly inFlightReports = new Set<string>();
  private readonly queuedReports = new Map<string, CodexWorkerReportView>();

  constructor(options: {
    store: ButlerStateStore;
    stateDir: string;
    codexHomeDir: string;
    enabled?: boolean;
    timeoutMs?: number;
    model?: string;
    runner?: MemoryReviewRunner;
  }) {
    this.store = options.store;
    this.stateDir = options.stateDir;
    this.codexHomeDir = options.codexHomeDir;
    this.enabled = options.enabled ?? true;
    this.timeoutMs = options.timeoutMs ?? 90_000;
    this.model = options.model?.trim() || process.env.MANOR_MEMORY_SYNTHESIS_MODEL?.trim() || process.env.MANOR_MEMORY_REVIEW_MODEL?.trim() || "5.4 mini";
    this.runner = options.runner ?? ((input) => this.runCodexExec(input));
  }

  reviewWorkerReportAsync(report: CodexWorkerReportView): void {
    if (!this.enabled) {
      return;
    }

    const key = `${report.threadId}:${report.turnId}`;
    if (this.inFlightReports.has(key)) {
      const queued = this.queuedReports.get(key);
      if (!queued || report.updatedAt > queued.updatedAt) {
        this.queuedReports.set(key, report);
      }
      return;
    }
    this.inFlightReports.add(key);

    void this.reviewWorkerReport(report)
      .catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        this.store.addEvent(report.threadId, "memory/review/failed", `Memory review failed: ${message}`);
      })
      .finally(() => {
        const queued = this.queuedReports.get(key);
        this.queuedReports.delete(key);
        this.inFlightReports.delete(key);
        if (queued && queued.updatedAt > report.updatedAt) {
          this.reviewWorkerReportAsync(queued);
        }
      });
  }

  reviewPendingReportsAsync(): void {
    if (!this.enabled) {
      return;
    }

    for (const memory of this.store.listJobMemories()) {
      for (const entry of memory.entries) {
        const pending = parseReviewPendingSourceId(entry.id);
        if (!pending) {
          continue;
        }
        const report = this.store.getWorkerReport(memory.threadId, pending.turnId);
        if (report && !this.hasCompletedReview(report)) {
          this.reviewWorkerReportAsync(report);
        }
      }
    }
  }

  async reviewWorkerReport(report: CodexWorkerReportView): Promise<MemoryReviewCandidate[]> {
    if (!this.enabled) {
      return [];
    }

    const context = this.buildReviewContext(report);
    if (!context) {
      return [];
    }

    if (this.hasCompletedReview(report)) {
      return [];
    }

    const prompt = this.buildPrompt(context);
    this.markReviewPending(context);
    this.store.addEvent(report.threadId, "memory/review/started", "Started Codex memory review for worker report.");
    const output = await this.runner({ cwd: context.cwd, prompt, timeoutMs: this.timeoutMs });
    if (this.isStaleReview(report)) {
      this.store.addEvent(report.threadId, "memory/review/stale", "Skipped stale Codex memory review for worker report.");
      return [];
    }
    const submitted: MemoryReviewCandidate[] = [];
    const durableCandidates = output.candidates.filter(shouldSubmitCandidate);
    const existingCandidates = this.store.getJobMemory(report.threadId)?.promotionCandidates ?? [];
    const existingSourceIds = new Set(existingCandidates.map((candidate) => candidate.sourceEntryId));
    const existingCandidateKeys = new Set(existingCandidates.map((candidate) => reviewCandidateKey(candidate)));

    for (const candidate of durableCandidates) {
      const candidateKey = reviewCandidateKey(candidate);
      const sourceEntryId = reviewCandidateSourceId(report, candidate);
      if (existingSourceIds.has(sourceEntryId) || existingCandidateKeys.has(candidateKey)) {
        continue;
      }
      const details = [
        candidate.details,
        `Memory review confidence: ${candidate.confidence}.`,
        `Reason: ${candidate.reason}`
      ]
        .filter((entry): entry is string => Boolean(entry))
        .join("\n");

      this.store.submitJobMemoryPromotionCandidate(report.threadId, {
        kind: candidate.kind,
        summary: candidate.summary,
        details,
        sourceEntryId,
        context
      });
      submitted.push(candidate);
      existingSourceIds.add(sourceEntryId);
      existingCandidateKeys.add(candidateKey);
    }

    this.store.addEvent(
      report.threadId,
      durableCandidates.length > 0 ? "memory/review/candidates" : "memory/review/none",
      durableCandidates.length > 0
        ? `Memory review proposed ${durableCandidates.length} durable candidate${durableCandidates.length === 1 ? "" : "s"}.`
        : "Memory review found no durable candidates."
    );
    this.store.recordJobNote(report.threadId, {
      summary:
        durableCandidates.length > 0
          ? `Memory review completed with ${durableCandidates.length} candidate${durableCandidates.length === 1 ? "" : "s"}.`
          : "Memory review completed with no durable candidates.",
      details: `Worker report ${report.turnId} was reviewed by Codex exec.`,
      sourceEntryId: reviewStateSourceId(report),
      context
    });
    return submitted;
  }

  private hasCompletedReview(report: CodexWorkerReportView): boolean {
    const existingMemory = this.store.getJobMemory(report.threadId);
    const stateSourceId = reviewStateSourceId(report);
    return Boolean(existingMemory?.entries.some((entry) => entry.id === stateSourceId));
  }

  private isStaleReview(report: CodexWorkerReportView): boolean {
    const latestReport = this.store.getWorkerReport(report.threadId, report.turnId);
    const queuedReport = this.queuedReports.get(`${report.threadId}:${report.turnId}`);
    return Boolean((latestReport && latestReport.updatedAt > report.updatedAt) || (queuedReport && queuedReport.updatedAt > report.updatedAt));
  }

  private markReviewPending(context: MemoryReviewContext): void {
    const report = context.report;
    const existingMemory = this.store.getJobMemory(report.threadId);
    const pendingSourceId = reviewPendingSourceId(report);
    if (existingMemory?.entries.some((entry) => entry.id === pendingSourceId)) {
      return;
    }
    this.store.recordJobNote(report.threadId, {
      summary: "Memory review pending.",
      details: `Worker report ${report.turnId} is queued for Codex exec memory review.`,
      sourceEntryId: pendingSourceId,
      context
    });
  }

  private buildReviewContext(report: CodexWorkerReportView): MemoryReviewContext | null {
    const thread = this.store.getThread(report.threadId);
    const memory = this.store.getJobMemory(report.threadId);
    if (!thread && !memory) {
      return null;
    }
    const checklist = thread ? this.store.getSupervisionChecklist(report.threadId) : null;
    const projectId =
      (thread?.supervisor.projectId && thread.supervisor.projectId !== "unknown" ? thread.supervisor.projectId : null) ??
      thread?.executionContract?.projectId ??
      memory?.projectId ??
      "unknown";
    const projectLabel =
      (thread?.supervisor.projectLabel && thread.supervisor.projectLabel !== "Unknown" ? thread.supervisor.projectLabel : null) ??
      thread?.executionContract?.projectLabel ??
      memory?.projectLabel ??
      projectId;
    return {
      report,
      cwd: thread?.cwd ?? thread?.executionContract?.workspaceCwd ?? "/repos",
      projectId,
      projectLabel,
      requestedTask: thread?.executionContract?.requestedTask ?? thread?.supervisor.latestUserPrompt ?? memory?.requestedTask ?? null,
      operatorGoal: thread?.executionContract?.operatorGoal ?? memory?.operatorGoal ?? null,
      proofRequirements: memory?.proofRequirements ?? [],
      checklist: checklist
        ? {
            reviewState: checklist.reviewState,
            items: checklist.items.map((item) => ({
              text: item.text,
              status: item.status
            }))
          }
        : null
    };
  }

  private buildPrompt(context: MemoryReviewContext): string {
    const report = context.report;
    const payload = {
      threadId: report.threadId,
      projectId: context.projectId,
      projectLabel: context.projectLabel,
      requestedTask: context.requestedTask,
      operatorGoal: context.operatorGoal,
      workerReport: report,
      checklist: context.checklist
    };

    return `${DURABLE_REVIEW_PROMPT}\n\nJob outcome payload:\n${JSON.stringify(payload, null, 2)}`;
  }

  private async runCodexExec(input: { cwd: string; prompt: string; timeoutMs: number }): Promise<MemoryReviewOutput> {
    const scratchDir = path.join(this.stateDir, "memory-review");
    await fs.mkdir(scratchDir, { recursive: true });
    const runId = crypto.randomUUID();
    const schemaPath = path.join(scratchDir, `${runId}.schema.json`);
    const outputPath = path.join(scratchDir, `${runId}.output.json`);
    await fs.writeFile(schemaPath, JSON.stringify(OUTPUT_SCHEMA, null, 2), "utf8");

    const modelArgs = this.model ? ["--model", this.model] : [];
    const args = [
      "exec",
      "--ephemeral",
      "--sandbox",
      "read-only",
      "--skip-git-repo-check",
      "--ignore-rules",
      "--output-schema",
      schemaPath,
      "--output-last-message",
      outputPath,
      "--cd",
      input.cwd,
      ...modelArgs,
      "-"
    ];

    try {
      await new Promise<void>((resolve, reject) => {
        const child = spawn("codex", args, {
          env: {
            ...process.env,
            CODEX_HOME: this.codexHomeDir,
            NO_COLOR: "1"
          },
          stdio: ["pipe", "pipe", "pipe"]
        });
        let stderr = "";
        let stdout = "";
        const timeout = setTimeout(() => {
          child.kill("SIGTERM");
          reject(new Error("codex exec memory review timed out"));
        }, input.timeoutMs);

        child.stdout.on("data", (chunk: Buffer) => {
          stdout = `${stdout}${chunk.toString("utf8")}`.slice(-16_000);
        });
        child.stderr.on("data", (chunk: Buffer) => {
          stderr = `${stderr}${chunk.toString("utf8")}`.slice(-16_000);
        });
        child.on("error", (error) => {
          clearTimeout(timeout);
          reject(error);
        });
        child.on("close", (code) => {
          clearTimeout(timeout);
          if (code === 0) {
            resolve();
            return;
          }
          reject(new Error(`codex exec exited with ${code}: ${stderr || stdout}`.trim()));
        });

        child.stdin.end(input.prompt);
      });

      const output = await fs.readFile(outputPath, "utf8");
      return parseReviewOutput(output);
    } finally {
      await Promise.all([schemaPath, outputPath].map((filePath) => fs.rm(filePath, { force: true }).catch(() => {})));
    }
  }
}
