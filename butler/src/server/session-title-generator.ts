import { spawn } from "node:child_process";
import crypto from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

import { isUnsupportedCodexModelError, memoryCodexModelArgs, normalizeMemoryCodexModel } from "./memory-codex-model.js";

type SessionTitleRunner = (input: { cwd: string; prompt: string; timeoutMs: number }) => Promise<unknown>;

export type SessionTitleGenerator = {
  generateTitle(input: { firstUserPrompt: string; cwd?: string | null }): Promise<string | null>;
};

type CodexSessionTitleGeneratorOptions = {
  stateDir: string;
  codexHomeDir: string;
  model?: string | null;
  timeoutMs?: number;
  runner?: SessionTitleRunner;
};

const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_INPUT_CHARS = 4_000;
const OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["title"],
  properties: {
    title: { type: "string", minLength: 1, maxLength: 80 }
  }
};

const TITLE_PROMPT = [
  "Create a concise session title from the user's first prompt.",
  "Rules:",
  "- Four words or fewer.",
  "- Plain text only.",
  "- No quotes, punctuation wrapper, or trailing period.",
  "- Preserve the user's intent."
].join("\n");

function clampTimeout(value: number | undefined): number {
  if (!Number.isFinite(value)) return DEFAULT_TIMEOUT_MS;
  return Math.max(1_000, Math.min(60_000, Math.trunc(value!)));
}

function normalizeTitleText(value: string | null | undefined): string {
  return (value ?? "")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/[`"'“”‘’]+/g, "")
    .replace(/[()[\]{}<>]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^[\s:;,.!?-]+|[\s:;,.!?-]+$/g, "");
}

function titleWords(value: string): string[] {
  return normalizeTitleText(value)
    .split(/\s+/)
    .map((word) => word.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, ""))
    .filter(Boolean);
}

export function fallbackSessionTitle(firstUserPrompt: string): string {
  const words = titleWords(firstUserPrompt.replace(/https?:\/\/\S+/gi, " "));
  return words.slice(0, 4).join(" ") || "New session";
}

export function sanitizeSessionTitle(rawTitle: string | null | undefined, firstUserPrompt = ""): string {
  const words = titleWords(rawTitle ?? "");
  const title = words.slice(0, 4).join(" ");
  return title || fallbackSessionTitle(firstUserPrompt);
}

function parseTitleOutput(text: string, firstUserPrompt: string): string {
  const parsed = JSON.parse(text) as { title?: unknown };
  return sanitizeSessionTitle(typeof parsed.title === "string" ? parsed.title : "", firstUserPrompt);
}

export function readSessionTitleConfig(env: NodeJS.ProcessEnv = process.env): { model: string | null; timeoutMs: number } {
  const timeout = Number(env.MANOR_SESSION_TITLE_TIMEOUT_MS);
  return {
    model: normalizeMemoryCodexModel(env.MANOR_SESSION_TITLE_MODEL ?? env.MANOR_MEMORY_SYNTHESIS_MODEL ?? env.MANOR_MEMORY_EXEC_MODEL ?? env.MANOR_MEMORY_REVIEW_MODEL),
    timeoutMs: clampTimeout(timeout)
  };
}

export class CodexSessionTitleGenerator implements SessionTitleGenerator {
  private readonly model: string | null;
  private readonly timeoutMs: number;
  private readonly runner: SessionTitleRunner;

  constructor(private readonly options: CodexSessionTitleGeneratorOptions) {
    this.model = normalizeMemoryCodexModel(options.model);
    this.timeoutMs = clampTimeout(options.timeoutMs);
    this.runner = options.runner ?? ((input) => this.runCodexExec(input));
  }

  async generateTitle(input: { firstUserPrompt: string; cwd?: string | null }): Promise<string | null> {
    const prompt = input.firstUserPrompt.trim();
    if (!prompt) {
      return null;
    }
    let raw: unknown;
    try {
      raw = await this.runner({
        cwd: input.cwd?.trim() || "/repos",
        prompt: `${TITLE_PROMPT}\n\nFirst user prompt:\n${prompt.slice(0, MAX_INPUT_CHARS)}`,
        timeoutMs: this.timeoutMs
      });
    } catch (error) {
      return null;
    }
    try {
      const text = typeof raw === "string" ? raw : JSON.stringify(raw ?? {});
      return parseTitleOutput(text, prompt);
    } catch {
      return fallbackSessionTitle(prompt);
    }
  }

  private async runCodexExec(input: { prompt: string; cwd: string; timeoutMs: number }): Promise<string> {
    const scratchDir = path.join(this.options.stateDir, "session-title");
    await fs.mkdir(scratchDir, { recursive: true });
    const runId = crypto.randomUUID();
    const schemaPath = path.join(scratchDir, `${runId}.schema.json`);
    const outputPath = path.join(scratchDir, `${runId}.output.json`);
    await fs.writeFile(schemaPath, JSON.stringify(OUTPUT_SCHEMA, null, 2), "utf8");
    const baseArgs = ["exec", "--ephemeral", "--sandbox", "read-only", "--skip-git-repo-check", "--ignore-rules", "--output-schema", schemaPath, "--output-last-message", outputPath, "--cd", input.cwd];
    const run = async (model: string | null): Promise<void> => {
      const args = [...baseArgs, ...memoryCodexModelArgs(model), "-"];
      await new Promise<void>((resolve, reject) => {
        const child = spawn("codex", args, {
          env: { ...process.env, CODEX_HOME: this.options.codexHomeDir, NO_COLOR: "1" },
          stdio: ["pipe", "pipe", "pipe"]
        });
        let stderr = "";
        let stdout = "";
        const timeout = setTimeout(() => {
          child.kill("SIGTERM");
          reject(new Error("codex exec session title timed out"));
        }, input.timeoutMs);
        child.stdout.on("data", (chunk: Buffer) => { stdout = `${stdout}${chunk.toString("utf8")}`.slice(-8_000); });
        child.stderr.on("data", (chunk: Buffer) => { stderr = `${stderr}${chunk.toString("utf8")}`.slice(-8_000); });
        child.on("error", (error) => { clearTimeout(timeout); reject(error); });
        child.on("close", (code) => {
          clearTimeout(timeout);
          code === 0 ? resolve() : reject(new Error(`codex exec exited with ${code}: ${stderr || stdout}`.trim()));
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
      return fs.readFile(outputPath, "utf8");
    } finally {
      await Promise.all([fs.rm(schemaPath, { force: true }).catch(() => {}), fs.rm(outputPath, { force: true }).catch(() => {})]);
    }
  }
}
