import test from "node:test";
import assert from "node:assert/strict";

import { getButlerActivityTurns, recordButlerActivityEvent } from "../../src/server/butler-activity.js";
import type { ButlerAgentSessionAccess } from "../../src/server/butler-agent-tool-access.js";

function makeAccess(): ButlerAgentSessionAccess {
  return {
    activityTurns: [],
    activeActivityTurnId: null,
    activitySequence: 0
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
  assert.match(turns[0]?.items[0]?.text ?? "", /Inspecting the workspace/);
  assert.equal(turns[0]?.items[1]?.kind, "tool");
  assert.equal(turns[0]?.items[1]?.title, "list_jobs");
  assert.equal(turns[0]?.items[1]?.status, "completed");
});
