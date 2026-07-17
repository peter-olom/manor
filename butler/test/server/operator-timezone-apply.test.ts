import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { createManorSettingsApplyHandler } from "../../src/server/manor-settings-apply.js";
import { ManorSettingsService } from "../../src/server/manor-settings-service.js";
import { setActiveManorSettingsService } from "../../src/server/manor-settings-runtime.js";
import { PairStore } from "../../src/server/pair-store.js";
import { ButlerStateStore } from "../../src/server/state-store.js";

async function setup() {
  const directory = await mkdtemp(path.join(tmpdir(), "manor-tz-apply-"));
  const dbPath = path.join(directory, "settings.sqlite");
  const service = new ManorSettingsService(dbPath, {} as NodeJS.ProcessEnv);
  await service.load();
  const state = new ButlerStateStore(path.join(directory, "state.json"));
  const pairs = new PairStore(path.join(directory, "pairs.json"), state);
  await pairs.load();
  return { directory, service, pairs };
}

// Minimal stubs for the non-timezone dependencies of the settings-apply handler.
// The handler wraps every dependency in .catch except the pairStore recompute, so
// the recompute path is what this integration test exercises end-to-end.
function applyHandler(service: ManorSettingsService, pairs: PairStore, now: () => number, refreshModels: () => Promise<void> = async () => undefined) {
  return createManorSettingsApplyHandler({
    settingsService: service,
    applyBackgroundSettings: () => undefined,
    sessionTitleGenerator: { applySettings() {} } as never,
    piRpcWorkerClient: { refreshModels } as never,
    butlerAgent: {
      refreshModelSettings: async () => false,
      getWorkerAffinity: () => null,
      getCodexAuthStatus: () => ({ loggedIn: false })
    } as never,
    pairSessions: { refreshModelSettings: async () => undefined } as never,
    pairStore: pairs,
    store: {} as never,
    codexClient: { getConnectionState: () => ({ compose: { model: null, availableModels: [] } }) } as never,
    getSseHub: () => null,
    now
  });
}

test("settings-apply handler recomputes daily automation nextRunAt when the operator timezone changes via Settings", async (t) => {
  const { directory, service, pairs } = await setup();
  t.after(async () => {
    setActiveManorSettingsService(null);
    await pairs.flushPendingSave().catch(() => undefined);
    await rm(directory, { recursive: true, force: true });
  });

  // Start in Europe/Berlin (winter CET, UTC+1).
  await service.patch({ overview: { operatorTimezone: "Europe/Berlin" } } as never);
  setActiveManorSettingsService(service);

  const pair = pairs.createPair();
  // Freeze the recompute clock at 2026-01-15 07:30 UTC (08:30 Berlin) so the daily
  // run is ahead (not overdue) and the recompute is deterministic.
  const fixedNow = Date.UTC(2026, 0, 15, 7, 30);

  const configured = pairs.configureAutomation(pair.id, { instruction: "Report", dailyTimes: ["09:00"] }, fixedNow)!;
  assert.equal(configured.automation!.nextRunAt, Date.UTC(2026, 0, 15, 8, 0)); // 09:00 Berlin = 08:00 UTC

  const apply = applyHandler(service, pairs, () => fixedNow);

  // Operator changes the timezone to America/New_York via the Settings UI. The
  // /api/settings route calls settingsService.patch(...) then this apply handler.
  await service.patch({ overview: { operatorTimezone: "America/New_York" } } as never);
  await apply();
  await pairs.flushPendingSave();

  // The handler recomputed the already-scheduled daily run into the new zone in
  // real time (no restart): 09:00 New York (winter UTC-5) = 14:00 UTC.
  assert.equal(pairs.getPair(pair.id)?.automation?.nextRunAt, Date.UTC(2026, 0, 15, 14, 0));
  assert.match(pairs.getPair(pair.id)?.automation?.nextRunLabel ?? "", /Jan 15, 9:00 AM UTC-5$/);
});

test("settings-apply moves schedules before awaiting provider refreshes", async (t) => {
  const { directory, service, pairs } = await setup();
  t.after(async () => {
    setActiveManorSettingsService(null);
    await pairs.flushPendingSave().catch(() => undefined);
    await rm(directory, { recursive: true, force: true });
  });
  await service.patch({ overview: { operatorTimezone: "Europe/Berlin" } } as never);
  setActiveManorSettingsService(service);
  const now = Date.UTC(2026, 0, 15, 7, 30);
  const pair = pairs.createPair();
  pairs.configureAutomation(pair.id, { instruction: "Report", dailyTimes: ["09:00"] }, now);

  let releaseRefresh!: () => void;
  const refreshBlocked = new Promise<void>((resolve) => { releaseRefresh = resolve; });
  const apply = applyHandler(service, pairs, () => now, () => refreshBlocked);
  await service.patch({ overview: { operatorTimezone: "America/New_York" } } as never);
  const applying = apply();
  assert.equal(pairs.getPair(pair.id)?.automation?.nextRunAt, Date.UTC(2026, 0, 15, 14, 0));
  releaseRefresh();
  await applying;
});
