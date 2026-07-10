const KNOWN_CODEX_MODEL_LABELS = new Map<string, string>([
  ["5.4 mini", "gpt-5.4-mini"],
  ["gpt 5.4 mini", "gpt-5.4-mini"],
  ["gpt-5.4 mini", "gpt-5.4-mini"],
  ["gpt 5.4-mini", "gpt-5.4-mini"],
  ["gpt-5.4-mini", "gpt-5.4-mini"],
  ["gpt-5.4", "gpt-5.4"],
  ["gpt-5.5", "gpt-5.5"]
]);

const MODEL_REF_PART = "[a-z][a-z0-9]*(?:[._:-][a-z0-9]+)*(?:-[a-z0-9]+)*";
const CODEX_MODEL_SLUG_PATTERN = new RegExp(`^${MODEL_REF_PART}$`, "i");
const PROVIDER_MODEL_REF_PATTERN = new RegExp(`^(${MODEL_REF_PART})\\/(\\S+)$`, "i");

function normalizeProviderModelRef(value: string): string | null {
  const match = PROVIDER_MODEL_REF_PATTERN.exec(value);
  if (!match) {
    return null;
  }
  const provider = match[1]!;
  const rawModel = match[2]!;
  let model = rawModel;
  try {
    model = decodeURIComponent(rawModel);
  } catch {
    model = rawModel;
  }
  return model && !/\s/.test(model) ? `${provider}/${model}` : null;
}

export function normalizeMemoryCodexModel(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) {
    return null;
  }
  const normalized = trimmed.replace(/\s+/g, " ");
  const known = KNOWN_CODEX_MODEL_LABELS.get(normalized.toLowerCase());
  if (known) {
    return known;
  }
  if (trimmed.includes(" ")) {
    return null;
  }
  if (CODEX_MODEL_SLUG_PATTERN.test(trimmed)) {
    return trimmed;
  }
  return normalizeProviderModelRef(trimmed);
}

export function memoryCodexModelArgs(value: string | null | undefined): string[] {
  const model = normalizeMemoryCodexModel(value);
  return model ? ["--model", model] : [];
}

export const MEMORY_CODEX_MODEL_ENV_KEYS = [
  "MANOR_MEMORY_SYNTHESIS_MODEL",
  "MANOR_MEMORY_PROMOTION_MODEL"
] as const;

export function normalizeMemoryCodexModelEnv(env: NodeJS.ProcessEnv): void {
  for (const key of MEMORY_CODEX_MODEL_ENV_KEYS) {
    if (env[key] === undefined) {
      continue;
    }
    const model = normalizeMemoryCodexModel(env[key]);
    if (model) {
      env[key] = model;
    } else {
      delete env[key];
    }
  }
}

export function isUnsupportedCodexModelError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /model[^\n]*(not supported|unsupported|unknown|not found|invalid)/i.test(message);
}
