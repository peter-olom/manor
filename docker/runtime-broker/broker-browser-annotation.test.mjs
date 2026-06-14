import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const source = await readFile(new URL("./broker-browser.mjs", import.meta.url), "utf8");

test("preview browser proof sessions do not request the annotation layer by default", () => {
  const previewSessionBlock = source.slice(source.indexOf('app.post("/leases/:leaseId/browser-sessions"'), source.indexOf('app.post("/browser/sessions"'));
  assert.doesNotMatch(previewSessionBlock, /previewAnnotationLayer:\s*true/);
});

test("generic browser sessions do not enable annotations by default", () => {
  const genericSessionBlock = source.slice(source.indexOf('app.post("/browser/sessions"'), source.indexOf('app.get("/browser/sessions/:sessionId"'));
  assert.doesNotMatch(genericSessionBlock, /previewAnnotationLayer:\s*true/);
});


test("preview browser sessions wire annotation insertion through Butler internal endpoint", () => {
  assert.match(source, /api\/internal\/browser-annotations\/insert/);
  assert.match(source, /annotationTargets/);
  assert.match(source, /thread:\$\{scope.threadId\}/);
});
