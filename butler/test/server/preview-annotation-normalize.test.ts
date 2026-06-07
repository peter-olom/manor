import assert from "node:assert/strict";
import test from "node:test";

import { normalizePreviewVerification } from "../../src/server/state-store-helpers";
import type { PreviewVerificationView } from "../../src/server/types";

function baseVerification(): PreviewVerificationView {
  return {
    runId: "run-1",
    mode: "headless",
    checkedAt: 1000,
    durationMs: 10,
    ok: true,
    status: 200,
    title: "Preview",
    url: "http://example.test/",
    error: null,
    failureKind: "none",
    summary: {
      consoleMessageCount: 0,
      pageErrorCount: 0,
      failedRequestCount: 0,
      responseErrorCount: 0,
      assetFailureCount: 0,
      phaseCount: 0,
      actionCount: 0
    },
    phases: [],
    readiness: {
      initialUrl: "http://example.test/",
      finalUrl: "http://example.test/",
      expectedPath: "/",
      selector: null,
      selectorSatisfied: null,
      routeStatus: 200,
      routeOk: true,
      loginRedirectDetected: false,
      htmlErrorSignals: [],
      sameOriginAssetFailureCount: 0,
      websocketFailureCount: 0,
      notes: []
    },
    auth: {
      headerCount: 0,
      cookieCount: 0,
      cookieNames: [],
      usedSessionCookie: false
    },
    artifacts: [],
    consoleMessages: [],
    pageErrors: [],
    failedRequests: []
  };
}

test("preview verification normalization preserves structured browser annotation batches", () => {
  const verification = baseVerification();
  verification.annotations = {
    targets: [{ id: "butler", label: "Butler" }, { id: "thread:abc", label: "Codex job" }],
    batches: [
      {
        id: "batch-1",
        at: 1234,
        intent: "insert",
        targetId: "thread:abc",
        page: { title: "Checkout", url: "https://preview.test/cart" },
        annotations: [
          { id: "a1", number: 1, x: 0.1, y: 0.2, width: 0.3, height: 0.4, color: "#ff6b2c", note: "Button is clipped" }
        ]
      }
    ],
    insertions: [{ batchId: "batch-1", at: 1240, ok: true, target: { id: "thread:abc", label: "Codex job" } }]
  };

  const normalized = normalizePreviewVerification(verification, 60_000);

  assert.equal(normalized.annotationBatchCount, 1);
  assert.equal(normalized.annotations?.targets.length, 2);
  assert.equal(normalized.annotations?.batches[0]?.annotations[0]?.note, "Button is clipped");
  assert.equal(normalized.annotations?.insertions[0]?.ok, true);
});
