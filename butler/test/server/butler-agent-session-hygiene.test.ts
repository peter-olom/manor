import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { contentAttachmentSummary, sanitizeHistoryMessages, serializeMessages } from "../../src/server/butler-agent-helpers.js";
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
import {
  backfillOperatorMessagesFromSessionFiles,
  normalizeOperatorMessages,
  upsertOperatorMessage,
  upsertProviderBackedOperatorMessage
} from "../../src/server/butler-operator-messages.js";

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

test("Butler message serialization skips internal assistant tool-only rows", () => {
  const messages = serializeMessages({
    sessionId: "session-1",
    messages: [
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "Checking state" },
          { type: "toolCall", id: "call-1", name: "read_job", arguments: {} }
        ],
        timestamp: 100
      },
      {
        role: "assistant",
        content: [{ type: "function_call", name: "list_jobs", arguments: "{}" }],
        timestamp: 110
      }
    ]
  } as never);

  assert.equal(contentAttachmentSummary([{ type: "thinking" }, { type: "toolCall", name: "read_job" }]), "");
  assert.deepEqual(messages, []);
});

test("Butler message serialization skips assistant attachment summary text rows", () => {
  const messages = serializeMessages({
    sessionId: "session-1",
    messages: [
      { role: "assistant", content: [{ type: "text", text: "Attached 2 attachments" }], timestamp: 100 },
      { role: "assistant", content: [{ type: "text", text: "Attached 1 attachment" }], timestamp: 110 },
      { role: "assistant", content: [{ type: "text", text: "Reviewed the worker reply." }], timestamp: 120 }
    ]
  } as never);

  assert.equal(messages.length, 1);
  assert.equal(messages[0].text, "Reviewed the worker reply.");
});

test("Butler message serialization hides background prompts with attachments", () => {
  const messages = serializeMessages({
    sessionId: "session-1",
    messages: [
      {
        role: "user-with-attachments",
        content: [
          { type: "text", text: "[[BUTLER_BACKGROUND]]\nprivate review" },
          { type: "image", data: "abc", mimeType: "image/png" }
        ],
        timestamp: 100
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "Hidden internal reply" }],
        timestamp: 110
      },
      {
        role: "user",
        content: [{ type: "text", text: "Visible prompt" }],
        timestamp: 120
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "Visible reply" }],
        timestamp: 130
      }
    ]
  } as never);

  assert.deepEqual(messages.map((message) => message.text), ["Visible prompt", "Visible reply"]);
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

test("durable operator prompts remain visible after provider compaction drops user rows", () => {
  const access = pendingAccess();
  access.operatorMessages.push({
    id: "operator-user-1",
    role: "user",
    text: "Please review the latest preview",
    at: 100,
    taskDurationMs: null,
    kind: "message"
  });
  access.session = {
    sessionId: "session-1",
    messages: [
      { role: "assistant", content: [{ type: "text", text: "Review complete." }], timestamp: 120 }
    ]
  };

  const messages = getVisibleButlerMessages(access as never);

  assert.deepEqual(messages.map((message) => message.role), ["user", "assistant"]);
  assert.equal(messages[0].text, "Please review the latest preview");
});

test("durable provider replies remain visible after provider compaction drops assistant rows", () => {
  const access = pendingAccess();
  access.operatorMessages.push(
    {
      id: "operator-user-1",
      role: "user",
      text: "Are you learning from my feedback?",
      at: 100,
      taskDurationMs: null,
      kind: "message"
    },
    {
      id: "operator-session-reply-1",
      role: "assistant",
      text: "Yes. I am carrying that feedback forward.",
      at: 120,
      taskDurationMs: null,
      kind: "message"
    }
  );

  const messages = getVisibleButlerMessages(access as never);

  assert.deepEqual(messages.map((message) => message.role), ["user", "assistant"]);
  assert.deepEqual(messages.map((message) => message.text), ["Are you learning from my feedback?", "Yes. I am carrying that feedback forward."]);
});

test("provider history suppresses duplicate durable provider replies", () => {
  const access = pendingAccess();
  access.operatorMessages.push({
    id: "operator-session-reply-1",
    role: "assistant",
    text: "I am carrying that feedback forward.",
    at: 120,
    taskDurationMs: null,
    kind: "message"
  });
  access.session = {
    sessionId: "session-1",
    messages: [
      { role: "assistant", content: [{ type: "text", text: "I am carrying that feedback forward." }], timestamp: 121 }
    ]
  };

  const messages = getVisibleButlerMessages(access as never);

  assert.equal(messages.length, 1);
  assert.equal(messages[0].id, "message-0");
});

