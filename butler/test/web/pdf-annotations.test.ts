import assert from "node:assert/strict";
import test from "node:test";

import { buildAnnotatedPdfName, buildPdfAnnotationPrompt, pdfLabelOrigin, pdfRectFromViewport, type PdfAnnotation } from "../../src/web/pdf-annotations";

function roundedRect(rect: { x: number; y: number; width: number; height: number }) {
  return { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) };
}

test("PDF annotation rectangles map from top-left viewport coordinates into PDF space", () => {
  const annotation = { x: 0.1, y: 0.2, width: 0.3, height: 0.4 };
  const upright = pdfRectFromViewport({ width: 600, height: 800, convertToPdfPoint: (x, y) => [x, 800 - y] }, annotation);
  assert.ok(Math.abs(upright.x - 60) < 0.0001);
  assert.ok(Math.abs(upright.y - 320) < 0.0001);
  assert.ok(Math.abs(upright.width - 180) < 0.0001);
  assert.ok(Math.abs(upright.height - 320) < 0.0001);
  assert.deepEqual(roundedRect(pdfRectFromViewport({ width: 800, height: 600, convertToPdfPoint: (x, y) => [y, x] }, annotation)), {
    x: 120,
    y: 80,
    width: 240,
    height: 240
  });
  assert.deepEqual(roundedRect(pdfRectFromViewport({ width: 600, height: 800, convertToPdfPoint: (x, y) => [600 - x, y] }, annotation)), {
    x: 360,
    y: 160,
    width: 180,
    height: 320
  });
});

test("PDF labels remain centered for every supported page rotation", () => {
  for (const rotation of [0, 90, 180, 270]) {
    const origin = pdfLabelOrigin(100, 200, 20, 10, rotation);
    const radians = rotation * Math.PI / 180;
    const centerX = origin.x + Math.cos(radians) * 10 - Math.sin(radians) * 3.5;
    const centerY = origin.y + Math.sin(radians) * 10 + Math.cos(radians) * 3.5;
    assert.ok(Math.abs(centerX - 100) < 0.0001);
    assert.ok(Math.abs(centerY - 200) < 0.0001);
  }
});

test("PDF annotation output keeps page context and a safe immutable-version name", () => {
  const annotations: PdfAnnotation[] = [
    { id: "one", pageNumber: 1, x: 0, y: 0, width: 0.2, height: 0.2, text: "Fix the heading" },
    { id: "two", pageNumber: 3, x: 0, y: 0, width: 0.2, height: 0.2, text: "Update the total" }
  ];
  assert.equal(buildPdfAnnotationPrompt(annotations), "Please follow up on the numbered tags in the attached annotated PDF.\n\n1. Page 1: Fix the heading\n2. Page 3: Update the total");
  assert.equal(buildAnnotatedPdfName("Quarterly: report.pdf"), "Quarterly- report-annotated.pdf");
  assert.equal(buildPdfAnnotationPrompt([{ ...annotations[0]!, wholePage: true }]), "Please follow up on the numbered tags in the attached annotated PDF.\n\n1. Page 1 (whole page): Fix the heading");
});
