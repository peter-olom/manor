import assert from "node:assert/strict";
import { mkdir, mkdtemp, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { purgeNonPiWorkerArtifacts } from "../../src/server/pi-only-cleanup.js";
import type { CodexThreadSummary } from "../../src/server/types.js";

async function exists(target: string): Promise<boolean> {
  return stat(target).then(() => true, () => false);
}

test("Pi-only cleanup removes retired Worker artifacts and orphaned review baselines", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "manor-pi-cleanup-"));
  const activeBaseline = path.join(root, "review-baselines", "baseline-active", "objects");
  const orphanBaseline = path.join(root, "review-baselines", "baseline-orphan", "objects");
  for (const scopedRoot of ["files", "job-payloads", "job-instructions"]) {
    await mkdir(path.join(root, scopedRoot, "legacy-thread"), { recursive: true });
    await mkdir(path.join(root, scopedRoot, "pi-current"), { recursive: true });
  }
  await mkdir(activeBaseline, { recursive: true });
  await mkdir(orphanBaseline, { recursive: true });

  await purgeNonPiWorkerArtifacts(root, [{ executionContract: { reviewBaselineObjectDir: activeBaseline } } as CodexThreadSummary]);

  for (const scopedRoot of ["files", "job-payloads", "job-instructions"]) {
    assert.equal(await exists(path.join(root, scopedRoot, "legacy-thread")), false);
    assert.equal(await exists(path.join(root, scopedRoot, "pi-current")), true);
  }
  assert.equal(await exists(path.dirname(activeBaseline)), true);
  assert.equal(await exists(path.dirname(orphanBaseline)), false);
});
