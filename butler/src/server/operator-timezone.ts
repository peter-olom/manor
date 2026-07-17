import { getActiveManorSettings } from "./manor-settings-runtime.js";

export const DEFAULT_OPERATOR_TIMEZONE = "UTC";

export type ZonedWallParts = {
  year: number;
  month0: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
};

const TIMEZONE_VALIDITY_CACHE = new Map<string, boolean>();

/**
 * Returns true when `value` is an IANA timezone identifier that the runtime can
 * resolve. `Intl.DateTimeFormat` throws a `RangeError` for unknown zones, which
 * is the canonical Node-side validity check.
 */
export function isValidTimezone(value: string): boolean {
  if (!value) return false;
  const cached = TIMEZONE_VALIDITY_CACHE.get(value);
  if (cached !== undefined) return cached;
  let valid = false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    valid = true;
  } catch {
    valid = false;
  }
  TIMEZONE_VALIDITY_CACHE.set(value, valid);
  return valid;
}

/** Coerces an unknown settings value into a usable IANA timezone, falling back to UTC. */
export function normalizeTimezone(value: unknown, fallback: string = DEFAULT_OPERATOR_TIMEZONE): string {
  if (typeof value !== "string") return fallback;
  const trimmed = value.trim();
  if (!trimmed) return fallback;
  return isValidTimezone(trimmed) ? trimmed : fallback;
}

/**
 * Reads the operator timezone from the active Manor settings. Always returns a
 * valid IANA zone (UTC when unset, invalid, or before the settings service loads).
 *
 * Live vs scheduled: this is re-read on every automation mutation and label
 * refresh, so displayed times follow a timezone change immediately. When the
 * operator changes the timezone via the Settings UI, `PairStore.recomputeAutomationSchedules`
 * (invoked by the settings-apply handler) re-derives each enabled daily
 * automation's stored `nextRunAt` into the new zone, so scheduling also updates
 * in real time without a restart.
 */
export function resolveOperatorTimezone(): string {
  try {
    return normalizeTimezone(getActiveManorSettings().overview.operatorTimezone);
  } catch {
    return DEFAULT_OPERATOR_TIMEZONE;
  }
}

const FORMATTER_CACHE = new Map<string, Intl.DateTimeFormat>();

function zonedPartsFormatter(timezone: string): Intl.DateTimeFormat {
  const cached = FORMATTER_CACHE.get(timezone);
  if (cached) return cached;
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  });
  FORMATTER_CACHE.set(timezone, formatter);
  return formatter;
}

function partsToWallParts(parts: Intl.DateTimeFormatPart[]): ZonedWallParts {
  const map: Record<string, string> = {};
  for (const part of parts) {
    if (part.type === "literal") continue;
    map[part.type] = part.value;
  }
  // Some runtimes emit "24" for midnight with hour12:false; normalize to 0.
  let hour = Number(map.hour ?? "0");
  if (Number.isNaN(hour)) hour = 0;
  if (hour === 24) hour = 0;
  return {
    year: Number(map.year ?? "1970"),
    month0: Math.max(0, Number(map.month ?? "1") - 1),
    day: Number(map.day ?? "1"),
    hour,
    minute: Number(map.minute ?? "0"),
    second: Number(map.second ?? "0")
  };
}

/** Wall-clock components (Y/M/D/H/M/S) that the given instant maps to in `timezone`. */
export function getZonedWallParts(ms: number, timezone: string): ZonedWallParts {
  return partsToWallParts(zonedPartsFormatter(timezone).formatToParts(new Date(ms)));
}

/** The HH:mm wall-clock slot of `ms` in `timezone` (e.g. `09:00`). */
export function zonedHourMinute(ms: number, timezone: string): string {
  const wall = getZonedWallParts(ms, timezone);
  return `${String(wall.hour).padStart(2, "0")}:${String(wall.minute).padStart(2, "0")}`;
}

/**
 * Offset (in milliseconds) of `timezone` at the given instant, defined so that
 * `wallAsUtc = ms + offset` (e.g. UTC+1 in winter => +3_600_000).
 */
function getOffsetMs(ms: number, timezone: string): number {
  const wall = getZonedWallParts(ms, timezone);
  const wallAsUtc = Date.UTC(wall.year, wall.month0, wall.day, wall.hour, wall.minute, wall.second);
  return wallAsUtc - ms;
}

