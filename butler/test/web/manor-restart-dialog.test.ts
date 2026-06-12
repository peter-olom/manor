import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import assert from "node:assert/strict";

const testDir = dirname(fileURLToPath(import.meta.url));
const webRoot = resolve(testDir, "../../src/web");

test("Manor restart dialog requires an explicit operator authorization button", () => {
  const appSource = readFileSync(resolve(webRoot, "App.tsx"), "utf8");
  const noticeSource = readFileSync(resolve(webRoot, "ManorRestartNotice.tsx"), "utf8");
  const styleSource = readFileSync(resolve(webRoot, "styles.css"), "utf8");

  assert.match(appSource, /Authorize Manor restart\\?/);
  assert.match(appSource, /Authorize restart/);
  assert.match(appSource, /Keep running/);
  assert.match(appSource, /Manor restart started/);
  assert.match(noticeSource, /Manor restart succeeded/);
  assert.match(noticeSource, /Manor restart failed/);
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
  assert.match(styleSource, /manor-restart-result/);
  assert.match(styleSource, /manor-restart-error/);
});
