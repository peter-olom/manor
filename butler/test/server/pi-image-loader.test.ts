import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, truncate } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { ImageReferenceStore } from "../../src/server/image-store.js";

test("Butler loads every image MIME type supported by Pi", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "manor-butler-pi-images-"));
  try {
    const store = new ImageReferenceStore(tempDir);
    await store.load();
    const ids: string[] = [];
    for (const mimeType of ["image/jpeg", "image/png", "image/gif", "image/webp"]) {
      const reference = await store.createFromBuffer({
        name: "reference",
        mimeType,
        buffer: Buffer.from([1, 2, 3, 4])
      });
      ids.push(reference.id);
    }

    const images = await store.loadPiImages(ids);
    assert.deepEqual(images.map((image) => image.mimeType), [
      "image/jpeg",
      "image/png",
      "image/gif",
      "image/webp"
    ]);
    assert.ok(images.every((image) => image.data === Buffer.from([1, 2, 3, 4]).toString("base64")));
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("Butler rejects image MIME types that Pi cannot send", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "manor-butler-pi-unsupported-"));
  try {
    const store = new ImageReferenceStore(tempDir);
    await store.load();
    for (const mimeType of ["image/tiff", "image/svg+xml", "image/avif"]) {
      const reference = await store.createFromBuffer({
        name: "reference",
        mimeType,
        buffer: Buffer.from([1, 2, 3, 4])
      });
      await assert.rejects(
        store.loadPiImages([reference.id]),
        new RegExp(`Unsupported Pi image MIME type .*${mimeType.replace(/[+]/g, "\\+")}`)
      );
    }
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("Butler rejects one oversized Pi image before reading it", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "manor-butler-pi-oversize-"));
  try {
    const store = new ImageReferenceStore(tempDir);
    await store.load();
    const reference = await store.createFromBuffer({
      name: "large.png",
      mimeType: "image/png",
      buffer: Buffer.from([1])
    });
    await chmod(store.getFilePath(reference.id)!, 0o644);
    await truncate(store.getFilePath(reference.id)!, 3 * 1024 * 1024 + 1);

    await assert.rejects(
      store.loadPiImages([reference.id]),
      /Pi image attachment exceeds the 3 MiB limit: .* is 3145729 bytes/
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("Butler rejects aggregate Pi image payloads before reading them", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "manor-butler-pi-aggregate-"));
  try {
    const store = new ImageReferenceStore(tempDir);
    await store.load();
    const ids: string[] = [];
    for (let index = 0; index < 5; index += 1) {
      const reference = await store.createFromBuffer({
        name: `large-${index}.png`,
        mimeType: "image/png",
        buffer: Buffer.from([1])
      });
      await chmod(store.getFilePath(reference.id)!, 0o644);
      await truncate(store.getFilePath(reference.id)!, 3 * 1024 * 1024);
      ids.push(reference.id);
    }

    await assert.rejects(
      store.loadPiImages(ids),
      /Pi image attachments exceed the 12 MiB aggregate limit: 15728640 bytes across 5 images/
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
