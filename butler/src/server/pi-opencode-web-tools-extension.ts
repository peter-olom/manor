import { Type } from "@mariozechner/pi-ai";
import { defineTool, type ExtensionAPI } from "@mariozechner/pi-coding-agent";

import {
  formatOpencodeWebToolResult,
  opencodeWebFetch,
  opencodeWebSearch,
  readOpencodeWebToolsConfig
} from "./opencode-web-tools.js";

const webSearchTool = defineTool({
  name: "web_search",
  label: "Web Search",
  description: "Search the web using Exa AI. Use for current facts, recent events, prices, schedules, docs, or external sources.",
  promptSnippet: "web_search: search the web through Exa AI when current or external information is needed.",
  promptGuidelines: [
    "Use web_search before answering questions that depend on current or external information.",
    "Cite URLs from search or fetch results when they materially support the final answer."
  ],
  parameters: Type.Object({
    query: Type.String({ description: "The web search query." }),
    max_results: Type.Optional(Type.Number({ description: "Maximum number of results to return. Defaults to Manor's configured value; max 10." }))
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
  description: "Fetch a web page through Exa AI after a search result looks relevant.",
  promptSnippet: "web_fetch: fetch a specific URL through Exa AI after search identifies a relevant source.",
  promptGuidelines: [
    "Use web_fetch only for specific URLs that need more detail than the search snippet provides."
  ],
  parameters: Type.Object({
    url: Type.String({ description: "The URL to fetch." })
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

export default async function opencodeWebToolsExtension(pi: ExtensionAPI): Promise<void> {
  const config = readOpencodeWebToolsConfig();
  if (!config.enabled) {
    return;
  }
  pi.registerTool(webSearchTool);
  pi.registerTool(webFetchTool);
}