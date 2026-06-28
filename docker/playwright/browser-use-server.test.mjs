import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const source = await readFile(new URL("./browser-use-server.mjs", import.meta.url), "utf8");

test("browser action failures are serialized instead of thrown", () => {
  const runActionBlock = source.slice(source.indexOf("async function runAction"), source.indexOf("async function stopSession"));
  assert.match(runActionBlock, /ok: false/);
  assert.match(runActionBlock, /status: "failed"/);
  assert.doesNotMatch(runActionBlock, /throw error;\s*\n\s*}\s*\n}/);
});

test("browser sidecar exits on process-level faults so Docker can restart it", () => {
  assert.match(source, /process\.on\("uncaughtException"/);
  assert.match(source, /process\.on\("unhandledRejection"/);
  assert.match(source, /processErrors: processErrorCount/);
  assert.match(source, /process\.exit\(1\)/);
});
