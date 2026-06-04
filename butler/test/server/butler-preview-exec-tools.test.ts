import test from "node:test";
import assert from "node:assert/strict";

import { buildButlerStackPreviewTools } from "../../src/server/butler-agent-stack-preview-tools.js";
import type { ButlerAgentToolAccess } from "../../src/server/butler-agent-tool-access.js";

test("Butler preview exec forwards argv and stdin to the runtime broker", async () => {
  const definitions: Array<{
    name: string;
    execute: (toolCallId: string, params: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }>;
  }> = [];
  let receivedInput: Record<string, unknown> | null = null;
  let notedLeaseId: string | null = null;

  const access = {
    defineButlerTool: (definition: (typeof definitions)[number]) => {
      definitions.push(definition);
      return definition;
    },
    getToolUiEffects: () => [],
    runtimeBroker: {
      execInLease: async (input: Record<string, unknown>) => {
        receivedInput = input;
        return {
          leaseId: input.leaseId,
          command: input.command,
          exitCode: 0,
          stdout: "preview ok\n",
          stderr: ""
        };
      }
    },
    store: {
      notePreviewLeaseActivity: (leaseId: string) => {
        notedLeaseId = leaseId;
      }
    }
  } as unknown as ButlerAgentToolAccess;

  buildButlerStackPreviewTools(access);
  const execPreview = definitions.find((definition) => definition.name === "exec_preview");
  assert.ok(execPreview);

  const result = await execPreview.execute("tool-call-1", {
    leaseId: "preview-1",
    commandArgs: ["node", "-"],
    cwd: " /app ",
    stdin: "console.log('preview ok')"
  });

  assert.deepEqual(receivedInput, {
    leaseId: "preview-1",
    command: "",
    commandArgs: ["node", "-"],
    cwd: "/app",
    stdin: "console.log('preview ok')",
    stdinProvided: true
  });
  assert.equal(notedLeaseId, "preview-1");
  assert.match(result.content[0]?.text ?? "", /stdout:\npreview ok/);
});
