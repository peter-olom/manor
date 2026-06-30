import { spawn } from "node:child_process";
import crypto from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

import { isUnsupportedCodexModelError, memoryCodexModelArgs, normalizeMemoryCodexModel } from "./memory-codex-model.js";
import { normalizeWorkerReviewResults, shouldRunCodexWorkerReview } from "./butler-orchestration.js";
import type { ButlerStateStore } from "./state-store.js";
import type { CodexThreadRecord, CodexWorkerReportView, WorkerReviewResultRecordView } from "./types.js";

type WorkerReviewRunner = (input: { cwd: string; prompt: string; timeoutMs: number }) => Promise<unknown>;

export type CodexWorkerReviewCommandInput = {
  cwd: string;
  codexHomeDir: string;
  schemaPath: string;
  outputPath: string;
  model: string | null;
  prompt: string;
  timeoutMs: number;
};

export function buildCodexWorkerReviewArgs(input: Pick<CodexWorkerReviewCommandInput, "schemaPath" | "outputPath" | "model">): string[] {
  return [
    "exec",
    "review",
    "--uncommitted",
    "--ephemeral",
    "--skip-git-repo-check",
    "--ignore-rules",
    "--output-schema",
    input.schemaPath,
    "--output-last-message",
    input.outputPath,
    ...memoryCodexModelArgs(input.model)
  ];
}

export async function runCodexWorkerReviewCommand(input: CodexWorkerReviewCommandInput): Promise<void> {
  const args = buildCodexWorkerReviewArgs(input);
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
      reject(new Error("codex worker review timed out"));
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
      code === 0 ? resolve() : reject(new Error(`codex review exited with ${code}: ${stderr || stdout}`.trim()));
    });
    child.stdin.end(input.prompt);
  });
}

export const WORKER_REVIEW_OUTPUT_SCHEMA = {
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
          linkedClaimIds: { type: "array", maxItems: 20, items: { type: "string", maxLength: 100 } },
          waived: { type: "boolean" },
          waiverReason: { type: ["string", "null"], maxLength: 400 }
        }
      }
    }
  }
};

export class CodexWorkerReviewService {
  private readonly store: ButlerStateStore;
  private readonly stateDir: string;
  private readonly codexHomeDir: string;
  private readonly enabled: boolean;
  private readonly timeoutMs: number;
  private readonly model: string | null;
  private readonly runner: WorkerReviewRunner;
  private readonly inFlightReports = new Set<string>();

  constructor(options: {
    store: ButlerStateStore;
    stateDir: string;
    codexHomeDir: string;
    enabled?: boolean;
    timeoutMs?: number;
    model?: string;
    runner?: WorkerReviewRunner;
  }) {
    this.store = options.store;
    this.stateDir = options.stateDir;
    this.codexHomeDir = options.codexHomeDir;
    this.enabled = options.enabled ?? true;
    this.timeoutMs = options.timeoutMs ?? 120_000;
    this.model = normalizeMemoryCodexModel(options.model ?? process.env.MANOR_WORKER_REVIEW_MODEL);
    this.runner = options.runner ?? ((input) => this.runCodexReview(input));
  }

