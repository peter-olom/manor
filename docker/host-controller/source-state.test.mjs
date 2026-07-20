import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { compareSourceState } from "./source-state.mjs";

const execFileAsync = promisify(execFile);
const scriptPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "source-provenance.sh");

async function provenance(directory, cleanHead = null) {
  const args = [scriptPath, directory];
  if (cleanHead) args.push(cleanHead);
  const { stdout } = await execFileAsync("bash", args);
  const [head, dirty, fingerprint] = stdout.trim().split("\t");
  return { head, dirty: dirty === "true", fingerprint };
}

test("source fingerprints include tracked and untracked pending changes", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "manor-source-state-"));
  await execFileAsync("git", ["init", "--quiet"], { cwd: directory });
  await execFileAsync("git", ["config", "user.email", "test@example.com"], { cwd: directory });
  await execFileAsync("git", ["config", "user.name", "Test"], { cwd: directory });
  await writeFile(path.join(directory, "tracked.txt"), "one\n");
  await execFileAsync("git", ["add", "tracked.txt"], { cwd: directory });
  await execFileAsync("git", ["commit", "--quiet", "-m", "initial"], { cwd: directory });

  const clean = await provenance(directory);
  assert.equal(clean.dirty, false);

  await writeFile(path.join(directory, "tracked.txt"), "two\n");
  const tracked = await provenance(directory);
  assert.equal(tracked.dirty, true);
  assert.notEqual(tracked.fingerprint, clean.fingerprint);

  await writeFile(path.join(directory, "new.txt"), "new\n");
  const untracked = await provenance(directory);
  assert.notEqual(untracked.fingerprint, tracked.fingerprint);

  const cleanHead = await provenance(directory, clean.head);
  assert.deepEqual(cleanHead, clean);
});

test("source comparison distinguishes live pending changes from clean HEAD fallback", () => {
  const checkout = { head: "abc", dirty: true, fingerprint: "dirty" };
  const service = { service: "butler", head: "abc", dirty: true, fingerprint: "dirty" };
  assert.equal(compareSourceState(checkout, [service]).relation, "matches_checkout");
  assert.match(compareSourceState(checkout, [service]).summary, /pending local changes/);

  const fallback = { service: "butler", head: "abc", dirty: false, fingerprint: "clean" };
  assert.equal(compareSourceState(checkout, [fallback]).relation, "clean_head_fallback");

  const mixed = { service: "worker", head: "abc", dirty: false, fingerprint: "other" };
  assert.equal(compareSourceState(checkout, [service, mixed]).relation, "inconsistent");
});
