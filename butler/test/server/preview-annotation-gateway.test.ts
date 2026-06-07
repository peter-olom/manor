import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("../../src/server/preview-gateway.ts", import.meta.url), "utf8");
const routesSource = await readFile(new URL("../../src/server/preview-annotation-routes.ts", import.meta.url), "utf8");

test("operator preview HTML receives the annotation widget injection", () => {
  assert.match(source, /data-manor-preview-annotations/);
  assert.match(source, /PREVIEW_ANNOTATION_LAYER_SCRIPT/);
  assert.match(source, /api\/preview-annotations\/batches/);
});

test("preview annotation injection is limited to html responses", () => {
  assert.match(source, /injectAnnotations:\s*contentType\.toLowerCase\(\)\.includes\("text\/html"\)/);
});

test("operator preview annotation commits use a transient per-preview token", () => {
  assert.match(source, /x-manor-preview-annotation-token/);
  assert.match(source, /crypto\.createHmac\("sha256", access\.previewAnnotationSecret\)/);
  assert.match(source, /delete window\.__manorPreviewAnnotationConfig/);
  assert.match(routesSource, /function hasPreviewAnnotationAccess/);
  assert.match(routesSource, /app\.post\("\/api\/preview-annotations\/batches"[\s\S]*hasPreviewAnnotationAccess/);
  assert.match(routesSource, /app\.get\("\/api\/preview-annotations\/:leaseId\/batches"[\s\S]*hasPreviewAnnotationAccess/);
});
