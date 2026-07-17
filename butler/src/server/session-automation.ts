import type { PairAutomation, PairAutomationLastRun, PairAutomationSchedule } from "../shared/pairing.js";
import { DEFAULT_OPERATOR_TIMEZONE, getZonedWallParts, timezoneOffsetLabel, zonedHourMinute, zonedWallTimeCandidates, zonedWallTimeToUtcMs } from "./operator-timezone.js";

const DAILY_TIME = /^(?:[01]\d|2[0-3]):[0-5]\d$/;

export function normalizeDailyTimes(values: unknown): string[] {
  if (!Array.isArray(values)) throw new Error("dailyTimes must be an array of Butler wall-clock times");
  const normalized = [...new Set(values.map((value) => typeof value === "string" ? value.trim() : ""))].sort();
  if (normalized.length === 0) throw new Error("At least one daily time is required");
  if (normalized.some((value) => !DAILY_TIME.test(value))) throw new Error("Daily times must use 24-hour HH:mm format");
  return normalized;
}

/**
 * Returns the epoch ms of the next daily wall-clock run after `after`, where
 * `dailyTimes` are 24-hour HH:mm strings interpreted in `timezone`.
 *
 * DST: all concrete instants for the day's wall-clock slots are compared so
 * folded times and multiple slots stay in chronological order. A non-existent
 * spring-forward time uses compatible shift-forward semantics.
 *
 * Scheduling refresh: an automation's stored `nextRunAt` is re-derived through
 * this function on the next scheduling cycle (configure/claim/finish/restart), and
 * also immediately when the operator changes their timezone via the Settings UI
 * (see `PairStore.recomputeAutomationSchedules`), so already-scheduled daily
 * runs move to the new zone in real time.
 */
export function nextDailyRunAt(dailyTimes: string[], after: number, timezone: string = DEFAULT_OPERATOR_TIMEZONE): number {
  const start = getZonedWallParts(after, timezone);
  for (let dayOffset = 0; dayOffset <= 1; dayOffset += 1) {
    const candidates: number[] = [];
    for (const value of dailyTimes) {
      const [hour, minute] = value.split(":").map(Number);
      const nominal = new Date(Date.UTC(start.year, start.month0, start.day + dayOffset, hour ?? 0, minute ?? 0, 0));
      const parts = {
        year: nominal.getUTCFullYear(), month0: nominal.getUTCMonth(), day: nominal.getUTCDate(),
        hour: nominal.getUTCHours(), minute: nominal.getUTCMinutes(), second: 0
      };
      const exact = zonedWallTimeCandidates(timezone, parts);
      candidates.push(...(exact.length > 0 ? exact : [zonedWallTimeToUtcMs(timezone, parts)]));
    }
    const next = candidates.filter((candidate) => candidate > after).sort((left, right) => left - right)[0];
    if (next !== undefined) return next;
  }
  throw new Error("Could not calculate the next automation run");
}

export function createIntervalSchedule(everyMinutes: unknown, durationMinutes: unknown, now = Date.now()): Extract<PairAutomationSchedule, { kind: "interval" }> {
  if (!Number.isInteger(everyMinutes) || (everyMinutes as number) < 1 || (everyMinutes as number) > 1_440) {
    throw new Error("Interval must be a whole number from 1 to 1,440 minutes");
  }
  if (!Number.isInteger(durationMinutes) || (durationMinutes as number) < (everyMinutes as number) || (durationMinutes as number) > 10_080) {
    throw new Error("Duration must be at least one interval and no more than 7 days");
  }
  if (Math.floor((durationMinutes as number) / (everyMinutes as number)) > 288) {
    throw new Error("An interval automation can schedule at most 288 runs");
  }
  return { kind: "interval", everyMinutes: everyMinutes as number, startsAt: now, endsAt: now + (durationMinutes as number) * 60_000 };
}

export function nextAutomationRunAt(schedule: PairAutomationSchedule, after: number, timezone: string = DEFAULT_OPERATOR_TIMEZONE): number | null {
  if (schedule.kind === "daily") return nextDailyRunAt(schedule.times, after, timezone);
  const intervalMs = schedule.everyMinutes * 60_000;
  const elapsedIntervals = Math.floor(Math.max(0, after - schedule.startsAt) / intervalMs) + 1;
  const candidate = schedule.startsAt + elapsedIntervals * intervalMs;
  return candidate <= schedule.endsAt ? candidate : null;
}

