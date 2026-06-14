import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import assert from "node:assert/strict";

const testDir = dirname(fileURLToPath(import.meta.url));
const webRoot = resolve(testDir, "../../src/web");

test("topbar collapses worker and auth into one hover status", () => {
  const appSource = readFileSync(resolve(webRoot, "App.tsx"), "utf8");
  const statusSource = readFileSync(resolve(webRoot, "StatusItem.tsx"), "utf8");
  const iconSource = readFileSync(resolve(webRoot, "icons.tsx"), "utf8");
  const styleSource = readFileSync(resolve(webRoot, "styles.css"), "utf8");

  assert.match(appSource, /label="Status"/);
  assert.match(appSource, /operatorStatusRows/);
  assert.match(appSource, /Codex worker/);
  assert.match(appSource, /Codex auth/);
  assert.match(appSource, /Butler auth/);
  assert.match(appSource, /operator-status-popover/);
  assert.doesNotMatch(appSource, /<StatusItem\s+kind="codex"/);
  assert.doesNotMatch(appSource, /<StatusItem\s+kind="auth"/);
  assert.match(statusSource, /kind: "status"/);
  assert.match(iconSource, /kind === "status"/);
  assert.match(styleSource, /operator-status:hover \.operator-status-popover/);
  assert.match(styleSource, /status-item\.is-danger \.status-item-label/);
  assert.match(styleSource, /operator-status-row\.is-danger/);
});
