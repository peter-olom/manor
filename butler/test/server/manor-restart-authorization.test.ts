import test from "node:test";
import assert from "node:assert/strict";

import { buildButlerManorTools } from "../../src/server/butler-agent-manor-tools.js";
import type { ButlerAgentToolAccess } from "../../src/server/butler-agent-tool-access.js";
import {
  authorizeManorRestartRequest,
  buildAuthorizedManorRestartInput,
  createManorRestartRequest,
  isRestartAuthorizeAction
} from "../../src/server/manor-restart-authorization.js";

test("restart authorization requests capture operator-facing details without magic phrases", () => {
  const request = createManorRestartRequest({
    reason: "Update Manor to the published image.",
    mode: "image",
    target: "current",
    imageTag: "sha-14ed905",
    includeDesktop: true,
    update: true,
    details: "GHCR publish completed."
  });

  assert.equal(request.status, "pending");
  assert.equal(request.authorizedAt, null);
  assert.equal(request.reason, "Update Manor to the published image.");
  assert.equal(request.mode, "image");
  assert.equal(request.target, "current");
  assert.equal(request.imageTag, "sha-14ed905");
  assert.equal(request.includeDesktop, true);
  assert.equal(request.update, true);
  assert.equal(request.details, "GHCR publish completed.");
  assert.equal(isRestartAuthorizeAction("authorize_restart"), true);
  assert.equal(isRestartAuthorizeAction("RESTART MANOR"), false);
});

test("authorized restart requests map to host-controller payloads", () => {
  const request = createManorRestartRequest({
    reason: "Update source checkout.",
    mode: "source",
    target: "current",
    gitRef: "feature/restart-workflow",
    includeDesktop: true,
    build: false,
    update: true
  });
  const authorized = authorizeManorRestartRequest(request, request.id);

  assert.deepEqual(buildAuthorizedManorRestartInput(authorized), {
    confirmation: "restart Manor",
    mode: "source",
    target: "current",
    gitRef: "feature/restart-workflow",
    imageTag: null,
    includeDesktop: true,
    build: false,
    update: true
  });
});

test("authorized auto restart payloads preserve no-build intent", () => {
  const pending = createManorRestartRequest({
    reason: "Restart only.",
    build: false,
    update: false
  });
  const authorized = authorizeManorRestartRequest(pending, pending.id);

  assert.deepEqual(buildAuthorizedManorRestartInput(authorized), {
    confirmation: "restart Manor",
    mode: "auto",
    target: "current",
    gitRef: null,
    imageTag: null,
    includeDesktop: false,
    build: false,
    update: false
  });
});

test("request_manor_restart opens an authorization dialog request instead of requiring a guessed phrase", async () => {
  const definitions: Array<{
    name: string;
    parameters: Record<string, unknown>;
    execute: (toolCallId: string, params: Record<string, unknown>) => Promise<{
      content: Array<{ text: string }>;
      details?: Record<string, unknown>;
    }>;
  }> = [];
  let requestedInput: Record<string, unknown> | null = null;
  const access = {
    defineButlerTool: (definition: (typeof definitions)[number]) => {
      definitions.push(definition);
      return definition;
    },
    getToolUiEffects: () => [],
    requestManorRestartAuthorization: (input: Record<string, unknown>) => {
      requestedInput = input;
      return createManorRestartRequest(input);
    }
  } as unknown as ButlerAgentToolAccess;

  buildButlerManorTools(access);
  const restartTool = definitions.find((definition) => definition.name === "request_manor_restart");
  assert.ok(restartTool);
  const schemaText = JSON.stringify(restartTool.parameters);
  assert.match(schemaText, /reason/);
  assert.doesNotMatch(schemaText, /RESTART MANOR/);
  assert.equal((restartTool.parameters.properties as Record<string, unknown>).confirmation, undefined);

  const result = await restartTool.execute("tool-call-1", {
    reason: "Operator should approve the Manor update.",
    mode: "image",
    imageTag: "sha-14ed905"
  });

  assert.deepEqual(requestedInput, {
    reason: "Operator should approve the Manor update.",
    mode: "image",
    imageTag: "sha-14ed905"
  });
  assert.match(result.content[0]?.text ?? "", new RegExp("Opened a Manor restart/update authorization dialog"));
  assert.match(result.content[0]?.text ?? "", new RegExp("Request id:"));
  assert.equal(result.details?.liveMutationPerformed, false);
});
