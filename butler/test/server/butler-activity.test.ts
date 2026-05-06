import test from "node:test";
import assert from "node:assert/strict";

import { getButlerActivityTurns, keepButlerActivityBefore, recordButlerActivityEvent } from "../../src/server/butler-activity.js";
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
  assert.equal(turns[0]?.items[0]?.text, "Thinking update recorded.");
  assert.equal(turns[0]?.items[1]?.kind, "tool");
  assert.equal(turns[0]?.items[1]?.title, "list_jobs");
  assert.equal(turns[0]?.items[1]?.status, "completed");
  assert.equal(turns[0]?.items[1]?.text, "count: 3");
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
  assert.equal(turns[0]?.items[0]?.text, "Thinking update recorded.");
  assert.equal(turns[0]?.items[1]?.title, "remember_insight");
  assert.equal(turns[0]?.items[1]?.text, "Remembered: Agent Slidev desktop app direction");
  assert.equal(access.activitySummaryTurns[0]?.items[0]?.text, "Thinking update recorded.");
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
        text: "**Considering user insight storage** with `markdown`.",
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
  assert.equal(turns[0]?.items[0]?.text, "Thinking update recorded.");
  assert.equal(turns[0]?.items[1]?.text, "Remembered: Agent Slidev desktop app direction");
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
