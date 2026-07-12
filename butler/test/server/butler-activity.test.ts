import test from "node:test";
import assert from "node:assert/strict";

import { finalizeButlerActivityTurn, getButlerActivityTurns, keepButlerActivityBefore, normalizeButlerActivitySummaryTurns, recordButlerActivityEvent } from "../../src/server/butler-activity.js";
import type { ButlerAgentSessionAccess } from "../../src/server/butler-agent-tool-access.js";

function makeAccess(): ButlerAgentSessionAccess {
  return {
    activityTurns: [],
    activitySummaryTurns: [],
    activeActivityTurnId: null,
    activitySequence: 0,
    persistActivitySummaryTurn(turn) {
      const existingIndex = this.activitySummaryTurns.findIndex((entry) => entry.id === turn.id);
      if (existingIndex >= 0) {
        this.activitySummaryTurns.splice(existingIndex, 1, turn);
      } else {
        this.activitySummaryTurns.push(turn);
      }
    }
  } as unknown as ButlerAgentSessionAccess;
}

test("Butler activity captures thinking updates and tool calls without final text", () => {
  const access = makeAccess();
  const assistantMessage = {
    role: "assistant",
    content: [{ type: "thinking", thinking: "Inspecting\\nthe workspace." }],
    timestamp: Date.now()
  };

  recordButlerActivityEvent(access, { type: "agent_start" } as never);
  recordButlerActivityEvent(access, {
    type: "message_update",
    message: assistantMessage,
    assistantMessageEvent: {
      type: "thinking_delta",
      contentIndex: 0,
      delta: "workspace",
      partial: assistantMessage
    }
  } as never);
  recordButlerActivityEvent(access, {
    type: "message_update",
    message: assistantMessage,
    assistantMessageEvent: {
      type: "toolcall_end",
      contentIndex: 1,
      toolCall: {
        type: "toolCall",
        id: "tool-1",
        name: "list_jobs",
        arguments: { status: "active" }
      },
      partial: {
        ...assistantMessage,
        content: [
          ...assistantMessage.content,
          { type: "toolCall", id: "tool-1", name: "list_jobs", arguments: { status: "active" } }
        ]
      }
    }
  } as never);
  recordButlerActivityEvent(access, {
    type: "tool_execution_end",
    toolCallId: "tool-1",
    toolName: "list_jobs",
    result: { count: 3 },
    isError: false
  } as never);
  recordButlerActivityEvent(access, { type: "agent_end", messages: [] } as never);

  const turns = getButlerActivityTurns(access);
  assert.equal(turns.length, 1);
  assert.equal(turns[0]?.status, "completed");
  assert.equal(turns[0]?.items.length, 2);
  assert.equal(turns[0]?.items[0]?.kind, "thinking");
  assert.equal(turns[0]?.items[0]?.text.includes("\\n"), false);
  assert.equal(turns[0]?.items[0]?.text, "Inspecting the workspace.");
  assert.equal(turns[0]?.items[1]?.kind, "tool");
  assert.equal(turns[0]?.items[1]?.title, "list_jobs");
  assert.equal(turns[0]?.items[1]?.status, "completed");
  assert.equal(turns[0]?.items[1]?.text, "count: 3");
});

test("failed Butler turns persist their failure and do not complete active tools", () => {
  const access = makeAccess();
  recordButlerActivityEvent(access, { type: "agent_start" } as never);
  recordButlerActivityEvent(access, {
    type: "tool_execution_start",
    toolCallId: "tool-failed",
    toolName: "inspect_filesystem",
    args: { path: "/repos" }
  } as never);
  recordButlerActivityEvent(access, {
    type: "agent_end",
    messages: [{
      role: "assistant",
      stopReason: "error",
      errorMessage: "Provider failed with Authorization: Bearer opaque-token-123456"
    }]
  } as never);

  const persisted = access.activitySummaryTurns[0];
  assert.equal(persisted?.status, "failed");
  assert.equal(persisted?.items[0]?.status, "error");
  assert.equal(persisted?.detail, "Provider failed with Authorization: Bearer [REDACTED]");

  const reloaded = normalizeButlerActivitySummaryTurns(JSON.parse(JSON.stringify(access.activitySummaryTurns)));
  assert.equal(reloaded[0]?.status, "failed");
  assert.equal(reloaded[0]?.items[0]?.status, "error");
  assert.equal(reloaded[0]?.detail, "Provider failed with Authorization: Bearer [REDACTED]");
});

