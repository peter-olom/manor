import assert from "node:assert/strict";
import test from "node:test";

import { buildPendingChatCallback } from "../../src/server/butler-callback-state.js";

function callback(options: Parameters<typeof buildPendingChatCallback>[0]["options"], existing?: ReturnType<typeof buildPendingChatCallback>) {
  return buildPendingChatCallback({
    threadId: "pi-worker",
    requestedAt: existing ? 200 : 100,
    now: existing ? 200 : 100,
    existing,
    existingOutstanding: Boolean(existing),
    options,
    currentScopeId: "scope-current",
    workerStatus: "idle",
    reviewModelProvider: "ollama-cloud",
    reviewModelId: "glm-5.2",
    reviewReasoningLevel: "high"
  });
}

test("preserved rejection rework keeps the operator task as the review label", () => {
  const original = callback({
    operatorRequestText: "Create Current Alpha and Current Beta.",
    privateSteerText: "Create two artifacts.",
    scopeDisposition: "replace"
  });
  const rework = callback({
    privateSteerText: "Add direct proof for the rejected acceptance point.",
    scopeDisposition: "preserve"
  }, original);

  assert.equal(rework.operatorRequestText, "Create Current Alpha and Current Beta.");
  assert.equal(rework.scopeLabel, "Create Current Alpha and Current Beta.");
  assert.equal(rework.lastPrivateSteerText, "Add direct proof for the rejected acceptance point.");
});

test("a newer operator request becomes the review label for preserved work", () => {
  const original = callback({ operatorRequestText: "Initial task.", scopeDisposition: "replace" });
  const followup = callback({
    operatorRequestText: "Answer whether the push completed.",
    privateSteerText: "Verify the remote revision.",
    scopeDisposition: "preserve"
  }, original);

  assert.equal(followup.scopeLabel, "Answer whether the push completed.");
});
