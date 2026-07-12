import { spawn } from "node:child_process";
import crypto from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

import { complete, type Api, type Message, type Model, type ToolCall } from "@mariozechner/pi-ai";
import { readCodexAuthStatus } from "./auth-status.js";
import { contentToText } from "./butler-agent-helpers.js";
import { memoryCodexModelArgs } from "./memory-codex-model.js";
import { createManorModelRegistry, isCodexPreferredModelRef, parseProviderModelRef, type ProviderModelRef } from "./model-provider-config.js";
import { appendToolMessages } from "./ollama-web-tools.js";
import { appendProviderWebToolInstruction, executeProviderWebToolCall, providerWebTools, selectProviderWebToolSource, PROVIDER_WEB_FETCH_TOOL_NAME, PROVIDER_WEB_SEARCH_TOOL_NAME } from "./provider-web-tools.js";

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

type ResolvedModelTaskRunnerInput = ModelTaskRunnerInput & { model: ProviderModelRef; deadline: number };
type PiModelAuth =
  | { ok: true; apiKey: string; headers?: Record<string, string> }
  | { ok: false; error: string };
type ModelTaskRunnerOptions = {
  stateDir: string;
  codexHomeDir: string;
  piAuthPath: string;
  codexAuthenticated?: () => Promise<boolean>;
  codexExecutor?: (input: ResolvedModelTaskRunnerInput) => Promise<string>;
  piExecutor?: (input: ResolvedModelTaskRunnerInput) => Promise<string>;
};

function normalizeRef(ref: string | ProviderModelRef | null | undefined): ProviderModelRef {
  return typeof ref === "string" ? parseProviderModelRef(ref) : (ref ?? { provider: null, model: null });
}

function matchesModelRef(entry: Model<Api>, ref: ProviderModelRef): boolean {
  if (!ref.model) return false;
  const entryId = entry.id.startsWith(`${entry.provider}/`) ? entry.id : `${entry.provider}/${entry.id}`;
  if (ref.provider) return entry.provider === ref.provider && (entry.id === ref.model || entryId === `${ref.provider}/${ref.model}`);
  return entry.id === ref.model || entryId === ref.model || entry.id.endsWith(`/${ref.model}`);
}

export function modelTaskTransport(ref: string | ProviderModelRef | null | undefined, codexAuthenticated: boolean): "codex" | "pi" {
  const normalized = normalizeRef(ref);
  if (normalized.provider || normalized.model) return isCodexPreferredModelRef(normalized) ? "codex" : "pi";
  return codexAuthenticated ? "codex" : "pi";
}

function providerReconnectError(provider: string, detail?: string): Error {
  return new Error(`The ${provider} background provider needs to be reconnected${detail ? ` (${detail})` : ""}. Open Settings → Providers to repair authentication, or choose another model.`);
}

export async function selectAuthenticatedPiModel(
  available: Model<Api>[],
  ref: ProviderModelRef,
  getAuth: (model: Model<Api>) => Promise<PiModelAuth>
): Promise<{ model: Model<Api>; auth: Extract<PiModelAuth, { ok: true }> }> {
  const candidates = ref.model
    ? available.filter((entry) => matchesModelRef(entry, ref))
    : available.filter((entry) => !isCodexPreferredModelRef({ provider: entry.provider, model: entry.id }));
  if (candidates.length === 0) {
    const requested = ref.provider && ref.model ? `${ref.provider}/${ref.model}` : ref.model ?? "automatic selection";
    throw new Error(`The background model ${requested} is unavailable. Open Settings → Providers to reconnect it, or choose another model.`);
  }
  let lastAuthError: string | null = null;
  for (const model of candidates) {
    const auth = await getAuth(model);
    if (auth.ok) return { model, auth };
    lastAuthError = auth.error;
    if (ref.model) throw providerReconnectError(model.provider, auth.error);
  }
  throw providerReconnectError("configured", lastAuthError ?? "no authenticated model is available");
}

function remainingTimeout(deadline: number, purpose: string): number {
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new Error(`${purpose} timed out`);
  return remaining;
}

export async function withinDeadline<T>(promise: Promise<T>, deadline: number, purpose: string): Promise<T> {
  const timeoutMs = remainingTimeout(deadline, purpose);
  let timeout: NodeJS.Timeout | null = null;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error(`${purpose} timed out`)), timeoutMs);
      })
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function extractJson(text: string): string {
  const trimmed = text.trim();
  if (!trimmed.startsWith("```")) return trimmed;
  const match = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return match ? match[1]!.trim() : trimmed;
}

function isAuthenticationFailure(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /auth|log.?in|sign.?in|unauthori[sz]ed|forbidden|invalid (?:api )?key|expired (?:token|credential)|\b401\b|\b403\b/i.test(message);
}

