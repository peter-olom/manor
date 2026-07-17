import { Type } from "@sinclair/typebox";

import type { PairAutomation } from "../shared/pairing.js";
import type { ButlerAgentToolAccess, ButlerCustomTool } from "./butler-agent-tool-access.js";
import { formatTimezoneLabel, resolveOperatorTimezone } from "./operator-timezone.js";
import { formatButlerDateTime, upcomingAutomationRuns } from "./session-automation.js";

const CLOCK_TIME = Type.String({ minLength: 1, pattern: "^(?:[01]\\d|2[0-3]):[0-5]\\d$" });
const LOCAL_DATE = Type.String({ minLength: 1, pattern: "^\\d{4}-\\d{2}-\\d{2}$" });
const WEEKDAY = Type.Union(["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"].map((day) => Type.Literal(day)));

function configurationResult(configured: PairAutomation) {
  const timezone = resolveOperatorTimezone();
  const upcoming = upcomingAutomationRuns(configured.schedule, Date.now(), timezone, 3).map((run) => formatButlerDateTime(run, timezone));
  const preview = upcoming.length > 0 ? ` Next runs: ${upcoming.join("; ")}.` : " No future runs remain.";
  return { content: [{ type: "text" as const, text: `Automation configured: ${configured.scheduleLabel}.${preview} Operator timezone: ${formatTimezoneLabel(timezone)}.` }], details: { automation: configured, upcomingRuns: upcoming, timezone } };
}

export function buildButlerAutomationTools(access: ButlerAgentToolAccess): ButlerCustomTool[] {
  const automation = access.getAutomationAccess();
  if (!automation) return [];
  return [
    access.defineButlerTool({
      name: "inspect_automation",
      label: "Inspect automation",
      description: "Read the current session automation state, schedule, next run, and latest outcome.",
      promptSnippet: "inspect_automation: Use before answering whether an automation is enabled, stopped, overdue, skipped, failed, or when it will run next. Report the returned state instead of inferring it from conversation history.",
      parameters: Type.Object({}),
      uiEffects: access.getToolUiEffects("inspect_automation"),
      execute: async () => {
        const current = automation.get();
        if (!current) return { content: [{ type: "text", text: "This session does not have an automation." }], details: { automation: null } };
        const latest = current.lastRun
          ? ` Last outcome: ${current.lastRun.outcome} at ${current.lastRunLabel ?? current.lastRun.finishedAt}. ${current.lastRun.summary}`
          : " No run has completed yet.";
        return {
          content: [{ type: "text", text: `Automation is ${current.enabled ? "enabled" : "paused"} (${current.state}). ${current.scheduleLabel}. Next run: ${current.nextRunLabel ?? "none"}.${latest}` }],
          details: { automation: current }
        };
      }
    }),
    access.defineButlerTool({
      name: "configure_automation",
      label: "Configure automation",
      description: "Create or replace a daily wall-clock automation, optionally through an inclusive local end date.",
      promptSnippet: "configure_automation: Use for every-day requests at one or more exact local times. endDate is optional and inclusive, so a 17:00 schedule ending 2026-08-03 still runs at 17:00 on August 3. Use operator-local HH:mm and YYYY-MM-DD values without UTC conversion.",
      parameters: Type.Object({
        instruction: Type.String({ minLength: 1, maxLength: 20_000 }),
        dailyTimes: Type.Array(CLOCK_TIME, { minItems: 1, uniqueItems: true }),
        endDate: Type.Optional(LOCAL_DATE)
      }),
      uiEffects: access.getToolUiEffects("configure_automation"),
      execute: async (_toolCallId, params) => {
        const configured = await automation.configure(params as { instruction: string; dailyTimes: string[]; endDate?: string });
        return configurationResult(configured);
      }
    }),
    access.defineButlerTool({
      name: "configure_once_automation",
      label: "Configure one-off automation",
      description: "Run once at a local date and time, or on the next occurrence of a singular weekday.",
      promptSnippet: "configure_once_automation: Use for one specific occurrence such as 'at 5 PM on Sunday'. Pass on='sunday' for the next Sunday occurrence, or an exact YYYY-MM-DD date. A singular weekday is one-off; use configure_weekly_automation for plural or recurring weekdays.",
      parameters: Type.Object({ instruction: Type.String({ minLength: 1, maxLength: 20_000 }), on: Type.String({ minLength: 1, pattern: "^(?:\\d{4}-\\d{2}-\\d{2}|monday|tuesday|wednesday|thursday|friday|saturday|sunday)$" }), time: CLOCK_TIME }),
      uiEffects: access.getToolUiEffects("configure_once_automation"),
      execute: async (_toolCallId, params) => configurationResult(await automation.configureOnce(params as { instruction: string; on: string; time: string }))
    }),
    access.defineButlerTool({
      name: "configure_weekly_automation",
      label: "Configure weekly automation",
      description: "Run at exact local times on selected weekdays, optionally through an inclusive local end date.",
      promptSnippet: "configure_weekly_automation: Use for recurring weekday requests such as 'at 5 PM on Sundays'. Weekdays are recurring. endDate is optional and inclusive.",
      parameters: Type.Object({ instruction: Type.String({ minLength: 1, maxLength: 20_000 }), weekdays: Type.Array(WEEKDAY, { minItems: 1, uniqueItems: true }), times: Type.Array(CLOCK_TIME, { minItems: 1, uniqueItems: true }), endDate: Type.Optional(LOCAL_DATE) }),
      uiEffects: access.getToolUiEffects("configure_weekly_automation"),
      execute: async (_toolCallId, params) => configurationResult(await automation.configureWeekly(params as { instruction: string; weekdays: string[]; times: string[]; endDate?: string }))
    }),
    access.defineButlerTool({
      name: "configure_window_automation",
      label: "Configure daily window automation",
      description: "Repeat at a fixed minute interval inside a daily local-time window, including windows that cross midnight.",
      promptSnippet: "configure_window_automation: Use for requests such as hourly every day from 19:00 through 00:00. Both boundaries are included when they land on the cadence. A cross-midnight window belongs to the local date on which it starts; an inclusive endDate includes that date's whole window.",
      parameters: Type.Object({ instruction: Type.String({ minLength: 1, maxLength: 20_000 }), everyMinutes: Type.Integer({ minimum: 1, maximum: 1_440 }), startTime: CLOCK_TIME, endTime: CLOCK_TIME, endDate: Type.Optional(LOCAL_DATE) }),
      uiEffects: access.getToolUiEffects("configure_window_automation"),
      execute: async (_toolCallId, params) => configurationResult(await automation.configureWindow(params as { instruction: string; everyMinutes: number; startTime: string; endTime: string; endDate?: string }))
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
