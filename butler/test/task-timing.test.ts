import assert from "node:assert/strict";
import test from "node:test";

import { appendElapsedTaskTime, formatElapsedTaskTime } from "../src/server/task-timing.js";

test("formatElapsedTaskTime keeps elapsed task time operator friendly", () => {
  assert.equal(formatElapsedTaskTime(0), "0s");
  assert.equal(formatElapsedTaskTime(1_499), "1s");
  assert.equal(formatElapsedTaskTime(65_000), "1m 5s");
  assert.equal(formatElapsedTaskTime(3_600_000), "1h");
  assert.equal(formatElapsedTaskTime(7_260_000), "2h 1m");
});

test("appendElapsedTaskTime appends an idempotent final response footer", () => {
  const once = appendElapsedTaskTime("Done.", 1_000, 66_000, "Butler");
  assert.equal(once, "Done.\n\n_Task time (Butler): 1m 5s_");

  const twice = appendElapsedTaskTime(once, 1_000, 2_000, "Butler");
  assert.equal(twice, "Done.\n\n_Task time (Butler): 1s_");
});

test("appendElapsedTaskTime skips incomplete timing inputs", () => {
  assert.equal(appendElapsedTaskTime("Done.", null, 66_000, "Codex"), "Done.");
  assert.equal(appendElapsedTaskTime("Done.", 66_000, 1_000, "Codex"), "Done.");
  assert.equal(appendElapsedTaskTime("   ", 1_000, 66_000, "Codex"), "   ");
});
