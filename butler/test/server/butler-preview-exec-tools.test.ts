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

test("Butler lease tools update sticky preview and stack lifecycle", async () => {
  const definitions: Array<{
    name: string;
    execute: (toolCallId: string, params: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }>;
  }> = [];
  const lifecycleUpdates: Record<string, unknown>[] = [];

  const access = {
    defineButlerTool: (definition: (typeof definitions)[number]) => {
      definitions.push(definition);
      return definition;
    },
    getToolUiEffects: () => [],
    getValidatedStack: () => ({ id: "stack-1" }),
    requireValidatedPreview: () => ({ id: "preview-1" }),
    store: {
      setStackLeaseLifecycle: (leaseId: string, patch: Record<string, unknown>) => {
        lifecycleUpdates.push({ kind: "stack", leaseId, ...patch });
        return {
          id: leaseId,
          title: "Warm stack",
          pinned: patch.pinned,
          leaseTtlMs: patch.leaseTtlMs,
          lifecycleState: "active"
        };
      },
      setPreviewLeaseLifecycle: (leaseId: string, patch: Record<string, unknown>) => {
        lifecycleUpdates.push({ kind: "preview", leaseId, ...patch });
        return {
          id: leaseId,
          title: "Warm preview",
          pinned: patch.pinned,
          leaseTtlMs: patch.leaseTtlMs,
          lifecycleState: "active"
        };
      }
    }
  } as unknown as ButlerAgentToolAccess;

  buildButlerStackPreviewTools(access);
  const setStackLease = definitions.find((definition) => definition.name === "set_stack_lease");
  const setPreviewLease = definitions.find((definition) => definition.name === "set_preview_lease");
  assert.ok(setStackLease);
  assert.ok(setPreviewLease);

  const stackResult = await setStackLease.execute("tool-call-1", {
    stackId: "stack-1",
    sticky: true,
    leaseTtlMinutes: 45
  });
  const previewResult = await setPreviewLease.execute("tool-call-2", {
    leaseId: "preview-1",
    sticky: true
  });

  assert.deepEqual(lifecycleUpdates, [
    { kind: "stack", leaseId: "stack-1", pinned: true, leaseTtlMs: 2_700_000, refresh: true },
    { kind: "preview", leaseId: "preview-1", pinned: true, leaseTtlMs: undefined, refresh: true }
  ]);
  assert.match(stackResult.content[0]?.text ?? "", /lease=sticky ttl=45m/);
  assert.match(previewResult.content[0]?.text ?? "", /lease=sticky/);
});
