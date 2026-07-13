import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { InvalidTextPreviewError, MAX_TEXT_PREVIEW_BYTES, readTextPreview } from "../../src/server/text-preview.js";
import { resolveReferencePreviewKind } from "../../src/shared/references.js";

test("text preview classification prefers recognized extensions and accepts text MIME types", () => {
  assert.equal(resolveReferencePreviewKind("README.MD", "text/plain"), "markdown");
  assert.equal(resolveReferencePreviewKind("page.html", "text/markdown"), "html");
  assert.equal(resolveReferencePreviewKind("events.log", "application/octet-stream"), "text");
  assert.equal(resolveReferencePreviewKind("payload", "application/json; charset=utf-8"), "text");
  assert.equal(resolveReferencePreviewKind("event", "application/problem+json"), "text");
  assert.equal(resolveReferencePreviewKind("feed", "application/atom+xml"), "text");
  assert.equal(resolveReferencePreviewKind("query", "application/sql"), "text");
  assert.equal(resolveReferencePreviewKind("Dockerfile", "application/octet-stream"), "text");
  assert.equal(resolveReferencePreviewKind("schema.sql", "application/octet-stream"), "text");
  assert.equal(resolveReferencePreviewKind("report.PDF", "application/octet-stream"), "pdf");
  assert.equal(resolveReferencePreviewKind("report", "application/pdf"), "pdf");
  assert.equal(resolveReferencePreviewKind("archive.zip", "application/zip"), null);
});

test("text previews are bounded and reject binary or invalid UTF-8 content", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "manor-text-preview-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const largePath = path.join(root, "large.txt");
  const binaryPath = path.join(root, "binary.txt");
  const invalidPath = path.join(root, "invalid.txt");
  await fs.writeFile(largePath, Buffer.alloc(MAX_TEXT_PREVIEW_BYTES + 20, 97));
  await fs.writeFile(binaryPath, Buffer.from([65, 0, 66]));
  await fs.writeFile(invalidPath, Buffer.from([0xc3, 0x28]));

  const large = await readTextPreview(largePath);
  assert.equal(large.text.length, MAX_TEXT_PREVIEW_BYTES);
  assert.equal(large.truncated, true);
  const small = await readTextPreview(largePath, { maxBytes: 32 });
  assert.equal(small.text.length, 32);
  assert.equal(small.truncated, true);
  await assert.rejects(readTextPreview(binaryPath), InvalidTextPreviewError);
  await assert.rejects(readTextPreview(invalidPath), InvalidTextPreviewError);
});