/** Resolves a concrete daily run back to its configured HH:mm slot. */
export function dailyScheduledSlotAt(dailyTimes: string[], scheduledFor: number, timezone: string): string {
  const day = getZonedWallParts(scheduledFor, timezone);
  for (const value of dailyTimes) {
    const [hour, minute] = value.split(":").map(Number);
    const parts = { year: day.year, month0: day.month0, day: day.day, hour: hour ?? 0, minute: minute ?? 0, second: 0 };
    const exact = zonedWallTimeCandidates(timezone, parts);
    const candidates = exact.length > 0 ? exact : [zonedWallTimeToUtcMs(timezone, parts)];
    if (candidates.includes(scheduledFor)) return value;
  }
  return zonedHourMinute(scheduledFor, timezone);
}

function zonedDayKey(ms: number, timezone: string): string {
  const wall = getZonedWallParts(ms, timezone);
  return `${wall.year}-${wall.month0}-${wall.day}`;
}

/**
 * Next daily run after `after` in `timezone`, skipping only the specific slot that
 * already fired (not the whole calendar day). If `lastRun` is present, the
 * candidate is advanced past slots up to the most recently fired configured slot
 * on the new-zone calendar day of `lastRun.scheduledFor`, so a timezone change
 * cannot replay earlier slots while still keeping later same-day slots
 * (e.g. ['09:00','17:00']: after 09:00 fires, 17:00 still runs today). The iteration
 * cap scales with the number of daily times so it never over-skips.
 */
export function nextDailyRunAfterLastRun(dailyTimes: string[], after: number, timezone: string, lastRun: { scheduledFor: number; scheduledSlot: string | null } | null): number {
  let candidate = nextDailyRunAt(dailyTimes, after, timezone);
  if (!lastRun || !lastRun.scheduledSlot) return candidate;
  const firedDay = zonedDayKey(lastRun.scheduledFor, timezone);
  const firedSlot = lastRun.scheduledSlot;
  const cap = Math.max(dailyTimes.length, 1) + 2;
  for (let guard = 0; guard < cap; guard += 1) {
    if (zonedDayKey(candidate, timezone) !== firedDay || zonedHourMinute(candidate, timezone) > firedSlot) break;
    candidate = nextDailyRunAt(dailyTimes, candidate, timezone);
  }
  return candidate;
}

function formatClockTime(value: string): string {
  const [hour, minute] = value.split(":").map(Number);
  const h = hour ?? 0;
  const period = h < 12 ? "AM" : "PM";
  const displayHour = h % 12 === 0 ? 12 : h % 12;
  return `${displayHour}:${String(minute ?? 0).padStart(2, "0")} ${period}`;
}

export function formatAutomationSchedule(schedule: PairAutomationSchedule): string {
  if (schedule.kind === "daily") return `Daily at ${schedule.times.map(formatClockTime).join(", ")}`;
  const durationMinutes = Math.round((schedule.endsAt - schedule.startsAt) / 60_000);
  const interval = schedule.everyMinutes === 1 ? "Every minute" : `Every ${schedule.everyMinutes} min`;
  return `${interval} for ${durationMinutes} min`;
}

export function formatButlerDateTime(value: number, timezone: string = DEFAULT_OPERATOR_TIMEZONE): string {
  const main = new Intl.DateTimeFormat("en", {
    timeZone: timezone,
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit"
  }).format(new Date(value));
  return `${main} ${timezoneOffsetLabel(timezone, value)}`;
}

export function withAutomationLabels(automation: Omit<PairAutomation, "state" | "scheduleLabel" | "endsAtLabel" | "nextRunLabel" | "lastRunLabel">, now = Date.now(), timezone: string = DEFAULT_OPERATOR_TIMEZONE): PairAutomation {
  const completed = automation.schedule.kind === "interval" && automation.schedule.endsAt <= now && !automation.running;
  return {
    ...automation,
    state: automation.running ? "running" : completed ? "completed" : automation.enabled ? "active" : "paused",
    scheduleLabel: formatAutomationSchedule(automation.schedule),
    endsAtLabel: automation.schedule.kind === "interval" ? formatButlerDateTime(automation.schedule.endsAt, timezone) : null,
    nextRunLabel: automation.nextRunAt ? formatButlerDateTime(automation.nextRunAt, timezone) : null,
    lastRunLabel: automation.lastRun ? formatButlerDateTime(automation.lastRun.finishedAt, timezone) : null
  };
}

