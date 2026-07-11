import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_TERMINAL_TARGET,
  TERMINAL_LABELS,
  TERMINAL_URLS,
  readInitialTerminalTarget
} from "../../src/shared/terminal";

test("CLI targets represent the two agent environments", () => {
  assert.deepEqual(TERMINAL_LABELS, {
    butler: "Butler CLI",
    worker: "Worker CLI"
  });
  assert.deepEqual(TERMINAL_URLS, {
    butler: "/butler-terminal/",
    worker: "/terminal/"
  });
});

test("legacy Codex terminal links normalize to the active Worker shell", () => {
  assert.equal(DEFAULT_TERMINAL_TARGET, "worker");
  assert.equal(readInitialTerminalTarget("worker"), "worker");
  assert.equal(readInitialTerminalTarget("codex"), "worker");
  assert.equal(readInitialTerminalTarget("pi"), "worker");
  assert.equal(readInitialTerminalTarget("butler"), "butler");
  assert.equal(readInitialTerminalTarget("unknown"), null);
});
