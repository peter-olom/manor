import assert from "node:assert/strict";
import test from "node:test";

import { upsertProviderBackedOperatorMessage } from "../../src/server/butler-operator-messages.js";
import type { ButlerMessageView } from "../../src/server/types.js";

test("upsertProviderBackedOperatorMessage persists and clears the trace", () => {
  const messages: ButlerMessageView[] = [];
  upsertProviderBackedOperatorMessage(
    messages,
    "operator-session-asst-1",
    "final",
    1000,
    "assistant",
    null,
    {
      trace: [
        { id: "r-1", type: "reasoning", status: "completed", text: "thinking", at: 999 }
      ],
      traceMeta: { turnId: "turn-1", startedAt: 900, completedAt: 1000, items: [
        { id: "r-1", type: "reasoning", status: "completed", text: "thinking", at: 999 }
      ] },
      normalize: false
    }
  );
  const stored = messages[0];
  assert.ok(stored?.trace);
  assert.equal(stored?.providerBacked, true);
  assert.equal(stored?.providerSucceeded, true);
  assert.equal(stored.trace?.length, 1);
  assert.equal(stored.trace?.[0]?.text, "thinking");
  assert.equal(stored.traceMeta?.turnId, "turn-1");

  upsertProviderBackedOperatorMessage(
    messages,
    "operator-session-asst-1",
    "final updated",
    1100,
    "assistant",
    null,
    { trace: null, traceMeta: null, normalize: false }
  );
  const updated = messages[0];
  assert.ok(updated);
  assert.equal(updated.text, "final updated");
  assert.equal(updated.trace, undefined);
  assert.equal(updated.traceMeta, undefined);
});

test("upsertProviderBackedOperatorMessage updates the trace in place", () => {
  const messages: ButlerMessageView[] = [];
  upsertProviderBackedOperatorMessage(
    messages,
    "operator-session-asst-2",
    "v1",
    1000,
    "assistant",
    null,
    {
      trace: [{ id: "r-1", type: "reasoning", status: "in_progress", text: "draft", at: 999 }],
      normalize: false
    }
  );
  upsertProviderBackedOperatorMessage(
    messages,
    "operator-session-asst-2",
    "v2",
    1100,
    "assistant",
    null,
    {
      trace: [{ id: "r-1", type: "reasoning", status: "completed", text: "draft", at: 999, completedAt: 1100 }],
      normalize: false
    }
  );
  assert.equal(messages[0]?.text, "v2");
  assert.equal(messages[0]?.trace?.[0]?.status, "completed");
  assert.equal(messages[0]?.trace?.[0]?.completedAt, 1100);
});
