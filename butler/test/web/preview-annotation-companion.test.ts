import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import assert from "node:assert/strict";

const testDir = dirname(fileURLToPath(import.meta.url));
const webRoot = resolve(testDir, "../../src/web");

test("preview annotation companion toolbar is draggable", () => {
  const appSource = readFileSync(resolve(webRoot, "App.tsx"), "utf8");
  const styleSource = readFileSync(resolve(webRoot, "styles.css"), "utf8");

  assert.match(appSource, /preview-annotation-companion-handle/);
  assert.match(appSource, /onPointerDown=\{startDrag\}/);
  assert.match(appSource, /setPointerCapture/);
  assert.match(appSource, /setPosition\(clampPosition/);
  assert.match(appSource, /window\.addEventListener\("pointermove", moveDrag\)/);
  assert.match(appSource, /Preview annotations/);
  assert.match(appSource, /preview-annotation-companion-label/);
  assert.match(appSource, /preview-annotation-companion-insert/);
  assert.match(appSource, /Inserting/);
  assert.match(appSource, /measureDefaultBottom/);
  assert.match(appSource, /querySelectorAll/);
  assert.match(appSource, /\.composer/);
  assert.match(appSource, /--preview-annotation-companion-bottom/);
  assert.doesNotMatch(appSource, /Insert batch/);
  assert.doesNotMatch(appSource, /annotation batch toolbar/);
  assert.match(appSource, /selectedBatch\.ready/);
  assert.match(appSource, /Add comments to every mark/);
  assert.match(styleSource, /preview-annotation-companion\.is-dragging/);
  assert.match(styleSource, /bottom: calc\(var\(--preview-annotation-companion-bottom, 136px\) \+ env\(safe-area-inset-bottom, 0px\)\)/);
  assert.match(styleSource, /preview-annotation-companion-label/);
  assert.match(styleSource, /preview-annotation-companion-insert/);
  assert.match(styleSource, /preview-annotation-companion-dot\.is-pending/);
  assert.match(styleSource, /touch-action: none/);
});