test("provider user history suppresses duplicate durable operator prompts", () => {
  const access = pendingAccess();
  access.operatorMessages.push({
    id: "operator-user-1",
    role: "user",
    text: "Original prompt",
    at: 100,
    taskDurationMs: null,
    kind: "message"
  });
  access.session = {
    sessionId: "session-1",
    messages: [
      { role: "user", content: [{ type: "text", text: "Normalized prompt" }], timestamp: 110 },
      { role: "assistant", content: [{ type: "text", text: "Done." }], timestamp: 120 }
    ]
  };

  const messages = getVisibleButlerMessages(access as never);

  assert.deepEqual(messages.map((message) => message.id), ["message-0", "message-1"]);
  assert.deepEqual(messages.map((message) => message.text), ["Normalized prompt", "Done."]);
});

test("pending operator prompts override durable prompt rows with the same id", () => {
  const access = pendingAccess();
  access.operatorMessages.push({
    id: "pending-operator-1",
    role: "user",
    text: "Queued prompt",
    at: 100,
    taskDurationMs: null,
    kind: "message"
  });
  access.pendingOperatorMessages.push({
    id: "pending-operator-1",
    role: "user",
    text: "Queued prompt",
    at: 100,
    taskDurationMs: null,
    kind: "message",
    pending: true
  });

  const messages = getVisibleButlerMessages(access as never);

  assert.equal(messages.length, 1);
  assert.equal(messages[0].pending, true);
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

test("startup backfill restores operator user prompts from persisted session logs", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "manor-butler-session-backfill-"));
  const messages = [];
  await writeFile(
    path.join(dir, "session.jsonl"),
    [
      JSON.stringify({ type: "message", id: "one", timestamp: "2026-06-15T10:00:00.000Z", message: { role: "user", content: [{ type: "text", text: "Show this prompt" }] } }),
      JSON.stringify({ type: "message", id: "reply", timestamp: "2026-06-15T10:00:20.000Z", message: { role: "assistant", content: [{ type: "text", text: "Visible reply" }] } }),
      JSON.stringify({ type: "message", id: "internal", timestamp: "2026-06-15T10:01:00.000Z", message: { role: "user", content: [{ type: "text", text: "[[BUTLER_BACKGROUND]]\nHide this" }] } }),
      JSON.stringify({ type: "message", id: "assistant", timestamp: "2026-06-15T10:02:00.000Z", message: { role: "assistant", content: [{ type: "text", text: "Hidden reply" }] } })
    ].join("\n"),
    "utf8"
  );

  const changed = await backfillOperatorMessagesFromSessionFiles(messages, dir);

  assert.equal(changed, true);
  assert.deepEqual(messages.map((message) => message.text), ["Show this prompt", "Visible reply"]);
  assert.deepEqual(messages.map((message) => message.role), ["user", "assistant"]);
});

test("startup backfill ignores internal tool-only assistant turns", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "manor-butler-session-backfill-"));
  const messages = [];
  await writeFile(
    path.join(dir, "session.jsonl"),
    [
      JSON.stringify({
        type: "message",
        id: "tool-only",
        timestamp: "2026-06-15T10:00:00.000Z",
        message: {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "Inspecting" },
            { type: "toolCall", id: "call-1", name: "list_jobs", arguments: {} }
          ]
        }
      }),
      JSON.stringify({
        type: "message",
        id: "visible",
        timestamp: "2026-06-15T10:00:10.000Z",
        message: { role: "assistant", content: [{ type: "text", text: "Visible reply" }] }
      })
    ].join("\n"),
    "utf8"
  );

  const changed = await backfillOperatorMessagesFromSessionFiles(messages, dir);

  assert.equal(changed, true);
  assert.deepEqual(messages.map((message) => message.text), ["Visible reply"]);
});

test("operator history normalization removes stale leaked attachment summaries", () => {
  const messages = [
    {
      id: "operator-session-message-216",
      role: "assistant",
      text: "Attached 2 attachments",
      at: 100,
      taskDurationMs: null,
      kind: "message" as const
    },
    {
      id: "operator-user-visible",
      role: "user",
      text: "Visible prompt",
      at: 200,
      taskDurationMs: null,
      kind: "message" as const
    },
    {
      id: "operator-session-visible",
      role: "assistant",
      text: "Visible reply",
      at: 210,
      taskDurationMs: null,
      kind: "message" as const
    }
  ];

  const changed = normalizeOperatorMessages(messages);

  assert.equal(changed, true);
  assert.deepEqual(messages.map((message) => message.text), ["Visible prompt", "Visible reply"]);
});

