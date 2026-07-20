import { Type, type Tool } from "@earendil-works/pi-ai";

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
  content: string;
};

export type OpencodeWebFetchResponse = {
  title: string;
  url: string;
  contentType: string;
  content: string;
};

type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

export const OPENCODE_WEB_SEARCH_TOOL_NAME = "web_search";
export const OPENCODE_WEB_FETCH_TOOL_NAME = "web_fetch";

export const OPENCODE_WEB_SEARCH_TOOL: Tool = {
  name: OPENCODE_WEB_SEARCH_TOOL_NAME,
  description: "Search the web using Exa's MCP service. Results use a structured Content Admission Review envelope and may be warned or withheld.",
  parameters: Type.Object({
    query: Type.String({ minLength: 1, description: "The web search query." }),
    max_results: Type.Optional(Type.Integer({ minimum: 1, maximum: 10, description: "Maximum number of results to return. Defaults to Manor's configured value; max 10." }))
  }) as never
};

export const OPENCODE_WEB_FETCH_TOOL: Tool = {
  name: OPENCODE_WEB_FETCH_TOOL_NAME,
  description: "Fetch a specific HTTP or HTTPS page after a search result looks relevant. Results use a structured Content Admission Review envelope and may be warned or withheld.",
  parameters: Type.Object({
    url: Type.String({ minLength: 1, description: "The URL to fetch." })
  }) as never
};

const EXA_MCP_URL = "https://mcp.exa.ai/mcp";
const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;
const MAX_REDIRECTS = 5;
const SEARCH_TIMEOUT_MAX_MS = 25_000;
const FETCH_TIMEOUT_MAX_MS = 120_000;
const BROWSER_USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36";

class MalformedMcpResponseError extends Error {}

function clampInteger(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

function truncateText(value: string, maxChars: number): string {
  return value.length <= maxChars ? value : `${value.slice(0, Math.max(0, maxChars - 15))}\n[truncated]`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

async function readResponseTextWithinLimit(response: Response, label: string): Promise<string> {
  const declaredLength = Number(response.headers.get("content-length") ?? "");
  if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) {
    throw new Error(`${label} response too large (exceeds ${MAX_RESPONSE_BYTES} bytes).`);
  }

  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      totalBytes += value.byteLength;
      if (totalBytes > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new Error(`${label} response too large (exceeds ${MAX_RESPONSE_BYTES} bytes).`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

async function withRequestTimeout<T>(label: string, timeoutMs: number, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  let timer: NodeJS.Timeout | null = null;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`${label} request timed out after ${timeoutMs}ms.`));
      controller.abort();
    }, timeoutMs);
  });
  try {
    return await Promise.race([work(controller.signal), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function mcpProviderError(value: unknown): Error | null {
  if (!isRecord(value) || !isRecord(value.error)) return null;
  return new Error("Exa web_search provider returned an error.");
}

function parseMcpPayload(payload: string): string {
  let value: unknown;
  try {
    value = JSON.parse(payload);
  } catch {
    throw new MalformedMcpResponseError("Exa web_search returned malformed JSON-RPC data.");
  }
  const providerError = mcpProviderError(value);
  if (providerError) throw providerError;
  if (!isRecord(value) || !isRecord(value.result) || !Array.isArray(value.result.content)) {
    throw new MalformedMcpResponseError("Exa web_search returned a malformed MCP response.");
  }
  const text = value.result.content
    .filter(isRecord)
    .map((item) => typeof item.text === "string" ? item.text : "")
    .find(Boolean) ?? "";
  if (value.result.isError === true) {
    throw new Error("Exa web_search provider returned an error.");
  }
  return text || "No search results found. Please try a different query.";
}

function parseMcpResponse(body: string): string {
  const trimmed = body.trim();
  if (trimmed.startsWith("{")) return parseMcpPayload(trimmed);
  const dataLines = body.split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trim())
    .filter((line) => line && line !== "[DONE]");
  if (dataLines.length === 0) throw new MalformedMcpResponseError("Exa web_search returned a malformed MCP response.");
  let malformed: Error | null = null;
  for (const line of dataLines) {
    try {
      return parseMcpPayload(line);
    } catch (error) {
      if (!(error instanceof MalformedMcpResponseError)) throw error;
      malformed = error instanceof Error ? error : new Error(String(error));
    }
  }
  throw malformed ?? new MalformedMcpResponseError("Exa web_search returned a malformed MCP response.");
}

function structuredSearchResults(content: string): OpencodeWebSearchResult[] {
  if (content === "No search results found. Please try a different query.") return [];
  const blocks = content.split(/\n(?=Title:\s)/).map((block) => block.trim()).filter(Boolean);
  return blocks.map((block) => ({
    title: block.match(/(?:^|\n)Title:\s*(.*)/)?.[1]?.trim() ?? "",
    url: block.match(/(?:^|\n)URL:\s*(\S+)/)?.[1]?.trim() ?? "",
    content: block
  }));
}

function parseFetchUrl(rawUrl: string): URL {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error("web_fetch URL is invalid.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("web_fetch URL must start with http:// or https://.");
  }
  if (url.username || url.password) throw new Error("web_fetch URL cannot include credentials.");
  return url;
}

function decodeHtmlEntities(value: string): string {
  const decodeCodePoint = (match: string, raw: string, radix: number) => {
    const codePoint = Number.parseInt(raw, radix);
    return Number.isInteger(codePoint) && codePoint >= 0 && codePoint <= 0x10ffff && !(codePoint >= 0xd800 && codePoint <= 0xdfff)
      ? String.fromCodePoint(codePoint)
      : match;
  };
  return value
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, "\"")
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (match, value: string) => decodeCodePoint(match, value, 10))
    .replace(/&#x([0-9a-f]+);/gi, (match, value: string) => decodeCodePoint(match, value, 16));
}

function htmlTitle(html: string): string {
  const match = html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i);
  return match ? decodeHtmlEntities(match[1].replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim()) : "";
}

