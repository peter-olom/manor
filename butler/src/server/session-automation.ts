import type { PairAutomation, PairAutomationLastRun, PairAutomationSchedule, PairAutomationWeekday } from "../shared/pairing.js";
import { DEFAULT_OPERATOR_TIMEZONE, getZonedWallParts, timezoneOffsetLabel, zonedHourMinute, zonedWallTimeCandidates, zonedWallTimeToUtcMs } from "./operator-timezone.js";

const DAILY_TIME = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
const LOCAL_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const WEEKDAYS: PairAutomationWeekday[] = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

export function normalizeDailyTimes(values: unknown): string[] {
  if (!Array.isArray(values)) throw new Error("dailyTimes must be an array of Butler wall-clock times");
  const normalized = [...new Set(values.map((value) => typeof value === "string" ? value.trim() : ""))].sort();
  if (normalized.length === 0) throw new Error("At least one daily time is required");
  if (normalized.some((value) => !DAILY_TIME.test(value))) throw new Error("Daily times must use 24-hour HH:mm format");
  return normalized;
}

export function normalizeLocalDate(value: unknown, field = "endDate"): string {
  if (typeof value !== "string" || !LOCAL_DATE.test(value.trim())) throw new Error(`${field} must use YYYY-MM-DD format`);
  const normalized = value.trim();
  const match = LOCAL_DATE.exec(normalized)!;
  const year = Number(match[1]), month = Number(match[2]), day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) throw new Error(`${field} must be a real calendar date`);
  return normalized;
}

export function normalizeWeekdays(values: unknown): PairAutomationWeekday[] {
  if (!Array.isArray(values)) throw new Error("weekdays must be an array");
  const normalized = [...new Set(values.map((value) => typeof value === "string" ? value.trim().toLowerCase() : ""))]
    .filter((value): value is PairAutomationWeekday => WEEKDAYS.includes(value as PairAutomationWeekday))
    .sort((left, right) => WEEKDAYS.indexOf(left) - WEEKDAYS.indexOf(right));
  if (normalized.length === 0 || normalized.length !== new Set(values.map((value) => typeof value === "string" ? value.trim().toLowerCase() : "")).size) {
    throw new Error("weekdays must contain valid weekday names");
  }
  return normalized;
}

function optionalEndDate(value: unknown): string | undefined {
  return value === undefined || value === null || value === "" ? undefined : normalizeLocalDate(value);
}

function wallParts(date: string, time: string) {
  const [year, month, day] = date.split("-").map(Number);
  const [hour, minute] = time.split(":").map(Number);
  return { year: year!, month0: month! - 1, day: day!, hour: hour!, minute: minute!, second: 0 };
}

function wallDate(parts: { year: number; month0: number; day: number }): string {
  return `${String(parts.year).padStart(4, "0")}-${String(parts.month0 + 1).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}`;
}

function shiftedWallDate(parts: { year: number; month0: number; day: number }, offset: number): string {
  const date = new Date(Date.UTC(parts.year, parts.month0, parts.day + offset));
  return wallDate({ year: date.getUTCFullYear(), month0: date.getUTCMonth(), day: date.getUTCDate() });
}

function timeMinutes(value: string): number {
  const [hour, minute] = value.split(":").map(Number);
  return hour! * 60 + minute!;
}

function calendarCandidates(date: string, time: string, timezone: string): number[] {
  const parts = wallParts(date, time);
  const exact = zonedWallTimeCandidates(timezone, parts);
  return exact.length > 0 ? exact : [zonedWallTimeToUtcMs(timezone, parts)];
}

export function createDailySchedule(times: unknown, endDate?: unknown): Extract<PairAutomationSchedule, { kind: "daily" }> {
  const schedule: Extract<PairAutomationSchedule, { kind: "daily" }> = { kind: "daily", times: normalizeDailyTimes(times) };
  const endsOn = optionalEndDate(endDate);
  if (endsOn) schedule.endsOn = endsOn;
  return schedule;
}

export function createWeeklySchedule(weekdays: unknown, times: unknown, endDate?: unknown): Extract<PairAutomationSchedule, { kind: "weekly" }> {
  const schedule: Extract<PairAutomationSchedule, { kind: "weekly" }> = { kind: "weekly", weekdays: normalizeWeekdays(weekdays), times: normalizeDailyTimes(times) };
  const endsOn = optionalEndDate(endDate);
  if (endsOn) schedule.endsOn = endsOn;
  return schedule;
}

