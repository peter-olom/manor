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

test("Butler authorized restart tool consumes approval before scheduling host-controller restart", async () => {
  const definitions: Array<{
    name: string;
    execute: (toolCallId: string, params: Record<string, unknown>) => Promise<{ content: Array<{ text: string }>; details?: Record<string, unknown> }>;
  }> = [];
  let startedRequestId: string | null = null;

  const access = {
    defineButlerTool: (definition: (typeof definitions)[number]) => {
      definitions.push(definition);
      return definition;
    },
    getToolUiEffects: () => [],
    startAuthorizedManorRestart: async (requestId: string) => {
      startedRequestId = requestId;
      return {
        restartRequest: {
          id: requestId,
          mode: "source",
          target: "latest",
          gitRef: null,
          imageTag: null,
          targetCommit: null,
          targetTag: null,
          includeDesktop: false,
          build: null,
          update: true,
          reason: "Operator approved update.",
          details: null,
          requestedAt: 1,
          status: "authorized",
          authorizedAt: 2
        },
        run: {
          id: "restart-1",
          status: "running",
          mode: "source",
          target: "latest",
          gitRef: null,
          imageTag: null,
          includeDesktop: false,
          update: true,
          startedAt: 1,
          completedAt: null,
          error: null,
          steps: []
        }
      };
    }
  } as unknown as ButlerAgentToolAccess;

  buildButlerManorTools(access);
  const restartTool = definitions.find((definition) => definition.name === "start_authorized_manor_restart");
  assert.ok(restartTool);

  const result = await restartTool.execute("tool-call-1", {
    requestId: "restart-request-1"
  });

  assert.equal(startedRequestId, "restart-request-1");
  assert.match(result.content[0]?.text ?? "", /Host controller accepted authorized Manor restart restart-1/);
  assert.match(result.content[0]?.text ?? "", /read restart status after it comes back/);
});

test("Butler authorized restart tool reports status when dialog already consumed approval", async () => {
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
    startAuthorizedManorRestart: async () => {
      throw new Error("No authorized Manor restart request matches this start request.");
    },
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
          startedAt: 1,
          completedAt: 2,
          error: null,
          steps: []
        }
      })
    }
  } as unknown as ButlerAgentToolAccess;

  buildButlerManorTools(access);
  const restartTool = definitions.find((definition) => definition.name === "start_authorized_manor_restart");
  assert.ok(restartTool);

  const result = await restartTool.execute("tool-call-1", {
    requestId: "restart-request-1"
  });

  assert.match(result.content[0]?.text ?? "", /approval dialog may already have consumed it/);
  assert.match(result.content[0]?.text ?? "", /Manor restart restart-1: completed/);
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
          startedAt: 1,
          completedAt: 2,
          error: null,
          steps: [
            {
              label: "Pull Manor images",
              status: "completed",
              startedAt: 1,
              completedAt: 2,
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
  assert.match(result.content[0]?.text ?? "", /completed: Pull Manor images/);
});
