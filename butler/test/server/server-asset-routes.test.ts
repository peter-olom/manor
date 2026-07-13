import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import express from "express";

import { FileReferenceStore } from "../../src/server/file-store.js";
import { ImageReferenceStore } from "../../src/server/image-store.js";
import { registerServerAssetRoutes } from "../../src/server/server-asset-routes.js";
import { shouldParseJsonRequest } from "../../src/server/upload-request.js";
import { ReferenceMutationQueue } from "../../src/server/reference-mutation-queue.js";

test("asset library lists references, downloads unsafe images, and deletes leaves", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "manor-asset-routes-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const referenceMutations = new ReferenceMutationQueue();
  const fileStore = new FileReferenceStore(path.join(root, "files"), "/api/files", referenceMutations);
  const imageStore = new ImageReferenceStore(path.join(root, "images"), "/api/images", referenceMutations);
  await Promise.all([fileStore.load(), imageStore.load()]);
  const source = await fileStore.createFromBuffer({
    name: "notes.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("notes")
  });
  const svg = await imageStore.createFromBuffer({
    name: "unsafe.svg",
    mimeType: "image/svg+xml",
    buffer: Buffer.from("<svg/>")
  });

  const app = express();
  app.use(express.json({ type: shouldParseJsonRequest }));
  registerServerAssetRoutes({
    app,
    artifactsDir: root,
    store: {} as never,
    imageStore,
    fileStore,
    referenceMutations,
    imageUploadBinaryParser: express.raw({ type: () => true, limit: "1mb" }),
    fileUploadBinaryParser: express.raw({ type: () => true, limit: "1mb" })
  });
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const port = (server.address() as AddressInfo).port;
  const origin = `http://127.0.0.1:${port}`;

  const libraryResponse = await fetch(`${origin}/api/references`);
  const library = await libraryResponse.json() as { items: Array<{ id: string; kind: string; downloadUrl: string }> };
  assert.equal(libraryResponse.status, 200);
  assert.deepEqual(new Set(library.items.map((item) => item.kind)), new Set(["file", "image"]));
  assert.equal(library.items.find((item) => item.id === svg.id)?.downloadUrl, `${svg.url}?download=1`);

  const jsonUploadResponse = await fetch(`${origin}/api/files/upload`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-manor-upload-name": "settings.json",
      "x-manor-upload-size": "13",
      "x-manor-upload-mime-type": "application/json"
    },
    body: '{"live":true}'
  });
  const jsonUpload = await jsonUploadResponse.json() as { file?: { name?: string; mimeType?: string } };
  assert.equal(jsonUploadResponse.status, 201);
  assert.equal(jsonUpload.file?.name, "settings.json");
  assert.equal(jsonUpload.file?.mimeType, "application/json");

  const unsafeResponse = await fetch(`${origin}${svg.url}`);
  assert.match(unsafeResponse.headers.get("content-disposition") ?? "", /^attachment;/);
  assert.equal(unsafeResponse.headers.get("x-content-type-options"), "nosniff");

  const deleteResponse = await fetch(`${origin}/api/references/${source.id}`, { method: "DELETE" });
  assert.equal(deleteResponse.status, 204);
  assert.equal(fileStore.get(source.id), null);
});
