import test from "node:test";
import assert from "node:assert/strict";
import { Value } from "@sinclair/typebox/value";

import { buildButlerWorkerTools } from "../../src/server/butler-agent-codex-tools.js";
import { buildButlerManorTools } from "../../src/server/butler-agent-manor-tools.js";
import { buildButlerOperatorTools } from "../../src/server/butler-agent-operator-tools.js";
import { buildButlerAutomationTools } from "../../src/server/butler-agent-automation-tools.js";
import { buildButlerProjectTools } from "../../src/server/butler-agent-project-tools.js";
import { buildButlerServiceTools } from "../../src/server/butler-agent-service-tools.js";
import { buildButlerDelegationTools, buildButlerStackPreviewTools, workerProviderModelRoute } from "../../src/server/butler-agent-stack-preview-tools.js";
import { buildButlerFilesystemTools } from "../../src/server/butler-agent-filesystem-tools.js";
import { buildButlerBashTools } from "../../src/server/butler-agent-bash-tools.js";
import { buildButlerSkillTools } from "../../src/server/butler-agent-skill-tools.js";
import { BUTLER_TOOL_CATALOG } from "../../src/server/butler-agent-tool-catalog.js";
import { OLLAMA_WEB_FETCH_TOOL, OLLAMA_WEB_SEARCH_TOOL } from "../../src/server/ollama-web-tools.js";
import { OPENCODE_WEB_FETCH_TOOL, OPENCODE_WEB_SEARCH_TOOL } from "../../src/server/opencode-web-tools.js";
import { buildButlerProviderWebTools } from "../../src/server/provider-web-tools.js";
import { buildComposerInputItemsPrompt, buildReferencePromptText, normalizeComposerInputItems } from "../../src/server/reference-inputs.js";
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

function schemaContainsKey(schema: unknown, key: string): boolean {
  if (!schema || typeof schema !== "object") return false;
  const record = schema as Record<string, unknown>;
  if (Object.prototype.hasOwnProperty.call(record, key)) return true;
  return Object.values(record).some((value) => {
    if (Array.isArray(value)) return value.some((entry) => schemaContainsKey(entry, key));
    return schemaContainsKey(value, key);
  });
}

function requiredStringsWithoutMinLength(schema: unknown, path = "parameters"): string[] {
  if (!schema || typeof schema !== "object") return [];
  const record = schema as Record<string, unknown>;
  const properties = record.properties;
  const required = Array.isArray(record.required)
    ? record.required.filter((entry): entry is string => typeof entry === "string")
    : [];
  const failures: string[] = [];

  if (properties && typeof properties === "object" && !Array.isArray(properties)) {
    const propertySchemas = properties as Record<string, unknown>;
    for (const propertyName of required) {
      const propertySchema = propertySchemas[propertyName];
      if (!propertySchema || typeof propertySchema !== "object" || Array.isArray(propertySchema)) continue;
      const propertyRecord = propertySchema as Record<string, unknown>;
      const hasNonEmptyLiteral = typeof propertyRecord.const === "string" && propertyRecord.const.length > 0;
      const hasNonEmptyEnum = Array.isArray(propertyRecord.enum)
        && propertyRecord.enum.length > 0
        && propertyRecord.enum.every((entry) => typeof entry === "string" && entry.length > 0);
      if (
        propertyRecord.type === "string"
        && !hasNonEmptyLiteral
        && !hasNonEmptyEnum
        && !(typeof propertyRecord.minLength === "number" && propertyRecord.minLength >= 1)
      ) {
        failures.push(`${path}.${propertyName}`);
      }
    }
  }

  for (const [key, value] of Object.entries(record)) {
    if (key === "additionalProperties") continue;
    if (Array.isArray(value)) {
      value.forEach((entry, index) => failures.push(...requiredStringsWithoutMinLength(entry, `${path}.${key}[${index}]`)));
    } else if (value && typeof value === "object") {
      failures.push(...requiredStringsWithoutMinLength(value, `${path}.${key}`));
    }
  }
  return failures;
}

test("Butler custom tool registration has unique tool names and provider-portable schemas", () => {
  const definitions: Array<{ name: string; parameters?: unknown }> = [];
  const access = {
    defineButlerTool: (definition: { name: string; parameters?: unknown }) => {
      definitions.push(definition);
      return definition;
    },
    getToolUiEffects: () => [],
    getAutomationAccess: () => ({ get: () => null, configure: async () => { throw new Error("unused"); }, configureInterval: async () => { throw new Error("unused"); }, setEnabled: async () => { throw new Error("unused"); }, delete: async () => true })
  } as unknown as ButlerAgentToolAccess;

  buildButlerBashTools(access);
  buildButlerStackPreviewTools(access);
  buildButlerFilesystemTools(access);
  buildButlerServiceTools(access);
  buildButlerManorTools(access);
  buildButlerOperatorTools(access);
  buildButlerAutomationTools(access);
  buildButlerSkillTools(access);
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
  assert.deepEqual(
    definitions.filter((definition) => schemaContainsKey(definition.parameters, "patternProperties")).map((definition) => definition.name),
    []
  );
  assert.deepEqual(
    definitions.flatMap((definition) =>
      requiredStringsWithoutMinLength(definition.parameters).map((path) => `${definition.name}:${path}`)
    ),
    []
  );
});

