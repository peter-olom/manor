import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

import {
  formatOpencodeWebToolResult,
  opencodeWebFetch,
  opencodeWebSearch,
  readOpencodeWebToolsConfig
} from "./opencode-web-tools.js";

const webSearchTool = defineTool({
  name: "web_search",
  label: "Web Search",
  description: "Search the web using Exa's MCP service. Use for current facts, recent events, prices, schedules, docs, or external sources.",
  promptSnippet: "web_search: search the web through Exa when current or external information is needed.",
  promptGuidelines: [
    "Use web_search before answering questions that depend on current or external information.",
    "Cite URLs from search or fetch results when they materially support the final answer."
  ],
  parameters: Type.Object({
    query: Type.String({ minLength: 1, description: "The web search query." }),
    max_results: Type.Optional(Type.Integer({ minimum: 1, maximum: 10, description: "Maximum number of results to return. Defaults to Manor's configured value; max 10." }))
  }),
  async execute(_toolCallId, params) {
    const config = readOpencodeWebToolsConfig();
    const result = await opencodeWebSearch({ query: params.query, maxResults: params.max_results ?? null }, config);
    return {
      content: [{ type: "text", text: formatOpencodeWebToolResult(result) }],
      details: result
    };
  }
});

const webFetchTool = defineTool({
  name: "web_fetch",
  label: "Web Fetch",
  description: "Fetch a specific HTTP or HTTPS page directly after a search result looks relevant.",
  promptSnippet: "web_fetch: fetch a specific URL directly after search identifies a relevant source.",
  promptGuidelines: [
    "Use web_fetch only for specific URLs that need more detail than the search snippet provides."
  ],
  parameters: Type.Object({
    url: Type.String({ minLength: 1, description: "The URL to fetch." })
  }),
  async execute(_toolCallId, params) {
    const config = readOpencodeWebToolsConfig();
    const result = await opencodeWebFetch({ url: params.url }, config);
    return {
      content: [{ type: "text", text: formatOpencodeWebToolResult(result) }],
      details: result
    };
  }
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/**
 * Restore OpenCode's native MiniMax M3 variants after Pi has produced its
 * OpenAI-compatible payload. Pi can only store fixed thinking levels, so Manor
 * maps the picker values onto transport levels and patches the final request
 * here. Pi emits `reasoning_effort: "none"` or
 * `reasoning_effort: "thinking"` as local sentinels for the provider-native
 * variants. This hook removes that sentinel before the request leaves Pi and
 * restores OpenCode's native `thinking` object.
 */
export function applyOpencodeGoNativeThinkingPayload(payload: unknown): unknown {
  if (!isRecord(payload)) return payload;
  const modelId = typeof payload.model === "string" ? payload.model.toLowerCase() : "";
  if (!modelId.includes("minimax-m3")) return payload;

  const next = { ...payload };
  const variant = typeof next.reasoning_effort === "string" ? next.reasoning_effort : null;
  delete next.reasoning_effort;
  if (variant === "none") {
    next.thinking = { type: "disabled" };
  } else if (variant === "thinking") {
    next.thinking = { type: "adaptive" };
  } else {
    delete next.thinking;
  }
  return next;
}

export default async function opencodeWebToolsExtension(pi: ExtensionAPI): Promise<void> {
  const config = readOpencodeWebToolsConfig();
  pi.on("before_provider_request", (event) => applyOpencodeGoNativeThinkingPayload(event.payload));
  if (config.enabled) {
    pi.registerTool(webSearchTool);
    pi.registerTool(webFetchTool);
  }
}
