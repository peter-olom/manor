import assert from "node:assert/strict";
import test from "node:test";

import { buildAnnotatedPreviewFileName, formatAnnotationBatchText } from "../../src/server/preview-annotation-capture";
import type { OperatorPreviewAnnotationBatch } from "../../src/server/preview-annotation-types";

function batch(): OperatorPreviewAnnotationBatch {
  return {
    id: "batch-1",
    at: 1234,
    intent: "insert",
    leaseId: "lease-1",
    targetId: "thread:abc",
    page: { title: "Checkout / cart", url: "https://manor.example/preview/lease-1/cart" },
    annotations: [
      {
        id: "mark-1",
        number: 1,
        x: 0.1,
        y: 0.2,
        width: 0.3,
        height: 0.4,
        color: "#ff6b2c",
        note: "Button overlaps the total",
        viewport: {
          width: 1920,
          height: 1080,
          scrollX: 0,
          scrollY: 240,
          documentWidth: 1920,
          documentHeight: 2400
        }
      }
    ]
  };
}

test("preview annotation insert text matches image annotation prompt style", () => {
  const text = formatAnnotationBatchText(batch());

  assert.match(text, /attached annotated preview screenshot/);
  assert.match(text, /Page: Checkout \/ cart/);
  assert.match(text, /1\. Button overlaps the total/);
  assert.doesNotMatch(text, /x=0\.1/);
});

test("preview annotation screenshot file names are safe png names", () => {
  assert.equal(buildAnnotatedPreviewFileName(batch()), "Checkout-cart-annotated-preview.png");
});