test("immediate provider failures persist even when no activity item started", () => {
  const access = makeAccess();
  recordButlerActivityEvent(access, { type: "agent_start" } as never);
  recordButlerActivityEvent(access, {
    type: "agent_end",
    messages: [{ role: "assistant", stopReason: "error", errorMessage: "Provider connection closed before streaming." }]
  } as never);

  const reloaded = normalizeButlerActivitySummaryTurns(JSON.parse(JSON.stringify(access.activitySummaryTurns)));
  assert.equal(reloaded.length, 1);
  assert.equal(reloaded[0]?.status, "failed");
  assert.equal(reloaded[0]?.items.length, 0);
  assert.equal(getButlerActivityTurns({ ...access, activityTurns: [], activitySummaryTurns: reloaded } as never)[0]?.detail, "Provider connection closed before streaming.");
});

test("pre-agent attachment failures create a durable zero-item turn", () => {
  const access = makeAccess();

  finalizeButlerActivityTurn(access, "failed", "Attachment image-1 could not be decoded.", 250, 100);

  const snapshot = getButlerActivityTurns(access);
  assert.equal(snapshot.length, 1);
  assert.deepEqual(snapshot[0], {
    id: "butler-activity-100-1",
    status: "failed",
    startedAt: 100,
    completedAt: 250,
    detail: "Attachment image-1 could not be decoded.",
    items: []
  });

  const reloaded = normalizeButlerActivitySummaryTurns(JSON.parse(JSON.stringify(access.activitySummaryTurns)));
  assert.equal(reloaded.length, 1);
  assert.equal(reloaded[0]?.status, "failed");
  assert.equal(reloaded[0]?.detail, "Attachment image-1 could not be decoded.");
  assert.deepEqual(reloaded[0]?.items, []);
});

test("prompt rejection reuses a failure already finalized by agent_end", () => {
  const access = makeAccess();
  recordButlerActivityEvent(access, { type: "agent_start" } as never);
  recordButlerActivityEvent(access, {
    type: "agent_end",
    messages: [{ role: "assistant", stopReason: "error", errorMessage: "Provider stream failed." }]
  } as never);
  const existingId = access.activityTurns[0]?.id;

  finalizeButlerActivityTurn(access, "failed", "Provider prompt rejected.", Date.now() + 10, 0);

  assert.equal(access.activityTurns.length, 1);
  assert.equal(access.activityTurns[0]?.id, existingId);
  assert.equal(access.activityTurns[0]?.status, "failed");
  assert.equal(access.activityTurns[0]?.detail, "Provider prompt rejected.");
});

test("interrupted Butler turns remain stopped after persistence reload", () => {
  const access = makeAccess();
  recordButlerActivityEvent(access, { type: "agent_start" } as never);
  recordButlerActivityEvent(access, {
    type: "tool_execution_start",
    toolCallId: "tool-stopped",
    toolName: "web_fetch",
    args: { url: "https://example.com" }
  } as never);
  recordButlerActivityEvent(access, {
    type: "agent_end",
    messages: [{ role: "assistant", stopReason: "aborted" }]
  } as never);

  const reloaded = normalizeButlerActivitySummaryTurns(JSON.parse(JSON.stringify(access.activitySummaryTurns)));
  assert.equal(reloaded[0]?.status, "interrupted");
  assert.equal(reloaded[0]?.items[0]?.status, "stopped");
  assert.equal(reloaded[0]?.detail, "Butler was stopped before the turn finished.");
});

