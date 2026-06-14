import assert from "node:assert/strict";
import test from "node:test";

import { sanitizeHistoryMessages } from "../../src/server/butler-agent-helpers.js";
import { dropTrailingFailedButlerTurns } from "../../src/server/butler-agent-session.js";

test("Butler session sanitizer removes orphan tool results", () => {
  const messages = [
    { role: "user", content: [{ type: "text", text: "review this" }] },
    { role: "toolResult", toolCallId: "call_missing|fc_missing", content: [{ type: "text", text: "stale output" }] },
    {
      role: "assistant",
      content: [
        {
          type: "toolCall",
          id: "call_kept|fc_kept",
          name: "read_job",
          arguments: {}
        }
      ]
    },
    { role: "toolResult", toolCallId: "call_kept|fc_kept", content: [{ type: "text", text: "fresh output" }] }
  ];

  const sanitized = sanitizeHistoryMessages(messages as never);

  assert.equal(sanitized.changed, true);
  assert.deepEqual(
    sanitized.messages.map((message) => (message as { role?: string }).role),
    ["user", "assistant", "toolResult"]
  );
  assert.equal((sanitized.messages[2] as { toolCallId?: string }).toolCallId, "call_kept|fc_kept");
});

test("Butler session sanitizer matches tool results by base call id", () => {
  const messages = [
    {
      role: "assistant",
      content: [
        {
          type: "toolCall",
          id: "call_base|fc_detail",
          name: "read_job",
          arguments: {}
        }
      ]
    },
    { role: "toolResult", toolCallId: "call_base", content: [{ type: "text", text: "output" }] }
  ];

  const sanitized = sanitizeHistoryMessages(messages as never);

  assert.equal(sanitized.changed, false);
  assert.equal(sanitized.messages.length, 2);
});

test("Butler failed retry cleanup removes the failed assistant and prompt", () => {
  const messages = [
    { role: "assistant", content: [{ type: "text", text: "previous ok" }] },
    { role: "user", content: [{ type: "text", text: "background review" }] },
    { role: "assistant", stopReason: "error", errorMessage: "No tool call found for function call output with call_id call_missing." }
  ];
  const access = {
    session: {
      messages,
      agent: {
        state: {
          messages
        }
      }
    }
  };

  dropTrailingFailedButlerTurns(access as never);

  assert.deepEqual(access.session.agent.state.messages, [{ role: "assistant", content: [{ type: "text", text: "previous ok" }] }]);
});
