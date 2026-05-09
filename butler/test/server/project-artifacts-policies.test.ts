import test from "node:test";
import assert from "node:assert/strict";
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createProjectArtifactFromFile, readProjectArtifactContent } from "../../src/server/project-artifacts-policies.js";
import { ButlerStateStore } from "../../src/server/state-store.js";

test("project artifacts can be created from local HTML files", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "manor-project-artifact-"));
  try {
    const sourcePath = path.join(tempDir, "index.html");
    await writeFile(sourcePath, "<!doctype html><title>Courseware</title>", "utf8");

    const artifact = await createProjectArtifactFromFile({
      artifactsDir: path.join(tempDir, "artifacts"),
      projectId: "victor-js-foundations-courseware",
      projectLabel: "victor-js-foundations-courseware",
      kind: "download",
      title: "Courseware HTML",
      sourceFilePath: sourcePath
    });

    assert.equal(artifact.fileName, "index.html");
    assert.equal(artifact.contentType, "text/html");
    assert.equal(artifact.sizeBytes, Buffer.byteLength("<!doctype html><title>Courseware</title>"));
    assert.match(artifact.filePath, /projects/);

    const content = await readProjectArtifactContent(artifact);
    assert.equal(content.truncated, false);
    assert.equal(content.content, "<!doctype html><title>Courseware</title>");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("project artifacts are backfilled into the sqlite search index", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "manor-project-artifact-search-"));
  try {
    const sourcePath = path.join(tempDir, "ledger.pdf");
    await writeFile(sourcePath, "Acme ledger reconciliation export", "utf8");
    const artifact = await createProjectArtifactFromFile({
      artifactsDir: path.join(tempDir, "artifacts"),
      projectId: "alpha",
      projectLabel: "Alpha",
      kind: "report",
      title: "Quarterly Ledger Report",
      description: "Finance proof bundle for Acme",
      sourceFilePath: sourcePath,
      tags: ["finance", "proof"],
      metadata: { client: "Acme" }
    });
    const statePath = path.join(tempDir, "state.json");
    await writeFile(
      statePath,
      JSON.stringify(
        {
          windows: [],
          focusedWindowId: null,
          projectArtifactsByProjectId: {
            alpha: [artifact]
          }
        },
        null,
        2
      )
    );

    const firstStore = new ButlerStateStore(statePath);
    await firstStore.load();
    await access(path.join(tempDir, "butler-memory.sqlite"));
    assert.equal((await firstStore.searchProjectArtifacts({ projectId: "alpha", query: "ledger" }))[0]?.id, artifact.id);

    await writeFile(statePath, JSON.stringify({ windows: [], focusedWindowId: null }, null, 2));
    const secondStore = new ButlerStateStore(statePath);
    await secondStore.load();
    assert.equal((await secondStore.searchProjectArtifacts({ projectId: "alpha", query: "acme" }))[0]?.id, artifact.id);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("deleted artifact records clear search index and policy references", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "manor-project-artifact-delete-"));
  try {
    const sourcePath = path.join(tempDir, "invoice.txt");
    await writeFile(sourcePath, "Vendor invoice export", "utf8");
    const artifact = await createProjectArtifactFromFile({
      artifactsDir: path.join(tempDir, "artifacts"),
      projectId: "alpha",
      projectLabel: "Alpha",
      kind: "report",
      title: "Vendor Invoice",
      sourceFilePath: sourcePath
    });
    const statePath = path.join(tempDir, "state.json");
    await writeFile(
      statePath,
      JSON.stringify(
        {
          windows: [],
          focusedWindowId: null,
          projectArtifactsByProjectId: { alpha: [artifact] },
          projectPoliciesByProjectId: {
            alpha: [
              {
                id: "policy-alpha",
                projectId: "alpha",
                projectLabel: "Alpha",
                title: "Use vendor invoice",
                instruction: "Attach the stored vendor invoice.",
                artifacts: [artifact.id],
                triggers: ["invoice"],
                createdAt: 1,
                updatedAt: 1
              }
            ]
          }
        },
        null,
        2
      )
    );

    const store = new ButlerStateStore(statePath);
    await store.load();
    assert.equal((await store.searchProjectArtifacts({ projectId: "alpha", query: "invoice" })).length, 1);
    assert.equal(store.removeProjectArtifact("alpha", artifact.id)?.id, artifact.id);
    await store.flushSave();
    assert.equal((await store.searchProjectArtifacts({ projectId: "alpha", query: "invoice" })).length, 0);
    assert.equal(store.listProjectPolicies("alpha")[0]?.artifacts.length, 0);

    const reloadedStore = new ButlerStateStore(statePath);
    await reloadedStore.load();
    assert.equal(reloadedStore.listProjectArtifacts("alpha").length, 0);
    assert.equal((await reloadedStore.searchProjectArtifacts({ projectId: "alpha", query: "invoice" })).length, 0);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("missing artifact files are pruned from catalog and search", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "manor-project-artifact-prune-"));
  try {
    const sourcePath = path.join(tempDir, "receipt.txt");
    await writeFile(sourcePath, "Receipt proof export", "utf8");
    const artifact = await createProjectArtifactFromFile({
      artifactsDir: path.join(tempDir, "artifacts"),
      projectId: "alpha",
      projectLabel: "Alpha",
      kind: "report",
      title: "Receipt Proof",
      sourceFilePath: sourcePath
    });
    const statePath = path.join(tempDir, "state.json");
    await writeFile(
      statePath,
      JSON.stringify({ windows: [], focusedWindowId: null, projectArtifactsByProjectId: { alpha: [artifact] } }, null, 2)
    );

    const store = new ButlerStateStore(statePath);
    await store.load();
    await rm(artifact.filePath, { force: true });
    assert.equal(await store.pruneMissingProjectArtifacts("alpha"), 1);
    await store.flushSave();
    assert.equal(store.listProjectArtifacts("alpha").length, 0);
    assert.equal((await store.searchProjectArtifacts({ projectId: "alpha", query: "receipt" })).length, 0);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