export class ManorModelTaskRunner implements ModelTaskRunner {
  private readonly stateDir: string;
  private readonly codexHomeDir: string;
  private readonly piAuthPath: string;
  private readonly authStatus: () => Promise<boolean>;
  private readonly codexExecutor?: (input: ResolvedModelTaskRunnerInput) => Promise<string>;
  private readonly piExecutor?: (input: ResolvedModelTaskRunnerInput) => Promise<string>;

  constructor(options: ModelTaskRunnerOptions) {
    this.stateDir = options.stateDir;
    this.codexHomeDir = options.codexHomeDir;
    this.piAuthPath = options.piAuthPath;
    this.authStatus = options.codexAuthenticated ?? (async () => Boolean(process.env.OPENAI_API_KEY?.trim()) || (await readCodexAuthStatus(path.join(this.codexHomeDir, "auth.json"))).loggedIn);
    this.codexExecutor = options.codexExecutor;
    this.piExecutor = options.piExecutor;
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
    const deadline = Date.now() + input.timeoutMs;
    const codexAuthenticated = await withinDeadline(this.authStatus(), deadline, input.purpose);
    const resolvedInput = { ...input, model: ref, deadline };
    if (modelTaskTransport(ref, codexAuthenticated) === "pi") {
      return this.piExecutor ? this.piExecutor(resolvedInput) : this.runPiInline(resolvedInput);
    }
    if (!codexAuthenticated) throw providerReconnectError("OpenAI / Codex");
    try {
      return await withinDeadline(
        this.codexExecutor ? this.codexExecutor(resolvedInput) : this.runCodexExec(resolvedInput),
        deadline,
        input.purpose
      );
    } catch (error) {
      if (isAuthenticationFailure(error)) throw providerReconnectError("OpenAI / Codex");
      throw error;
    }
  }

  private async resolvePiModel(ref: ProviderModelRef, deadline: number, purpose: string): Promise<{ model: Model<Api>; auth: Extract<PiModelAuth, { ok: true }> }> {
    const preferredModelRef = ref.provider && ref.model ? `${ref.provider}/${ref.model}` : ref.model;
    const registry = await withinDeadline(createManorModelRegistry(this.piAuthPath, process.env, {
      preferredModelRef,
      recoveryTimeoutMs: Math.max(1, Math.min(10_000, deadline - Date.now()))
    }), deadline, purpose);
    const available = registry.getAvailable();
    return selectAuthenticatedPiModel(
      available,
      ref,
      (model) => withinDeadline(registry.getApiKeyAndHeaders(model) as Promise<PiModelAuth>, deadline, purpose)
    );
  }

  private async runPiInline(input: ResolvedModelTaskRunnerInput): Promise<string> {
    const deadline = input.deadline;
    const { model, auth } = await this.resolvePiModel(input.model, deadline, input.purpose);
    const webToolSource = await selectProviderWebToolSource(model.provider);
    const baseSystemPrompt = `You are Manor's ${input.purpose} model task runner. Follow the requested output format exactly.`;
    const context = {
      systemPrompt: webToolSource ? appendProviderWebToolInstruction(baseSystemPrompt) : baseSystemPrompt,
      messages: [{ role: "user", timestamp: Date.now(), content: input.prompt }] as Message[],
      ...(webToolSource ? { tools: providerWebTools(webToolSource) } : {})
    };
    let response = await complete(model, context, {
      apiKey: auth.apiKey,
      headers: auth.headers,
      timeoutMs: remainingTimeout(deadline, input.purpose),
      maxRetries: 0
    });
    for (let round = 0; webToolSource && round < 4; round += 1) {
      const toolCalls = response.content.filter((entry): entry is ToolCall => entry.type === "toolCall" && (entry.name === PROVIDER_WEB_SEARCH_TOOL_NAME || entry.name === PROVIDER_WEB_FETCH_TOOL_NAME));
      if (response.stopReason !== "toolUse" && toolCalls.length === 0) break;
      const toolResults = await withinDeadline(
        Promise.all(toolCalls.map((toolCall) => executeProviderWebToolCall(toolCall, webToolSource))),
        deadline,
        input.purpose
      );
      context.messages = appendToolMessages(context.messages, response, toolResults);
      response = await complete(model, context, {
        apiKey: auth.apiKey,
        headers: auth.headers,
        timeoutMs: remainingTimeout(deadline, input.purpose),
        maxRetries: 0
      });
    }
    if (response.stopReason === "error" || response.stopReason === "aborted") {
      throw new Error(response.errorMessage || `Pi inline ${input.purpose} failed.`);
    }
    if (response.stopReason === "toolUse") {
      throw new Error(`Pi inline ${input.purpose} requested more web tool calls than Manor allows.`);
    }
    return contentToText(response.content).trim();
  }

  private async runCodexExec(input: ResolvedModelTaskRunnerInput): Promise<string> {
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
        }, remainingTimeout(input.deadline, input.purpose));
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
