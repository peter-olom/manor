import assert from "node:assert/strict";
import test from "node:test";

import { deriveReferenceMetadata, normalizeReferenceMetadata } from "../../src/server/reference-metadata.js";

test("reference metadata drops unknown origins and empty fields", () => {
  assert.deepEqual(normalizeReferenceMetadata({ sessionId: " session-1 ", origin: "unknown" }), {
    sessionId: "session-1"
  });
  assert.equal(normalizeReferenceMetadata({ projectId: " ", origin: "unknown" }), undefined);
});

test("derived metadata keeps source context and records the new origin", () => {
  assert.deepEqual(deriveReferenceMetadata(
    { projectId: "project-1", projectLabel: "Manor", sessionId: "session-1", sessionTitle: "Original", origin: "butler-upload" },
    { projectId: "other", sessionId: "other", origin: "worker-output" }
  ), {
    projectId: "project-1",
    projectLabel: "Manor",
    sessionId: "session-1",
    sessionTitle: "Original",
    origin: "worker-output"
  });
});
