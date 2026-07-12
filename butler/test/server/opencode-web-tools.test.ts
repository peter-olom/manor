import assert from "node:assert/strict";
import test from "node:test";

import {
  formatOpencodeWebToolResult,
  opencodeWebFetch,
  opencodeWebSearch,
  type OpencodeWebToolsConfig
} from "../../src/server/opencode-web-tools.js";

const enabledConfig: OpencodeWebToolsConfig = {
  enabled: true,
  maxResults: 5,
  timeoutMs: 5_000,
  maxContentChars: 12_000
};

test("opencodeWebSearch calls Exa's no-key MCP tool and parses its SSE response", async () => {
  const calls: Array<{ input: string | URL; init?: RequestInit }> = [];
  const fetchImpl = async (input: string | URL, init?: RequestInit) => {
    calls.push({ input, init });
    return new Response([
      "event: message",
      `data: ${JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        result: { content: [{ type: "text", text: "Title: Manor\nURL: https://example.com/manor" }] }
      })}`,
      ""
    ].join("\n"), {
      status: 200,
      headers: { "content-type": "text/event-stream" }
    });
  };

  const result = await opencodeWebSearch({ query: " latest Manor ", maxResults: 99 }, enabledConfig, fetchImpl);

  assert.equal(result.content, "Title: Manor\nURL: https://example.com/manor");
  assert.deepEqual(result.results, [{
    title: "Manor",
    url: "https://example.com/manor",
    content: result.content
  }]);
  assert.equal(formatOpencodeWebToolResult(result), result.content);
  assert.equal(String(calls[0]?.input), "https://mcp.exa.ai/mcp");
  assert.equal(calls[0]?.init?.method, "POST");
  assert.equal((calls[0]?.init?.headers as Record<string, string>).accept, "application/json, text/event-stream");
  assert.equal("authorization" in (calls[0]?.init?.headers as Record<string, string>), false);
  assert.deepEqual(JSON.parse(String(calls[0]?.init?.body)), {
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: {
      name: "web_search_exa",
      arguments: {
        query: "latest Manor",
        type: "auto",
        numResults: 10,
        livecrawl: "fallback",
        contextMaxCharacters: 12_000
      }
    }
  });
});

test("opencodeWebSearch accepts a direct JSON-RPC response and bounds returned content", async () => {
  const result = await opencodeWebSearch({ query: "Manor" }, {
    ...enabledConfig,
    maxContentChars: 30
  }, async () => new Response(JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    result: { content: [{ type: "text", text: "x".repeat(200) }] }
  }), { status: 200 }));

  assert.ok(result.content.length <= 30);
  assert.match(result.content, /\[truncated\]$/);
});

test("opencodeWebSearch reports HTTP and JSON-RPC provider errors", async () => {
  await assert.rejects(
    opencodeWebSearch({ query: "Manor" }, enabledConfig, async () => new Response("rate limited", { status: 429 })),
    /Exa web_search failed with HTTP 429: rate limited/
  );
  await assert.rejects(
    opencodeWebSearch({ query: "Manor" }, enabledConfig, async () => new Response(JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      error: { code: -32000, message: "provider unavailable" }
    }), { status: 200 })),
    /Exa web_search failed \(-32000\): provider unavailable/
  );
});

test("opencodeWebSearch rejects malformed MCP responses", async () => {
  await assert.rejects(
    opencodeWebSearch({ query: "Manor" }, enabledConfig, async () => new Response(JSON.stringify({ result: { content: "wrong" } }), { status: 200 })),
    /malformed MCP response/
  );
  await assert.rejects(
    opencodeWebSearch({ query: "Manor" }, enabledConfig, async () => new Response("event: message\ndata: not-json\n", { status: 200 })),
    /malformed JSON-RPC data/
  );
});

