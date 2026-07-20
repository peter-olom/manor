import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

test("Worker exposes normal development commands without runtime guard shims", () => {
  const dockerfile = readFileSync(path.join(here, "Dockerfile"), "utf8");
  assert.doesNotMatch(dockerfile, /install-guard|python-guard|runtime-guard|install-guard-bin/);
  assert.match(dockerfile, /ENV PATH="\$\{MANOR_REAL_PATH\}"/);
});

test("the Git admission wrapper has valid Bash syntax", () => {
  execFileSync("bash", ["-n", path.join(here, "git-admission.sh")]);
});

test("report help is concise and includes exact browser proof syntax", () => {
  for (const args of [["report", "--help"], ["report", "help"]]) {
    const result = spawnSync(process.execPath, [path.join(here, "manor-harness.mjs"), ...args], {
      encoding: "utf8",
      env: { ...process.env, MANOR_HARNESS_REGISTRY_PATH: path.join(tmpdir(), "missing-manor-capabilities.json") }
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /proofRunId/);
    assert.match(result.stdout, /--evidence-json/);
    assert.doesNotMatch(result.stdout, /memory diagnostics/);
  }
});