export function createWindowSchedule(everyMinutes: unknown, startTime: unknown, endTime: unknown, endDate?: unknown): Extract<PairAutomationSchedule, { kind: "window" }> {
  if (!Number.isInteger(everyMinutes) || (everyMinutes as number) < 1 || (everyMinutes as number) > 1_440) throw new Error("Window interval must be a whole number from 1 to 1,440 minutes");
  const times = normalizeDailyTimes([startTime, endTime]);
  const start = typeof startTime === "string" ? startTime.trim() : "";
  const end = typeof endTime === "string" ? endTime.trim() : "";
  if (!times.includes(start) || !times.includes(end) || start === end) throw new Error("Window start and end must be different HH:mm times");
  const duration = (timeMinutes(end) - timeMinutes(start) + 1_440) % 1_440;
  if (Math.floor(duration / (everyMinutes as number)) + 1 > 288) throw new Error("A daily window can schedule at most 288 runs");
  const schedule: Extract<PairAutomationSchedule, { kind: "window" }> = { kind: "window", everyMinutes: everyMinutes as number, startTime: start, endTime: end };
  const endsOn = optionalEndDate(endDate);
  if (endsOn) schedule.endsOn = endsOn;
  return schedule;
}

export function createOnceSchedule(on: unknown, time: unknown, now: number, timezone: string): Extract<PairAutomationSchedule, { kind: "once" }> {
  const normalizedTime = normalizeDailyTimes([time])[0]!;
  const normalizedOn = typeof on === "string" ? on.trim().toLowerCase() : "";
  if (WEEKDAYS.includes(normalizedOn as PairAutomationWeekday)) {
    const current = getZonedWallParts(now, timezone);
    const currentDay = new Date(Date.UTC(current.year, current.month0, current.day)).getUTCDay();
    const targetDay = WEEKDAYS.indexOf(normalizedOn as PairAutomationWeekday);
    let offset = (targetDay - currentDay + 7) % 7;
    let date = shiftedWallDate(current, offset);
    if (calendarCandidates(date, normalizedTime, timezone).every((candidate) => candidate <= now)) {
      offset += 7;
      date = shiftedWallDate(current, offset);
    }
    return { kind: "once", date, time: normalizedTime };
  }
  return { kind: "once", date: normalizeLocalDate(on, "on"), time: normalizedTime };
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
  if (schedule.kind === "once") {
    const candidate = calendarCandidates(schedule.date, schedule.time, timezone).find((value) => value > after);
    return candidate ?? null;
  }
  if (schedule.kind === "daily") {
    const candidate = nextDailyRunAt(schedule.times, after, timezone);
    return !schedule.endsOn || wallDate(getZonedWallParts(candidate, timezone)) <= schedule.endsOn ? candidate : null;
  }
  if (schedule.kind === "weekly") {
    const start = getZonedWallParts(after, timezone);
    for (let offset = 0; offset <= 7; offset += 1) {
      const date = shiftedWallDate(start, offset);
      const day = WEEKDAYS[new Date(`${date}T00:00:00Z`).getUTCDay()]!;
      if (!schedule.weekdays.includes(day) || (schedule.endsOn && date > schedule.endsOn)) continue;
      const next = schedule.times.flatMap((time) => calendarCandidates(date, time, timezone)).filter((candidate) => candidate > after).sort((left, right) => left - right)[0];
      if (next !== undefined) return next;
    }
    return null;
  }
  if (schedule.kind === "window") {
    const start = getZonedWallParts(after, timezone);
    const startMinute = timeMinutes(schedule.startTime);
    const duration = (timeMinutes(schedule.endTime) - startMinute + 1_440) % 1_440;
    const candidates: number[] = [];
    for (let offset = -1; offset <= 1; offset += 1) {
      const anchorDate = shiftedWallDate(start, offset);
      if (schedule.endsOn && anchorDate > schedule.endsOn) continue;
      for (let elapsed = 0; elapsed <= duration; elapsed += schedule.everyMinutes) {
        const nominal = new Date(`${anchorDate}T00:00:00Z`);
        nominal.setUTCMinutes(startMinute + elapsed);
        const occurrenceDate = wallDate({ year: nominal.getUTCFullYear(), month0: nominal.getUTCMonth(), day: nominal.getUTCDate() });
        const occurrenceTime = `${String(nominal.getUTCHours()).padStart(2, "0")}:${String(nominal.getUTCMinutes()).padStart(2, "0")}`;
        candidates.push(...calendarCandidates(occurrenceDate, occurrenceTime, timezone));
      }
    }
    return candidates.filter((candidate) => candidate > after).sort((left, right) => left - right)[0] ?? null;
  }
  const intervalMs = schedule.everyMinutes * 60_000;
  const elapsedIntervals = Math.floor(Math.max(0, after - schedule.startsAt) / intervalMs) + 1;
  const candidate = schedule.startsAt + elapsedIntervals * intervalMs;
  return candidate <= schedule.endsAt ? candidate : null;
}

