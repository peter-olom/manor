import test from "node:test";
import assert from "node:assert/strict";

import { buildButlerManorTools } from "../../src/server/butler-agent-manor-tools.js";
import type { ButlerAgentToolAccess } from "../../src/server/butler-agent-tool-access.js";
import { createManorRestartRequest, isRestartAuthorizeAction } from "../../src/server/manor-restart-authorization.js";

test("restart authorization requests capture operator-facing details without magic phrases", () => {
  const request = createManorRestartRequest({
    reason: "Update Manor to the published image.",
    targetCommit: "14ed90500ac6f96146584ba7e7d3444a91155555",
    targetTag: "sha-14ed905",
    details: "GHCR publish completed."
  });

  assert.equal(request.status, "pending");
  assert.equal(request.authorizedAt, null);
  assert.equal(request.reason, "Update Manor to the published image.");
  assert.equal(request.targetCommit, "14ed90500ac6f96146584ba7e7d3444a91155555");
  assert.equal(request.targetTag, "sha-14ed905");
  assert.equal(request.details, "GHCR publish completed.");
  assert.equal(isRestartAuthorizeAction("authorize_restart"), true);
  assert.equal(isRestartAuthorizeAction("RESTART MANOR"), false);
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
    targetCommit: "14ed90500ac6f96146584ba7e7d3444a91155555",
    targetTag: "sha-14ed905"
  });

  assert.deepEqual(requestedInput, {
    reason: "Operator should approve the Manor update.",
    targetCommit: "14ed90500ac6f96146584ba7e7d3444a91155555",
    targetTag: "sha-14ed905"
  });
  assert.match(result.content[0]?.text ?? "", new RegExp("Opened a Manor restart/update authorization dialog"));
  assert.equal(result.details?.liveMutationPerformed, false);
});
