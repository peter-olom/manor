import { spawn } from "node:child_process";
import crypto from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

import { normalizeRoutingDecision } from "./butler-orchestration.js";
import { isUnsupportedCodexModelError, memoryCodexModelArgs, normalizeMemoryCodexModel } from "./memory-codex-model.js";
import { inferTaskCategory, inferWorkDepth } from "./thread-contract.js";
import type { ButlerRoutingDecisionView } from "./types.js";

type RoutingClassifierRunner = (input: { cwd: string; prompt: string; timeoutMs: number }) => Promise<unknown>;

const OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "taskClass",
    "confidence",
    "questionSet",
    "goalRecommendation",
    "reviewRecommendation",
    "subAgentRoles",
    "riskLevel",
    "fallbackReason"
  ],
  properties: {
    taskClass: {
      type: "string",
      enum: ["trivial", "ui", "api", "deploy", "docs", "data", "writing", "generic_code", "read_only", "research", "prototype", "plan", "recommendation", "unknown"]
    },
    confidence: { type: "number", minimum: 0, maximum: 1 },
    questionSet: {
      type: "array",
      maxItems: 5,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "prompt", "context", "options", "allowFreeform"],
        properties: {
          id: { type: "string", minLength: 1, maxLength: 80 },
          prompt: { type: "string", minLength: 1, maxLength: 500 },
          context: { type: ["string", "null"], maxLength: 500 },
          allowFreeform: { type: "boolean" },
          options: {
            type: "array",
            maxItems: 4,
            items: {
              type: "object",
              additionalProperties: false,
              required: ["id", "label", "description"],
              properties: {
                id: { type: ["string", "null"], maxLength: 80 },
                label: { type: "string", minLength: 1, maxLength: 120 },
                description: { type: ["string", "null"], maxLength: 300 }
              }
            }
          }
        }
      }
    },
    goalRecommendation: {
      type: "object",
      additionalProperties: false,
      required: ["mode", "goal", "fallbackReason"],
      properties: {
        mode: { type: "string", enum: ["none", "native_goal", "contract_fallback"] },
        goal: { type: ["string", "null"], maxLength: 500 },
        fallbackReason: { type: ["string", "null"], maxLength: 500 }
      }
    },
    reviewRecommendation: {
      type: "object",
      additionalProperties: false,
      required: ["target", "required", "reason"],
      properties: {
        target: { type: "string", enum: ["none", "codex_review"] },
        required: { type: "boolean" },
        reason: { type: ["string", "null"], maxLength: 500 }
      }
    },
    subAgentRoles: { type: "array", maxItems: 8, items: { type: "string", minLength: 1, maxLength: 80 } },
    riskLevel: { type: "string", enum: ["low", "medium", "high", "critical"] },
    fallbackReason: { type: ["string", "null"], maxLength: 500 }
  }
};

export class ButlerRoutingClassifier {
  private readonly stateDir: string;
  private readonly codexHomeDir: string;
  private readonly enabled: boolean;
  private readonly timeoutMs: number;
  private readonly model: string | null;
  private readonly runner: RoutingClassifierRunner;

  constructor(options: {
    stateDir: string;
    codexHomeDir: string;
    enabled?: boolean;
    timeoutMs?: number;
    model?: string;
    runner?: RoutingClassifierRunner;
  }) {
    this.stateDir = options.stateDir;
    this.codexHomeDir = options.codexHomeDir;
    this.enabled = options.enabled ?? true;
    this.timeoutMs = options.timeoutMs ?? 60_000;
    this.model = normalizeMemoryCodexModel(options.model ?? process.env.MANOR_ROUTING_CLASSIFIER_MODEL ?? process.env.MANOR_MEMORY_REVIEW_MODEL);
    this.runner = options.runner ?? ((input) => this.runCodexExec(input));
  }

