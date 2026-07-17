import { Bash } from "just-bash";
import { Type } from "@sinclair/typebox";

import type { ButlerAgentToolAccess, ButlerCustomTool } from "./butler-agent-tool-access.js";
import { resolveOperatorTimezone } from "./operator-timezone.js";

const BASH_LIMITS = {
  maxCallDepth: 10,
  maxCommandCount: 20,
  maxLoopIterations: 100,
  maxAwkIterations: 100,
  maxSedIterations: 100,
  maxJqIterations: 100,
  maxStringLength: 32_768,
  maxArrayElements: 1_000,
  maxHeredocSize: 32_768,
  maxSubstitutionDepth: 5,
  maxBraceExpansionResults: 100,
  maxOutputSize: 32_768,
  maxFileDescriptors: 32,
  maxSourceDepth: 5
} as const;

export function buildButlerBashTools(access: ButlerAgentToolAccess): ButlerCustomTool[] {
  return [access.defineButlerTool({
    name: "bash",
    label: "Sandboxed clock",
    description: "Run the date command in a restricted just-bash sandbox using the operator's configured timezone.",
    promptSnippet: "bash: Always run date immediately before answering questions about the current date or time, elapsed or remaining time, deadlines, or whether a schedule window has passed. Never infer the current time from chat timestamps, automation history, or system context. This sandbox exposes only date and has no host filesystem, network, JavaScript, or Python access.",
    parameters: Type.Object({
      script: Type.String({ minLength: 1, maxLength: 2_000 })
    }),
    uiEffects: access.getToolUiEffects("bash"),
    execute: async (_toolCallId, params, signal) => {
      const timezone = resolveOperatorTimezone();
      const sandbox = new Bash({
        commands: ["date"],
        env: { TZ: timezone },
        executionLimits: BASH_LIMITS
      });
      const result = await sandbox.exec((params as { script: string }).script, { signal });
      const output = [
        result.stdout ? `stdout:\n${result.stdout}` : null,
        result.stderr ? `stderr:\n${result.stderr}` : null,
        `exitCode: ${result.exitCode}`
      ].filter(Boolean).join("\n");
      return {
        content: [{ type: "text", text: output }],
        details: { stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode, timezone }
      };
    }
  })];
}
