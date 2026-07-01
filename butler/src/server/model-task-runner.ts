import { spawn } from "node:child_process";
import crypto from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

import { complete, type Api, type Message, type Model, type ToolCall } from "@mariozechner/pi-ai";
import { contentToText } from "./butler-agent-helpers.js";
import { isUnsupportedCodexModelError, memoryCodexModelArgs } from "./memory-codex-model.js";
import { getActiveManorSettings } from "./manor-settings-runtime.js";
import { createManorModelRegistry, isCodexPreferredModelRef, parseProviderModelRef, type ProviderModelRef } from "./model-provider-config.js";
import { appendOllamaWebToolInstruction, appendToolMessages, executeOllamaWebToolCall, ollamaWebTools, readOllamaWebToolsConfig, shouldAttachOllamaWebTools } from "./ollama-web-tools.js";

export type ModelTaskRunnerInput = {
  purpose: string;
  prompt: string;
  cwd?: string | null;
  timeoutMs: number;
  model?: string | ProviderModelRef | null;
  schema?: unknown;
};

export type ModelTaskRunner = {
  runJson(input: ModelTaskRunnerInput): Promise<unknown>;
  runText(input: ModelTaskRunnerInput): Promise<string>;
};

type RunnerMode = "auto" | "codex" | "pi";

function runnerMode(): RunnerMode {
  return getActiveManorSettings().modelTasks.runnerMode;
}

function normalizeRef(ref: string | ProviderModelRef | null | undefined): ProviderModelRef {
  return typeof ref === "string" ? parseProviderModelRef(ref) : (ref ?? { provider: null, model: null });
}

function extractJson(text: string): string {
  const trimmed = text.trim();
  if (!trimmed.startsWith("```")) return trimmed;
  const match = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return match ? match[1]!.trim() : trimmed;
}

export class ManorModelTaskRunner implements ModelTaskRunner {
  private readonly stateDir: string;
  private readonly codexHomeDir: string;
  private readonly piAuthPath: string;
  private mode: RunnerMode;

  constructor(options: { stateDir: string; codexHomeDir: string; piAuthPath: string; mode?: RunnerMode }) {
    this.stateDir = options.stateDir;
    this.codexHomeDir = options.codexHomeDir;
    this.piAuthPath = options.piAuthPath;
    this.mode = options.mode ?? runnerMode();
  }

  applySettings(mode = runnerMode()): void {
    this.mode = mode;
  }

  async runJson(input: ModelTaskRunnerInput): Promise<unknown> {
    const text = await this.runText({
      ...input,
      prompt: [
        input.prompt,
        "",
        "Return valid JSON only. Do not include Markdown fences or prose outside the JSON object."
      ].join("\n")
    });
    return JSON.parse(extractJson(text));
  }

  async runText(input: ModelTaskRunnerInput): Promise<string> {
    const ref = normalizeRef(input.model);
    if (this.shouldUsePi(ref)) {
      return this.runPiInline({ ...input, model: ref });
    }
    try {
      return await this.runCodexExec({ ...input, model: ref });
    } catch (error) {
      if (this.mode !== "auto" || !isUnsupportedCodexModelError(error)) {
        throw error;
      }
      return this.runPiInline({ ...input, model: ref });
    }
  }

  private shouldUsePi(ref: ProviderModelRef): boolean {
    if (this.mode === "pi") return true;
    if (this.mode === "codex") return false;
    return !isCodexPreferredModelRef(ref);
  }

  private async resolvePiModel(ref: ProviderModelRef): Promise<{ registry: Awaited<ReturnType<typeof createManorModelRegistry>>; model: Model<Api> }> {
    const registry = await createManorModelRegistry(this.piAuthPath);
    const available = registry.getAvailable();
    const model =
      ref.provider && ref.model
        ? available.find((entry) => entry.provider === ref.provider && entry.id === ref.model)
        : ref.model
          ? available.find((entry) => entry.id === ref.model || `${entry.provider}/${entry.id}` === ref.model)
          : available[0];
    if (!model) {
      const requested = ref.provider && ref.model ? `${ref.provider}/${ref.model}` : ref.model ?? "default";
      throw new Error(`No Pi model is available for ${requested}.`);
    }
    return { registry, model };
  }