test("Butler activity keeps distinct tool calls that reuse a provider content index", () => {
  const access = makeAccess();
  recordButlerActivityEvent(access, { type: "agent_start" } as never);
  recordButlerActivityEvent(access, {
    type: "message_update",
    message: { role: "assistant", content: [] },
    assistantMessageEvent: {
      type: "toolcall_end",
      contentIndex: 0,
      toolCall: { type: "toolCall", id: "tool-1", name: "inspect_filesystem", arguments: { path: "/repos" } },
      partial: { role: "assistant", content: [] }
    }
  } as never);
  recordButlerActivityEvent(access, { type: "tool_execution_start", toolCallId: "tool-1", toolName: "inspect_filesystem", args: { path: "/repos" } } as never);
  recordButlerActivityEvent(access, { type: "tool_execution_end", toolCallId: "tool-1", toolName: "inspect_filesystem", result: { type: "directory" }, isError: false } as never);
  recordButlerActivityEvent(access, {
    type: "message_update",
    message: { role: "assistant", content: [] },
    assistantMessageEvent: {
      type: "toolcall_end",
      contentIndex: 0,
      toolCall: { type: "toolCall", id: "tool-2", name: "ask_operator", arguments: { questions: [] } },
      partial: { role: "assistant", content: [] }
    }
  } as never);
  recordButlerActivityEvent(access, { type: "tool_execution_end", toolCallId: "tool-2", toolName: "ask_operator", result: { posted: true }, isError: false } as never);
  recordButlerActivityEvent(access, { type: "agent_end", messages: [] } as never);

  const tools = getButlerActivityTurns(access)[0]?.items.filter((item) => item.kind === "tool") ?? [];
  assert.deepEqual(tools.map((item) => [item.toolCallId, item.title]), [
    ["tool-1", "inspect_filesystem"],
    ["tool-2", "ask_operator"]
  ]);
});

test("Butler activity strips markdown thinking and humanizes tool content", () => {
  const access = makeAccess();
  const assistantMessage = {
    role: "assistant",
    content: [{ type: "thinking", thinking: "**Considering** `options` for [the plan](https://example.com)." }],
    timestamp: Date.now()
  };

  recordButlerActivityEvent(access, { type: "agent_start" } as never);
  recordButlerActivityEvent(access, {
    type: "message_update",
    message: assistantMessage,
    assistantMessageEvent: {
      type: "thinking_delta",
      contentIndex: 0,
      delta: "plan",
      partial: assistantMessage
    }
  } as never);

  let turns = getButlerActivityTurns(access);
  assert.equal(turns[0]?.items[0]?.text, "Considering options for the plan.");

  recordButlerActivityEvent(access, {
    type: "tool_execution_end",
    toolCallId: "tool-1",
    toolName: "remember_insight",
    result: {
      content: [{ type: "text", text: "Remembered: Agent Slidev desktop app direction" }],
      details: {
        entry: {
          id: "entry-1",
          summary: "Long internal summary"
        }
      }
    },
    isError: false
  } as never);
  recordButlerActivityEvent(access, { type: "agent_end", messages: [] } as never);

  turns = getButlerActivityTurns(access);
  assert.equal(turns[0]?.items[0]?.text, "Considering options for the plan.");
  assert.equal(turns[0]?.items[1]?.title, "remember_insight");
  assert.equal(turns[0]?.items[1]?.text, "Remembered: Agent Slidev desktop app direction");
  assert.equal(access.activitySummaryTurns[0]?.items[0]?.text, "Considering options for the plan.");
});

test("completed thinking persists its redacted text across reload", () => {
  const access = makeAccess();
  const assistantMessage = {
    role: "assistant",
    content: [{ type: "thinking", thinking: "Checking **provider state** with Authorization: Bearer opaque-token-123456" }],
    timestamp: Date.now()
  };

  recordButlerActivityEvent(access, { type: "agent_start" } as never);
  recordButlerActivityEvent(access, {
    type: "message_update",
    message: assistantMessage,
    assistantMessageEvent: {
      type: "thinking_delta",
      contentIndex: 0,
      delta: "provider state",
      partial: assistantMessage
    }
  } as never);
  recordButlerActivityEvent(access, { type: "message_end", message: assistantMessage } as never);
  recordButlerActivityEvent(access, { type: "agent_end", messages: [assistantMessage] } as never);

  const reloaded = normalizeButlerActivitySummaryTurns(JSON.parse(JSON.stringify(access.activitySummaryTurns)));
  assert.equal(reloaded[0]?.items[0]?.text, "Checking provider state with Authorization: Bearer [REDACTED]");
});

