import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { FileReferenceStore } from "../../src/server/file-store.js";
import { ImageReferenceStore } from "../../src/server/image-store.js";
import {
  deleteReference,
  listReferenceLibrary,
  ReferenceHasChildrenError
} from "../../src/server/reference-library.js";
import { ReferenceMutationQueue } from "../../src/server/reference-mutation-queue.js";

test("reference library merges stores, preserves lineage, and safely deletes leaves", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "manor-reference-library-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const referenceMutations = new ReferenceMutationQueue();
  const fileStore = new FileReferenceStore(path.join(root, "files"), "/api/files", referenceMutations);
  const imageStore = new ImageReferenceStore(path.join(root, "images"), "/api/images", referenceMutations);
  await Promise.all([fileStore.load(), imageStore.load()]);

  const source = await fileStore.createFromBuffer({
    name: "source.pdf",
    mimeType: "application/pdf",
    buffer: Buffer.from("source")
  });
  const derived = await imageStore.createFromBuffer({
    name: "page.png",
    mimeType: "image/png",
    buffer: Buffer.from("derived"),
    sourceReferenceId: source.id,
    version: 2
  });

  const library = listReferenceLibrary(imageStore, fileStore);
  assert.equal(library.items.length, 2);
  assert.deepEqual(
    library.items.map(({ id, kind, version, hasChildren }) => ({ id, kind, version, hasChildren })),
    [
      { id: derived.id, kind: "image", version: 2, hasChildren: false },
      { id: source.id, kind: "file", version: 1, hasChildren: true }
    ]
  );
  await assert.rejects(
    deleteReference(source.id, imageStore, fileStore, referenceMutations),
    ReferenceHasChildrenError
  );
  assert.equal(await deleteReference(derived.id, imageStore, fileStore, referenceMutations), true);
  assert.equal(imageStore.get(derived.id), null);
  assert.equal(await deleteReference(source.id, imageStore, fileStore, referenceMutations), true);
  assert.equal(fileStore.get(source.id), null);

  const reloadedFiles = new FileReferenceStore(path.join(root, "files"));
  const reloadedImages = new ImageReferenceStore(path.join(root, "images"));
  await Promise.all([reloadedFiles.load(), reloadedImages.load()]);
  assert.equal(listReferenceLibrary(reloadedImages, reloadedFiles).items.length, 0);
});

test("image metadata persists and remains visible in the reference library", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "manor-image-metadata-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const imageStore = new ImageReferenceStore(path.join(root, "images"));
  const fileStore = new FileReferenceStore(path.join(root, "files"));
  await Promise.all([imageStore.load(), fileStore.load()]);
  const image = await imageStore.createFromBuffer({
    name: "proof.png",
    mimeType: "image/png",
    buffer: Buffer.from("image"),
    metadata: { projectId: "project-1", projectLabel: "Manor", sessionId: "session-1", sessionTitle: "Visual review", origin: "image-annotation" }
  });

  const reloadedImages = new ImageReferenceStore(path.join(root, "images"));
  await reloadedImages.load();
  assert.deepEqual(reloadedImages.get(image.id)?.metadata, image.metadata);
  assert.deepEqual(listReferenceLibrary(reloadedImages, fileStore).items[0]?.metadata, image.metadata);
});
