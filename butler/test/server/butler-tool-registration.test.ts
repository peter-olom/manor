import test from "node:test";
import assert from "node:assert/strict";

import { buildButlerCodexTools } from "../../src/server/butler-agent-codex-tools.js";
import { buildButlerManorTools } from "../../src/server/butler-agent-manor-tools.js";
import { buildButlerProjectTools } from "../../src/server/butler-agent-project-tools.js";
import { buildButlerServiceTools } from "../../src/server/butler-agent-service-tools.js";
import { buildButlerDelegationTools, buildButlerStackPreviewTools } from "../../src/server/butler-agent-stack-preview-tools.js";
import type { ButlerAgentToolAccess } from "../../src/server/butler-agent-tool-access.js";

function schemaContainsLiteral(schema: unknown, literal: string): boolean {
  if (!schema || typeof schema !== "object") return false;
  const record = schema as Record<string, unknown>;
  if (record.const === literal) return true;
  if (Array.isArray(record.enum) && record.enum.includes(literal)) return true;
  return Object.values(record).some((value) => {
    if (Array.isArray(value)) return value.some((entry) => schemaContainsLiteral(entry, literal));
    return schemaContainsLiteral(value, literal);
  });
}

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
  assert.equal(definitions.filter((definition) => definition.name === "request_self_improvement").length, 1);
  assert.equal(definitions.filter((definition) => definition.name === "discard_self_improvement").length, 1);
  assert.equal(definitions.filter((definition) => definition.name === "commit_self_improvement").length, 1);
  assert.equal(definitions.filter((definition) => definition.name === "open_self_improvement_pr").length, 1);
});

test("delegation tool schema keeps provider, model, and thinking selection out of Butler control", () => {
  const tools = buildButlerDelegationTools({
    defineButlerTool: (definition) => definition,
    getToolUiEffects: () => []
  } as unknown as ButlerAgentToolAccess);
  const tool = tools.find((definition) => definition.name === "delegate_to_codex") as { parameters?: Record<string, unknown> } | undefined;
  const properties = tool?.parameters?.properties as Record<string, unknown> | undefined;

  assert.equal(properties?.workerRuntime, undefined);
  assert.equal(properties?.workerModel, undefined);
  assert.equal(properties?.thinkingBudget, undefined);
});