test("startup backfill restores older coherent turns before pruning", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "manor-butler-session-backfill-"));
  const messages = [{
    id: "operator-session-latest",
    role: "assistant",
    text: "Later durable assistant row",
    at: Date.parse("2026-06-15T14:00:00.000Z"),
    taskDurationMs: null,
    kind: "message" as const
  }];
  await writeFile(
    path.join(dir, "session.jsonl"),
    [
      JSON.stringify({ type: "message", id: "prompt", timestamp: "2026-06-15T09:00:00.000Z", message: { role: "user", content: [{ type: "text", text: "Recover this older prompt" }] } }),
      JSON.stringify({ type: "message", id: "reply", timestamp: "2026-06-15T09:00:20.000Z", message: { role: "assistant", content: [{ type: "text", text: "Recover this older reply" }] } })
    ].join("\n"),
    "utf8"
  );

  const changed = await backfillOperatorMessagesFromSessionFiles(messages, dir);

  assert.equal(changed, true);
  assert.deepEqual(messages.map((message) => message.text), [
    "Recover this older prompt",
    "Recover this older reply",
    "Later durable assistant row"
  ]);
  assert.deepEqual(messages.map((message) => message.role), ["user", "assistant", "assistant"]);
});

test("startup backfill repairs assistant-only durable history from raw session turns", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "manor-butler-session-backfill-"));
  const messages = [
    {
      id: "operator-session-reply-one",
      role: "assistant",
      text: "First recovered reply",
      at: Date.parse("2026-06-15T09:00:20.000Z"),
      taskDurationMs: null,
      kind: "message" as const
    },
    {
      id: "operator-session-reply-two",
      role: "assistant",
      text: "Second recovered reply",
      at: Date.parse("2026-06-15T09:01:20.000Z"),
      taskDurationMs: null,
      kind: "message" as const
    }
  ];
  await writeFile(
    path.join(dir, "session.jsonl"),
    [
      JSON.stringify({ type: "message", id: "prompt-one", timestamp: "2026-06-15T09:00:00.000Z", message: { role: "user", content: [{ type: "text", text: "First missing prompt" }] } }),
      JSON.stringify({ type: "message", id: "reply-one", timestamp: "2026-06-15T09:00:20.000Z", message: { role: "assistant", content: [{ type: "text", text: "First recovered reply" }] } }),
      JSON.stringify({ type: "message", id: "prompt-two", timestamp: "2026-06-15T09:01:00.000Z", message: { role: "user", content: [{ type: "text", text: "Second missing prompt" }] } }),
      JSON.stringify({ type: "message", id: "reply-two", timestamp: "2026-06-15T09:01:20.000Z", message: { role: "assistant", content: [{ type: "text", text: "Second recovered reply" }] } })
    ].join("\n"),
    "utf8"
  );

  const changed = await backfillOperatorMessagesFromSessionFiles(messages, dir);

  assert.equal(changed, true);
  assert.deepEqual(messages.map((message) => message.role), ["user", "assistant", "user", "assistant"]);
  assert.deepEqual(messages.map((message) => message.text), [
    "First missing prompt",
    "First recovered reply",
    "Second missing prompt",
    "Second recovered reply"
  ]);
});

test("operator history normalization drops old prompt-only rows before coherent turns", () => {
  const messages = [];
  for (let index = 0; index < 20; index += 1) {
    upsertProviderBackedOperatorMessage(messages, `operator-user-old-${index}`, `orphan prompt ${index}`, 1000 + index, "user");
  }

  for (let index = 0; index < 12; index += 1) {
    const at = 10_000_000 + index * 10_000;
    upsertProviderBackedOperatorMessage(messages, `operator-user-new-${index}`, `prompt ${index}`, at, "user");
    upsertOperatorMessage(messages, `reply-${index}`, `reply ${index}`, at + 1000);
  }

  assert.equal(messages.some((message) => message.text.startsWith("orphan prompt")), false);
  assert.deepEqual(messages.slice(0, 2).map((message) => message.role), ["user", "assistant"]);
  assert.equal(messages.at(-1)?.text, "reply 11");
});

test("operator history normalization drops old provider replies with no recovered prompt", () => {
  const messages = [];
  for (let index = 0; index < 8; index += 1) {
    upsertProviderBackedOperatorMessage(messages, `operator-session-old-${index}`, `old assistant ${index}`, 1000 + index, "assistant");
  }
  upsertProviderBackedOperatorMessage(messages, "operator-user-current", "current prompt", 10_000_000, "user");
  upsertProviderBackedOperatorMessage(messages, "operator-session-current", "current reply", 10_000_100, "assistant");

  assert.deepEqual(messages.map((message) => message.text), ["current prompt", "current reply"]);
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