test("Butler activity normalizes persisted item text when read back", () => {
  const access = makeAccess();
  access.activityTurns.push({
    id: "turn-1",
    status: "completed",
    startedAt: Date.now(),
    completedAt: Date.now(),
    items: [
      {
        id: "thinking-1",
        kind: "thinking",
        status: "completed",
        title: "Thinking",
        text: "**Considering user insight storage** with `markdown`. Authorization: Bearer opaque-token-123456",
        at: Date.now(),
        updatedAt: Date.now(),
        contentIndex: null,
        toolCallId: null
      },
      {
        id: "tool-1",
        kind: "tool",
        status: "completed",
        title: "remember_insight",
        text: JSON.stringify({
          content: [{ type: "text", text: "Remembered: Agent Slidev desktop app direction" }],
          details: { entry: { summary: "Noisy raw payload" } }
        }),
        at: Date.now(),
        updatedAt: Date.now(),
        contentIndex: null,
        toolCallId: "tool-1"
      }
    ]
  });

  const turns = getButlerActivityTurns(access);
  assert.equal(turns[0]?.items[0]?.text, "Considering user insight storage with markdown. Authorization: Bearer [REDACTED]");
  assert.equal(turns[0]?.items[1]?.text, "Remembered: Agent Slidev desktop app direction");
});

test("Butler activity can be compacted for live snapshots", () => {
  const access = makeAccess();
  for (let turnIndex = 0; turnIndex < 6; turnIndex += 1) {
    access.activitySummaryTurns.push({
      id: `turn-${turnIndex}`,
      status: "completed",
      startedAt: turnIndex * 100,
      completedAt: turnIndex * 100 + 50,
      items: Array.from({ length: 4 }, (_, itemIndex) => ({
        id: `turn-${turnIndex}:tool-${itemIndex}`,
        kind: "tool",
        status: "completed",
        title: `tool_${itemIndex}`,
        text: `payload-${turnIndex}-${itemIndex}-${"x".repeat(60)}`,
        at: turnIndex * 100 + itemIndex,
        updatedAt: turnIndex * 100 + itemIndex,
        contentIndex: null,
        toolCallId: `tool-${itemIndex}`
      }))
    });
  }
  access.activityTurns.push({
    id: "active-turn",
    status: "active",
    startedAt: 700,
    completedAt: null,
    items: [
      {
        id: "active-turn:tool",
        kind: "tool",
        status: "active",
        title: "active_tool",
        text: "running",
        at: 700,
        updatedAt: 700,
        contentIndex: null,
        toolCallId: "active-tool"
      }
    ]
  });

  const turns = getButlerActivityTurns(access, {
    maxCompletedTurns: 2,
    maxItemsPerTurn: 2,
    maxItemText: 24
  });

  assert.deepEqual(turns.map((turn) => turn.id), ["turn-4", "turn-5", "active-turn"]);
  assert.deepEqual(turns[0]?.items.map((item) => item.id), ["turn-4:tool-2", "turn-4:tool-3"]);
  assert.match(turns[0]?.items[0]?.text ?? "", /\.\.\.$/);
  assert.equal(turns[2]?.items[0]?.text, "running");
});

test("Butler activity is pruned when chat is deleted from a prompt", () => {
  const access = makeAccess();
  access.activeActivityTurnId = "active-turn";
  access.activityTurns.push(
    {
      id: "kept-turn",
      status: "completed",
      startedAt: 100,
      completedAt: 150,
      items: [
        {
          id: "kept-tool",
          kind: "tool",
          status: "completed",
          title: "kept_tool",
          text: "done",
          at: 120,
          updatedAt: 150,
          contentIndex: null,
          toolCallId: "kept-tool"
        }
      ]
    },
    {
      id: "active-turn",
      status: "active",
      startedAt: 250,
      completedAt: null,
      items: [
        {
          id: "active-tool",
          kind: "tool",
          status: "active",
          title: "active_tool",
          text: "running",
          at: 250,
          updatedAt: 250,
          contentIndex: null,
          toolCallId: "active-tool"
        }
      ]
    }
  );
  access.activitySummaryTurns.push(
    access.activityTurns[0]!,
    {
      id: "deleted-summary",
      status: "completed",
      startedAt: 220,
      completedAt: 260,
      items: [
        {
          id: "deleted-tool",
          kind: "tool",
          status: "completed",
          title: "deleted_tool",
          text: "done",
          at: 230,
          updatedAt: 260,
          contentIndex: null,
          toolCallId: "deleted-tool"
        }
      ]
    }
  );

  assert.equal(keepButlerActivityBefore(access, 200), true);
  assert.deepEqual(access.activityTurns.map((turn) => turn.id), ["kept-turn"]);
  assert.deepEqual(access.activitySummaryTurns.map((turn) => turn.id), ["kept-turn"]);
  assert.equal(access.activeActivityTurnId, null);
});
