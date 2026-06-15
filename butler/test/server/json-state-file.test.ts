import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { readJsonStateFile, writeJsonStateFileAtomic } from "../../src/server/json-state-file.js";

test("state files are written as valid JSON", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "manor-json-state-"));
  const filePath = path.join(dir, "state.json");

  await writeJsonStateFileAtomic(filePath, [{ id: "one" }]);

  assert.deepEqual(JSON.parse(await readFile(filePath, "utf8")), [{ id: "one" }]);
});

test("concurrent state writes leave a parseable file", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "manor-json-state-"));
  const filePath = path.join(dir, "state.json");

  await Promise.all(
    Array.from({ length: 30 }, (_, index) =>
      writeJsonStateFileAtomic(filePath, [{ index, text: "x".repeat(1024) }])
    )
  );

  const parsed = JSON.parse(await readFile(filePath, "utf8"));
  assert.equal(Array.isArray(parsed), true);
  assert.equal(typeof parsed[0]?.index, "number");
});

test("corrupt state files are quarantined instead of thrown", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "manor-json-state-"));
  const filePath = path.join(dir, "state.json");
  await writeFile(filePath, "[{\"id\":\"one\"}]\n{\"id\":\"stale-tail\"}", "utf8");

  const parsed = await readJsonStateFile(filePath, []);
  const entries = await readdir(dir);

  assert.deepEqual(parsed, []);
  assert.equal(entries.some((entry) => entry.startsWith("state.json.corrupt-")), true);
});
