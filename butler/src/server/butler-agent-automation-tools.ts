import { Type } from "@sinclair/typebox";

import type { ButlerAgentToolAccess, ButlerCustomTool } from "./butler-agent-tool-access.js";
import { formatTimezoneLabel, resolveOperatorTimezone } from "./operator-timezone.js";

export function buildButlerAutomationTools(access: ButlerAgentToolAccess): ButlerCustomTool[] {
  const automation = access.getAutomationAccess();
  if (!automation) return [];
  return [
    access.defineButlerTool({
      name: "configure_automation",
      label: "Configure automation",
      description: "Create or replace a daily wall-clock automation attached to this Butler session. Times are interpreted in the operator's configured timezone.",
      promptSnippet: "configure_automation: Configure this session's one daily automation only after the task and the operator's local wall-clock times are clear. Times are 24-hour HH:mm in the operator's configured timezone (do not convert to UTC yourself). This replaces the previous schedule and enables it.",
      parameters: Type.Object({
        instruction: Type.String({ minLength: 1, maxLength: 20_000 }),
        dailyTimes: Type.Array(Type.String({ pattern: "^(?:[01]\\d|2[0-3]):[0-5]\\d$" }), { minItems: 1, uniqueItems: true })
      }),
      uiEffects: access.getToolUiEffects("configure_automation"),
      execute: async (_toolCallId, params) => {
        const configured = await automation.configure(params as { instruction: string; dailyTimes: string[] });
        const tzLabel = formatTimezoneLabel(resolveOperatorTimezone());
        return { content: [{ type: "text", text: `Automation configured. ${configured.scheduleLabel}. Next run: ${configured.nextRunLabel}. Times run in the operator timezone (${tzLabel}).` }], details: { automation: configured } };
      }
    }),
    access.defineButlerTool({
      name: "configure_interval_automation",
      label: "Configure interval automation",
      description: "Create or replace a bounded automation that repeats every N minutes for a fixed duration.",
      promptSnippet: "configure_interval_automation: Use for requests such as every 5 minutes for the next 30 minutes. The first run occurs after one interval. Provide the requested cadence and duration exactly. This replaces the previous schedule and enables it. Never claim recurring timers are unavailable when this tool can represent the request.",
      parameters: Type.Object({
        instruction: Type.String({ minLength: 1, maxLength: 20_000 }),
        everyMinutes: Type.Integer({ minimum: 1, maximum: 1_440 }),
        durationMinutes: Type.Integer({ minimum: 1, maximum: 10_080 })
      }),
      uiEffects: access.getToolUiEffects("configure_interval_automation"),
      execute: async (_toolCallId, params) => {
        const configured = await automation.configureInterval(params as { instruction: string; everyMinutes: number; durationMinutes: number });
        const tzLabel = formatTimezoneLabel(resolveOperatorTimezone());
        return { content: [{ type: "text", text: `Automation configured. ${configured.scheduleLabel}. Runs through: ${configured.endsAtLabel}. Next run: ${configured.nextRunLabel}. Times display in the operator timezone (${tzLabel}).` }], details: { automation: configured } };
      }
    }),
    access.defineButlerTool({
      name: "set_automation_enabled",
      label: "Pause or resume automation",
      description: "Pause or resume the automation attached to this Butler session.",
      promptSnippet: "set_automation_enabled: Pause or resume the current session automation. Do not claim the state changed until the tool succeeds.",
      parameters: Type.Object({ enabled: Type.Boolean() }),
      uiEffects: access.getToolUiEffects("set_automation_enabled"),
      execute: async (_toolCallId, params) => {
        const configured = await automation.setEnabled((params as { enabled: boolean }).enabled);
        return { content: [{ type: "text", text: configured.enabled ? `Automation resumed. Next run: ${configured.nextRunLabel}.` : "Automation paused." }], details: { automation: configured } };
      }
    }),
    access.defineButlerTool({
      name: "delete_automation",
      label: "Delete automation",
      description: "Delete the automation attached to this Butler session.",
      promptSnippet: "delete_automation: Permanently remove this session's automation after the operator asks to delete it. Existing session messages and saved results remain.",
      parameters: Type.Object({}),
      uiEffects: access.getToolUiEffects("delete_automation"),
      execute: async () => {
        if (!await automation.delete()) throw new Error("This session does not have an automation");
        return { content: [{ type: "text", text: "Automation deleted. Existing session history and saved results remain." }] };
      }
    })
  ];
}
