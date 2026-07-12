import { Type } from "@mariozechner/pi-ai";
import { defineTool, type ExtensionAPI } from "@mariozechner/pi-coding-agent";

import {
  formatOllamaWebToolResult,
  ollamaWebFetch,
  ollamaWebSearch,
  readOllamaWebToolsConfig
} from "./ollama-web-tools.js";

const webSearchTool = defineTool({
  name: "web_search",
  label: "Web Search",
  description: "Search the web using Ollama Cloud web search. Use for current facts, recent events, prices, schedules, docs, or external sources.",
  promptSnippet: "web_search: search the web through Ollama Cloud when current or external information is needed.",
  promptGuidelines: [
    "Use web_search before answering questions that depend on current or external information.",
    "Cite URLs from search or fetch results when they materially support the final answer."
  ],
  parameters: Type.Object({
    query: Type.String({ minLength: 1, description: "The web search query." }),
    max_results: Type.Optional(Type.Integer({ minimum: 1, maximum: 10, description: "Maximum number of results to return. Defaults to Manor's configured value; max 10." }))
  }),
  async execute(_toolCallId, params) {
    const config = await readOllamaWebToolsConfig();
    const result = await ollamaWebSearch({ query: params.query, maxResults: params.max_results ?? null }, config);
    return {
      content: [{ type: "text", text: formatOllamaWebToolResult(result) }],
      details: result
    };
  }
});

const webFetchTool = defineTool({
  name: "web_fetch",
  label: "Web Fetch",
  description: "Fetch a web page through Ollama Cloud web fetch after a search result looks relevant.",
  promptSnippet: "web_fetch: fetch a specific URL through Ollama Cloud after search identifies a relevant source.",
  promptGuidelines: [
    "Use web_fetch only for specific URLs that need more detail than the search snippet provides."
  ],
  parameters: Type.Object({
    url: Type.String({ minLength: 1, description: "The URL to fetch." })
  }),
  async execute(_toolCallId, params) {
    const config = await readOllamaWebToolsConfig();
    const result = await ollamaWebFetch({ url: params.url }, config);
    return {
      content: [{ type: "text", text: formatOllamaWebToolResult(result) }],
      details: result
    };
  }
});

export const ollamaWebSearchTool = webSearchTool;
export const ollamaWebFetchTool = webFetchTool;

export default async function ollamaWebToolsExtension(pi: ExtensionAPI): Promise<void> {
  const config = await readOllamaWebToolsConfig();
  if (!config.enabled) {
    return;
  }
  pi.registerTool(webSearchTool);
  pi.registerTool(webFetchTool);
}