  reviewWorkerReportAsync(report: CodexWorkerReportView): void {
    if (!this.enabled) return;
    const key = `${report.threadId}:${report.turnId}:${report.updatedAt}`;
    if (this.inFlightReports.has(key)) return;
    this.inFlightReports.add(key);
    void this.reviewWorkerReport(report)
      .catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        this.store.addEvent(report.threadId, "codex/review/failed", `Codex review failed: ${message}`);
        this.store.recordWorkerReviewResults(report.threadId, [
          {
            id: `review-${report.turnId}-${report.updatedAt}-failed`,
            reviewSource: "codex_review",
            turnId: report.turnId,
            reportUpdatedAt: report.updatedAt,
            severity: "high",
            findingSummary: `Codex review automation failed: ${message}`,
            blocking: true,
            waived: false,
            waiverReason: null,
            automationFailure: true,
            linkedClaimIds: report.claims?.claims.map((claim) => claim.claimId) ?? [],
            createdAt: Date.now(),
            updatedAt: Date.now()
          }
        ]);
      })
      .finally(() => this.inFlightReports.delete(key));
  }

  async reviewWorkerReport(report: CodexWorkerReportView): Promise<WorkerReviewResultRecordView[]> {
    if (!this.enabled) return [];
    const thread = this.store.getThread(report.threadId);
    if (!thread || !shouldRunCodexWorkerReview(thread.executionContract, report)) return [];
    const cwd = thread.executionContract?.workspaceCwd || thread.cwd || process.cwd();
    const prompt = this.buildPrompt(thread, report);
    this.store.addEvent(report.threadId, "codex/review/started", "Started Codex review for worker report.");
    const raw = await this.runner({ cwd, prompt, timeoutMs: this.timeoutMs });
    let results = normalizeWorkerReviewResults({
      raw,
      threadId: report.threadId,
      turnId: report.turnId,
      reportUpdatedAt: report.updatedAt
    });
    if (results.length === 0) {
      results = [
        {
          id: `review-${report.turnId}-none-${crypto.randomUUID().slice(0, 8)}`,
          reviewSource: "codex_review",
          turnId: report.turnId,
          reportUpdatedAt: report.updatedAt,
          severity: "info",
          findingSummary: "Codex review found no actionable findings.",
          blocking: false,
          waived: false,
          waiverReason: null,
          linkedClaimIds: [],
          createdAt: Date.now(),
          updatedAt: Date.now()
        }
      ];
    }
    this.store.recordWorkerReviewResults(report.threadId, results);
    return results;
  }

  reviewPendingReportsAsync(): void {
    if (!this.enabled) return;
    for (const thread of this.store.listThreads()) {
      const report = this.store.getWorkerReport(thread.id);
      if (!report || !shouldRunCodexWorkerReview(thread.executionContract, report)) continue;
      this.reviewWorkerReportAsync(report);
    }
  }

  private buildPrompt(thread: CodexThreadRecord, report: CodexWorkerReportView): string {
    const contract = thread.executionContract;
    return [
      "You are reviewing completed worker output for Manor.",
      "Use Codex review mode against the current repository changes. Prioritize bugs, regressions, missing proof, unsafe data/API/deploy behavior, and mismatches between the task and the claims.",
      "Do not rely on persuasive wording in the worker report. Treat the claims as hypotheses and verify them against the diff and proof pointers.",
      "Mark blocking=true only for serious actionable findings that Butler must not accept until fixed or explicitly waived.",
      "Return compact structured findings only.",
      "",
      `Task: ${contract?.requestedTask ?? thread.supervisor.latestUserPrompt ?? ""}`,
      `Risk: ${contract?.orchestration?.riskLevel ?? "unknown"}`,
      `Review reason: ${contract?.orchestration?.reviewRecommendation.reason ?? "risk-based review"}`,
      `Acceptance points: ${(contract?.acceptancePoints ?? []).join(" | ")}`,
      `Worker summary: ${report.summary}`,
      `Worker details: ${report.details ?? ""}`,
      `Worker claims: ${JSON.stringify(report.claims ?? null)}`,
      `Worker evidence: ${JSON.stringify(report.evidence ?? [])}`
    ].join("\n");
  }

  private async runCodexReview(input: { cwd: string; prompt: string; timeoutMs: number }): Promise<unknown> {
    const scratchDir = path.join(this.stateDir, "worker-review");
    await fs.mkdir(scratchDir, { recursive: true });
    const runId = crypto.randomUUID();
    const schemaPath = path.join(scratchDir, `${runId}.schema.json`);
    const outputPath = path.join(scratchDir, `${runId}.output.json`);
    await fs.writeFile(schemaPath, JSON.stringify(WORKER_REVIEW_OUTPUT_SCHEMA, null, 2), "utf8");

    try {
      const run = async (model: string | null): Promise<void> => {
        await runCodexWorkerReviewCommand({
          cwd: input.cwd,
          codexHomeDir: this.codexHomeDir,
          schemaPath,
          outputPath,
          model,
          prompt: input.prompt,
          timeoutMs: input.timeoutMs
        });
      };
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
      return JSON.parse(await fs.readFile(outputPath, "utf8"));
    } finally {
      await Promise.all([schemaPath, outputPath].map((filePath) => fs.rm(filePath, { force: true }).catch(() => {})));
    }
  }
}
