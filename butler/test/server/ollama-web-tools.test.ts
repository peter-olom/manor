import assert from "node:assert/strict";
import test from "node:test";

import { ollamaWebFetch, ollamaWebSearch, readOllamaWebToolsConfig, shouldAttachOllamaWebTools } from "../../src/server/ollama-web-tools.js";
import { applyOpencodeGoNativeThinkingPayload } from "../../src/server/pi-opencode-web-tools-extension.js";
import { webToolsExtensionArgsForProvider } from "../../src/server/pi-rpc-worker-client.js";
import { selectProviderWebToolSource, syncProviderWebToolsForSession } from "../../src/server/provider-web-tools.js";

test("readOllamaWebToolsConfig enables tools only when an Ollama API key is configured", async () => {
  assert.equal((await readOllamaWebToolsConfig({
    MANOR_OLLAMA_WEB_TOOLS_ENABLED: "1"
  } as NodeJS.ProcessEnv)).enabled, false);

  const config = await readOllamaWebToolsConfig({
    MANOR_OLLAMA_WEB_TOOLS_ENABLED: "1",
    MANOR_OLLAMA_WEB_TOOLS_BASE_URL: "https://ollama.example/api/",
    MANOR_OLLAMA_WEB_SEARCH_MAX_RESULTS: "50",
    OLLAMA_API_KEY: "test-key"
  } as NodeJS.ProcessEnv);

  assert.equal(config.enabled, true);
  assert.equal(config.baseUrl, "https://ollama.example/api");
  assert.equal(config.maxResults, 10);
});

test("ollamaWebSearch calls Ollama Cloud web_search with bearer auth and clamps result count", async () => {
  const calls: Array<{ input: string | URL; init?: RequestInit }> = [];
  const fetchImpl = async (input: string | URL, init?: RequestInit) => {
    calls.push({ input, init });
    return new Response(JSON.stringify({
      results: [{ title: "Result", url: "https://example.com", content: "Snippet" }]
    }), { status: 200 });
  };

  const result = await ollamaWebSearch({ query: "latest Manor", maxResults: 99 }, {
    enabled: true,
    apiKey: "test-key",
    baseUrl: "https://ollama.example/api",
    maxResults: 5,
    timeoutMs: 5_000,
    maxContentChars: 1_000
  }, fetchImpl);

  assert.deepEqual(result.results, [{ title: "Result", url: "https://example.com", content: "Snippet" }]);
  assert.equal(String(calls[0]?.input), "https://ollama.example/api/web_search");
  assert.equal(calls[0]?.init?.method, "POST");
  assert.equal((calls[0]?.init?.headers as Record<string, string>).Authorization, "Bearer test-key");
  assert.deepEqual(JSON.parse(String(calls[0]?.init?.body)), { query: "latest Manor", max_results: 10 });
});

test("ollamaWebFetch calls Ollama Cloud web_fetch", async () => {
  const calls: Array<{ input: string | URL; init?: RequestInit }> = [];
  const fetchImpl = async (input: string | URL, init?: RequestInit) => {
    calls.push({ input, init });
    return new Response(JSON.stringify({
      title: "Fetched",
      content: "Page content",
      links: ["https://example.com/a"]
    }), { status: 200 });
  };

  const result = await ollamaWebFetch({ url: "https://example.com" }, {
    enabled: true,
    apiKey: "test-key",
    baseUrl: "https://ollama.example/api",
    maxResults: 5,
    timeoutMs: 5_000,
    maxContentChars: 1_000
  }, fetchImpl);

  assert.equal(result.title, "Fetched");
  assert.equal(String(calls[0]?.input), "https://ollama.example/api/web_fetch");
  assert.deepEqual(JSON.parse(String(calls[0]?.init?.body)), { url: "https://example.com" });
});

test("Ollama web tools attach only to the Ollama Cloud provider by default", async () => {
  const env = {
    MANOR_OLLAMA_CLOUD_PROVIDER_ID: "ollama-cloud",
    OLLAMA_API_KEY: "test-key"
  } as NodeJS.ProcessEnv;

  assert.equal(shouldAttachOllamaWebTools("ollama-cloud", env), true);
  assert.equal(shouldAttachOllamaWebTools("openai", env), false);
  assert.match((await webToolsExtensionArgsForProvider("openai", env))[1] ?? "", /pi-manor-tools-extension\.(ts|js)$/);
  assert.match((await webToolsExtensionArgsForProvider("ollama-cloud", env))[3] ?? "", /pi-ollama-web-tools-extension\.(ts|js)$/);
});

test("Ollama web tools can be attached to all Pi models by opt-in", () => {
  assert.equal(shouldAttachOllamaWebTools("some-provider", {
    MANOR_OLLAMA_WEB_TOOLS_FOR_ALL_PI_MODELS: "1",
    OLLAMA_API_KEY: "test-key"
  } as NodeJS.ProcessEnv), true);
});

