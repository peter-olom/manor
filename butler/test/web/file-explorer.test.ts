import assert from "node:assert/strict";
import test from "node:test";

import {
  canPreviewStoredImage,
  filterStoredReferences,
  formatReferenceSize,
  reduceStoredFileDrag,
  shouldLoadImageThumbnail
} from "../../src/web/FileExplorer.js";
import type { StoredReference } from "../../src/web/api.js";

const items: StoredReference[] = [
  {
    id: "image-1",
    kind: "image",
    name: "Dashboard.png",
    mimeType: "image/png",
    sizeBytes: 2048,
    createdAt: 2,
    url: "/api/images/image-1",
    downloadUrl: "/api/images/image-1?download=1",
    version: 1,
    hasChildren: false
  },
  {
    id: "file-1",
    kind: "file",
    name: "Quarterly report.pdf",
    mimeType: "application/pdf",
    sizeBytes: 5 * 1024 * 1024,
    createdAt: 1,
    url: "/api/files/file-1",
    downloadUrl: "/api/files/file-1",
    version: 1,
    hasChildren: true
  },
  {
    id: "file-image-1",
    kind: "file",
    name: "Artwork.svg",
    mimeType: "image/svg+xml",
    sizeBytes: 1024,
    createdAt: 3,
    url: "/api/files/file-image-1",
    downloadUrl: "/api/files/file-image-1",
    version: 1,
    hasChildren: false
  }
];

test("file explorer filters by kind, name, and MIME type", () => {
  assert.deepEqual(filterStoredReferences(items, "image", ""), [items[0], items[2]]);
  assert.deepEqual(filterStoredReferences(items, "file", "PDF"), [items[1]]);
  assert.deepEqual(filterStoredReferences(items, "all", "dashboard"), [items[0]]);
  assert.deepEqual(filterStoredReferences(items, "all", "missing"), []);
});

test("file explorer formats compact byte sizes", () => {
  assert.equal(formatReferenceSize(10), "10 B");
  assert.equal(formatReferenceSize(2048), "2.0 KB");
  assert.equal(formatReferenceSize(5 * 1024 * 1024), "5.0 MB");
});

test("file explorer avoids automatically loading oversized image originals", () => {
  assert.equal(shouldLoadImageThumbnail(items[0]!), true);
  assert.equal(shouldLoadImageThumbnail({ ...items[0]!, sizeBytes: 3 * 1024 * 1024 + 1 }), false);
  assert.equal(shouldLoadImageThumbnail(items[2]!), false);
  const storedSvg = { ...items[2]!, kind: "image" as const };
  assert.equal(canPreviewStoredImage(storedSvg), false);
  assert.equal(shouldLoadImageThumbnail(storedSvg), false);
});

test("file explorer accepts full-surface file drops", () => {
  const file = new File(["data"], "report.pdf", { type: "application/pdf" });
  const entered = reduceStoredFileDrag({ phase: "enter", depth: 0, hasFileType: true, files: [], canUpload: true });
  assert.deepEqual(entered, { depth: 1, active: true, preventDefault: true, filesToUpload: [] });
  const dropped = reduceStoredFileDrag({ phase: "drop", depth: entered.depth, hasFileType: true, files: [file], canUpload: true });
  assert.deepEqual(dropped, { depth: 0, active: false, preventDefault: true, filesToUpload: [file] });
});

test("file explorer refuses drops while an upload is active", () => {
  const file = new File(["data"], "report.pdf", { type: "application/pdf" });
  const dropped = reduceStoredFileDrag({ phase: "drop", depth: 1, hasFileType: true, files: [file], canUpload: false });
  assert.deepEqual(dropped, { depth: 0, active: false, preventDefault: true, filesToUpload: [] });
});
