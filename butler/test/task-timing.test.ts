import assert from "node:assert/strict";
import test from "node:test";

import { serializeMessages } from "../src/server/butler-agent-helpers.js";
import { ButlerStateStore } from "../src/server/state-store.js";
import { elapsedTaskDurationMs, formatElapsedTaskTime, stripElapsedTaskTimeFooter } from "../src/server/task-timing.js";

test("formatElapsedTaskTime keeps elapsed task time operator friendly", () => {
  assert.equal(formatElapsedTaskTime(0), "0s");
  assert.equal(formatElapsedTaskTime(1_499), "1s");
  assert.equal(formatElapsedTaskTime(65_000), "1m 5s");
  assert.equal(formatElapsedTaskTime(3_600_000), "1h");
  assert.equal(formatElapsedTaskTime(7_260_000), "2h 1m");
});

test("elapsedTaskDurationMs returns duration only for complete timing inputs", () => {
  assert.equal(elapsedTaskDurationMs(1_000, 66_000), 65_000);
  assert.equal(elapsedTaskDurationMs(null, 66_000), null);
  assert.equal(elapsedTaskDurationMs(66_000, 1_000), null);
});

test("stripElapsedTaskTimeFooter removes legacy body footers without changing message text", () => {
  assert.equal(stripElapsedTaskTimeFooter("Done.\n\n_Task time (Butler): 1m 5s_"), "Done.");
  assert.equal(stripElapsedTaskTimeFooter("Done.\n\n_Task time (Codex): 1s_"), "Done.");
  assert.equal(stripElapsedTaskTimeFooter("Done."), "Done.");
});

test("serializeMessages attaches Butler task duration to final operator-facing assistant response", () => {
  const startedAt = Date.UTC(2026, 0, 1, 12, 0, 0);
  const completedAt = startedAt + 170_000;
  const messages = serializeMessages({
    messages: [
      { role: "user", content: "Please finish the Manor task.", timestamp: startedAt },
      { role: "assistant", content: "Done.", timestamp: completedAt }
    ]
  } as never);

  assert.equal(messages[0]?.taskDurationMs, null);
  assert.equal(messages[1]?.text, "Done.");
  assert.equal(messages[1]?.taskDurationMs, 170_000);
});

test("Codex thread detail attaches task duration to completed final assistant item", () => {
  const originalNow = Date.now;
  let now = Date.UTC(2026, 0, 1, 12, 0, 0);
  Date.now = () => now;
  try {
    const store = new ButlerStateStore("/tmp/manor-task-timing-test-ui-state.json");
    store.updateTurn("thread-1", { id: "turn-1", status: "running" });
    store.updateItem("thread-1", "turn-1", { id: "user-1", type: "userMessage", text: "Run this task" }, "completed");
    now += 170_000;
    store.updateItem("thread-1", "turn-1", { id: "agent-1", type: "agentMessage", text: "Done." }, "completed");
    store.updateTurn("thread-1", { id: "turn-1", status: "completed" });
    store.openWindow("thread-1");

    const detail = store.listOpenThreadDetails()["thread-1"];
    const finalItem = detail?.turns[0]?.items.find((item) => item.id === "agent-1");
    const userItem = detail?.turns[0]?.items.find((item) => item.id === "user-1");

    assert.equal(userItem?.taskDurationMs, null);
    assert.equal(finalItem?.text, "Done.");
    assert.equal(finalItem?.taskDurationMs, 170_000);
  } finally {
    Date.now = originalNow;
  }
});
