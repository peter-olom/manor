import { Type, type Tool, type ToolCall, type ToolResultMessage } from "@mariozechner/pi-ai";
import { defineTool } from "@mariozechner/pi-coding-agent";

import {
  formatOllamaWebToolResult,
  ollamaWebFetch,
  ollamaWebSearch,
  ollamaWebTools,
  readOllamaWebToolsConfig,
  shouldAttachOllamaWebTools
} from "./ollama-web-tools.js";
import {
  formatOpencodeWebToolResult,
  opencodeWebFetch,
  opencodeWebSearch,
  opencodeWebTools,
  readOpencodeWebToolsConfig,
  shouldAttachOpencodeWebTools
} from "./opencode-web-tools.js";

export type ProviderWebToolSource = "opencode" | "ollama";

export const PROVIDER_WEB_SEARCH_TOOL_NAME = "web_search";
export const PROVIDER_WEB_FETCH_TOOL_NAME = "web_fetch";
export const PROVIDER_WEB_TOOL_NAMES = [PROVIDER_WEB_SEARCH_TOOL_NAME, PROVIDER_WEB_FETCH_TOOL_NAME] as const;

type ToolActiveSession = {
  model?: { provider?: string | null } | null;
  getActiveToolNames(): string[];
  setActiveToolsByName(toolNames: string[]): void;
};

function isProviderWebToolName(value: string): value is typeof PROVIDER_WEB_TOOL_NAMES[number] {
  return value === PROVIDER_WEB_SEARCH_TOOL_NAME || value === PROVIDER_WEB_FETCH_TOOL_NAME;
}

function details(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? value as Record<string, unknown> : { value };
}

function formatProviderWebToolResult(source: ProviderWebToolSource, result: unknown): string {
  return source === "opencode"
    ? formatOpencodeWebToolResult(result as never)
    : formatOllamaWebToolResult(result as never);
}

export async function selectProviderWebToolSource(modelProvider: string | null | undefined, env: NodeJS.ProcessEnv = process.env): Promise<ProviderWebToolSource | null> {
  if (shouldAttachOpencodeWebTools(modelProvider, env)) {
    return "opencode";
  }
  const ollamaConfig = await readOllamaWebToolsConfig(env);
  if (ollamaConfig.enabled && shouldAttachOllamaWebTools(modelProvider, env)) {
    return "ollama";
  }
  return null;
}

export function providerWebTools(source: ProviderWebToolSource): Tool[] {
  return source === "opencode" ? opencodeWebTools() : ollamaWebTools();
}

export function appendProviderWebToolInstruction(systemPrompt: string): string {
  return [
    systemPrompt,
    "When current or external information is needed, use web_search first. Use web_fetch only for a specific URL that needs more detail. Cite URLs from tool results in the final answer when they materially support the response."
  ].join("\n\n");
}

export async function executeProviderWebToolCall(toolCall: ToolCall, source: ProviderWebToolSource): Promise<ToolResultMessage> {
  try {
    const args = toolCall.arguments && typeof toolCall.arguments === "object" ? toolCall.arguments as Record<string, unknown> : {};
    const query = typeof args.query === "string" ? args.query : "";
    const url = typeof args.url === "string" ? args.url : "";
    const maxResults = typeof args.max_results === "number" ? args.max_results : null;
    const result = source === "opencode"
      ? toolCall.name === PROVIDER_WEB_SEARCH_TOOL_NAME
        ? await opencodeWebSearch({ query, maxResults }, readOpencodeWebToolsConfig())
        : toolCall.name === PROVIDER_WEB_FETCH_TOOL_NAME
          ? await opencodeWebFetch({ url }, readOpencodeWebToolsConfig())
          : null
      : toolCall.name === PROVIDER_WEB_SEARCH_TOOL_NAME
        ? await ollamaWebSearch({ query, maxResults }, await readOllamaWebToolsConfig())
        : toolCall.name === PROVIDER_WEB_FETCH_TOOL_NAME
          ? await ollamaWebFetch({ url }, await readOllamaWebToolsConfig())
          : null;
    if (!result) {
      throw new Error(`Unsupported provider web tool: ${toolCall.name}`);
    }
    return {
      role: "toolResult",
      toolCallId: toolCall.id,
      toolName: toolCall.name,
      content: [{ type: "text", text: formatProviderWebToolResult(source, result) }],
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

export function buildButlerProviderWebTools(getModelProvider: () => string | null | undefined): ReturnType<typeof defineTool>[] {
  return [
    defineTool({
      name: PROVIDER_WEB_SEARCH_TOOL_NAME,
      label: "Web Search",
      description: "Search the web using the web tool provider configured for the current Butler model.",
      promptSnippet: "web_search: search the web when current or external information is needed.",
      promptGuidelines: [
        "Use web_search before answering questions that depend on current or external information.",
        "Cite URLs from search or fetch results when they materially support the final answer."
      ],
      parameters: Type.Object({
        query: Type.String({ minLength: 1, description: "The web search query." }),
        max_results: Type.Optional(Type.Integer({ minimum: 1, maximum: 10, description: "Maximum number of results to return. Defaults to Manor's configured value; max 10." }))
      }),
      async execute(_toolCallId, params) {
        const source = await selectProviderWebToolSource(getModelProvider());
        if (!source) {
          throw new Error("No web_search provider is enabled for the current Butler model.");
        }
        const result = source === "opencode"
          ? await opencodeWebSearch({ query: params.query, maxResults: params.max_results ?? null }, readOpencodeWebToolsConfig())
          : await ollamaWebSearch({ query: params.query, maxResults: params.max_results ?? null }, await readOllamaWebToolsConfig());
        return {
          content: [{ type: "text", text: formatProviderWebToolResult(source, result) }],
          details: details(result)
        };
      }
    }),
    defineTool({
      name: PROVIDER_WEB_FETCH_TOOL_NAME,
      label: "Web Fetch",
      description: "Fetch a web page using the web tool provider configured for the current Butler model.",
      promptSnippet: "web_fetch: fetch a specific URL after search identifies a relevant source.",
      promptGuidelines: [
        "Use web_fetch only for specific URLs that need more detail than the search snippet provides."
      ],
      parameters: Type.Object({
        url: Type.String({ minLength: 1, description: "The URL to fetch." })
      }),
      async execute(_toolCallId, params) {
        const source = await selectProviderWebToolSource(getModelProvider());
        if (!source) {
          throw new Error("No web_fetch provider is enabled for the current Butler model.");
        }
        const result = source === "opencode"
          ? await opencodeWebFetch({ url: params.url }, readOpencodeWebToolsConfig())
          : await ollamaWebFetch({ url: params.url }, await readOllamaWebToolsConfig());
        return {
          content: [{ type: "text", text: formatProviderWebToolResult(source, result) }],
          details: details(result)
        };
      }
    })
  ];
}

export async function syncProviderWebToolsForSession(session: ToolActiveSession, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const activeTools = new Set(session.getActiveToolNames().filter((name) => !isProviderWebToolName(name)));
  if (await selectProviderWebToolSource(session.model?.provider, env)) {
    for (const name of PROVIDER_WEB_TOOL_NAMES) {
      activeTools.add(name);
    }
  }
  session.setActiveToolsByName([...activeTools]);
}
