import test from "node:test";
import assert from "node:assert/strict";

import { buildButlerCodexTools } from "../../src/server/butler-agent-codex-tools.js";
import { buildButlerManorTools } from "../../src/server/butler-agent-manor-tools.js";
import { buildButlerProjectTools } from "../../src/server/butler-agent-project-tools.js";
import { buildButlerServiceTools } from "../../src/server/butler-agent-service-tools.js";
import { buildButlerDelegationTools, buildButlerStackPreviewTools } from "../../src/server/butler-agent-stack-preview-tools.js";
import type { ButlerAgentToolAccess } from "../../src/server/butler-agent-tool-access.js";

test("Butler custom tool registration has unique tool names", () => {
  const definitions: Array<{ name: string }> = [];
  const access = {
    defineButlerTool: (definition: { name: string }) => {
      definitions.push(definition);
      return definition;
    },
    getToolUiEffects: () => []
  } as unknown as ButlerAgentToolAccess;

  buildButlerStackPreviewTools(access);
  buildButlerServiceTools(access);
  buildButlerManorTools(access);
  buildButlerProjectTools(access, "/artifacts");
  buildButlerCodexTools(access);
  buildButlerDelegationTools(access);

  const duplicates = definitions
    .map((definition) => definition.name)
    .filter((name, index, names) => names.indexOf(name) !== index);

  assert.deepEqual([...new Set(duplicates)].sort(), []);
  assert.equal(definitions.filter((definition) => definition.name === "request_manor_restart").length, 1);
  assert.equal(definitions.filter((definition) => definition.name === "read_manor_restart_status").length, 1);
});
