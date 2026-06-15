import assert from "node:assert/strict";
import test from "node:test";

import { sanitizeHistoryMessages, serializeMessages } from "../../src/server/butler-agent-helpers.js";
import {
  clearPendingOperatorPrompts,
  commitPendingOperatorPrompt,
  dropTrailingFailedButlerTurns,
  hasBlockingStopRequest,
  getVisibleButlerMessages,
  keepPendingOperatorPromptsBefore,
  registerPendingOperatorPrompt,
  removeCommittedPendingOperatorPrompt,
  removePendingOperatorPrompt,
  stopButlerPrompt
} from "../../src/server/butler-agent-session.js";

function pendingAccess() {
  return {
    session: null,
    pending: false,
    stopRequestedAt: null,
    stopRequestSequence: 0,
    lastError: null,
    operatorMessages: [],
    pendingOperatorMessages: [],
    pendingOperatorMessageSequence: 0,
    pendingOperatorMessageRevision: 0,
    emit() {
      return true;
    }
  };
}

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

test("Butler message serialization skips empty user rows", () => {
  const messages = serializeMessages({
    sessionId: "session-1",
    messages: [
      { role: "user", content: [{ type: "text", text: "" }], timestamp: 100 },
      { role: "user", content: [{ type: "text", text: "Review the current implementation" }], timestamp: 110 }
    ]
  } as never);

  assert.equal(messages.length, 1);
  assert.equal(messages[0].role, "user");
  assert.equal(messages[0].text, "Review the current implementation");
});

test("Butler message serialization keeps attachment-only user rows visible", () => {
  const messages = serializeMessages({
    sessionId: "session-1",
    messages: [
      {
        role: "user-with-attachments",
        content: [
          { type: "image", data: "abc", mimeType: "image/png" },
          { type: "file", name: "notes.txt" }
        ],
        timestamp: 100
      }
    ]
  } as never);

  assert.equal(messages.length, 1);
  assert.equal(messages[0].role, "user-with-attachments");
  assert.equal(messages[0].text, "Attached 1 image, 1 file");
});

test("server-owned pending operator prompts are visible before Pi commits them", () => {
  const access = pendingAccess();
  registerPendingOperatorPrompt(access as never, "Review the current implementation\n\nStored reference files:\n- internal", "Review the current implementation");

  const messages = getVisibleButlerMessages(access as never);

  assert.equal(messages.length, 1);
  assert.equal(messages[0].role, "user");
  assert.equal(messages[0].text, "Review the current implementation\n\nStored reference files:\n- internal");
  assert.equal(messages[0].displayText, "Review the current implementation");
  assert.equal(messages[0].pending, true);
  assert.equal(access.pendingOperatorMessageRevision, 1);

  removeCommittedPendingOperatorPrompt(access as never, "Review the current implementation\n\nStored reference files:\n- internal", Date.now() + 100);
  assert.equal(access.pendingOperatorMessages.length, 0);
  assert.equal(access.pendingOperatorMessageRevision, 2);
});

test("server-owned pending operator prompts settle one committed user row at a time", () => {
  const access = pendingAccess();
  registerPendingOperatorPrompt(access as never, "same prompt");
  registerPendingOperatorPrompt(access as never, "same prompt");

  removeCommittedPendingOperatorPrompt(access as never, "same prompt", Date.now() + 100);
  assert.equal(access.pendingOperatorMessages.length, 1);
  assert.equal(access.pendingOperatorMessages[0].text, "same prompt");

  removeCommittedPendingOperatorPrompt(access as never, "same prompt", Date.now() + 200);
  assert.equal(access.pendingOperatorMessages.length, 0);
});

test("server-owned pending operator prompts settle when providers normalize user text", () => {
  const access = pendingAccess();
  registerPendingOperatorPrompt(access as never, "original prompt");

  removeCommittedPendingOperatorPrompt(access as never, "normalized prompt", Date.now() + 100);

  assert.equal(access.pendingOperatorMessages.length, 0);
});

