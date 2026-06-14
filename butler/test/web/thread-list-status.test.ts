import test from "node:test";
import assert from "node:assert/strict";

import { describeCallbackState } from "../../src/web/utils.js";
import type { ButlerThreadCallback } from "../../src/web/types.js";

function callback(overrides: Partial<ButlerThreadCallback> = {}): ButlerThreadCallback {
  return {
    threadId: "thread-1",
    callbackState: "waiting",
    resolutionState: null,
    requestedAt: 1,
    lastEventAt: 1,
    lastWorkerStatusSeen: "active",
    lastTerminalReportAt: null,
    lastPrivateSteerText: null,
    lastPrivateSteerAt: null,
    nextWorkerReportAction: "review",
    operatorCloseoutStatus: "owed",
    owesOperatorReply: true,
    closeoutChannel: "none",
    reviewState: "idle",
    reviewReason: null,
    closedAt: null,
    updatedAt: 1,
    ...overrides
  };
}

test("thread list callback status labels review, rework, blocked, accepted, and closed states", () => {
  assert.deepEqual(describeCallbackState(callback({ reviewState: "queued" })), {
    label: "Butler reviewing",
    tone: "waiting"
  });
  assert.deepEqual(describeCallbackState(callback({ lastPrivateSteerText: "Fix evidence." })), {
    label: "Needs rework",
    tone: "needs-work"
  });
  assert.deepEqual(describeCallbackState(callback(), { supervisor: { blocked: true } } as any), {
    label: "Blocked review",
    tone: "blocked"
  });
  assert.deepEqual(
    describeCallbackState(
      callback(),
      {
        supervisor: { blocked: false },
        supervisionChecklist: { reviewState: "reviewed", items: [] }
      } as any
    ),
    { label: "Accepted", tone: "accepted" }
  );
  assert.deepEqual(describeCallbackState(callback({ owesOperatorReply: false, operatorCloseoutStatus: "posted" })), {
    label: "Closed",
    tone: "closed"
  });
});
