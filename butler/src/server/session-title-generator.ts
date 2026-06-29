import { complete, type Model } from "@mariozechner/pi-ai";
import { AuthStorage, ModelRegistry } from "@mariozechner/pi-coding-agent";

import { contentToText } from "./butler-agent-helpers.js";
import { isUnsupportedCodexModelError, normalizeMemoryCodexModel } from "./memory-codex-model.js";

type SessionTitleRunner = (input: { prompt: string; timeoutMs: number }) => Promise<unknown>;

export type SessionTitleGenerator = {
  generateTitle(input: { firstUserPrompt: string; cwd?: string | null }): Promise<string | null>;
};

type PiSessionTitleGeneratorOptions = {
  piAuthPath: string;
  model?: string | null;
  timeoutMs?: number;
  runner?: SessionTitleRunner;
  modelRegistry?: ModelRegistry;
};

const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_INPUT_CHARS = 4_000;
const DEFAULT_TITLE_MODEL_IDS = ["gpt-5.4-mini", "gpt-5.4", "gpt-5.5"];
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
  const timeout = Number(env.MANOR_SESSION_TITLE_TIMEOUT_MS);
  return {
    model: normalizeSessionTitleModel(env.MANOR_SESSION_TITLE_MODEL ?? env.MANOR_MEMORY_SYNTHESIS_MODEL),
    timeoutMs: clampTimeout(timeout)
  };
}

function titleModelPreference(model: Model<any>): number {
  if (model.provider === "openai-codex") return 0;
  if (model.provider === "openai") return 1;
  return 2;
}

function sortTitleModels(models: Model<any>[]): Model<any>[] {
  return [...models].sort((a, b) => {
    const aDefault = DEFAULT_TITLE_MODEL_IDS.indexOf(a.id);
    const bDefault = DEFAULT_TITLE_MODEL_IDS.indexOf(b.id);
    const aRank = aDefault === -1 ? DEFAULT_TITLE_MODEL_IDS.length : aDefault;
    const bRank = bDefault === -1 ? DEFAULT_TITLE_MODEL_IDS.length : bDefault;
    return aRank - bRank || titleModelPreference(a) - titleModelPreference(b);
  });
}

export class PiSessionTitleGenerator implements SessionTitleGenerator {
  private readonly model: string | null;
  private readonly timeoutMs: number;
  private readonly runner: SessionTitleRunner;
  private modelRegistry: ModelRegistry | null = null;

  constructor(private readonly options: PiSessionTitleGeneratorOptions) {
    this.model = normalizeSessionTitleModel(options.model);
    this.timeoutMs = clampTimeout(options.timeoutMs);
    this.runner = options.runner ?? ((input) => this.runPiCompletion(input));
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
        timeoutMs: this.timeoutMs
      });
    } catch (error) {
      return fallbackSessionTitle(prompt);
    }
    try {
      const text = typeof raw === "string" ? raw : JSON.stringify(raw ?? {});
      return parseTitleOutput(text, prompt);
    } catch {
      return fallbackSessionTitle(prompt);
    }
  }

  private getModelRegistry(): ModelRegistry {
    this.modelRegistry ??= this.options.modelRegistry ?? ModelRegistry.inMemory(AuthStorage.create(this.options.piAuthPath));
    return this.modelRegistry;
  }

  private resolveModels(): Model<any>[] {
    const registry = this.getModelRegistry();
    const available = registry.getAvailable();
    const models: Model<any>[] = [];
    if (this.model) {
      const requested = this.model;
      const requestedModels = available.filter((model) => model.id === requested || `${model.provider}/${model.id}` === requested);
      models.push(...sortTitleModels(requestedModels));
    }
    for (const model of sortTitleModels(available)) {
      if (!models.some((candidate) => candidate.provider === model.provider && candidate.id === model.id)) {
        models.push(model);
      }
    }
    if (models.length === 0) {
      throw new Error("No Butler model is available for session title generation.");
    }
    return models;
  }

  private async runPiCompletion(input: { prompt: string; timeoutMs: number }): Promise<string> {
    const registry = this.getModelRegistry();
    const errors: unknown[] = [];
    for (const model of this.resolveModels()) {
      const auth = await registry.getApiKeyAndHeaders(model);
      if (!auth.ok) {
        errors.push(new Error(auth.error));
        continue;
      }

      const response = await complete(
        model,
        {
          systemPrompt: "You generate short UI session titles. Return compact valid JSON only.",
          messages: [{ role: "user", timestamp: Date.now(), content: input.prompt }]
        },
        {
          apiKey: auth.apiKey,
          headers: auth.headers,
          timeoutMs: input.timeoutMs,
          maxRetries: 0
        }
      );

      if (response.stopReason !== "error" && response.stopReason !== "aborted") {
        return contentToText(response.content);
      }

      const error = new Error(response.errorMessage || "Butler session title generation failed.");
      if (!isUnsupportedCodexModelError(error)) throw error;
      errors.push(error);
    }

    throw errors[errors.length - 1] ?? new Error("Butler session title generation failed.");
  }
}
