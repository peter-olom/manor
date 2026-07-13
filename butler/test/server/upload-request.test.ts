import assert from "node:assert/strict";
import test from "node:test";

import { isBinaryUploadRequest, shouldParseJsonRequest } from "../../src/server/upload-request.js";

function request(headers: Record<string, string>): Parameters<typeof shouldParseJsonRequest>[0] {
  return { headers } as Parameters<typeof shouldParseJsonRequest>[0];
}

test("binary uploads bypass JSON parsing regardless of file MIME type", () => {
  const upload = request({
    "content-type": "application/json",
    "x-manor-upload-name": "settings.json"
  });
  assert.equal(isBinaryUploadRequest(upload), true);
  assert.equal(shouldParseJsonRequest(upload), false);
});

test("ordinary JSON and structured JSON requests still use JSON parsing", () => {
  assert.equal(shouldParseJsonRequest(request({ "content-type": "application/json; charset=utf-8" })), true);
  assert.equal(shouldParseJsonRequest(request({ "content-type": "application/problem+json" })), true);
  assert.equal(shouldParseJsonRequest(request({ "content-type": "text/plain" })), false);
});