test("server-owned pending operator prompts commit when providers omit user echoes", () => {
  const access = pendingAccess();
  const id = registerPendingOperatorPrompt(access as never, "provider omitted this echo", "provider omitted this echo");

  commitPendingOperatorPrompt(access as never, id);

  assert.equal(access.pendingOperatorMessages.length, 1);
  assert.equal(access.pendingOperatorMessages[0].pending, undefined);
  assert.equal(getVisibleButlerMessages(access as never)[0].text, "provider omitted this echo");
});

test("server-owned committed prompts defer to provider-stored user history", () => {
  const access = pendingAccess();
  const id = registerPendingOperatorPrompt(access as never, "Original prompt");
  access.pendingOperatorMessages[0].at = 100;
  commitPendingOperatorPrompt(access as never, id);
  access.session = {
    sessionId: "session-1",
    messages: [
      { role: "user", content: [{ type: "text", text: "Normalized prompt" }], timestamp: 110 }
    ]
  };

  const messages = getVisibleButlerMessages(access as never);

  assert.equal(messages.length, 1);
  assert.equal(messages[0].id, "message-0");
  assert.equal(messages[0].text, "Normalized prompt");
});

test("provider-stored user history suppresses only one synthetic prompt", () => {
  const access = pendingAccess();
  const firstId = registerPendingOperatorPrompt(access as never, "first prompt");
  const secondId = registerPendingOperatorPrompt(access as never, "second prompt");
  access.pendingOperatorMessages[0].at = 100;
  access.pendingOperatorMessages[1].at = 110;
  commitPendingOperatorPrompt(access as never, firstId);
  commitPendingOperatorPrompt(access as never, secondId);
  access.session = {
    sessionId: "session-1",
    messages: [
      { role: "user", content: [{ type: "text", text: "provider stored one prompt" }], timestamp: 105 }
    ]
  };

  const messages = getVisibleButlerMessages(access as never);

  assert.equal(messages.length, 2);
  assert.deepEqual(messages.map((message) => message.text), ["provider stored one prompt", "second prompt"]);
});

test("server-owned pending operator prompts clear by id or pending-only sweep", () => {
  const access = pendingAccess();
  const firstId = registerPendingOperatorPrompt(access as never, "first prompt");
  const secondId = registerPendingOperatorPrompt(access as never, "second prompt");
  commitPendingOperatorPrompt(access as never, secondId);

  removePendingOperatorPrompt(access as never, firstId);
  assert.deepEqual(access.pendingOperatorMessages.map((message) => message.text), ["second prompt"]);

  clearPendingOperatorPrompts(access as never);
  assert.deepEqual(access.pendingOperatorMessages.map((message) => message.text), ["second prompt"]);

  clearPendingOperatorPrompts(access as never, { includeCommitted: true });
  assert.equal(access.pendingOperatorMessages.length, 0);
});

test("server-owned operator prompts trim by timestamp", () => {
  const access = pendingAccess();
  const firstId = registerPendingOperatorPrompt(access as never, "first prompt");
  const secondId = registerPendingOperatorPrompt(access as never, "second prompt");
  access.pendingOperatorMessages[0].at = 100;
  access.pendingOperatorMessages[1].at = 200;
  commitPendingOperatorPrompt(access as never, firstId);
  commitPendingOperatorPrompt(access as never, secondId);

  keepPendingOperatorPromptsBefore(access as never, 200);

  assert.deepEqual(access.pendingOperatorMessages.map((message) => message.text), ["first prompt"]);
});

test("Butler stop requests advance a sequence for steer handoff checks", async () => {
  const access = pendingAccess();

  await stopButlerPrompt(access as never);
  assert.equal(access.stopRequestSequence, 1);

  await stopButlerPrompt(access as never);
  assert.equal(access.stopRequestSequence, 2);
});

test("Butler stop guard blocks stops after a steer handoff before prompt execution", async () => {
  const access = pendingAccess();

  await stopButlerPrompt(access as never, { clearPendingOperatorMessages: false });
  const acceptedSteerStop = access.stopRequestSequence;
  assert.equal(hasBlockingStopRequest(access as never, acceptedSteerStop), false);

  await stopButlerPrompt(access as never);
  assert.equal(hasBlockingStopRequest(access as never, acceptedSteerStop), true);
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
