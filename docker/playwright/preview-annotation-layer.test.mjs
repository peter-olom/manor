import assert from "node:assert/strict";
import { test } from "node:test";

import { PREVIEW_ANNOTATION_LAYER_SCRIPT } from "./preview-annotation-layer.mjs";

test("preview annotation layer source includes expected toolbar controls and API", () => {
  assert.match(PREVIEW_ANNOTATION_LAYER_SCRIPT, /Annotate preview/);
  assert.match(PREVIEW_ANNOTATION_LAYER_SCRIPT, /data-mode="draw"/);
  assert.match(PREVIEW_ANNOTATION_LAYER_SCRIPT, /data-action="hide"/);
  assert.match(PREVIEW_ANNOTATION_LAYER_SCRIPT, /Show annotations/);
  assert.match(PREVIEW_ANNOTATION_LAYER_SCRIPT, /getMarks/);
  assert.match(PREVIEW_ANNOTATION_LAYER_SCRIPT, /manorPreviewAnnotationCommit/);
  assert.match(PREVIEW_ANNOTATION_LAYER_SCRIPT, /Insert batch/);
  assert.match(PREVIEW_ANNOTATION_LAYER_SCRIPT, /data-drag-handle/);
  assert.match(PREVIEW_ANNOTATION_LAYER_SCRIPT, /manor\.butler\.themePreference/);
  assert.match(PREVIEW_ANNOTATION_LAYER_SCRIPT, /attachShadow\(\{\s*mode:\s*"closed"/);
  assert.match(PREVIEW_ANNOTATION_LAYER_SCRIPT, /localStorage\?\.getItem\("manor\.butler\.themePreference"\)/);
  assert.match(PREVIEW_ANNOTATION_LAYER_SCRIPT, /<rect x="\$\{x\}%"/);
});

test("preview annotation layer source is self-contained for page evaluation", () => {
  assert.doesNotThrow(() => new Function(PREVIEW_ANNOTATION_LAYER_SCRIPT));
  assert.equal(PREVIEW_ANNOTATION_LAYER_SCRIPT.includes("document.createElement"), true);
  assert.equal(PREVIEW_ANNOTATION_LAYER_SCRIPT.includes("window.__manorPreviewAnnotationLayer"), true);
});
