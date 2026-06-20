import assert from "node:assert/strict";
import test from "node:test";

import { buildImmediatePendingButlerRows, butlerMessagesAreEquivalent } from "../../src/web/ButlerSurface.js";
import { dedupeMessages } from "../../src/web/utils.js";
import type { ButlerMessageRecord } from "../../src/web/types.js";

function message(overrides: Partial<ButlerMessageRecord> = {}): ButlerMessageRecord {
  return {
    id: "pending-operator-1",
    role: "user",
    text: "Review the implementation",
    displayText: "Review the implementation",
    at: 100,
    taskDurationMs: null,
    kind: "message",
    ...overrides
  };
}

test("Butler history sync detects pending state transitions without text changes", () => {
  assert.equal(
    butlerMessagesAreEquivalent(
      [message({ pending: true })],
      [message({ pending: undefined })]
    ),
    false
  );
});

test("Butler history sync detects display text transitions without text changes", () => {
  assert.equal(
    butlerMessagesAreEquivalent(
      [message({ displayText: "Visible prompt" })],
      [message({ displayText: "Updated visible prompt" })]
    ),
    false
  );
});

test("Butler history merge keeps newer question state for duplicate ids", () => {
  const merged = dedupeMessages([
    message({
      id: "question-1",
      role: "assistant",
      question: {
        id: "question-1",
        prompt: "Choose",
        context: null,
        options: [
          { id: "a", label: "A", description: null },
          { id: "b", label: "B", description: null }
        ],
        allowFreeform: false,
        createdAt: 1,
        selectedOptionId: null,
        answeredAt: null
      }
    }),
    message({
      id: "question-1",
      role: "assistant",
      question: {
        id: "question-1",
        prompt: "Choose",
        context: null,
        options: [
          { id: "a", label: "A", description: null },
          { id: "b", label: "B", description: null }
        ],
        allowFreeform: false,
        createdAt: 1,
        selectedOptionId: "a",
        answeredAt: 2
      }
    })
  ]);

  assert.equal(merged.length, 1);
  assert.equal(merged[0]!.question?.selectedOptionId, "a");
});

test("Butler history sync detects question state transitions without text changes", () => {
  assert.equal(
    butlerMessagesAreEquivalent(
      [message({
        question: {
          id: "question-1",
          prompt: "Choose",
          context: null,
          options: [
            { id: "a", label: "A", description: null },
            { id: "b", label: "B", description: null }
          ],
          allowFreeform: false,
          createdAt: 1,
          selectedOptionId: null,
          answeredAt: null
        }
      })],
      [message({
        question: {
          id: "question-1",
          prompt: "Choose",
          context: null,
          options: [
            { id: "a", label: "A", description: null },
            { id: "b", label: "B", description: null }
          ],
          allowFreeform: false,
          createdAt: 1,
          selectedOptionId: "a",
          answeredAt: 2
        }
      })]
    ),
    false
  );
});

test("Butler live pending rows render immediately before deferred history catches up", () => {
  const rows = buildImmediatePendingButlerRows({
    liveMessages: [message({ pending: true })],
    deferredRowIds: new Set(),
    suppressAllLiveMessages: false,
    suppressedLiveMessageIds: new Set()
  });

  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, "pending-operator-1");
  assert.equal(rows[0].message.pending, true);
});

test("Butler live pending rows are not duplicated after deferred history catches up", () => {
  const rows = buildImmediatePendingButlerRows({
    liveMessages: [message({ pending: true })],
    deferredRowIds: new Set(["pending-operator-1"]),
    suppressAllLiveMessages: false,
    suppressedLiveMessageIds: new Set()
  });

  assert.equal(rows.length, 0);
});

test("Butler live pending rows respect clear and delete suppression", () => {
  assert.equal(
    buildImmediatePendingButlerRows({
      liveMessages: [message({ pending: true })],
      deferredRowIds: new Set(),
      suppressAllLiveMessages: true,
      suppressedLiveMessageIds: new Set()
    }).length,
    0
  );
  assert.equal(
    buildImmediatePendingButlerRows({
      liveMessages: [message({ pending: true })],
      deferredRowIds: new Set(),
      suppressAllLiveMessages: false,
      suppressedLiveMessageIds: new Set(["pending-operator-1"])
    }).length,
    0
  );
});
