import assert from "node:assert/strict";
import { test } from "node:test";

import { recoverCodexTranscriptActivityFromText } from "../../src/server/codex-transcript-activity.js";

test("Codex transcript activity recovers command calls and outputs by turn", () => {
  const raw = [
    JSON.stringify({
      timestamp: "2026-06-28T15:48:36.000Z",
      type: "response_item",
      payload: {
        type: "function_call",
        id: "fc-1",
        name: "exec_command",
        arguments: JSON.stringify({ cmd: "npm run build", workdir: "/repos/app" }),
        call_id: "call-1",
        internal_chat_message_metadata_passthrough: { turn_id: "turn-1" }
      }
    }),
    JSON.stringify({
      timestamp: "2026-06-28T15:48:37.000Z",
      type: "response_item",
      payload: {
        type: "function_call_output",
        call_id: "call-1",
        output: "Build passed."
      }
    })
  ].join("\n");

  const [turn] = recoverCodexTranscriptActivityFromText(raw);

  assert.equal(turn?.turnId, "turn-1");
  assert.equal(turn.items.length, 1);
  assert.equal(turn.items[0]?.id, "fc-1");
  assert.equal(turn.items[0]?.type, "commandExecution");
  assert.match(turn.items[0]?.text ?? "", /npm run build/);
  assert.match(turn.items[0]?.text ?? "", /Build passed/);
  assert.equal(turn.items[0]?.at, Date.parse("2026-06-28T15:48:37.000Z"));
});

test("Codex transcript activity keeps file and search rows typed", () => {
  const raw = [
    JSON.stringify({
      timestamp: "2026-06-28T15:48:36.000Z",
      type: "response_item",
      payload: {
        type: "custom_tool_call",
        id: "patch-1",
        name: "apply_patch",
        input: "*** Begin Patch\n*** Update File: app.js\n*** End Patch",
        call_id: "call-patch",
        internal_chat_message_metadata_passthrough: { turn_id: "turn-1" }
      }
    }),
    JSON.stringify({
      timestamp: "2026-06-28T15:48:37.000Z",
      type: "response_item",
      payload: {
        type: "tool_search_call",
        id: "search-1",
        call_id: "call-search",
        arguments: { query: "spawn sub-agent", limit: 5 },
        internal_chat_message_metadata_passthrough: { turn_id: "turn-1" }
      }
    })
  ].join("\n");

  const [turn] = recoverCodexTranscriptActivityFromText(raw);

  assert.deepEqual(turn?.items.map((item) => item.type), ["fileChange", "webSearch"]);
});