export function automationScheduledSlotAt(schedule: PairAutomationSchedule, scheduledFor: number, timezone: string): string | null {
  if (schedule.kind === "interval") return null;
  if (schedule.kind === "once") return `${schedule.date}@${schedule.time}`;
  if (schedule.kind === "daily") return dailyScheduledSlotAt(schedule.times, scheduledFor, timezone);
  if (schedule.kind === "weekly") return `${wallDate(getZonedWallParts(scheduledFor, timezone))}@${dailyScheduledSlotAt(schedule.times, scheduledFor, timezone)}`;
  const wall = getZonedWallParts(scheduledFor, timezone);
  const actualDate = wallDate(wall), actualTime = zonedHourMinute(scheduledFor, timezone);
  const startMinute = timeMinutes(schedule.startTime), actualMinute = timeMinutes(actualTime);
  const anchorDate = actualMinute <= timeMinutes(schedule.endTime) && timeMinutes(schedule.endTime) < startMinute ? shiftedWallDate(wall, -1) : actualDate;
  const elapsed = actualMinute >= startMinute ? actualMinute - startMinute : actualMinute + 1_440 - startMinute;
  return `${anchorDate}@${String(elapsed).padStart(4, "0")}`;
}

export function nextCalendarRunAfterLastRun(schedule: PairAutomationSchedule, after: number, timezone: string, lastRun: { scheduledFor: number; scheduledSlot: string | null } | null): number | null {
  let candidate = nextAutomationRunAt(schedule, after, timezone);
  if (!candidate || !lastRun?.scheduledSlot || schedule.kind === "interval" || schedule.kind === "once") return candidate;
  const firedKey = lastRun.scheduledSlot.includes("@") ? lastRun.scheduledSlot : `${wallDate(getZonedWallParts(lastRun.scheduledFor, timezone))}@${lastRun.scheduledSlot}`;
  const cap = schedule.kind === "window" ? 290 : schedule.kind === "weekly" ? schedule.times.length + 2 : schedule.times.length + 2;
  for (let guard = 0; candidate && guard < cap; guard += 1) {
    const rawCandidateKey = automationScheduledSlotAt(schedule, candidate, timezone);
    const candidateKey = rawCandidateKey && !rawCandidateKey.includes("@") ? `${wallDate(getZonedWallParts(candidate, timezone))}@${rawCandidateKey}` : rawCandidateKey;
    if (!candidateKey || candidateKey > firedKey) break;
    candidate = nextAutomationRunAt(schedule, candidate, timezone);
  }
  return candidate;
}

export function upcomingAutomationRuns(schedule: PairAutomationSchedule, after: number, timezone: string, limit = 3): number[] {
  const runs: number[] = [];
  const occurrenceKeys = new Set<string>();
  let cursor = after;
  while (runs.length < Math.max(0, Math.min(limit, 10))) {
    const next = nextAutomationRunAt(schedule, cursor, timezone);
    if (next === null) break;
    cursor = next;
    const rawKey = automationScheduledSlotAt(schedule, next, timezone);
    const key = rawKey && !rawKey.includes("@") ? `${wallDate(getZonedWallParts(next, timezone))}@${rawKey}` : rawKey ?? String(next);
    if (occurrenceKeys.has(key)) continue;
    occurrenceKeys.add(key);
    runs.push(next);
  }
  return runs;
}

/** Last instant a bounded recurring schedule may dispatch. One-off runs catch up when Manor resumes. */
export function automationDispatchEndsAt(schedule: PairAutomationSchedule, timezone: string): number | null {
  if (schedule.kind === "interval") return schedule.endsAt;
  if (schedule.kind === "once" || !("endsOn" in schedule) || !schedule.endsOn) return null;
  if (schedule.kind === "window") {
    const endDate = timeMinutes(schedule.endTime) <= timeMinutes(schedule.startTime)
      ? shiftedWallDate(wallParts(schedule.endsOn, "00:00"), 1)
      : schedule.endsOn;
    return zonedWallTimeToUtcMs(timezone, wallParts(endDate, schedule.endTime));
  }
  return zonedWallTimeToUtcMs(timezone, { ...wallParts(schedule.endsOn, "23:59"), second: 59 }) + 999;
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
  const candidate = nextCalendarRunAfterLastRun({ kind: "daily", times: dailyTimes }, after, timezone, lastRun);
  if (candidate === null) throw new Error("Could not calculate the next daily automation run");
  return candidate;
}

function formatClockTime(value: string): string {
  const [hour, minute] = value.split(":").map(Number);
  const h = hour ?? 0;
  const period = h < 12 ? "AM" : "PM";
  const displayHour = h % 12 === 0 ? 12 : h % 12;
  return `${displayHour}:${String(minute ?? 0).padStart(2, "0")} ${period}`;
}

