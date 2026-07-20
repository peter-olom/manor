import { Type } from "@sinclair/typebox";

import type { ButlerAgentToolAccess, ButlerCustomTool } from "./butler-agent-tool-access.js";
import { resolveOperatorTimezone } from "./operator-timezone.js";

export function buildButlerBashTools(access: ButlerAgentToolAccess): ButlerCustomTool[] {
  return [access.defineButlerTool({
    name: "bash",
    label: "Butler shell",
    description: "Run a bounded command as the unprivileged Butler executor. The live repository and shared skills are read-only; /scratch is writable.",
    promptSnippet: "bash: Use this bounded non-root shell for direct inspection and lightweight development work. Commands start in /scratch. /repos and /skills are live read-only inputs, so write generated files, installs, and build artifacts under /scratch. Always run date immediately before answering time-sensitive questions. Git uses Manor's Content Admission Review wrapper. Delegate repository mutations to Worker.",
    parameters: Type.Object({
      script: Type.String({ minLength: 1, maxLength: 32_768 }),
      timeoutMs: Type.Optional(Type.Integer({ minimum: 1_000, maximum: 900_000 }))
    }),
    uiEffects: access.getToolUiEffects("bash"),
    execute: async (_toolCallId, params, signal) => {
      if (!access.butlerExecutorClient) {
        throw new Error("Butler executor is unavailable. Restart Manor after the executor runtime is configured.");
      }
      const timezone = resolveOperatorTimezone();
      const result = await access.butlerExecutorClient.execute({
        script: (params as { script: string }).script,
        threadId: access.runtimeThreadId,
        timeoutMs: (params as { timeoutMs?: number }).timeoutMs,
        timezone,
        signal
      });
      const output = [
        result.stdout ? `stdout:\n${result.stdout}` : null,
        result.stderr ? `stderr:\n${result.stderr}` : null,
        `exitCode: ${result.exitCode}`,
        result.signal ? `signal: ${result.signal}` : null,
        result.timedOut ? "timedOut: true" : null,
        result.truncated ? "outputTruncated: true" : null
      ].filter(Boolean).join("\n");
      return {
        content: [{ type: "text", text: output }],
        details: { ...result, timezone }
      };
    }
  })];
}
