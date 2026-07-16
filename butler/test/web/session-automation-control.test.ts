import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { PairRow } from "../../src/web/PairRow.js";
import { SessionAutomationControl } from "../../src/web/SessionAutomationControl.js";
import type { PairAutomation, PairDetail, PairSummary } from "../../src/shared/pairing.js";

function automation(overrides: Partial<PairAutomation> = {}): PairAutomation {
  return {
    id: "automation-1", instruction: "Prepare a daily report", schedule: { kind: "daily", times: ["12:00", "18:00"] }, enabled: true,
    createdAt: 1, updatedAt: 1, nextRunAt: 2, running: null, lastRun: null,
    state: "active", scheduleLabel: "Daily at 12:00 PM, 6:00 PM", endsAtLabel: null, nextRunLabel: "Jul 15, 12:00 PM UTC", lastRunLabel: null,
    ...overrides
  };
}

test("session row decorates active, paused, and failed automations", () => {
  const base = { id: "pair-1", title: "Reports", status: "idle", updatedAt: 1, messageCount: 0, lastMessage: null } as PairSummary;
  const active = renderToStaticMarkup(React.createElement(PairRow, { pair: { ...base, automation: automation() }, isActive: false, onSelect() {}, onDelete() {} }));
  assert.match(active, /Automation active: Daily at 12:00 PM, 6:00 PM/);
  const paused = renderToStaticMarkup(React.createElement(PairRow, { pair: { ...base, automation: automation({ enabled: false, state: "paused" }) }, isActive: false, onSelect() {}, onDelete() {} }));
  assert.match(paused, /pair-automation-icon is-paused/);
  const failed = renderToStaticMarkup(React.createElement(PairRow, { pair: { ...base, automation: automation({ lastRun: { id: "run", scheduledFor: 1, startedAt: 1, finishedAt: 2, outcome: "failed", summary: "Failed", resultPath: null } }) }, isActive: false, onSelect() {}, onDelete() {} }));
  assert.match(failed, /pair-automation-icon[^\"]*is-failed/);
});

test("bounded interval automation shows its deadline and completed state", () => {
  const interval = automation({
    schedule: { kind: "interval", everyMinutes: 5, startsAt: 1, endsAt: 1_800_001 },
    state: "completed", nextRunAt: null, nextRunLabel: null,
    scheduleLabel: "Every 5 min for 30 min", endsAtLabel: "Jul 14, 6:30 PM UTC"
  });
  const pair = { id: "pair-1", automation: interval } as PairDetail;
  const markup = renderToStaticMarkup(React.createElement(SessionAutomationControl, {
    pair, pending: false, onEnabledChange: async () => {}, onDelete: async () => {}, onEdit: () => {}
  }));
  assert.match(markup, /Completed · Every 5 min · until Jul 14, 6:30 PM UTC/);
});

test("automation trigger renders the server-provided operator timezone labels", () => {
  const pair = { id: "pair-1", automation: automation() } as PairDetail;
  const markup = renderToStaticMarkup(React.createElement(SessionAutomationControl, {
    pair, pending: false, onEnabledChange: async () => {}, onDelete: async () => {}, onEdit: () => {}
  }));
  assert.match(markup, /Daily at 12:00 PM, 6:00 PM/);
  assert.match(markup, /aria-label="Automation: Daily at 12:00 PM, 6:00 PM"/);
});
