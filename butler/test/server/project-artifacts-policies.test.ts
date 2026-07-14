import test from "node:test";
import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable, Writable } from "node:stream";

import {
  createProjectArtifactFromFile,
  createProjectArtifactFromUrl,
  isPublicProjectArtifactAddress,
  pipeProjectArtifactStreamWithinLimit,
  readProjectArtifactContent,
  resolveApprovedProjectFilePath,
  sanitizeProjectArtifactProvenanceUrl
} from "../../src/server/project-artifacts-policies.js";
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

test("project artifacts infer video content types from file names", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "manor-project-video-"));
  try {
    const sourcePath = path.join(tempDir, "interaction.webm");
    await writeFile(sourcePath, Buffer.from("video"));
    const artifact = await createProjectArtifactFromFile({
      artifactsDir: path.join(tempDir, "artifacts"),
      projectId: "alpha",
      projectLabel: "Alpha",
      kind: "download",
      title: "Interaction recording",
      sourceFilePath: sourcePath
    });
    assert.equal(artifact.contentType, "video/webm");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("shared project files stay within approved real roots", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "manor-project-artifact-root-"));
  try {
    const approved = path.join(tempDir, "approved");
    const outside = path.join(tempDir, "outside");
    await mkdir(approved);
    await mkdir(outside);
    const allowedFile = path.join(approved, "allowed.txt");
    const outsideFile = path.join(outside, "private.txt");
    await writeFile(allowedFile, "allowed", "utf8");
    await writeFile(outsideFile, "private", "utf8");
    await symlink(outsideFile, path.join(approved, "file-link.txt"));
    await symlink(outside, path.join(approved, "directory-link"));

    assert.equal(await resolveApprovedProjectFilePath(allowedFile, [approved]), await realpath(allowedFile));
    await assert.rejects(resolveApprovedProjectFilePath(outsideFile, [approved]), /outside approved roots/);
    await assert.rejects(resolveApprovedProjectFilePath(path.join(approved, "file-link.txt"), [approved]), /symbolic link/);
    await assert.rejects(resolveApprovedProjectFilePath(path.join(approved, "directory-link", "private.txt"), [approved]), /resolves outside approved root/);

    const artifact = await createProjectArtifactFromFile({
      artifactsDir: path.join(tempDir, "artifacts"),
      projectId: "alpha",
      projectLabel: "Alpha",
      kind: "download",
      title: "Allowed",
      sourceFilePath: allowedFile,
      approvedRoots: [approved]
    });
    assert.equal((await readProjectArtifactContent(artifact)).content, "allowed");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("project artifact downloads reject unsafe URL destinations before connecting", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "manor-project-artifact-url-"));
  const download = (url: string) => createProjectArtifactFromUrl({
    artifactsDir: tempDir,
    projectId: "alpha",
    projectLabel: "Alpha",
    kind: "download",
    title: "Remote artifact",
    url
  });
  try {
    await assert.rejects(download("file:///etc/passwd"), /HTTP or HTTPS/);
    await assert.rejects(download("http://user:password@8.8.8.8/file"), /cannot include credentials/);
    await assert.rejects(download("http://127.0.0.1/file"), /non-public network address/);
    await assert.rejects(download("http://169.254.169.254/latest/meta-data"), /non-public network address/);
    await assert.rejects(download("http://[::1]/file"), /non-public network address/);
    assert.equal(isPublicProjectArtifactAddress("8.8.8.8"), true);
    assert.equal(isPublicProjectArtifactAddress("2606:4700:4700::1111"), true);
    assert.equal(isPublicProjectArtifactAddress("10.0.0.1"), false);
    assert.equal(isPublicProjectArtifactAddress("fe80::1"), false);
    assert.equal(isPublicProjectArtifactAddress("::ffff:127.0.0.1"), false);
    assert.equal(isPublicProjectArtifactAddress("2002:7f00:1::"), false);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("project artifact URL provenance redacts signed query credentials", () => {
  const sanitized = sanitizeProjectArtifactProvenanceUrl(
    "https://storage.example/report.pdf?view=compact&sig=short-secret&Authorization=Bearer%20opaque-secret&X-Amz-Signature=aws-secret"
  );

  assert.equal(
    sanitized,
    "https://storage.example/report.pdf?view=compact&sig=[REDACTED]&Authorization=[REDACTED]&X-Amz-Signature=[REDACTED]"
  );
  assert.doesNotMatch(sanitized, /short-secret|opaque-secret|aws-secret/);
  assert.equal(sanitizeProjectArtifactProvenanceUrl(" https://storage.example/public.pdf?view=compact "), "https://storage.example/public.pdf?view=compact");
});

test("project artifact stream copy enforces the byte limit after an earlier size check", async () => {
  const written: Buffer[] = [];
  const destination = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      written.push(Buffer.from(chunk));
      callback();
    }
  });

  await assert.rejects(
    pipeProjectArtifactStreamWithinLimit({
      source: Readable.from([Buffer.from("small"), Buffer.from("-then-grew")]),
      destination,
      maxBytes: 10
    }),
    /Artifact exceeds 10 bytes/
  );
  assert.equal(Buffer.concat(written).toString("utf8"), "small");
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
