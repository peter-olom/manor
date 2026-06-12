import { Type } from "@sinclair/typebox";

import type { ButlerAgentToolAccess, ButlerCustomTool } from "./butler-agent-tool-access.js";
import type { ManorRestartRun } from "./host-controller-client.js";

function formatRestartRequestTarget(request: {
  mode: string | null;
  target: string | null;
  gitRef: string | null;
  imageTag: string | null;
  targetCommit: string | null;
  targetTag: string | null;
}): string {
  const parts = [
    request.mode ? `mode ${request.mode}` : null,
    request.target ? `target ${request.target}` : null,
    request.imageTag ?? request.targetTag,
    request.gitRef ?? request.targetCommit
  ].filter((part): part is string => Boolean(part));
  return parts.join(" / ") || "not specified";
}

function formatRestartRun(run: ManorRestartRun): string {
  return [
    `Manor restart ${run.id}: ${run.status}`,
    `Mode: ${run.mode}. Target: ${run.target}.`,
    run.error ? `Error: ${run.error}` : null,
    ...run.steps.map((step) => `${step.status}: ${step.label}${step.exitCode === null ? "" : ` (${step.exitCode})`}`)
  ]
    .filter((line): line is string => Boolean(line))
    .join("\n");
}

export function buildButlerManorTools(access: ButlerAgentToolAccess): ButlerCustomTool[] {
  return [
    access.defineButlerTool({
      name: "request_manor_restart",
      label: "Request Manor restart",
      description:
        "Open an operator-facing Manor restart/update authorization dialog. This Butler tool does not directly restart or deploy the live Manor stack.",
      promptSnippet:
        "request_manor_restart: use when a Manor restart or update needs explicit operator authorization. Provide clear target and reason details; for source restarts from a local commit, pass the exact commit SHA or local branch as gitRef/targetCommit instead of assuming the ref must be fetched. The operator must click the confirmation dialog. The approval route starts the authorized restart through the host controller; after Manor comes back, use read_manor_restart_status. Do not call start_authorized_manor_restart for the normal dialog flow.",
      parameters: Type.Object({
        reason: Type.String({
          minLength: 1,
          description: "Plain-language reason shown to the operator before they authorize the restart or update."
        }),
        mode: Type.Optional(Type.Union([Type.Literal("auto"), Type.Literal("source"), Type.Literal("image")])),
        target: Type.Optional(Type.Union([Type.Literal("current"), Type.Literal("latest")])),
        gitRef: Type.Optional(Type.String({ minLength: 1, maxLength: 128, pattern: "^[A-Za-z0-9][A-Za-z0-9._/@+-]*$", description: "Local or remote source ref. Use the exact local commit SHA when the operator asks to restart from a local commit." })),
        imageTag: Type.Optional(Type.String({ minLength: 1, maxLength: 128, pattern: "^[A-Za-z0-9_][A-Za-z0-9_.-]*$" })),
        includeDesktop: Type.Optional(Type.Boolean()),
        build: Type.Optional(Type.Boolean()),
        update: Type.Optional(Type.Boolean()),
        targetCommit: Type.Optional(Type.String({ minLength: 7, description: "Optional target Manor commit SHA for the authorized source restart or update." })),
        targetTag: Type.Optional(Type.String({ minLength: 1, description: "Optional target Manor image tag for the authorized update." })),
        details: Type.Optional(Type.String({ minLength: 1, description: "Optional extra restart/update details shown in the confirmation dialog." }))
      }),
      uiEffects: access.getToolUiEffects("request_manor_restart"),
      execute: async (_toolCallId, params) => {
        const typedParams = params as {
          mode?: unknown;
          target?: unknown;
          gitRef?: unknown;
          imageTag?: unknown;
          targetCommit?: unknown;
          targetTag?: unknown;
          includeDesktop?: unknown;
          build?: unknown;
          update?: unknown;
          reason?: unknown;
          details?: unknown;
        };
        const restartRequest = access.requestManorRestartAuthorization(typedParams);
        const target = formatRestartRequestTarget(restartRequest);

        return {
          content: [
            {
              type: "text",
              text: `Opened a Manor restart/update authorization dialog for the operator. Request id: ${restartRequest.id}. Target: ${target}. No live Manor restart, deploy, or stack mutation was performed by Butler.`
            }
          ],
          details: {
            restartRequest,
            liveMutationPerformed: false
          }
        };
      }
    }),
    access.defineButlerTool({
      name: "start_authorized_manor_restart",
      label: "Start authorized restart",
      description:
        "Consume an operator-authorized Manor restart/update request and ask the host controller to start it. This is the live mutation step.",
      promptSnippet:
        "start_authorized_manor_restart: legacy/manual fallback only. Do not call this after the browser approval dialog, because the approval route starts the host-controller run directly. Prefer read_manor_restart_status after Manor comes back.",
      parameters: Type.Object({
        requestId: Type.String({ minLength: 1, description: "Authorized Manor restart request id." })
      }),
      uiEffects: access.getToolUiEffects("start_authorized_manor_restart"),
      execute: async (_toolCallId, params) => {
        const typedParams = params as { requestId?: unknown };
        const requestId = typeof typedParams.requestId === "string" ? typedParams.requestId.trim() : "";
        if (!requestId) {
          throw new Error("requestId is required.");
        }

        let result: Awaited<ReturnType<ButlerAgentToolAccess["startAuthorizedManorRestart"]>>;
        try {
          result = await access.startAuthorizedManorRestart(requestId);
        } catch (error) {
          if (!(error instanceof Error) || !error.message.includes("No authorized Manor restart request")) {
            throw error;
          }
          const status = await access.hostController.getStatus();
          const run = status.active ?? status.latestRun;
          return {
            content: [
              {
                type: "text",
                text: run
                  ? [
                      "No authorized Manor restart request is pending. The approval dialog may already have consumed it.",
                      formatRestartRun(run)
                    ].join("\n")
                  : "No authorized Manor restart request is pending, and no Manor restart has been recorded yet."
              }
            ],
            details: { status }
          };
        }

        return {
          content: [
            {
              type: "text",
              text: [
                `Host controller accepted authorized Manor restart ${result.run.id}.`,
                `Authorized request: ${result.restartRequest.id}.`,
                `Mode: ${result.run.mode}. Target: ${result.run.target}.`,
                "Butler may disconnect while Manor restarts; read restart status after it comes back."
              ].join("\n")
            }
          ],
          details: {
            restartRequest: result.restartRequest,
            run: result.run
          }
        };
      }
    }),
    access.defineButlerTool({
      name: "read_manor_restart_status",
      label: "Restart status",
      description: "Read the host controller's active or latest Manor restart/update run.",
      promptSnippet:
        "read_manor_restart_status: use after an authorized Manor restart request, or when the operator asks whether a Manor restart/update completed.",
      parameters: Type.Object({}),
      uiEffects: access.getToolUiEffects("read_manor_restart_status"),
      execute: async () => {
        const status = await access.hostController.getStatus();
        const run = status.active ?? status.latestRun;
        const text = run ? formatRestartRun(run) : `No Manor restart has been recorded. Detected mode: ${status.detectedMode}.`;
        return {
          content: [{ type: "text", text }],
          details: { status }
        };
      }
    })
  ];
}
