import test from "node:test";
import assert from "node:assert/strict";

import { hasCommittedPendingButlerPrompt } from "../../src/web/utils.js";

test("pending Butler prompt remains until the matching user message is committed", () => {
  const pendingText = "Investigate the live-state race.";

  assert.equal(hasCommittedPendingButlerPrompt([], pendingText), false);
  assert.equal(
    hasCommittedPendingButlerPrompt(
      [
        {
          id: "assistant-1",
          role: "assistant",
          text: pendingText,
          at: Date.now(),
          kind: "message"
        }
      ],
      pendingText
    ),
    false
  );
  assert.equal(
    hasCommittedPendingButlerPrompt(
      [
        {
          id: "user-1",
          role: "user",
          text: "Different prompt",
          at: Date.now(),
          kind: "message"
        }
      ],
      pendingText
    ),
    false
  );
  assert.equal(
    hasCommittedPendingButlerPrompt(
      [
        {
          id: "user-2",
          role: "user",
          text: pendingText,
          at: Date.now(),
          kind: "message"
        }
      ],
      pendingText
    ),
    true
  );
});
