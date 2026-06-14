import assert from "node:assert/strict";
import test from "node:test";

import {
  isReservedPreviewAnnotationApiPath,
  resolvePreviewRefererRouteUrl
} from "../../src/server/preview-gateway.js";

test("preview annotation batch API is reserved for Butler instead of referer proxying", () => {
  assert.equal(isReservedPreviewAnnotationApiPath("/api/preview-annotations/batches"), true);
  assert.equal(isReservedPreviewAnnotationApiPath("/api/preview-annotations/batches?lease=preview-1"), true);
  assert.equal(isReservedPreviewAnnotationApiPath("/api/preview-annotations/batches/extra"), true);

  assert.equal(
    resolvePreviewRefererRouteUrl(
      "/api/preview-annotations/batches",
      "http://localhost:8080/preview/preview-1/"
    ),
    null
  );
});

test("non-reserved absolute paths from preview pages still fall back to preview referer proxying", () => {
  assert.deepEqual(
    resolvePreviewRefererRouteUrl("/api/products?limit=5", "http://localhost:8080/preview/preview-1/shop"),
    {
      leaseId: "preview-1",
      brokerUrl: "/routes/preview/preview-1/api/products?limit=5"
    }
  );
});
