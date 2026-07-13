import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

function guarded(script, command, args) {
  const directory = mkdtempSync(path.join(tmpdir(), "manor-runtime-guard-"));
  const executable = path.join(directory, command);
  copyFileSync(path.join(here, script), executable);
  chmodSync(executable, 0o755);
  return spawnSync(executable, args, { encoding: "utf8" });
}

test("runtime interpreters direct project execution to previews", () => {
  const result = guarded("runtime-guard.sh", "node", ["script.js"]);
  assert.equal(result.status, 126);
  assert.match(result.stderr, /^RUN_IN_PREVIEW/m);
  assert.match(result.stderr, /tests, scripts, servers, conversions, and project code/);
});

test("Python project execution is blocked outside previews", () => {
  const result = guarded("python-guard.sh", "python3", ["script.py"]);
  assert.equal(result.status, 126);
  assert.match(result.stderr, /^RUN_IN_PREVIEW/m);
});

test("package and build commands are blocked outside previews", () => {
  for (const [command, args] of [["npm", ["test"]], ["cargo", ["build"]], ["go", ["test", "./..."]], ["mise", ["exec", "--", "node", "app.js"]], ["make", ["test"]], ["pytest", []]]) {
    const result = guarded("install-guard.sh", command, args);
    assert.equal(result.status, 126, `${command} should be blocked: ${result.stderr}`);
    assert.match(result.stderr, /^RUN_IN_PREVIEW/m);
  }
});

test("guard scripts have valid Bash syntax", () => {
  for (const script of ["install-guard.sh", "python-guard.sh", "runtime-guard.sh"]) {
    execFileSync("bash", ["-n", path.join(here, script)]);
  }
});