function normalizeStoredSchedule(value: Partial<PairAutomation> & { dailyTimes?: unknown }): PairAutomationSchedule | null {
  const raw = value.schedule;
  if (raw?.kind === "daily") {
    try { return { kind: "daily", times: normalizeDailyTimes(raw.times) }; } catch { return null; }
  }
  if (raw?.kind === "interval" && Number.isInteger(raw.everyMinutes) && raw.everyMinutes >= 1 && raw.everyMinutes <= 1_440 &&
    Number.isFinite(raw.startsAt) && Number.isFinite(raw.endsAt) && raw.endsAt > raw.startsAt &&
    Math.floor((raw.endsAt - raw.startsAt) / (raw.everyMinutes * 60_000)) <= 288) {
    return { kind: "interval", everyMinutes: raw.everyMinutes, startsAt: raw.startsAt, endsAt: raw.endsAt };
  }
  try { return { kind: "daily", times: normalizeDailyTimes(value.dailyTimes) }; } catch { return null; }
}

export function normalizeStoredAutomation(raw: unknown, now = Date.now(), timezone: string = DEFAULT_OPERATOR_TIMEZONE): PairAutomation | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Partial<PairAutomation>;
  const instruction = typeof value.instruction === "string" ? value.instruction.trim().slice(0, 20_000) : "";
  if (!instruction || typeof value.id !== "string" || !value.id.trim()) return null;
  const schedule = normalizeStoredSchedule(value as Partial<PairAutomation> & { dailyTimes?: unknown });
  if (!schedule) return null;
  const createdAt = typeof value.createdAt === "number" && Number.isFinite(value.createdAt) ? value.createdAt : now;
  const updatedAt = typeof value.updatedAt === "number" && Number.isFinite(value.updatedAt) ? value.updatedAt : createdAt;
  const nextRunAt = typeof value.nextRunAt === "number" && Number.isFinite(value.nextRunAt) ? value.nextRunAt : null;
  const nextRunSlot = schedule.kind === "daily" && nextRunAt !== null
    ? typeof value.nextRunSlot === "string" && schedule.times.includes(value.nextRunSlot)
      ? value.nextRunSlot
      : dailyScheduledSlotAt(schedule.times, nextRunAt, timezone)
    : null;
  const running = value.running && typeof value.running.id === "string" && Number.isFinite(value.running.scheduledFor) && Number.isFinite(value.running.startedAt)
    ? { id: value.running.id, scheduledFor: value.running.scheduledFor, startedAt: value.running.startedAt, scheduledSlot: typeof value.running.scheduledSlot === "string" ? value.running.scheduledSlot : null }
    : null;
  const storedLast = value.lastRun as Partial<PairAutomationLastRun> | null | undefined;
  const lastRun = storedLast && typeof storedLast.id === "string" && Number.isFinite(storedLast.scheduledFor) && Number.isFinite(storedLast.startedAt) && Number.isFinite(storedLast.finishedAt) &&
    (storedLast.outcome === "succeeded" || storedLast.outcome === "failed" || storedLast.outcome === "skipped" || storedLast.outcome === "needs_input")
    ? {
        id: storedLast.id,
        scheduledFor: storedLast.scheduledFor!,
        startedAt: storedLast.startedAt!,
        finishedAt: storedLast.finishedAt!,
        outcome: storedLast.outcome,
        summary: typeof storedLast.summary === "string" ? storedLast.summary : "",
        resultPath: typeof storedLast.resultPath === "string" && storedLast.resultPath.trim() ? storedLast.resultPath : null,
        scheduledSlot: typeof storedLast.scheduledSlot === "string" ? storedLast.scheduledSlot : null
      }
    : null;
  const enabled = value.enabled !== false;
  const normalizedNextRunAt = schedule.kind === "interval" && nextRunAt !== null && nextRunAt > schedule.endsAt ? null : nextRunAt;
  return withAutomationLabels({
    id: value.id.trim(), instruction, schedule, enabled,
    createdAt, updatedAt, nextRunAt: normalizedNextRunAt, nextRunSlot, running, lastRun
  }, now, timezone);
}
