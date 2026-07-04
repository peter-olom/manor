export type OllamaLocalModelInfo = {
  id: string;
  contextWindow: number | null;
  capabilities: string[];
};

type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object";
}

function stringField(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0).map((entry) => entry.trim()) : [];
}

export function nativeOllamaBaseUrl(value: string): string {
  return value.trim().replace(/\/+$/, "").replace(/\/v1$/i, "");
}

export function normalizeOllamaModelName(value: unknown): string {
  const model = typeof value === "string" ? value.trim() : "";
  if (!model) throw new Error("Model name is required.");
  if (model.length > 220) throw new Error("Model name is too long.");
  if (/[\s"'`\\]/.test(model)) throw new Error("Model name cannot contain spaces, quotes, or backslashes.");
  return model;
}

function isPrivateIpv4(hostname: string): boolean {
  const parts = hostname.split(".").map((part) => Number(part));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return false;
  }
  const [first, second] = parts as [number, number, number, number];
  return first === 10 ||
    first === 127 ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168) ||
    (first === 169 && second === 254);
}

function isPrivateIpv6(hostname: string): boolean {
  if (!hostname.includes(":")) return false;
  return hostname === "::1" ||
    hostname === "0:0:0:0:0:0:0:1" ||
    hostname.startsWith("fc") ||
    hostname.startsWith("fd") ||
    hostname.startsWith("fe80:");
}

function isAllowedOllamaLocalHost(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[/, "").replace(/\]$/, "");
  return normalized === "localhost" ||
    normalized === "ollama" ||
    normalized === "host.docker.internal" ||
    normalized.endsWith(".local") ||
    isPrivateIpv4(normalized) ||
    isPrivateIpv6(normalized);
}

export function assertOllamaLocalBaseUrl(value: string, label = "Ollama Local URL"): string {
  const normalized = value.trim().replace(/\/+$/, "");
  let parsed: URL;
  try {
    parsed = new URL(normalized);
  } catch {
    throw new Error(`${label} must be a valid URL.`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`${label} must use HTTP or HTTPS.`);
  }
  if (!isAllowedOllamaLocalHost(parsed.hostname)) {
    throw new Error(`${label} must point to loopback, the bundled Ollama service, host.docker.internal, mDNS .local, or a private network address.`);
  }
  return normalized;
}

function contextWindowFromModelInfo(value: unknown): number | null {
  const info = isRecord(value) ? value : {};
  for (const key of Object.keys(info)) {
    if (!key.endsWith(".context_length")) continue;
    const candidate = info[key];
    if (typeof candidate === "number" && Number.isFinite(candidate)) return candidate;
  }
  return null;
}

function isChatCapable(capabilities: string[]): boolean {
  return capabilities.length === 0 || capabilities.includes("completion") || capabilities.includes("vision");
}

async function fetchJson<T>(url: string, init: RequestInit, timeoutMs: number, fetchImpl: FetchLike): Promise<{ ok: boolean; status: number; data: T | null; text: string }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, { ...init, signal: controller.signal });
    const text = await response.text().catch(() => "");
    let data: T | null = null;
    try { data = text ? JSON.parse(text) as T : null; } catch { /* keep null */ }
    return { ok: response.ok, status: response.status, data, text };
  } finally {
    clearTimeout(timeout);
  }
}

export async function fetchOllamaLocalModels(
  input: { nativeBaseUrl: string; timeoutMs?: number },
  fetchImpl: FetchLike = fetch
): Promise<OllamaLocalModelInfo[]> {
  const base = assertOllamaLocalBaseUrl(nativeOllamaBaseUrl(input.nativeBaseUrl), "Ollama Local native base URL");
  const timeoutMs = input.timeoutMs ?? 5_000;
  const tagsRes = await fetchJson<{ models?: { name?: string; model?: string }[] }>(`${base}/api/tags`, { method: "GET" }, timeoutMs, fetchImpl);
  if (!tagsRes.ok || !tagsRes.data?.models) {
    throw new Error(`Failed to list Ollama Local models (HTTP ${tagsRes.status}): ${tagsRes.text.slice(0, 800)}`);
  }

  const names = Array.from(new Set(tagsRes.data.models
    .map((entry) => stringField(entry.name) ?? stringField(entry.model))
    .filter((entry): entry is string => Boolean(entry))));

  const infos = await Promise.all(names.map(async (name) => {
    try {
      const showRes = await fetchJson<{ capabilities?: string[]; model_info?: Record<string, unknown> }>(`${base}/api/show`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: name })
      }, timeoutMs, fetchImpl);
      if (!showRes.ok) return null;
      const capabilities = stringArray(showRes.data?.capabilities);
      return {
        id: name,
        capabilities,
        contextWindow: contextWindowFromModelInfo(showRes.data?.model_info)
      };
    } catch {
      return null;
    }
  }));

  return infos
    .filter((model): model is OllamaLocalModelInfo => Boolean(model))
    .filter((model) => isChatCapable(model.capabilities));
}
