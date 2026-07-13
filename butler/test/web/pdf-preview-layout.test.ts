import assert from "node:assert/strict";
import test from "node:test";

import { calculatePdfCanvasLayout } from "../../src/web/pdf-preview-layout";

test("PDF pages fit narrow screens even when the required scale is below one half", () => {
  const layout = calculatePdfCanvasLayout(1_200, 800, 360, 2);
  assert.ok(layout.cssScale < 0.5);
  assert.ok(1_200 * layout.cssScale <= 328);
});

test("extreme PDF pages cannot allocate an unsafe canvas", () => {
  const layout = calculatePdfCanvasLayout(100, 1_000_000, 1_200, 2);
  assert.ok(layout.pixelWidth <= 8_192);
  assert.ok(layout.pixelHeight <= 8_192);
  assert.ok(layout.pixelWidth * layout.pixelHeight <= 16_000_000);
});