test("Butler tool catalog matches registered base tools", () => {
  const definitions: Array<{ name: string }> = [];
  const access = {
    defineButlerTool: (definition: { name: string }) => {
      definitions.push(definition);
      return definition;
    },
    getToolUiEffects: () => [],
    getAutomationAccess: () => ({ get: () => null, configure: async () => { throw new Error("unused"); }, configureInterval: async () => { throw new Error("unused"); }, setEnabled: async () => { throw new Error("unused"); }, delete: async () => true })
  } as unknown as ButlerAgentToolAccess;

  buildButlerBashTools(access);
  buildButlerStackPreviewTools(access);
  buildButlerFilesystemTools(access);
  buildButlerServiceTools(access);
  buildButlerManorTools(access);
  buildButlerOperatorTools(access);
  buildButlerAutomationTools(access);
  buildButlerSkillTools(access);
  buildButlerProjectTools(access, "/artifacts");
  buildButlerWorkerTools(access);
  buildButlerDelegationTools(access);

  const registered = definitions.map((definition) => definition.name).sort();
  const catalog = BUTLER_TOOL_CATALOG.map((definition) => definition.name).sort();
  assert.deepEqual(catalog, registered);
});

test("runtime-control tool schemas expose only supported actions and required capture metadata", () => {
  const definitions: Array<{ name: string; parameters: object }> = [];
  const access = {
    defineButlerTool: (definition: { name: string; parameters: object }) => {
      definitions.push(definition);
      return definition;
    },
    getToolUiEffects: () => []
  } as unknown as ButlerAgentToolAccess;
  buildButlerStackPreviewTools(access);

  const schema = (name: string) => definitions.find((definition) => definition.name === name)?.parameters as never;
  assert.equal(Value.Check(schema("browser_session_action"), {
    sessionId: "browser-1",
    actionType: "click",
    selector: "button",
    label: "Submit button clicked",
    fileName: "submit-clicked.png"
  }), true);
  assert.equal(Value.Check(schema("browser_session_action"), {
    sessionId: "browser-1",
    actionType: "shell",
    label: "Invalid action",
    fileName: "invalid.png"
  }), false);
  assert.equal(Value.Check(schema("browser_session_action"), {
    sessionId: "browser-1",
    actionType: "click",
    autoCapture: false
  }), false);

  assert.equal(Value.Check(schema("desktop_current_screen"), {
    sessionId: "desktop-1",
    label: "Current screen",
    fileName: "current-screen.png"
  }), true);
  assert.equal(Value.Check(schema("desktop_current_screen"), { sessionId: "desktop-1" }), false);
  assert.equal(Value.Check(schema("desktop_session_action"), { sessionId: "desktop-1", actionType: "window_list" }), false);
  assert.equal(Value.Check(schema("desktop_session_action"), {
    sessionId: "desktop-1",
    actionType: "window_list",
    label: "Open windows",
    fileName: "open-windows.png"
  }), true);
  assert.equal(Value.Check(schema("desktop_session_action"), {
    sessionId: "desktop-1",
    actionType: "screenshot",
    label: "Desktop screenshot",
    fileName: "desktop.png"
  }), true);
  assert.equal(Value.Check(schema("desktop_session_action"), { sessionId: "desktop-1", actionType: "shell" }), false);

  assert.equal(Value.Check(schema("start_preview"), {
    title: "App",
    command: "npm start",
    port: 3000,
    heartbeatKind: "tcp",
    env: { NODE_ENV: "development" }
  }), true);
  assert.equal(Value.Check(schema("start_preview"), {
    title: "App",
    command: "npm start",
    port: 3000,
    env: { PORT: 3000 }
  }), false);
  assert.equal(Value.Check(schema("start_preview"), { title: "App", command: "npm start", port: 3000, heartbeatKind: "socket" }), false);
  assert.equal(Value.Check(schema("start_preview"), { title: "App", command: "npm start", port: 3000.5 }), false);
  assert.equal(Value.Check(schema("start_preview"), { title: "App", command: "npm start", port: 0 }), false);
  assert.equal(Value.Check(schema("start_preview"), { title: "App", command: "npm start", port: 65536 }), false);

  assert.equal(Value.Check(schema("review_preview_proof"), { leaseId: "preview-1" }), true);
  assert.equal(Value.Check(schema("review_preview_proof"), { threadId: "thread-1", runId: "run-1" }), true);
  assert.equal(Value.Check(schema("review_preview_proof"), { leaseId: "preview-1", threadId: "thread-1" }), true);
  assert.equal(Value.Check(schema("review_preview_proof"), {}), true);
  assert.equal(Value.Check(schema("review_preview_proof"), { runId: "run-1" }), true);
  assert.equal(Value.Check(schema("review_preview_proof"), { leaseId: "" }), false);
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

test("provider web tool schemas reject empty inputs and out-of-range result counts", () => {
  const providerTools = buildButlerProviderWebTools(() => "ollama-cloud");
  const tools = [
    ...providerTools,
    OLLAMA_WEB_SEARCH_TOOL,
    OLLAMA_WEB_FETCH_TOOL,
    OPENCODE_WEB_SEARCH_TOOL,
    OPENCODE_WEB_FETCH_TOOL
  ] as Array<{ name: string; parameters: never }>;

  for (const tool of tools.filter((entry) => entry.name === "web_search")) {
    const properties = (tool.parameters as { properties: Record<string, Record<string, unknown>> }).properties;
    assert.equal(properties.query?.minLength, 1);
    assert.equal(properties.max_results?.type, "integer");
    assert.equal(properties.max_results?.minimum, 1);
    assert.equal(properties.max_results?.maximum, 10);
  }
  for (const tool of tools.filter((entry) => entry.name === "web_fetch")) {
    const properties = (tool.parameters as { properties: Record<string, Record<string, unknown>> }).properties;
    assert.equal(properties.url?.minLength, 1);
  }
});

test("delegation tool schema keeps provider, model, and thinking selection out of Butler control", () => {
  const tools = buildButlerDelegationTools({
    defineButlerTool: (definition) => definition,
    getToolUiEffects: () => []
  } as unknown as ButlerAgentToolAccess);
  const tool = tools.find((definition) => definition.name === "delegate_to_worker") as { parameters?: Record<string, unknown> } | undefined;
  const properties = tool?.parameters?.properties as Record<string, unknown> | undefined;

  assert.ok(tool);
  assert.equal(tools.some((definition) => definition.name === "delegate_to_codex"), false);
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

test("project policy catalog describes its context-only behavior", () => {
  const tool = BUTLER_TOOL_CATALOG.find((entry) => entry.name === "invoke_project_policy");
  const listTool = BUTLER_TOOL_CATALOG.find((entry) => entry.name === "list_project_policies");
  const registered = buildButlerProjectTools({
    defineButlerTool: (definition) => definition,
    getToolUiEffects: () => []
  } as unknown as ButlerAgentToolAccess, "/artifacts");
  const registeredListTool = registered.find((entry) => entry.name === "list_project_policies");

  assert.ok(tool);
  assert.ok(listTool);
  assert.ok(registeredListTool);
  assert.match(tool.description, /does not execute commands or mutate services/);
  assert.match(tool.description, /id or exact title/);
  assert.doesNotMatch(tool.description, /alias/);
  assert.doesNotMatch(tool.uiEffects.map((effect) => effect.description).join(" "), /applied|executed/i);
  assert.match(listTool.description, /surface as context/);
  assert.doesNotMatch(listTool.description, /apply|execute/i);
  assert.match(registeredListTool.description, /surface as context/);
  assert.doesNotMatch(registeredListTool.description, /apply|execute/i);
});

test("share project file accepts natural proof and screenshot categories", () => {
  const definitions: Array<{ name: string; parameters: object }> = [];
  const access = {
    defineButlerTool: (definition: { name: string; parameters: object }) => {
      definitions.push(definition);
      return definition;
    },
    getToolUiEffects: () => []
  } as unknown as ButlerAgentToolAccess;
  buildButlerProjectTools(access, "/artifacts");
  const schema = definitions.find((definition) => definition.name === "share_project_file")?.parameters as never;

  assert.equal(Value.Check(schema, { sourceFilePath: "/artifacts/proof.png", title: "Proof screenshot", kind: "proof" }), true);
  assert.equal(Value.Check(schema, { sourceFilePath: "/artifacts/proof.png", title: "Proof screenshot", kind: "screenshot" }), true);
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

test("Pair composer context normalizes opaque skills and explicit workspace files", () => {
  assert.deepEqual(normalizeComposerInputItems([
    { type: "skill", name: "review", id: "skill_123", environment: "butler-pi" },
    { type: "file", name: "src/app.ts", path: "/repos/src/app.ts" },
    { type: "file", name: "missing path" },
    { type: "skill", name: "review", id: "skill_123", environment: "butler-pi" }
  ]), [
    { type: "skill", name: "review", id: "skill_123", environment: "butler-pi" },
    { type: "file", name: "src/app.ts", path: "/repos/src/app.ts" }
  ]);
});
