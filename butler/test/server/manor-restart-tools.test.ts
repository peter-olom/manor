import test from "node:test";
import assert from "node:assert/strict";

import { buildButlerManorTools } from "../../src/server/butler-agent-manor-tools.js";
import type { ButlerAgentToolAccess } from "../../src/server/butler-agent-tool-access.js";
import { HostControllerClient } from "../../src/server/host-controller-client.js";

test("Host controller client uses only the scoped restart token header", async () => {
  const originalFetch = globalThis.fetch;
  let headers: HeadersInit | undefined;

  globalThis.fetch = (async (_url, init) => {
    headers = init?.headers;
    return new Response(JSON.stringify({ ok: true, active: null, latestRun: null, detectedMode: "source" }), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  }) as typeof fetch;

  try {
    const client = new HostControllerClient("http://host-controller:8092", "restart-token");
    await client.getStatus();

    assert.equal((headers as Record<string, string>)["x-manor-host-controller-token"], "restart-token");
    assert.equal(Object.hasOwn(headers as Record<string, string>, "x-manor-broker-token"), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Butler manor tools expose request and status restart surfaces only", async () => {
  const definitions: Array<{
    name: string;
    execute: (toolCallId: string, params: Record<string, unknown>) => Promise<{ content: Array<{ text: string }>; details?: Record<string, unknown> }>;
  }> = [];

  const access = {
    defineButlerTool: (definition: (typeof definitions)[number]) => {
      definitions.push(definition);
      return definition;
    },
    getToolUiEffects: () => [],
    hostController: {
      getStatus: async () => ({
        ok: true,
        detectedMode: "source",
        active: null,
        latestRun: {
          id: "restart-1",
          status: "completed",
          mode: "source",
          target: "current",
          gitRef: null,
          imageTag: null,
          includeDesktop: false,
          update: false,
          startedAt: 1_000,
          completedAt: 66_000,
          durationMs: 65_000,
          error: null,
          steps: []
        }
      })
    }
  } as unknown as ButlerAgentToolAccess;

  buildButlerManorTools(access);
  assert.deepEqual(definitions.map((definition) => definition.name), ["request_manor_restart", "read_manor_restart_status"]);
});

test("Butler restart status tool reports active host-controller runs", async () => {
  const definitions: Array<{
    name: string;
    execute: (toolCallId: string, params: Record<string, unknown>) => Promise<{ content: Array<{ text: string }>; details?: Record<string, unknown> }>;
  }> = [];

  const access = {
    defineButlerTool: (definition: (typeof definitions)[number]) => {
      definitions.push(definition);
      return definition;
    },
    getToolUiEffects: () => [],
    hostController: {
      getStatus: async () => ({
        ok: true,
        detectedMode: "image",
        active: null,
        latestRun: {
          id: "restart-1",
          status: "completed",
          mode: "image",
          target: "latest",
          gitRef: null,
          imageTag: null,
          includeDesktop: false,
          update: true,
          startedAt: 1_000,
          completedAt: 66_000,
          durationMs: 65_000,
          error: null,
          steps: [
            {
              label: "Pull Manor images",
              status: "completed",
              startedAt: 1_000,
              completedAt: 66_000,
              exitCode: 0,
              stdoutTail: "",
              stderrTail: ""
            }
          ]
        }
      })
    }
  } as unknown as ButlerAgentToolAccess;

  buildButlerManorTools(access);
  const statusTool = definitions.find((definition) => definition.name === "read_manor_restart_status");
  assert.ok(statusTool);

  const result = await statusTool.execute("tool-call-1", {});

  assert.match(result.content[0]?.text ?? "", /Manor restart restart-1: completed/);
  assert.match(result.content[0]?.text ?? "", /Duration: 1m 5s/);
  assert.match(result.content[0]?.text ?? "", /completed: Pull Manor images/);
});