test("OpenCode web tools take priority over Ollama all-model tools for OpenCode models", async () => {
  const env = {
    MANOR_OPENCODE_GO_PROVIDER_ID: "opencode-go",
    MANOR_OPENCODE_GO_WEB_TOOLS_ENABLED: "1",
    MANOR_OLLAMA_WEB_TOOLS_ENABLED: "1",
    MANOR_OLLAMA_WEB_TOOLS_FOR_ALL_PI_MODELS: "1",
    OLLAMA_API_KEY: "test-key"
  } as NodeJS.ProcessEnv;

  assert.equal(await selectProviderWebToolSource("opencode-go", env), "opencode");
  const args = await webToolsExtensionArgsForProvider("opencode-go", env);
  assert.equal(args.length, 4);
  assert.match(args[1] ?? "", /pi-manor-tools-extension\.(ts|js)$/);
  assert.match(args[3] ?? "", /pi-opencode-web-tools-extension\.(ts|js)$/);
  assert.doesNotMatch(args.join(" "), /pi-ollama-web-tools-extension/);
});

test("OpenCode provider extension loads for native request transforms even when web tools are disabled", async () => {
  const env = {
    MANOR_OPENCODE_GO_PROVIDER_ID: "opencode-go",
    MANOR_OPENCODE_GO_WEB_TOOLS_ENABLED: "0"
  } as NodeJS.ProcessEnv;

  assert.equal(await selectProviderWebToolSource("opencode-go", env), null);
  const args = await webToolsExtensionArgsForProvider("opencode-go", env);
  assert.equal(args.length, 4);
  assert.match(args[1] ?? "", /pi-manor-tools-extension\.(ts|js)$/);
  assert.match(args[3] ?? "", /pi-opencode-web-tools-extension\.(ts|js)$/);
});

test("OpenCode provider extension patches MiniMax M3 native thinking variants", () => {
  assert.deepEqual(
    applyOpencodeGoNativeThinkingPayload({ model: "minimax-m3", thinking: { type: "old" } }),
    { model: "minimax-m3" }
  );
  assert.deepEqual(
    applyOpencodeGoNativeThinkingPayload({ model: "minimax-m3", reasoning_effort: "none" }),
    { model: "minimax-m3", thinking: { type: "disabled" } }
  );
  assert.deepEqual(
    applyOpencodeGoNativeThinkingPayload({ model: "minimax-m3", reasoning_effort: "thinking" }),
    { model: "minimax-m3", thinking: { type: "adaptive" } }
  );
  assert.deepEqual(
    applyOpencodeGoNativeThinkingPayload({ model: "glm-5.2", reasoning_effort: "high" }),
    { model: "glm-5.2", reasoning_effort: "high" }
  );
});

test("Butler web tools are active only when the current model provider has a usable source", async () => {
  const env = {
    MANOR_OPENCODE_GO_PROVIDER_ID: "opencode-go",
    MANOR_OPENCODE_GO_WEB_TOOLS_ENABLED: "1",
    MANOR_OLLAMA_WEB_TOOLS_ENABLED: "0"
  } as NodeJS.ProcessEnv;
  const session = {
    model: { provider: "opencode-go" as string | null },
    activeTools: ["prepare_worktree"],
    getActiveToolNames() { return this.activeTools; },
    setActiveToolsByName(toolNames: string[]) { this.activeTools = toolNames; }
  };

  assert.equal(await selectProviderWebToolSource("opencode-go", env), "opencode");
  await syncProviderWebToolsForSession(session, env);
  assert.deepEqual(session.activeTools.sort(), ["prepare_worktree", "web_fetch", "web_search"]);

  session.model.provider = "openai";
  await syncProviderWebToolsForSession(session, env);
  assert.deepEqual(session.activeTools, ["prepare_worktree"]);
});

test("Butler and workers both skip Ollama all-model web tools when the Ollama key is missing", async () => {
  const env = {
    MANOR_OLLAMA_WEB_TOOLS_ENABLED: "1",
    MANOR_OLLAMA_WEB_TOOLS_FOR_ALL_PI_MODELS: "1"
  } as NodeJS.ProcessEnv;
  const session = {
    model: { provider: "openai" as string | null },
    activeTools: ["prepare_worktree", "web_search", "web_fetch"],
    getActiveToolNames() { return this.activeTools; },
    setActiveToolsByName(toolNames: string[]) { this.activeTools = toolNames; }
  };

  assert.equal(await selectProviderWebToolSource("openai", env), null);
  assert.match((await webToolsExtensionArgsForProvider("openai", env))[1] ?? "", /pi-manor-tools-extension\.(ts|js)$/);
  await syncProviderWebToolsForSession(session, env);
  assert.deepEqual(session.activeTools, ["prepare_worktree"]);
});
