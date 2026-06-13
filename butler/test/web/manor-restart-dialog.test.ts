import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import assert from "node:assert/strict";

import { formatRestartNoticeDuration } from "../../src/web/ManorRestartNotice.tsx";

const testDir = dirname(fileURLToPath(import.meta.url));
const webRoot = resolve(testDir, "../../src/web");

test("Manor restart dialog requires an explicit operator authorization button", () => {
  const appSource = readFileSync(resolve(webRoot, "App.tsx"), "utf8");
  const noticeSource = readFileSync(resolve(webRoot, "ManorRestartNotice.tsx"), "utf8");
  const styleSource = readFileSync(resolve(webRoot, "styles.css"), "utf8");
  const compactionStatusIndex = appSource.indexOf('label="Compact"');
  const restartControlIndex = appSource.indexOf('className="manor-restart-control"');

  assert.match(appSource, /Authorize Manor restart\\?/);
  assert.match(appSource, /Authorize restart/);
  assert.match(appSource, /RestartIcon/);
  assert.match(appSource, /type="checkbox"/);
  assert.match(appSource, /Update to latest before restarting/);
  assert.match(appSource, /api\/manor\/restart/);
  assert.match(appSource, /aria-label="Restart Manor"/);
  assert.ok(compactionStatusIndex >= 0);
  assert.ok(restartControlIndex > compactionStatusIndex);
  assert.doesNotMatch(appSource, /manor-restart-latest/);
  assert.match(appSource, /Keep running/);
  assert.match(appSource, /Manor restart started/);
  assert.match(noticeSource, /Manor restart succeeded/);
  assert.match(noticeSource, /Manor restart failed/);
  assert.match(noticeSource, /Duration/);
  assert.match(noticeSource, /Elapsed/);
  assert.match(appSource, /dismissManorRestartNotice/);
  assert.match(appSource, /MANOR_RESTART_TRACKED_RUN_KEY/);
  assert.match(appSource, /starts the approved restart through the host controller/);
  assert.match(appSource, /authorize_restart/);
  assert.match(appSource, /pendingManorRestartRequest/);
  assert.match(appSource, /pendingRestartRequest\.imageTag/);
  assert.match(appSource, /pendingRestartRequest\.gitRef/);
  assert.match(appSource, /api\/manor\/restart-status/);
  assert.match(noticeSource, /Failed step/);
  assert.match(noticeSource, /Waiting\.\.\./);
  assert.doesNotMatch(appSource, /RESTART MANOR/);
  assert.match(styleSource, /manor-restart-dialog/);
  assert.match(styleSource, /manor-restart-control/);
  assert.match(styleSource, /manor-restart-button/);
  assert.match(styleSource, /manor-restart-option/);
  assert.doesNotMatch(styleSource, /manor-restart-latest/);
  assert.match(styleSource, /manor-restart-result/);
  assert.match(styleSource, /manor-restart-error/);
});

test("Manor restart notice formats completed and running durations", () => {
  assert.equal(
    formatRestartNoticeDuration({
      id: "run-1",
      status: "completed",
      mode: "image",
      target: "latest",
      gitRef: null,
      imageTag: "latest",
      includeDesktop: false,
      update: true,
      startedAt: 1_000,
      completedAt: 66_000,
      durationMs: 65_000,
      error: null,
      steps: []
    }),
    "1m 5s"
  );

  assert.equal(
    formatRestartNoticeDuration({
      id: "run-2",
      status: "running",
      mode: "source",
      target: "current",
      gitRef: null,
      imageTag: null,
      includeDesktop: false,
      update: false,
      startedAt: 1_000,
      completedAt: null,
      error: null,
      steps: []
    }, 11_000),
    "10s"
  );
});
