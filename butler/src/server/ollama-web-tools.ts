import { Type, type Message, type Tool, type ToolCall, type ToolResultMessage } from "@mariozechner/pi-ai";

import { getActiveManorSettings, readSecretSourceValue } from "./manor-settings-runtime.js";

export type OllamaWebToolsConfig = {
  enabled: boolean;
  apiKey: string | null;
  baseUrl: string;
  maxResults: number;
  timeoutMs: number;
  maxContentChars: number;
};

export type OllamaWebSearchResult = {
  title: string;
  url: string;
  content: string;
};

export type OllamaWebSearchResponse = {
  results: OllamaWebSearchResult[];
};

export type OllamaWebFetchResponse = {
  title: string;
  content: string;
  links: string[];
};

type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

export const OLLAMA_WEB_SEARCH_TOOL_NAME = "web_search";
export const OLLAMA_WEB_FETCH_TOOL_NAME = "web_fetch";

export const OLLAMA_WEB_SEARCH_TOOL: Tool = {
  name: OLLAMA_WEB_SEARCH_TOOL_NAME,
  description: "Search the web using Ollama Cloud web search. Use this for current facts, recent events, prices, schedules, docs, or external sources.",
  parameters: Type.Object({
    query: Type.String({ description: "The web search query." }),
    max_results: Type.Optional(Type.Number({ description: "Maximum number of results to return. Defaults to Manor's configured value; max 10." }))
  }) as never
};

export const OLLAMA_WEB_FETCH_TOOL: Tool = {
  name: OLLAMA_WEB_FETCH_TOOL_NAME,
  description: "Fetch a web page through Ollama Cloud web fetch after a search result looks relevant.",
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

function normalizeSearchResponse(value: unknown, maxContentChars: number): OllamaWebSearchResponse {
  const results = isRecord(value) && Array.isArray(value.results) ? value.results : [];
  return {
    results: results.map((entry) => ({
      title: isRecord(entry) ? textField(entry.title) : "",
      url: isRecord(entry) ? textField(entry.url) : "",
      content: truncateText(isRecord(entry) ? textField(entry.content) : "", maxContentChars)
    })).filter((entry) => entry.title || entry.url || entry.content)
  };
}

function normalizeFetchResponse(value: unknown, maxContentChars: number): OllamaWebFetchResponse {
  const links = isRecord(value) && Array.isArray(value.links) ? value.links.filter((entry): entry is string => typeof entry === "string") : [];
  return {
    title: isRecord(value) ? textField(value.title) : "",
    content: truncateText(isRecord(value) ? textField(value.content) : "", maxContentChars),
    links
  };
}

export async function readOllamaWebToolsConfig(env: NodeJS.ProcessEnv = process.env): Promise<OllamaWebToolsConfig> {
  const settings = getActiveManorSettings(env);
  const webTools = settings.providers.ollamaWebTools;
  const apiKey = webTools.enabled ? await readSecretSourceValue(webTools.apiKeySource, env) : null;
  return {
    enabled: webTools.enabled && Boolean(apiKey),
    apiKey,
    baseUrl: webTools.baseUrl,
    maxResults: webTools.maxResults,
    timeoutMs: webTools.timeoutMs,
    maxContentChars: webTools.maxContentChars
  };
}

export function shouldAttachOllamaWebTools(modelProvider: string | null | undefined, env: NodeJS.ProcessEnv = process.env): boolean {
  const settings = getActiveManorSettings(env);
  if (!settings.providers.ollamaWebTools.enabled) return false;
  if (settings.providers.ollamaWebTools.forAllPiModels) return true;
  return modelProvider === settings.providers.ollamaCloud.providerId;
}

async function postOllamaWebEndpoint<T>(
  config: OllamaWebToolsConfig,
  endpoint: "web_search" | "web_fetch",
  body: Record<string, unknown>,
  fetchImpl: FetchLike = fetch
): Promise<T> {
  if (!config.enabled || !config.apiKey) {
    throw new Error("Ollama web tools are not configured. Set OLLAMA_API_KEY or OLLAMA_API_KEY_FILE.");
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.timeoutMs);
  try {
    const response = await fetchImpl(`${config.baseUrl}/${endpoint}`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${config.apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(body),
      signal: controller.signal
    });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`Ollama ${endpoint} failed with HTTP ${response.status}: ${text.slice(0, 1_000)}`);
    }
    return (text.trim() ? JSON.parse(text) : {}) as T;
  } finally {
    clearTimeout(timeout);
  }
}

export async function ollamaWebSearch(
  input: { query: string; maxResults?: number | null },
  config: OllamaWebToolsConfig,
  fetchImpl?: FetchLike
): Promise<OllamaWebSearchResponse> {
  const query = input.query.trim();
  if (!query) throw new Error("web_search query is required.");
  const maxResults = clampInteger(input.maxResults ?? config.maxResults, 1, 10);
  const response = await postOllamaWebEndpoint<unknown>(config, "web_search", { query, max_results: maxResults }, fetchImpl);
  return normalizeSearchResponse(response, config.maxContentChars);
}

export async function ollamaWebFetch(
  input: { url: string },
  config: OllamaWebToolsConfig,
  fetchImpl?: FetchLike
): Promise<OllamaWebFetchResponse> {
  const url = input.url.trim();
  if (!url) throw new Error("web_fetch url is required.");
  const response = await postOllamaWebEndpoint<unknown>(config, "web_fetch", { url }, fetchImpl);
  return normalizeFetchResponse(response, config.maxContentChars);
}

export function formatOllamaWebToolResult(result: OllamaWebSearchResponse | OllamaWebFetchResponse): string {
  return JSON.stringify(result, null, 2);
}

export function ollamaWebTools(): Tool[] {
  return [OLLAMA_WEB_SEARCH_TOOL, OLLAMA_WEB_FETCH_TOOL];
}

export async function executeOllamaWebToolCall(toolCall: ToolCall, config: OllamaWebToolsConfig): Promise<ToolResultMessage> {
  try {
    const args = isRecord(toolCall.arguments) ? toolCall.arguments : {};
    const result = toolCall.name === OLLAMA_WEB_SEARCH_TOOL_NAME
      ? await ollamaWebSearch({
        query: textField(args.query),
        maxResults: typeof args.max_results === "number" ? args.max_results : null
      }, config)
      : toolCall.name === OLLAMA_WEB_FETCH_TOOL_NAME
        ? await ollamaWebFetch({ url: textField(args.url) }, config)
        : null;
    if (!result) {
      throw new Error(`Unsupported Ollama web tool: ${toolCall.name}`);
    }
    return {
      role: "toolResult",
      toolCallId: toolCall.id,
      toolName: toolCall.name,
      content: [{ type: "text", text: formatOllamaWebToolResult(result) }],
      details: result,
      isError: false,
      timestamp: Date.now()
    };
  } catch (error) {
    return {
      role: "toolResult",
      toolCallId: toolCall.id,
      toolName: toolCall.name,
      content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
      isError: true,
      timestamp: Date.now()
    };
  }
}

export function appendOllamaWebToolInstruction(systemPrompt: string): string {
  return [
    systemPrompt,
    "When current or external information is needed, use web_search first. Use web_fetch only for a specific URL that needs more detail. Cite URLs from tool results in the final answer when they materially support the response."
  ].join("\n\n");
}

export function appendToolMessages(messages: Message[], assistant: Message, toolResults: ToolResultMessage[]): Message[] {
  return [...messages, assistant, ...toolResults];
}
