import { Type } from "@sinclair/typebox";

import type { ButlerAgentToolAccess, ButlerCustomTool } from "./butler-agent-tool-access.js";

export function buildButlerManorTools(access: ButlerAgentToolAccess): ButlerCustomTool[] {
  return [
    access.defineButlerTool({
      name: "request_manor_restart",
      label: "Request Manor restart",
      description:
        "Open an operator-facing Manor restart/update authorization dialog. This Butler tool does not directly restart or deploy the live Manor stack.",
      promptSnippet:
        "request_manor_restart: use when a Manor restart or update needs explicit operator authorization. Provide clear target and reason details; the operator must click the confirmation dialog before restart authorization is recorded.",
      parameters: Type.Object({
        reason: Type.String({
          minLength: 1,
          description: "Plain-language reason shown to the operator before they authorize the restart or update."
        }),
        targetCommit: Type.Optional(Type.String({ minLength: 7, description: "Optional target Manor commit SHA for the authorized update." })),
        targetTag: Type.Optional(Type.String({ minLength: 1, description: "Optional target Manor image tag for the authorized update." })),
        details: Type.Optional(Type.String({ minLength: 1, description: "Optional extra restart/update details shown in the confirmation dialog." }))
      }),
      uiEffects: access.getToolUiEffects("request_manor_restart"),
      execute: async (_toolCallId, params) => {
        const typedParams = params as {
          targetCommit?: unknown;
          targetTag?: unknown;
          reason?: unknown;
          details?: unknown;
        };
        const restartRequest = access.requestManorRestartAuthorization(typedParams);
        const target = [restartRequest.targetTag, restartRequest.targetCommit].filter(Boolean).join(" / ") || "not specified";

        return {
          content: [
            {
              type: "text",
              text: `Opened a Manor restart/update authorization dialog for the operator. Target: ${target}. No live Manor restart, deploy, or stack mutation was performed by Butler.`
            }
          ],
          details: {
            restartRequest,
            liveMutationPerformed: false
          }
        };
      }
    })
  ];
}
