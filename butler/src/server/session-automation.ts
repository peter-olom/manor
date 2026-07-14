import type { PairAutomation, PairAutomationLastRun, PairAutomationSchedule } from "../shared/pairing.js";

const DAILY_TIME = /^(?:[01]\d|2[0-3]):[0-5]\d$/;

export function normalizeDailyTimes(values: unknown): string[] {
  if (!Array.isArray(values)) throw new Error("dailyTimes must be an array of Butler wall-clock times");
  const normalized = [...new Set(values.map((value) => typeof value === "string" ? value.trim() : ""))].sort();
  if (normalized.length === 0) throw new Error("At least one daily time is required");
  if (normalized.some((value) => !DAILY_TIME.test(value))) throw new Error("Daily times must use 24-hour HH:mm format");
  return normalized;
}

export function nextDailyRunAt(dailyTimes: string[], after: number): number {
  const now = new Date(after);
  for (let dayOffset = 0; dayOffset <= 1; dayOffset += 1) {
    for (const value of dailyTimes) {
      const [hour, minute] = value.split(":").map(Number);
      const candidate = new Date(now);
      candidate.setDate(now.getDate() + dayOffset);
      candidate.setHours(hour!, minute!, 0, 0);
      if (candidate.getTime() > after) return candidate.getTime();
    }
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

export function nextAutomationRunAt(schedule: PairAutomationSchedule, after: number): number | null {
  if (schedule.kind === "daily") return nextDailyRunAt(schedule.times, after);
  const intervalMs = schedule.everyMinutes * 60_000;
  const elapsedIntervals = Math.floor(Math.max(0, after - schedule.startsAt) / intervalMs) + 1;
  const candidate = schedule.startsAt + elapsedIntervals * intervalMs;
  return candidate <= schedule.endsAt ? candidate : null;
}

function formatClockTime(value: string): string {
  const [hour, minute] = value.split(":").map(Number);
  const date = new Date(2000, 0, 1, hour, minute);
  return new Intl.DateTimeFormat("en", { hour: "numeric", minute: "2-digit" }).format(date);
}

export function formatAutomationSchedule(schedule: PairAutomationSchedule): string {
  if (schedule.kind === "daily") return `Daily at ${schedule.times.map(formatClockTime).join(", ")}`;
  const durationMinutes = Math.round((schedule.endsAt - schedule.startsAt) / 60_000);
  const interval = schedule.everyMinutes === 1 ? "Every minute" : `Every ${schedule.everyMinutes} min`;
  return `${interval} for ${durationMinutes} min`;
}

export function formatButlerDateTime(value: number): string {
  return `${new Intl.DateTimeFormat("en", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit"
  }).format(new Date(value))} Butler clock`;
}

export function withAutomationLabels(automation: Omit<PairAutomation, "state" | "scheduleLabel" | "endsAtLabel" | "nextRunLabel" | "lastRunLabel">, now = Date.now()): PairAutomation {
  const completed = automation.schedule.kind === "interval" && automation.schedule.endsAt <= now && !automation.running;
  return {
    ...automation,
    state: automation.running ? "running" : completed ? "completed" : automation.enabled ? "active" : "paused",
    scheduleLabel: formatAutomationSchedule(automation.schedule),
    endsAtLabel: automation.schedule.kind === "interval" ? formatButlerDateTime(automation.schedule.endsAt) : null,
    nextRunLabel: automation.nextRunAt ? formatButlerDateTime(automation.nextRunAt) : null,
    lastRunLabel: automation.lastRun ? formatButlerDateTime(automation.lastRun.finishedAt) : null
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

export function normalizeStoredAutomation(raw: unknown, now = Date.now()): PairAutomation | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Partial<PairAutomation>;
  const instruction = typeof value.instruction === "string" ? value.instruction.trim().slice(0, 20_000) : "";
  if (!instruction || typeof value.id !== "string" || !value.id.trim()) return null;
  const schedule = normalizeStoredSchedule(value as Partial<PairAutomation> & { dailyTimes?: unknown });
  if (!schedule) return null;
  const createdAt = typeof value.createdAt === "number" && Number.isFinite(value.createdAt) ? value.createdAt : now;
  const updatedAt = typeof value.updatedAt === "number" && Number.isFinite(value.updatedAt) ? value.updatedAt : createdAt;
  const nextRunAt = typeof value.nextRunAt === "number" && Number.isFinite(value.nextRunAt) ? value.nextRunAt : null;
  const running = value.running && typeof value.running.id === "string" && Number.isFinite(value.running.scheduledFor) && Number.isFinite(value.running.startedAt)
    ? { id: value.running.id, scheduledFor: value.running.scheduledFor, startedAt: value.running.startedAt }
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
        resultPath: typeof storedLast.resultPath === "string" && storedLast.resultPath.trim() ? storedLast.resultPath : null
      }
    : null;
  const enabled = value.enabled !== false;
  const normalizedNextRunAt = schedule.kind === "interval" && nextRunAt !== null && nextRunAt > schedule.endsAt ? null : nextRunAt;
  return withAutomationLabels({
    id: value.id.trim(), instruction, schedule, enabled,
    createdAt, updatedAt, nextRunAt: normalizedNextRunAt, running, lastRun
  }, now);
}
