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