function htmlToText(html: string): string {
  return decodeHtmlEntities(html
    .replace(/<(script|style|noscript|iframe|object|embed)\b[^>]*>[\s\S]*?<\/\1>/gi, "")
    .replace(/<(br|\/p|\/div|\/li|\/h[1-6]|\/tr|\/section|\/article)>/gi, "\n")
    .replace(/<[^>]*>/g, " "))
    .replace(/[ \t]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function isTextContentType(contentType: string): boolean {
  const mime = contentType.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  return !mime || mime.startsWith("text/") || mime.includes("json") || mime.includes("xml") || mime.includes("javascript") || mime.includes("yaml");
}

async function fetchDirectUrl(url: URL, signal: AbortSignal, fetchImpl: FetchLike, redirects = 0): Promise<OpencodeWebFetchResponse> {
  const request = (userAgent: string) => fetchImpl(url, {
    method: "GET",
    headers: {
      "user-agent": userAgent,
      accept: "text/markdown;q=1.0, text/plain;q=0.9, text/html;q=0.8, application/json;q=0.7, */*;q=0.1",
      "accept-language": "en-US,en;q=0.9"
    },
    redirect: "manual",
    signal
  });
  let response = await request(BROWSER_USER_AGENT);
  if (response.status === 403 && response.headers.get("cf-mitigated") === "challenge") {
    await response.body?.cancel().catch(() => undefined);
    response = await request("opencode");
  }
  if ([301, 302, 303, 307, 308].includes(response.status)) {
    if (redirects >= MAX_REDIRECTS) throw new Error(`web_fetch exceeded ${MAX_REDIRECTS} redirects.`);
    const location = response.headers.get("location");
    if (!location) throw new Error(`web_fetch redirect ${response.status} did not include a location.`);
    return fetchDirectUrl(parseFetchUrl(new URL(location, url).toString()), signal, fetchImpl, redirects + 1);
  }

  const body = await readResponseTextWithinLimit(response, "web_fetch");
  if (!response.ok) {
    throw new Error(`web_fetch failed with HTTP ${response.status}.`);
  }
  const contentType = response.headers.get("content-type") ?? "";
  if (!isTextContentType(contentType)) {
    throw new Error("web_fetch returned an unsupported content type.");
  }
  const finalUrl = response.url || url.toString();
  const isHtml = contentType.toLowerCase().includes("text/html");
  return {
    title: isHtml ? htmlTitle(body) || finalUrl : finalUrl,
    url: finalUrl,
    contentType,
    content: isHtml ? htmlToText(body) : body
  };
}

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

export async function opencodeWebSearch(
  input: { query: string; maxResults?: number | null },
  config: OpencodeWebToolsConfig,
  fetchImpl: FetchLike = fetch
): Promise<OpencodeWebSearchResponse> {
  if (!config.enabled) throw new Error("OpenCode web tools are not enabled.");
  const query = input.query.trim();
  if (!query) throw new Error("web_search query is required.");
  const maxResults = clampInteger(input.maxResults ?? config.maxResults, 1, 10);
  return withRequestTimeout("web_search", Math.min(config.timeoutMs, SEARCH_TIMEOUT_MAX_MS), async (signal) => {
    const response = await fetchImpl(EXA_MCP_URL, {
      method: "POST",
      headers: {
        accept: "application/json, text/event-stream",
        "content-type": "application/json"
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "web_search_exa",
          arguments: {
            query,
            type: "auto",
            numResults: maxResults,
            livecrawl: "fallback",
            contextMaxCharacters: config.maxContentChars
          }
        }
      }),
      signal
    });
    const body = await readResponseTextWithinLimit(response, "web_search");
    if (!response.ok) {
      throw new Error(`Exa web_search failed with HTTP ${response.status}.`);
    }
    const content = truncateText(parseMcpResponse(body), config.maxContentChars);
    return { content, results: structuredSearchResults(content) };
  });
}

export async function opencodeWebFetch(
  input: { url: string },
  config: OpencodeWebToolsConfig,
  fetchImpl: FetchLike = fetch
): Promise<OpencodeWebFetchResponse> {
  if (!config.enabled) throw new Error("OpenCode web tools are not enabled.");
  const url = input.url.trim();
  if (!url) throw new Error("web_fetch url is required.");
  const parsedUrl = parseFetchUrl(url);
  const result = await withRequestTimeout("web_fetch", Math.min(config.timeoutMs, FETCH_TIMEOUT_MAX_MS), (signal) => fetchDirectUrl(parsedUrl, signal, fetchImpl));
  return { ...result, content: truncateText(result.content, config.maxContentChars) };
}

export function formatOpencodeWebToolResult(result: OpencodeWebSearchResponse | OpencodeWebFetchResponse): string {
  return result.content;
}

export function opencodeWebTools(): Tool[] {
  return [OPENCODE_WEB_SEARCH_TOOL, OPENCODE_WEB_FETCH_TOOL];
}
