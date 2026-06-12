import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const controllerPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "controller.mjs");

test("source restart clears local worktree changes before updating", async () => {
  const source = await readFile(controllerPath, "utf8");
  const executeRunBody = source.slice(
    source.indexOf("async function executeRun"),
    source.indexOf("function createRun")
  );
  const clearIndex = executeRunBody.indexOf("await clearGitWorktree(run)");
  const updateIndex = executeRunBody.indexOf("await updateSource(run)");

  assert.ok(clearIndex >= 0);
  assert.ok(updateIndex >= 0);
  assert.ok(clearIndex < updateIndex);
  assert.match(source, /"git", \["reset", "--hard"\]/);
  assert.match(source, /"git", \["clean", "-fd"\]/);
  assert.doesNotMatch(source, /Source update refused because the Manor checkout has uncommitted changes/);
});

test("source restart checks local target refs before fetching", async () => {
  const source = await readFile(controllerPath, "utf8");
  const updateSourceBody = source.slice(
    source.indexOf("async function updateSource"),
    source.indexOf("async function updateImage")
  );
  const localCheckIndex = updateSourceBody.indexOf("await localGitRefExists(run.gitRef)");
  const localCheckoutIndex = updateSourceBody.indexOf("\"Checkout local target ref\"");
  const fetchIndex = updateSourceBody.indexOf("\"Fetch source refs\"");

  assert.ok(localCheckIndex >= 0);
  assert.ok(localCheckoutIndex > localCheckIndex);
  assert.ok(fetchIndex > localCheckoutIndex);
  assert.match(source, /"git", \["rev-parse", "--verify", "--quiet", `\$\{gitRef\}\^\{commit\}`\]/);
});
