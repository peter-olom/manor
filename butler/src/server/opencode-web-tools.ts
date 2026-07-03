import { Type, type Tool } from "@mariozechner/pi-ai";

import { getActiveManorSettings } from "./manor-settings-runtime.js";

export type OpencodeWebToolsConfig = {
  enabled: boolean;
  maxResults: number;
  timeoutMs: number;
  maxContentChars: number;
};

export type OpencodeWebSearchResult = {
  title: string;
  url: string;
  content: string;
};

export type OpencodeWebSearchResponse = {
  results: OpencodeWebSearchResult[];
};

export type OpencodeWebFetchResponse = {
  title: string;
  content: string;
};

type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

export const OPENCODE_WEB_SEARCH_TOOL_NAME = "web_search";
export const OPENCODE_WEB_FETCH_TOOL_NAME = "web_fetch";

export const OPENCODE_WEB_SEARCH_TOOL: Tool = {
  name: OPENCODE_WEB_SEARCH_TOOL_NAME,
  description: "Search the web using Exa AI. Use this for current facts, recent events, prices, schedules, docs, or external sources.",
  parameters: Type.Object({
    query: Type.String({ description: "The web search query." }),
    max_results: Type.Optional(Type.Number({ description: "Maximum number of results to return. Defaults to Manor's configured value; max 10." }))
  }) as never
};

export const OPENCODE_WEB_FETCH_TOOL: Tool = {
  name: OPENCODE_WEB_FETCH_TOOL_NAME,
  description: "Fetch a web page using Exa AI after a search result looks relevant.",
  parameters: Type.Object({
    url: Type.String({ description: "The URL to fetch." })
  }) as never
};

function clampInteger(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

function truncateText(value: string, maxChars: number): string {
  return value.length <= maxChars ? value : `${value.slice(0, Math.max(0, maxChars - 15))}\n[truncated]`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object";
}

function textField(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function normalizeSearchResponse(value: unknown, maxContentChars: number): OpencodeWebSearchResponse {
  const results = isRecord(value) && Array.isArray(value.results) ? value.results : [];
  return {
    results: results.map((entry) => ({
      title: isRecord(entry) ? textField(entry.title) : "",
      url: isRecord(entry) ? textField(entry.url) : "",
      content: truncateText(isRecord(entry) ? (textField(entry.text) || textField(entry.highlight)) : "", maxContentChars)
    })).filter((entry) => entry.title || entry.url || entry.content)
  };
}

function normalizeFetchResponse(value: unknown, maxContentChars: number): OpencodeWebFetchResponse {
  const results = isRecord(value) && Array.isArray(value.results) ? value.results : [];
  const first = results.length > 0 && isRecord(results[0]) ? results[0] : {};
  return {
    title: textField(first.title),
    content: truncateText(textField(first.text), maxContentChars)
  };
}

const EXA_SEARCH_URL = "https://api.exa.ai/search";
const EXA_CONTENTS_URL = "https://api.exa.ai/contents";

export function readOpencodeWebToolsConfig(env: NodeJS.ProcessEnv = process.env): OpencodeWebToolsConfig {
  const settings = getActiveManorSettings(env);
  const webTools = settings.providers.opencodeGo.webTools;
  return {
    enabled: webTools.enabled,
    maxResults: webTools.maxResults,
    timeoutMs: webTools.timeoutMs,
    maxContentChars: webTools.maxContentChars
  };
}

export function shouldAttachOpencodeWebTools(modelProvider: string | null | undefined, env: NodeJS.ProcessEnv = process.env): boolean {
  const settings = getActiveManorSettings(env);
  if (!settings.providers.opencodeGo.webTools.enabled) return false;
  return modelProvider === settings.providers.opencodeGo.providerId;
}

async function postExa<T>(endpoint: string, body: Record<string, unknown>, config: OpencodeWebToolsConfig, fetchImpl: FetchLike = fetch): Promise<T> {
  if (!config.enabled) {
    throw new Error("OpenCode web tools are not enabled.");
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.timeoutMs);
  try {
    const response = await fetchImpl(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal
    });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`Exa ${endpoint} failed with HTTP ${response.status}: ${text.slice(0, 1_000)}`);
    }
    return (text.trim() ? JSON.parse(text) : {}) as T;
  } finally {
    clearTimeout(timeout);
  }
}

export async function opencodeWebSearch(
  input: { query: string; maxResults?: number | null },
  config: OpencodeWebToolsConfig,
  fetchImpl?: FetchLike
): Promise<OpencodeWebSearchResponse> {
  const query = input.query.trim();
  if (!query) throw new Error("web_search query is required.");
  const maxResults = clampInteger(input.maxResults ?? config.maxResults, 1, 10);
  const response = await postExa<unknown>(EXA_SEARCH_URL, {
    query,
    numResults: maxResults,
    contents: { text: { maxCharacters: config.maxContentChars }, highlights: true }
  }, config, fetchImpl);
  return normalizeSearchResponse(response, config.maxContentChars);
}

export async function opencodeWebFetch(
  input: { url: string },
  config: OpencodeWebToolsConfig,
  fetchImpl?: FetchLike
): Promise<OpencodeWebFetchResponse> {
  const url = input.url.trim();
  if (!url) throw new Error("web_fetch url is required.");
  const response = await postExa<unknown>(EXA_CONTENTS_URL, {
    urls: [url],
    text: { maxCharacters: config.maxContentChars }
  }, config, fetchImpl);
  return normalizeFetchResponse(response, config.maxContentChars);
}

export function formatOpencodeWebToolResult(result: OpencodeWebSearchResponse | OpencodeWebFetchResponse): string {
  return JSON.stringify(result, null, 2);
}

export function opencodeWebTools(): Tool[] {
  return [OPENCODE_WEB_SEARCH_TOOL, OPENCODE_WEB_FETCH_TOOL];
}