export function zonedWallTimeMatches(ms: number, timezone: string, parts: ZonedWallParts): boolean {
  const wall = getZonedWallParts(ms, timezone);
  return wall.year === parts.year && wall.month0 === parts.month0 && wall.day === parts.day &&
    wall.hour === parts.hour && wall.minute === parts.minute && wall.second === parts.second;
}

const OFFSET_PROBE_WINDOW_MS = 36 * 60 * 60_000;

function normalizeWallParts(parts: ZonedWallParts): ZonedWallParts {
  const normalized = new Date(Date.UTC(parts.year, parts.month0, parts.day, parts.hour, parts.minute, parts.second));
  return {
    year: normalized.getUTCFullYear(),
    month0: normalized.getUTCMonth(),
    day: normalized.getUTCDate(),
    hour: normalized.getUTCHours(),
    minute: normalized.getUTCMinutes(),
    second: normalized.getUTCSeconds()
  };
}

/** Every real instant represented by a wall time, ordered earliest first. */
export function zonedWallTimeCandidates(timezone: string, parts: ZonedWallParts): number[] {
  const normalized = normalizeWallParts(parts);
  const wallAsUtc = Date.UTC(normalized.year, normalized.month0, normalized.day, normalized.hour, normalized.minute, normalized.second);
  const offsets = [...new Set([
    getOffsetMs(wallAsUtc - OFFSET_PROBE_WINDOW_MS, timezone),
    getOffsetMs(wallAsUtc, timezone),
    getOffsetMs(wallAsUtc + OFFSET_PROBE_WINDOW_MS, timezone)
  ])];
  const matches = offsets
    .map((offset) => wallAsUtc - offset)
    .filter((candidate) => zonedWallTimeMatches(candidate, timezone, normalized));
  return [...new Set(matches)].sort((left, right) => left - right);
}

/**
 * Converts a wall-clock time in `timezone` to a UTC epoch milliseconds value.
 * Handles DST transitions deterministically:
 * - Ambiguous fall-back time (a wall time that occurs twice when clocks move
 *   back): the earlier (first) occurrence is returned.
 * - Non-existent spring-forward time: use compatible shift-forward semantics.
 *   For example, 02:30 in a one-hour gap runs at 03:30 local time, so a schedule
 *   is never moved earlier or silently skipped.
 */
export function zonedWallTimeToUtcMs(timezone: string, parts: ZonedWallParts): number {
  const matches = zonedWallTimeCandidates(timezone, parts);
  if (matches.length > 0) return matches[0]!;
  const normalized = normalizeWallParts(parts);
  const wallAsUtc = Date.UTC(normalized.year, normalized.month0, normalized.day, normalized.hour, normalized.minute, normalized.second);
  const beforeOffset = getOffsetMs(wallAsUtc - OFFSET_PROBE_WINDOW_MS, timezone);
  const afterOffset = getOffsetMs(wallAsUtc + OFFSET_PROBE_WINDOW_MS, timezone);
  return wallAsUtc - Math.min(beforeOffset, afterOffset);
}

/** Formats a UTC offset (in minutes) as a compact `UTC`, `UTC+1`, or `UTC-5:30` label. */
export function formatOffsetLabel(offsetMinutes: number): string {
  const rounded = Math.round(offsetMinutes);
  if (rounded === 0) return "UTC";
  const sign = rounded > 0 ? "+" : "-";
  const absolute = Math.abs(rounded);
  const hours = Math.floor(absolute / 60);
  const minutes = absolute % 60;
  return minutes === 0 ? `UTC${sign}${hours}` : `UTC${sign}${hours}:${String(minutes).padStart(2, "0")}`;
}

/** Short offset label for `timezone` at the given instant (e.g. `UTC+1`), defaulting to now. */
export function timezoneOffsetLabel(timezone: string, atMs: number = Date.now()): string {
  if (timezone === DEFAULT_OPERATOR_TIMEZONE) return DEFAULT_OPERATOR_TIMEZONE;
  return formatOffsetLabel(getOffsetMs(atMs, timezone) / 60_000);
}

/**
 * Human-readable label for a timezone, combining the IANA name with its current
 * offset (e.g. `Europe/Berlin (UTC+1)`). UTC renders as just `UTC`.
 */
export function formatTimezoneLabel(timezone: string, atMs: number = Date.now()): string {
  if (timezone === DEFAULT_OPERATOR_TIMEZONE) return DEFAULT_OPERATOR_TIMEZONE;
  return `${timezone} (${timezoneOffsetLabel(timezone, atMs)})`;
}