  async classify(input: {
    task: string;
    goal?: string | null;
    cwd: string;
    attachmentCount?: number;
    goalModeAvailable?: boolean;
  }): Promise<ButlerRoutingDecisionView> {
    if (!this.enabled) {
      throw new Error("Routing classifier is disabled.");
    }
    const prompt = this.buildPrompt(input);
    const raw = await this.runner({ cwd: input.cwd, prompt, timeoutMs: this.timeoutMs });
    const fallbackCategory = inferTaskCategory([input.task, input.goal ?? ""].join("\n"));
    const decision = normalizeRoutingDecision(raw, fallbackCategory);
    if (!decision) {
      throw new Error("Routing classifier returned invalid JSON.");
    }
    return {
      ...decision,
      goalRecommendation:
        decision.goalRecommendation.mode === "native_goal" && input.goalModeAvailable === false
          ? {
              mode: "contract_fallback",
              goal: decision.goalRecommendation.goal,
              fallbackReason: decision.goalRecommendation.fallbackReason ?? "Native goal mode is not available in this Manor runtime."
            }
          : decision.goalRecommendation
    };
  }

  private buildPrompt(input: { task: string; goal?: string | null; attachmentCount?: number; goalModeAvailable?: boolean }): string {
    const taskText = [input.task, input.goal ? `Goal: ${input.goal}` : ""].filter(Boolean).join("\n");
    const inferredCategory = inferTaskCategory(taskText);
    const inferredDepth = inferWorkDepth(taskText, inferredCategory);
    return [
      "You are Butler's pre-delegation routing classifier for Manor.",
      "Return strict JSON only. Do not execute the task.",
      "Decide whether Butler should ask structured operator questions before delegation, use goal handling, require Codex review, and ask the worker to run sub-agents inside the worker thread.",
      "Ask questions when missing information materially changes the route, acceptance criteria, credentials, deployment target, data safety, or user-visible outcome.",
      "Recommend review for code-changing, long, UI, API, data, deploy, and high-risk work. Trivial read-only answers usually do not need review.",
      "Recommend sub-agent roles for adversarial review, research, UI taste, API safety, ops, product, or security when they add value.",
      "Use native_goal when work is long or multi-phase and goal mode is available; use contract_fallback otherwise.",
      "",
      `Goal mode available: ${input.goalModeAvailable === false ? "false" : "true"}`,
      `Attachment count: ${input.attachmentCount ?? 0}`,
      `Heuristic category: ${inferredCategory}`,
      `Heuristic depth: ${inferredDepth}`,
      "",
      "Task:",
      input.task,
      input.goal ? `\nOperator goal:\n${input.goal}` : ""
    ].join("\n");
  }

  private async runCodexExec(input: { cwd: string; prompt: string; timeoutMs: number }): Promise<unknown> {
    const scratchDir = path.join(this.stateDir, "routing-classifier");
    await fs.mkdir(scratchDir, { recursive: true });
    const runId = crypto.randomUUID();
    const schemaPath = path.join(scratchDir, `${runId}.schema.json`);
    const outputPath = path.join(scratchDir, `${runId}.output.json`);
    await fs.writeFile(schemaPath, JSON.stringify(OUTPUT_SCHEMA, null, 2), "utf8");
    const baseArgs = [
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
      input.cwd
    ];

    try {
      const run = async (model: string | null): Promise<void> => {
        const args = [...baseArgs, ...memoryCodexModelArgs(model), "-"];
        await new Promise<void>((resolve, reject) => {
          const child = spawn("codex", args, {
            env: { ...process.env, CODEX_HOME: this.codexHomeDir, NO_COLOR: "1" },
            stdio: ["pipe", "pipe", "pipe"]
          });
          let stderr = "";
          let stdout = "";
          const timeout = setTimeout(() => {
            child.kill("SIGTERM");
            reject(new Error("codex routing classifier timed out"));
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
            code === 0 ? resolve() : reject(new Error(`codex routing classifier exited with ${code}: ${stderr || stdout}`.trim()));
          });
          child.stdin.end(input.prompt);
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
