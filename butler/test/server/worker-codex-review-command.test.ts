import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { buildCodexWorkerReviewArgs, runCodexWorkerReviewCommand } from "../../src/server/worker-codex-review.js";

test("worker codex review command has no positional prompt", () => {
  const args = buildCodexWorkerReviewArgs({
    schemaPath: "/tmp/schema.json",
    outputPath: "/tmp/output.json",
    model: null
  });

  assert.deepEqual(args, [
    "exec",
    "review",
    "--uncommitted",
    "--ephemeral",
    "--skip-git-repo-check",
    "--ignore-rules",
    "--output-schema",
    "/tmp/schema.json",
    "--output-last-message",
    "/tmp/output.json"
  ]);
  assert.equal(args.includes("-"), false);
  assert.equal(args.includes("Review this closeout."), false);
});

test("worker codex review command pipes prompt through stdin", async () => {
  const binDir = await mkdtemp(path.join(tmpdir(), "manor-worker-review-bin-"));
  const capturePath = path.join(binDir, "capture.json");
  const codexPath = path.join(binDir, "codex");
  await writeFile(
    codexPath,
    [
      "#!/usr/bin/env node",
      'const fs = require("node:fs");',
      `const capturePath = ${JSON.stringify(capturePath)};`,
      "let stdin = '';",
      "process.stdin.setEncoding('utf8');",
      "process.stdin.on('data', chunk => { stdin += chunk; });",
      "process.stdin.on('end', () => {",
      "  fs.writeFileSync(capturePath, JSON.stringify({ args: process.argv.slice(2), stdin, codexHome: process.env.CODEX_HOME }));",
      "});"
    ].join("\n"),
    "utf8"
  );
  await chmod(codexPath, 0o755);
  const originalPath = process.env.PATH;
  process.env.PATH = `${binDir}${path.delimiter}${originalPath ?? ""}`;

  try {
    await runCodexWorkerReviewCommand({
      cwd: binDir,
      codexHomeDir: "/tmp/codex-home",
      schemaPath: "/tmp/schema.json",
      outputPath: "/tmp/output.json",
      model: null,
      prompt: "Review the delegated closeout.",
      timeoutMs: 5_000
    });

    const captured = JSON.parse(await readFile(capturePath, "utf8"));
    assert.equal(captured.stdin, "Review the delegated closeout.");
    assert.equal(captured.codexHome, "/tmp/codex-home");
    assert.deepEqual(captured.args, [
      "exec",
      "review",
      "--uncommitted",
      "--ephemeral",
      "--skip-git-repo-check",
      "--ignore-rules",
      "--output-schema",
      "/tmp/schema.json",
      "--output-last-message",
      "/tmp/output.json"
    ]);
  } finally {
    process.env.PATH = originalPath;
  }
});
