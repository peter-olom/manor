import { Type } from "@sinclair/typebox";

import type { ButlerAgentToolAccess, ButlerCustomTool } from "./butler-agent-tool-access.js";
import { stringEnumSchema } from "./butler-agent-tool-schemas.js";
import type { ManorRestartRun, ManorSourceState } from "./host-controller-client.js";
import { formatElapsedTaskTime } from "./task-timing.js";
import { formatManorSystemAwareness, MANOR_AWARENESS_SECTIONS, type ManorAwarenessSection } from "./manor-system-awareness.js";

function formatRestartRequestTarget(request: {
  target: string | null;
  gitRef: string | null;
}): string {
  const parts = [
    "source",
    request.target ? `target ${request.target}` : null,
    request.gitRef
  ].filter((part): part is string => Boolean(part));
  return parts.join(" / ") || "not specified";
}

function formatRestartRun(run: ManorRestartRun): string {
  const completedAt = run.completedAt ?? (run.status === "running" ? Date.now() : null);
  const fallbackDurationMs = typeof completedAt === "number" && completedAt >= run.startedAt
    ? completedAt - run.startedAt
    : null;
  const durationMs = typeof run.durationMs === "number" && Number.isFinite(run.durationMs)
    ? run.durationMs
    : fallbackDurationMs;

  return [
    `Manor restart ${run.id}: ${run.status}`,
    `Target: ${run.target}.`,
    durationMs !== null ? `${run.status === "running" ? "Elapsed" : "Duration"}: ${formatElapsedTaskTime(durationMs)}.` : null,
    run.error ? `Error: ${run.error}` : null,
    ...run.steps.map((step) => `${step.status}: ${step.label}${step.exitCode === null ? "" : ` (${step.exitCode})`}`)
  ]
    .filter((line): line is string => Boolean(line))
    .join("\n");
}

function formatSourceState(state: ManorSourceState): string {
  const changed = state.checkout.changedFileCount === 0
    ? "clean"
    : `${state.checkout.changedFileCount} pending local change${state.checkout.changedFileCount === 1 ? "" : "s"}`;
  const runtimeServices = state.runtime.services.map((service) => service.service).join(", ") || "none";
  return [
    state.runtime.summary,
    `Active checkout: ${state.checkout.head.slice(0, 12)} (${changed}).`,
    `Running source-built services checked: ${runtimeServices}.`,
    "This source comparison is authoritative. Restart history is separate and does not determine what source is currently running."
  ].join("\n");
}

export function buildButlerManorTools(access: ButlerAgentToolAccess): ButlerCustomTool[] {
  return [
    access.defineButlerTool({
      name: "inspect_manor_system",
      label: "Inspect Manor system",
      description: "Read Manor's current secret-free system awareness without refreshing registries, validating credentials, changing settings, or mutating runtime state.",
      promptSnippet: "inspect_manor_system: use this as the authoritative source whenever the operator asks what Manor is running, supports, has configured, can access, or currently exposes. Choose providers or models for inventory questions, agents for current Butler/Worker selections, capabilities for tools, security for CAR and egress, services for health/source state, configuration for safe runtime defaults, or all for a complete audit. Preserve the distinction between credential presence, local usability, and last-known reachability.",
      parameters: Type.Object({
        section: Type.Optional(stringEnumSchema(MANOR_AWARENESS_SECTIONS))
      }),
      uiEffects: access.getToolUiEffects("inspect_manor_system"),
      execute: async (_toolCallId, params) => {
        const section = ((params as { section?: ManorAwarenessSection }).section ?? "overview");
        const snapshot = await access.readSystemAwareness(section);
        return {
          content: [{ type: "text", text: formatManorSystemAwareness(snapshot) }],
          details: { snapshot, mutationPerformed: false }
        };
      }
    }),
    access.defineButlerTool({
      name: "request_manor_restart",
      label: "Request Manor restart",
      description:
        "Open an operator-facing Manor restart/update authorization dialog. This Butler tool does not directly restart or deploy the live Manor stack.",
      promptSnippet:
        "request_manor_restart: use when a Manor restart or update needs explicit operator authorization. Provide clear target and reason details; for restarts from a local commit, pass the exact commit SHA or local branch as gitRef instead of assuming the ref must be fetched. The operator must click the confirmation dialog. The approval route starts the authorized restart through the host controller; after Manor comes back, use read_manor_restart_status.",
      parameters: Type.Object({
        reason: Type.String({
          minLength: 1,
          description: "Plain-language reason shown to the operator before they authorize the restart or update."
        }),
        target: Type.Optional(stringEnumSchema(["current", "latest"] as const)),
        gitRef: Type.Optional(Type.String({ minLength: 1, maxLength: 128, pattern: "^[A-Za-z0-9][A-Za-z0-9._/@+-]*$", description: "Local or remote source ref. Use the exact local commit SHA when the operator asks to restart from a local commit." })),
        includeDesktop: Type.Optional(Type.Boolean()),
        build: Type.Optional(Type.Boolean()),
        update: Type.Optional(Type.Boolean()),
        details: Type.Optional(Type.String({ minLength: 1, description: "Optional extra restart/update details shown in the confirmation dialog." }))
      }),
      uiEffects: access.getToolUiEffects("request_manor_restart"),
      execute: async (_toolCallId, params) => {
        const typedParams = params as {
          target?: unknown;
          gitRef?: unknown;
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
        const text = run ? formatRestartRun(run) : "No Manor restart has been recorded.";
        return {
          content: [{ type: "text", text }],
          details: { status }
        };
      }
    }),
    access.defineButlerTool({
      name: "read_manor_source_state",
      label: "Runtime source state",
      description: "Compare the active Manor checkout, including pending local changes, with the source provenance embedded in the running Manor services.",
      promptSnippet:
        "read_manor_source_state: use whenever the operator asks what source or pending local changes Manor is currently running. Treat this result as authoritative. Do not infer runtime source from read_manor_restart_status or from an earlier failed restart.",
      parameters: Type.Object({}),
      uiEffects: access.getToolUiEffects("read_manor_source_state"),
      execute: async () => {
        const state = await access.hostController.getSourceState();
        return {
          content: [{ type: "text", text: formatSourceState(state) }],
          details: { state }
        };
      }
    })
  ];
}
