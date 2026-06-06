import assert from "node:assert/strict";
import test from "node:test";

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
