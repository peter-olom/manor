import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, chmod } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import {
  buildUncommittedCodexExecReviewCommand,
  runUncommittedCodexExecReview
} from "../../src/server/codex-review-command.js";

test("uncommitted codex review sends prompt through stdin instead of positional prompt", () => {
  const command = buildUncommittedCodexExecReviewCommand({
    schemaPath: "/tmp/schema.json",
    outputLastMessagePath: "/tmp/output.json",
    cwd: "/workspace",
    prompt: "Review this closeout."
  });

  assert.equal(command.command, "codex");
  assert.deepEqual(command.args, [
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
  assert.equal(command.stdin, "Review this closeout.");
  assert.equal(command.args.includes("Review this closeout."), false);
  assert.equal(command.args.includes("-"), false);
});

test("uncommitted codex review runner pipes prompt to codex", async () => {
  const binDir = await mkdtemp(path.join(tmpdir(), "manor-codex-review-bin-"));
  const capturePath = path.join(binDir, "capture.json");
  const fakeCodexPath = path.join(binDir, "codex");
  await writeFile(
    fakeCodexPath,
    [
      "#!/usr/bin/env node",
      'const fs = require("node:fs");',
      `const capturePath = ${JSON.stringify(capturePath)};`,
      "let stdin = '';",
      "process.stdin.setEncoding('utf8');",
      "process.stdin.on('data', chunk => { stdin += chunk; });",
      "process.stdin.on('end', () => {",
      "  fs.writeFileSync(capturePath, JSON.stringify({ args: process.argv.slice(2), stdin }));",
      "});"
    ].join("\n"),
    "utf8"
  );
  await chmod(fakeCodexPath, 0o755);
  const originalPath = process.env.PATH;
  process.env.PATH = `${binDir}${path.delimiter}${originalPath ?? ""}`;
  try {
    await runUncommittedCodexExecReview({
      schemaPath: "/tmp/schema.json",
      outputLastMessagePath: "/tmp/output.json",
      prompt: "Review the delegated closeout."
    });

    const { readFile } = await import("node:fs/promises");
    const captured = JSON.parse(await readFile(capturePath, "utf8"));
    assert.equal(captured.stdin, "Review the delegated closeout.");
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