function formatLocalDate(value: string): string {
  return new Intl.DateTimeFormat("en", { timeZone: "UTC", month: "short", day: "numeric", year: "numeric" }).format(new Date(`${value}T12:00:00Z`));
}

function formatWeekdayList(weekdays: PairAutomationWeekday[]): string {
  const labels = weekdays.map((day) => `${day[0]!.toUpperCase()}${day.slice(1)}`);
  if (labels.length < 2) return labels[0] ?? "";
  if (labels.length === 2) return labels.join(" and ");
  return `${labels.slice(0, -1).join(", ")}, and ${labels.at(-1)}`;
}

export function formatAutomationSchedule(schedule: PairAutomationSchedule): string {
  if (schedule.kind === "once") return `Once on ${formatLocalDate(schedule.date)} at ${formatClockTime(schedule.time)}`;
  if (schedule.kind === "daily") return `Daily at ${schedule.times.map(formatClockTime).join(", ")}${schedule.endsOn ? ` through ${formatLocalDate(schedule.endsOn)}` : ""}`;
  if (schedule.kind === "weekly") return `Every ${formatWeekdayList(schedule.weekdays)} at ${schedule.times.map(formatClockTime).join(", ")}${schedule.endsOn ? ` through ${formatLocalDate(schedule.endsOn)}` : ""}`;
  if (schedule.kind === "window") {
    const interval = schedule.everyMinutes === 60 ? "Hourly" : schedule.everyMinutes === 1 ? "Every minute" : `Every ${schedule.everyMinutes} min`;
    return `${interval} daily from ${formatClockTime(schedule.startTime)} to ${formatClockTime(schedule.endTime)}${schedule.endsOn ? ` through ${formatLocalDate(schedule.endsOn)}` : ""}`;
  }
  const durationMinutes = Math.round((schedule.endsAt - schedule.startsAt) / 60_000);
  const interval = schedule.everyMinutes === 1 ? "Every minute" : `Every ${schedule.everyMinutes} min`;
  return `${interval} for ${durationMinutes} min`;
}

function automationEndLabel(schedule: PairAutomationSchedule, timezone: string): string | null {
  if (schedule.kind === "interval") return formatButlerDateTime(schedule.endsAt, timezone);
  if (schedule.kind === "once") return formatButlerDateTime(zonedWallTimeToUtcMs(timezone, wallParts(schedule.date, schedule.time)), timezone);
  return schedule.endsOn ? `${formatLocalDate(schedule.endsOn)} (inclusive)` : null;
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
  const finite = automation.schedule.kind === "interval" || automation.schedule.kind === "once" || ("endsOn" in automation.schedule && Boolean(automation.schedule.endsOn));
  const completed = automation.enabled && finite && automation.nextRunAt === null && !automation.running;
  return {
    ...automation,
    state: automation.running ? "running" : completed ? "completed" : automation.enabled ? "active" : "paused",
    scheduleLabel: formatAutomationSchedule(automation.schedule),
    endsAtLabel: automationEndLabel(automation.schedule, timezone),
    nextRunLabel: automation.nextRunAt ? formatButlerDateTime(automation.nextRunAt, timezone) : null,
    lastRunLabel: automation.lastRun ? formatButlerDateTime(automation.lastRun.finishedAt, timezone) : null
  };
}

function normalizeStoredSchedule(value: Partial<PairAutomation> & { dailyTimes?: unknown }): PairAutomationSchedule | null {
  const raw = value.schedule;
  if (raw?.kind === "once") {
    try { return { kind: "once", date: normalizeLocalDate(raw.date, "date"), time: normalizeDailyTimes([raw.time])[0]! }; } catch { return null; }
  }
  if (raw?.kind === "daily") {
    try { return createDailySchedule(raw.times, raw.endsOn); } catch { return null; }
  }
  if (raw?.kind === "weekly") {
    try { return createWeeklySchedule(raw.weekdays, raw.times, raw.endsOn); } catch { return null; }
  }
  if (raw?.kind === "window") {
    try { return createWindowSchedule(raw.everyMinutes, raw.startTime, raw.endTime, raw.endsOn); } catch { return null; }
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
  const nextRunSlot = schedule.kind !== "interval" && nextRunAt !== null
    ? typeof value.nextRunSlot === "string" && value.nextRunSlot.trim() ? value.nextRunSlot : automationScheduledSlotAt(schedule, nextRunAt, timezone)
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
  const dispatchEndsAt = automationDispatchEndsAt(schedule, timezone);
  const normalizedNextRunAt = nextRunAt !== null && dispatchEndsAt !== null && nextRunAt > dispatchEndsAt ? null : nextRunAt;
  return withAutomationLabels({
    id: value.id.trim(), instruction, schedule, enabled,
    createdAt, updatedAt, nextRunAt: normalizedNextRunAt, nextRunSlot, running, lastRun
  }, now, timezone);
}
