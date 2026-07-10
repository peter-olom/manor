import { getActiveManorSettings } from "./manor-settings-runtime.js";
import { normalizeMemoryCodexModel } from "./memory-codex-model.js";

type SessionTitleRunner = (input: { prompt: string; timeoutMs: number; model: string | null; cwd: string | null }) => Promise<unknown>;

export type SessionTitleGenerator = {
  generateTitle(input: { firstUserPrompt: string; cwd?: string | null }): Promise<string | null>;
};

type ManorSessionTitleGeneratorOptions = {
  model?: string | null;
  timeoutMs?: number;
  runner: SessionTitleRunner;
};

const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_INPUT_CHARS = 4_000;
const MODEL_REF_PATTERN = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*(?:-[a-z0-9]+)*(?:\/[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*(?:-[a-z0-9]+)*)?$/i;
const TITLE_PROMPT = [
  "Create a concise session title from the user's first prompt.",
  "Rules:",
  "- Four words or fewer.",
  "- Return JSON only with key title.",
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

export function normalizeSessionTitleModel(value: string | null | undefined): string | null {
  const normalized = normalizeMemoryCodexModel(value);
  if (normalized) return normalized;
  const trimmed = value?.trim();
  if (!trimmed || trimmed.includes(" ") || !MODEL_REF_PATTERN.test(trimmed)) {
    return null;
  }
  return trimmed;
}

export function readSessionTitleConfig(env: NodeJS.ProcessEnv = process.env): { model: string | null; timeoutMs: number } {
  const settings = getActiveManorSettings(env);
  return {
    model: normalizeSessionTitleModel(settings.modelTasks.sessionTitleModel),
    timeoutMs: clampTimeout(settings.modelTasks.sessionTitleTimeoutMs)
  };
}

export class ManorSessionTitleGenerator implements SessionTitleGenerator {
  private model: string | null;
  private timeoutMs: number;
  private readonly runner: SessionTitleRunner;

  constructor(options: ManorSessionTitleGeneratorOptions) {
    this.model = normalizeSessionTitleModel(options.model);
    this.timeoutMs = clampTimeout(options.timeoutMs);
    this.runner = options.runner;
  }

  applySettings(config = readSessionTitleConfig()): void {
    this.model = normalizeSessionTitleModel(config.model);
    this.timeoutMs = clampTimeout(config.timeoutMs);
  }

  async generateTitle(input: { firstUserPrompt: string; cwd?: string | null }): Promise<string | null> {
    const prompt = input.firstUserPrompt.trim();
    if (!prompt) {
      return null;
    }
    let raw: unknown;
    try {
      raw = await this.runner({
        prompt: `${TITLE_PROMPT}\n\nFirst user prompt:\n${prompt.slice(0, MAX_INPUT_CHARS)}`,
        timeoutMs: this.timeoutMs,
        model: this.model,
        cwd: input.cwd ?? null
      });
    } catch (error) {
      console.warn("Session title model failed; using prompt fallback", error instanceof Error ? error.message : String(error));
      return fallbackSessionTitle(prompt);
    }
    try {
      const text = typeof raw === "string" ? raw : JSON.stringify(raw ?? {});
      return parseTitleOutput(text, prompt);
    } catch {
      return fallbackSessionTitle(prompt);
    }
  }
}
