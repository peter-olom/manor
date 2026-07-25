import assert from "node:assert/strict";
import test from "node:test";

import {
  buildProofArtifactPreview,
  buildProjectArtifactPreview,
  isProjectArtifactDownloadUrl,
  parseProofArtifactPreviewTarget,
  parseProjectArtifactPreviewTarget
} from "../../src/web/project-artifact-preview.js";

const openUrl = "/api/project-artifacts/workspace%3Ashared/artifact-1/file";

test("only same-origin project artifact open links become preview targets", () => {
  assert.deepEqual(parseProjectArtifactPreviewTarget(openUrl), {
    projectId: "workspace:shared",
    artifactId: "artifact-1",
    openUrl,
    previewUrl: `${openUrl}?preview=1`,
    downloadUrl: `${openUrl}?download=1`,
    detailUrl: "/api/project-artifacts/workspace%3Ashared/artifact-1"
  });
  assert.equal(parseProjectArtifactPreviewTarget(`${openUrl}?download=1`), null);
  assert.equal(parseProjectArtifactPreviewTarget("https://example.com/api/project-artifacts/workspace%3Ashared/artifact-1/file"), null);
  assert.equal(parseProjectArtifactPreviewTarget("/api/project-artifacts/workspace%2Fshared/artifact-1/file"), null);
});

test("project artifact downloads are recognized separately from previews", () => {
  assert.equal(isProjectArtifactDownloadUrl(`${openUrl}?download=1`), true);
  assert.equal(isProjectArtifactDownloadUrl(`${openUrl}?download=1&other=1`), false);
  assert.equal(isProjectArtifactDownloadUrl(openUrl), false);
});

test("only previewable project artifact attachments open in the file previewer", () => {
  assert.deepEqual(buildProjectArtifactPreview({
    id: "artifact-1",
    name: "SPEC.md",
    mimeType: "text/markdown",
    url: openUrl
  }), {
    id: "artifact-1",
    name: "SPEC.md",
    mimeType: "text/markdown",
    previewKind: "markdown",
    previewUrl: `${openUrl}?preview=1`,
    downloadUrl: `${openUrl}?download=1`
  });
  assert.equal(buildProjectArtifactPreview({
    id: "artifact-2",
    name: "brief.docx",
    mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    url: openUrl
  }), null);
});

test("same-origin proof artifacts become bounded in-app preview targets", () => {
  const proofUrl = "/api/artifacts/files/thread-1/file-proof/report.md";
  assert.deepEqual(parseProofArtifactPreviewTarget(proofUrl), {
    openUrl: proofUrl,
    previewUrl: `${proofUrl}?preview=1`,
    downloadUrl: `${proofUrl}?download=1`
  });
  assert.equal(parseProofArtifactPreviewTarget(`${proofUrl}?download=1`), null);
  assert.equal(parseProofArtifactPreviewTarget("https://example.com/api/artifacts/files/thread-1/file-proof/report.md"), null);
  assert.equal(parseProofArtifactPreviewTarget("/api/project-artifacts/project-1/artifact-1/file"), null);
  assert.equal(parseProofArtifactPreviewTarget("/api/artifacts/files/thread-1/%2Fetc/report.md"), null);

  assert.deepEqual(buildProofArtifactPreview({
    id: "file-proof",
    name: "report.md",
    mimeType: "text/markdown",
    url: proofUrl
  }), {
    id: "file-proof",
    name: "report.md",
    mimeType: "text/markdown",
    previewKind: "markdown",
    previewUrl: `${proofUrl}?preview=1`,
    downloadUrl: `${proofUrl}?download=1`
  });
});