test("opencodeWebSearch times out even when the HTTP client ignores abort", async () => {
  await assert.rejects(
    opencodeWebSearch({ query: "Manor" }, { ...enabledConfig, timeoutMs: 10 }, () => new Promise<Response>(() => undefined)),
    /web_search request timed out after 10ms/
  );
});

test("opencodeWebFetch requests the target URL directly and extracts readable HTML", async () => {
  const calls: Array<{ input: string | URL; init?: RequestInit }> = [];
  const result = await opencodeWebFetch({ url: "https://example.com/page" }, enabledConfig, async (input, init) => {
    calls.push({ input, init });
    return new Response("<html><head><title>Example &amp; Co</title><script>ignore()</script></head><body><h1>Hello</h1><p>Readable page.</p></body></html>", {
      status: 200,
      headers: { "content-type": "text/html; charset=utf-8" }
    });
  });

  assert.equal(String(calls[0]?.input), "https://example.com/page");
  assert.equal(calls[0]?.init?.method, "GET");
  assert.equal(calls[0]?.init?.redirect, "manual");
  assert.match((calls[0]?.init?.headers as Record<string, string>)["user-agent"], /^Mozilla\/5\.0/);
  assert.equal(result.title, "Example & Co");
  assert.equal(result.url, "https://example.com/page");
  assert.match(result.content, /Hello\nReadable page\./);
  assert.doesNotMatch(result.content, /ignore/);
  assert.equal(formatOpencodeWebToolResult(result), result.content);
});

test("opencodeWebFetch retries a Cloudflare challenge with OpenCode's honest user agent", async () => {
  const userAgents: string[] = [];
  const result = await opencodeWebFetch({ url: "https://example.com/challenge" }, enabledConfig, async (_input, init) => {
    userAgents.push((init?.headers as Record<string, string>)["user-agent"]);
    return userAgents.length === 1
      ? new Response("challenge", { status: 403, headers: { "cf-mitigated": "challenge" } })
      : new Response("recovered", { status: 200, headers: { "content-type": "text/plain" } });
  });

  assert.deepEqual(userAgents.map((value) => value.startsWith("Mozilla/") ? "browser" : value), ["browser", "opencode"]);
  assert.equal(result.content, "recovered");
});

test("opencodeWebFetch reports target errors and rejects unsafe URL forms", async () => {
  await assert.rejects(
    opencodeWebFetch({ url: "https://example.com/missing" }, enabledConfig, async () => new Response("missing", { status: 404 })),
    /web_fetch failed with HTTP 404: missing/
  );
  await assert.rejects(
    opencodeWebFetch({ url: "file:///etc/passwd" }, enabledConfig, async () => new Response("unused")),
    /must start with http:\/\/ or https:\/\//
  );
  await assert.rejects(
    opencodeWebFetch({ url: "https://user:secret@example.com" }, enabledConfig, async () => new Response("unused")),
    /cannot include credentials/
  );
});

test("opencodeWebFetch applies its timeout to the whole direct request", async () => {
  await assert.rejects(
    opencodeWebFetch({ url: "https://example.com/slow" }, { ...enabledConfig, timeoutMs: 10 }, () => new Promise<Response>(() => undefined)),
    /web_fetch request timed out after 10ms/
  );
});

test("opencodeWebFetch enforces declared and streamed response size bounds", async () => {
  await assert.rejects(
    opencodeWebFetch({ url: "https://example.com/large" }, enabledConfig, async () => new Response("small", {
      status: 200,
      headers: { "content-type": "text/plain", "content-length": String(5 * 1024 * 1024 + 1) }
    })),
    /response too large/
  );

  let chunks = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (chunks < 6) {
        chunks += 1;
        controller.enqueue(new Uint8Array(1024 * 1024));
      } else {
        controller.close();
      }
    }
  });
  await assert.rejects(
    opencodeWebFetch({ url: "https://example.com/stream" }, enabledConfig, async () => new Response(stream, {
      status: 200,
      headers: { "content-type": "text/plain" }
    })),
    /response too large/
  );
});
