import assert from "node:assert/strict";
import test from "node:test";

import { validateToolArguments } from "@earendil-works/pi-ai";
import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

import { createPiReviewSubmissionTool } from "../../src/server/butler-adversarial-review.js";
import { buildButlerAutomationTools } from "../../src/server/butler-agent-automation-tools.js";
import { buildButlerBashTools } from "../../src/server/butler-agent-bash-tools.js";
import { buildButlerWorkerTools } from "../../src/server/butler-agent-codex-tools.js";
import { buildButlerFilesystemTools } from "../../src/server/butler-agent-filesystem-tools.js";
import { buildButlerManorTools } from "../../src/server/butler-agent-manor-tools.js";
import { buildButlerOperatorTools } from "../../src/server/butler-agent-operator-tools.js";
import { buildButlerProjectTools } from "../../src/server/butler-agent-project-tools.js";
import { buildButlerServiceTools } from "../../src/server/butler-agent-service-tools.js";
import { buildButlerSkillTools } from "../../src/server/butler-agent-skill-tools.js";
import { buildButlerDelegationTools, buildButlerStackPreviewTools } from "../../src/server/butler-agent-stack-preview-tools.js";
import type { ButlerAgentToolAccess } from "../../src/server/butler-agent-tool-access.js";
import {
  assertProviderPortableToolSchema,
  providerToolSchemaViolations,
  stringEnumSchema
} from "../../src/server/butler-agent-tool-schemas.js";
import { buildButlerVisionTools } from "../../src/server/butler-agent-vision-tools.js";
import { manorWorkerTools } from "../../src/server/pi-manor-tools-extension.js";
import { ollamaPiWebTools } from "../../src/server/pi-ollama-web-tools-extension.js";
import { opencodePiWebTools } from "../../src/server/pi-opencode-web-tools-extension.js";
import { buildButlerProviderWebTools, providerWebTools } from "../../src/server/provider-web-tools.js";

type ToolDefinition = { name: string; parameters: unknown };

function activeButlerToolDefinitions(): ToolDefinition[] {
  const definitions: ToolDefinition[] = [];
  const access = {
    defineButlerTool: (definition: ToolDefinition) => {
      definitions.push(definition);
      return definition;
    },
    getToolUiEffects: () => [],
    getAutomationAccess: () => ({
      get: () => null,
      configure: async () => { throw new Error("unused"); },
      configureInterval: async () => { throw new Error("unused"); },
      setEnabled: async () => { throw new Error("unused"); },
      delete: async () => true
    })
  } as unknown as ButlerAgentToolAccess;

  buildButlerBashTools(access);
  buildButlerStackPreviewTools(access);
  buildButlerFilesystemTools(access);
  buildButlerServiceTools(access);
  buildButlerManorTools(access);
  buildButlerProjectTools(access, "/artifacts");
  buildButlerOperatorTools(access);
  buildButlerAutomationTools(access);
  buildButlerSkillTools(access);
  buildButlerWorkerTools(access);
  buildButlerDelegationTools(access);
  buildButlerVisionTools(access, { inspect: async () => { throw new Error("unused"); } } as never);

  return definitions;
}

test("model tool schema lint rejects provider-fragile composition", () => {
  const portable = Type.Object({
    mode: stringEnumSchema(["safe", "strict"] as const),
    anyOf: Type.Optional(Type.String()),
    nested: Type.Optional(Type.Array(Type.Object({ value: Type.String() })))
  });
  assert.deepEqual(providerToolSchemaViolations(portable), []);
  assert.doesNotThrow(() => assertProviderPortableToolSchema("portable", portable));
  assert.equal(Value.Check(portable, { mode: "safe" }), true);
  assert.equal(Value.Check(portable, { mode: "unknown" }), false);

  assert.throws(
    () => assertProviderPortableToolSchema("root_union", Type.Union([Type.Object({ a: Type.String() }), Type.Object({ b: Type.String() })])),
    /top-level type=object and properties/
  );
  assert.throws(
    () => assertProviderPortableToolSchema("nested_union", Type.Object({ choice: Type.Union([Type.String(), Type.Number()]) })),
    /parameters\.properties\.choice\.anyOf/
  );
  assert.throws(
    () => assertProviderPortableToolSchema("literal", Type.Object({ choice: Type.Literal("only") })),
    /parameters\.properties\.choice\.const/
  );
  assert.throws(
    () => assertProviderPortableToolSchema("array_type", { type: "object", properties: { value: { type: ["string", "null"] } } }),
    /parameters\.properties\.value\.type/
  );
  assert.throws(
    () => assertProviderPortableToolSchema("deep_union", {
      type: "object",
      properties: { values: { type: "array", contains: { anyOf: [{ type: "string" }, { type: "number" }] } } }
    }),
    /parameters\.properties\.values\.contains\.anyOf/
  );
});

test("all Manor-owned model tools pass the provider-portability lint", () => {
  const reviewerTool = createPiReviewSubmissionTool(() => undefined) as unknown as ToolDefinition;
  const tools = [
    ...activeButlerToolDefinitions(),
    ...(buildButlerProviderWebTools(() => "ollama-cloud") as unknown as ToolDefinition[]),
    ...(providerWebTools("ollama") as unknown as ToolDefinition[]),
    ...(providerWebTools("opencode") as unknown as ToolDefinition[]),
    ...(ollamaPiWebTools as unknown as ToolDefinition[]),
    ...(opencodePiWebTools as unknown as ToolDefinition[]),
    ...(manorWorkerTools as unknown as ToolDefinition[]),
    reviewerTool
  ];

  assert.ok(tools.length > 100);
  for (const tool of tools) assertProviderPortableToolSchema(tool.name, tool.parameters);
});

test("Worker enum constraints remain locally enforceable after flattening", () => {
  const browserStart = manorWorkerTools.find((tool) => tool.name === "manor_browser_start")!;
  assert.doesNotThrow(() => validateToolArguments(browserStart, {
    id: "valid-browser",
    name: browserStart.name,
    arguments: { lease_id: "lease-1", mode: "headless", resolution: "1080p" }
  }));
  assert.throws(() => validateToolArguments(browserStart, {
    id: "invalid-browser",
    name: browserStart.name,
    arguments: { lease_id: "lease-1", mode: "screenshot", resolution: "720p" }
  }), /Validation failed/);

  const report = manorWorkerTools.find((tool) => tool.name === "manor_report")!;
  assert.throws(() => validateToolArguments(report, {
    id: "invalid-report",
    name: report.name,
    arguments: { status: "done", summary: "Finished" }
  }), /Validation failed/);
});