  private async runPiInline(input: ModelTaskRunnerInput & { model: ProviderModelRef }): Promise<string> {
    const { registry, model } = await this.resolvePiModel(input.model);
    const auth = await registry.getApiKeyAndHeaders(model);
    if (!auth.ok) {
      throw new Error(auth.error);
    }
    const webToolsConfig = await readOllamaWebToolsConfig();
    const useOllamaWebTools = webToolsConfig.enabled && shouldAttachOllamaWebTools(model.provider);
    const baseSystemPrompt = `You are Manor's ${input.purpose} model task runner. Follow the requested output format exactly.`;
    const context = {
      systemPrompt: useOllamaWebTools ? appendOllamaWebToolInstruction(baseSystemPrompt) : baseSystemPrompt,
      messages: [{ role: "user", timestamp: Date.now(), content: input.prompt }] as Message[],
      ...(useOllamaWebTools ? { tools: ollamaWebTools() } : {})
    };
    let response = await complete(model, context, {
      apiKey: auth.apiKey,
      headers: auth.headers,
      timeoutMs: input.timeoutMs,
      maxRetries: 0
    });
    for (let round = 0; useOllamaWebTools && round < 4; round += 1) {
      const toolCalls = response.content.filter((entry): entry is ToolCall => entry.type === "toolCall" && (entry.name === "web_search" || entry.name === "web_fetch"));
      if (response.stopReason !== "toolUse" && toolCalls.length === 0) break;
      const toolResults = await Promise.all(toolCalls.map((toolCall) => executeOllamaWebToolCall(toolCall, webToolsConfig)));
      context.messages = appendToolMessages(context.messages, response, toolResults);
      response = await complete(model, context, {
        apiKey: auth.apiKey,
        headers: auth.headers,
        timeoutMs: input.timeoutMs,
        maxRetries: 0
      });
    }
    if (response.stopReason === "error" || response.stopReason === "aborted") {
      throw new Error(response.errorMessage || `Pi inline ${input.purpose} failed.`);
    }
    if (response.stopReason === "toolUse") {
      throw new Error(`Pi inline ${input.purpose} requested more Ollama web tool calls than Manor allows.`);
    }
    return contentToText(response.content).trim();
  }

  private async runCodexExec(input: ModelTaskRunnerInput & { model: ProviderModelRef }): Promise<string> {
    const scratchDir = path.join(this.stateDir, "model-tasks");
    await fs.mkdir(scratchDir, { recursive: true });
    const runId = crypto.randomUUID();
    const outputPath = path.join(scratchDir, `${runId}.output.txt`);
    const schemaPath = input.schema ? path.join(scratchDir, `${runId}.schema.json`) : null;
    if (schemaPath) {
      await fs.writeFile(schemaPath, JSON.stringify(input.schema, null, 2), "utf8");
    }
    const modelArg =
      input.model.provider && input.model.model && !isCodexPreferredModelRef(input.model)
        ? `${input.model.provider}/${input.model.model}`
        : input.model.model;
    const args = [
      "exec",
      "--ephemeral",
      "--sandbox",
      "read-only",
      "--skip-git-repo-check",
      "--ignore-rules",
      ...(schemaPath ? ["--output-schema", schemaPath] : []),
      "--output-last-message",
      outputPath,
      "--cd",
      input.cwd || "/repos",
      ...memoryCodexModelArgs(modelArg),
      "-"
    ];
    try {
      await new Promise<void>((resolve, reject) => {
        const child = spawn("codex", args, {
          env: { ...process.env, CODEX_HOME: this.codexHomeDir, NO_COLOR: "1" },
          stdio: ["pipe", "pipe", "pipe"]
        });
        let stderr = "";
        let stdout = "";
        const timeout = setTimeout(() => {
          child.kill("SIGTERM");
          reject(new Error(`codex exec ${input.purpose} timed out`));
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
          code === 0 ? resolve() : reject(new Error(`codex exec ${input.purpose} exited with ${code}: ${stderr || stdout}`.trim()));
        });
        child.stdin.end(input.prompt);
      });
      return (await fs.readFile(outputPath, "utf8")).trim();
    } finally {
      await Promise.all([
        fs.rm(outputPath, { force: true }).catch(() => {}),
        ...(schemaPath ? [fs.rm(schemaPath, { force: true }).catch(() => {})] : [])
      ]);
    }
  }
}
