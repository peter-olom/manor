import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_OPERATOR_TIMEZONE,
  formatOffsetLabel,
  formatTimezoneLabel,
  getZonedWallParts,
  isValidTimezone,
  normalizeTimezone,
  timezoneOffsetLabel,
  zonedWallTimeCandidates,
  zonedWallTimeToUtcMs
} from "../../src/server/operator-timezone.js";

test("isValidTimezone and normalizeTimezone coerce bad input to UTC", () => {
  assert.equal(isValidTimezone("Europe/Berlin"), true);
  assert.equal(isValidTimezone("UTC"), true);
  assert.equal(isValidTimezone(""), false);
  assert.equal(isValidTimezone("Not/A_Real_Zone"), false);
  assert.equal(normalizeTimezone("Europe/Berlin"), "Europe/Berlin");
  assert.equal(normalizeTimezone("  Europe/Paris  "), "Europe/Paris");
  assert.equal(normalizeTimezone(""), DEFAULT_OPERATOR_TIMEZONE);
  assert.equal(normalizeTimezone("Mars/Olympus"), DEFAULT_OPERATOR_TIMEZONE);
  assert.equal(normalizeTimezone(42), DEFAULT_OPERATOR_TIMEZONE);
  assert.equal(normalizeTimezone(undefined), DEFAULT_OPERATOR_TIMEZONE);
});

test("formatOffsetLabel and timezoneOffsetLabel render compact offsets", () => {
  assert.equal(formatOffsetLabel(0), "UTC");
  assert.equal(formatOffsetLabel(60), "UTC+1");
  assert.equal(formatOffsetLabel(-300), "UTC-5");
  assert.equal(formatOffsetLabel(-330), "UTC-5:30");
  assert.equal(timezoneOffsetLabel("UTC"), "UTC");
  // Europe/Berlin is UTC+1 in winter.
  assert.equal(timezoneOffsetLabel("Europe/Berlin", Date.UTC(2026, 0, 15, 12, 0)), "UTC+1");
  // ...and UTC+2 in summer (CEST).
  assert.equal(timezoneOffsetLabel("Europe/Berlin", Date.UTC(2026, 6, 15, 12, 0)), "UTC+2");
});

test("formatTimezoneLabel names the zone with its current offset", () => {
  assert.equal(formatTimezoneLabel("UTC"), "UTC");
  assert.equal(formatTimezoneLabel("Europe/Berlin", Date.UTC(2026, 0, 15, 12, 0)), "Europe/Berlin (UTC+1)");
  assert.equal(formatTimezoneLabel("America/Los_Angeles", Date.UTC(2026, 6, 15, 12, 0)), "America/Los_Angeles (UTC-7)");
});

test("getZonedWallParts returns the wall-clock components in the zone", () => {
  const winter = getZonedWallParts(Date.UTC(2026, 0, 15, 10, 30), "Europe/Berlin");
  assert.deepEqual({ ...winter, second: 0 }, { year: 2026, month0: 0, day: 15, hour: 11, minute: 30, second: 0 });
  const summer = getZonedWallParts(Date.UTC(2026, 6, 15, 10, 30), "Europe/Berlin");
  assert.deepEqual({ ...summer, second: 0 }, { year: 2026, month0: 6, day: 15, hour: 12, minute: 30, second: 0 });
});

test("zonedWallTimeToUtcMs converts wall time to epoch with the correct offset", () => {
  // 09:00 Berlin in winter (UTC+1) = 08:00 UTC.
  assert.equal(zonedWallTimeToUtcMs("Europe/Berlin", { year: 2026, month0: 0, day: 15, hour: 9, minute: 0, second: 0 }), Date.UTC(2026, 0, 15, 8, 0));
  // 09:00 Berlin in summer (UTC+2) = 07:00 UTC.
  assert.equal(zonedWallTimeToUtcMs("Europe/Berlin", { year: 2026, month0: 6, day: 15, hour: 9, minute: 0, second: 0 }), Date.UTC(2026, 6, 15, 7, 0));
  // UTC is identity.
  assert.equal(zonedWallTimeToUtcMs("UTC", { year: 2026, month0: 6, day: 15, hour: 9, minute: 0, second: 0 }), Date.UTC(2026, 6, 15, 9, 0));
});

test("zonedWallTimeToUtcMs handles the fall-back fold by preferring the earlier occurrence", () => {
  // Europe/Berlin falls back from CEST (UTC+2) to CET (UTC+1) on 2026-10-25 at
  // 03:00 -> 02:00 local. The wall time 02:30 therefore occurs twice: first at
  // 00:30 UTC (CEST) and again at 01:30 UTC (CET). The earlier instant wins.
  const fold = zonedWallTimeToUtcMs("Europe/Berlin", { year: 2026, month0: 9, day: 25, hour: 2, minute: 30, second: 0 });
  assert.equal(fold, Date.UTC(2026, 9, 25, 0, 30));
});

test("zonedWallTimeToUtcMs shifts a spring-forward gap forward by one offset duration", () => {
  // Europe/Berlin springs forward 2026-03-29 02:00->03:00 CET->CEST, so 02:30
  // does not exist. Compatible disambiguation moves it to 03:30 CEST.
  const gap = zonedWallTimeToUtcMs("Europe/Berlin", { year: 2026, month0: 2, day: 29, hour: 2, minute: 30, second: 0 });
  assert.equal(gap, Date.UTC(2026, 2, 29, 1, 30));
  const wall = getZonedWallParts(gap, "Europe/Berlin");
  assert.equal(wall.hour, 3);
  assert.equal(wall.minute, 30);
});

test("zonedWallTimeCandidates supports non-hour fall-back folds", () => {
  // Lord Howe falls back by 30 minutes on 2026-04-05, so 01:45 occurs twice.
  assert.deepEqual(
    zonedWallTimeCandidates("Australia/Lord_Howe", { year: 2026, month0: 3, day: 5, hour: 1, minute: 45, second: 0 }),
    [Date.UTC(2026, 3, 4, 14, 45), Date.UTC(2026, 3, 4, 15, 15)]
  );
});
