import test from "node:test";
import assert from "node:assert/strict";

import { buildButlerWorkerTools } from "../../src/server/butler-agent-codex-tools.js";
import { buildButlerManorTools } from "../../src/server/butler-agent-manor-tools.js";
import { buildButlerOperatorTools } from "../../src/server/butler-agent-operator-tools.js";
import { buildButlerProjectTools } from "../../src/server/butler-agent-project-tools.js";
import { buildButlerServiceTools } from "../../src/server/butler-agent-service-tools.js";
import { buildButlerDelegationTools, buildButlerStackPreviewTools, workerProviderModelRoute } from "../../src/server/butler-agent-stack-preview-tools.js";
import { BUTLER_TOOL_CATALOG } from "../../src/server/butler-agent-tool-catalog.js";
import { buildComposerInputItemsPrompt, buildReferencePromptText } from "../../src/server/reference-inputs.js";
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
  buildButlerOperatorTools(access);
  buildButlerProjectTools(access, "/artifacts");
  buildButlerWorkerTools(access);
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

test("ask_operator exposes one provider-neutral questions-array schema", () => {
  const tools = buildButlerOperatorTools({
    defineButlerTool: (definition) => definition,
    getToolUiEffects: () => []
  } as unknown as ButlerAgentToolAccess);
  const tool = tools.find((definition) => definition.name === "ask_operator") as { parameters?: Record<string, unknown> } | undefined;
  const parameters = tool?.parameters;
  const properties = parameters?.properties as Record<string, unknown> | undefined;

  assert.ok(tool);
  assert.equal(parameters?.anyOf, undefined);
  assert.deepEqual(parameters?.required, ["questions"]);
  assert.ok(properties?.questions);
  assert.equal(properties?.prompt, undefined);
});

test("delegation tool schema keeps provider, model, and thinking selection out of Butler control", () => {
  const tools = buildButlerDelegationTools({
    defineButlerTool: (definition) => definition,
    getToolUiEffects: () => []
  } as unknown as ButlerAgentToolAccess);
  const tool = tools.find((definition) => definition.name === "delegate_to_worker") as { parameters?: Record<string, unknown> } | undefined;
  const properties = tool?.parameters?.properties as Record<string, unknown> | undefined;

  assert.ok(tool);
  assert.ok(tools.some((definition) => definition.name === "delegate_to_codex"), "legacy delegation alias should remain registered");
  assert.equal(properties?.workerRuntime, undefined);
  assert.equal(properties?.workerModel, undefined);
  assert.equal(properties?.thinkingBudget, undefined);
});

test("delegation route does not repeat a provider-qualified Worker model", () => {
  assert.equal(workerProviderModelRoute("ollama-cloud", "ollama-cloud/glm-5.2"), "ollama-cloud/glm-5.2");
  assert.equal(workerProviderModelRoute("openai-codex", "gpt-5.5"), "openai-codex/gpt-5.5");
  assert.equal(workerProviderModelRoute(null, null), "the selected provider/default");
});

test("Butler advertises provider-neutral worker delegation", () => {
  const tool = BUTLER_TOOL_CATALOG.find((entry) => entry.name === "delegate_to_worker");

  assert.ok(tool);
  assert.match(tool.description, /worker workstream/);
  assert.equal(BUTLER_TOOL_CATALOG.some((entry) => entry.name === "delegate_to_codex"), false);
  assert.deepEqual(BUTLER_TOOL_CATALOG.filter((entry) => /Codex/.test(`${entry.description} ${entry.uiEffects.map((effect) => effect.description).join(" ")}`)), []);
});

test("delegation reference guidance is provider-neutral", () => {
  const referencePrompt = buildReferencePromptText({
    text: "",
    imageStore: { resolveViews: () => [{ id: "image-1", name: "reference.png" }] } as never,
    imageReferenceIds: ["image-1"],
    fileStore: { resolveViews: () => [] } as never,
    fileReferenceIds: [],
    includeIds: true
  });
  const composerPrompt = buildComposerInputItemsPrompt([{ type: "skill", name: "review", path: "/skills/review" }]);

  assert.match(referencePrompt, /delegating to a Worker/);
  assert.match(composerPrompt, /selected Worker context items/);
  assert.doesNotMatch(`${referencePrompt}\n${composerPrompt}`, /Codex/);
});
