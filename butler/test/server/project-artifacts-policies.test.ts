import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createProjectArtifactFromFile, readProjectArtifactContent } from "../../src/server/project-artifacts-policies.js";

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
