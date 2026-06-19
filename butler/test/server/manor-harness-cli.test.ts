import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const harnessSource = readFileSync(new URL("../../../docker/codex-box/manor-harness.mjs", import.meta.url), "utf8");

test("manor-harness resolves lifecycle cwd flags before forwarding broker requests", () => {
  assert.match(harnessSource, /function readCwdFlag/);
  assert.match(harnessSource, /path\.resolve\(process\.cwd\(\), raw\)/);
  assert.doesNotMatch(harnessSource, /cwd: readFlag\(args, "--cwd"\)/);
});
