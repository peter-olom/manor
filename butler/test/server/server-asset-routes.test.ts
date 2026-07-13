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
  const pdf = await fileStore.createFromBuffer({
    name: "report.pdf",
    mimeType: "application/pdf",
    buffer: Buffer.from("%PDF-1.4\n%%EOF")
  });
  const inferredPdf = await fileStore.createFromBuffer({
    name: "inferred.pdf",
    mimeType: "application/octet-stream",
    buffer: Buffer.from("%PDF-1.4\n%%EOF")
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
  const library = await libraryResponse.json() as { items: Array<{ id: string; kind: string; downloadUrl: string; previewUrl?: string; previewKind?: string }> };
  assert.equal(libraryResponse.status, 200);
  assert.deepEqual(new Set(library.items.map((item) => item.kind)), new Set(["file", "image"]));
  assert.equal(library.items.find((item) => item.id === svg.id)?.downloadUrl, `${svg.url}?download=1`);
  assert.equal(library.items.find((item) => item.id === source.id)?.previewUrl, `${source.url}?preview=1`);
  assert.equal(library.items.find((item) => item.id === source.id)?.previewKind, "text");
  assert.equal(library.items.find((item) => item.id === pdf.id)?.previewUrl, `${pdf.url}?preview=1`);
  assert.equal(library.items.find((item) => item.id === pdf.id)?.previewKind, "pdf");

  const pdfPreviewResponse = await fetch(`${origin}${pdf.url}?preview=1`);
  assert.equal(pdfPreviewResponse.status, 200);
  assert.equal(pdfPreviewResponse.headers.get("content-type"), "application/pdf");
  assert.equal(pdfPreviewResponse.headers.get("content-disposition"), "inline");
  assert.equal(pdfPreviewResponse.headers.get("content-security-policy"), "sandbox; default-src 'none'");
  assert.equal(await pdfPreviewResponse.text(), "%PDF-1.4\n%%EOF");

  const previewResponse = await fetch(`${origin}${source.url}?preview=1`);
  assert.equal(previewResponse.status, 200);
  assert.equal(previewResponse.headers.get("x-content-type-options"), "nosniff");
  assert.equal(previewResponse.headers.get("content-security-policy"), "default-src 'none'");
  assert.deepEqual(await previewResponse.json(), { text: "notes", truncated: false });

  await fs.rm(fileStore.getFilePath(source.id)!);
  const originalConsoleError = console.error;
  console.error = () => undefined;
  let missingPreviewResponse: Response;
  try {
    missingPreviewResponse = await fetch(`${origin}${source.url}?preview=1`);
  } finally {
    console.error = originalConsoleError;
  }
  assert.equal(missingPreviewResponse.status, 500);
  assert.deepEqual(await missingPreviewResponse.json(), { error: "The file preview could not be read" });

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

  const annotatedUploadResponse = await fetch(`${origin}/api/files/upload`, {
    method: "POST",
    headers: {
      "content-type": "application/pdf",
      "x-manor-upload-name": "report-annotated.pdf",
      "x-manor-upload-size": "18",
      "x-manor-upload-mime-type": "application/pdf",
      "x-manor-source-reference-id": pdf.id
    },
    body: "%PDF-1.4 annotated"
  });
  const annotatedUpload = await annotatedUploadResponse.json() as { file?: { sourceReferenceId?: string; version?: number } };
  assert.equal(annotatedUploadResponse.status, 201);
  assert.equal(annotatedUpload.file?.sourceReferenceId, pdf.id);
  assert.equal(annotatedUpload.file?.version, 2);

  const inferredAnnotatedResponse = await fetch(`${origin}/api/files/upload`, {
    method: "POST",
    headers: {
      "content-type": "application/pdf; charset=binary",
      "x-manor-upload-name": "inferred-annotated.pdf",
      "x-manor-upload-size": "18",
      "x-manor-upload-mime-type": "application/pdf; charset=binary",
      "x-manor-source-reference-id": inferredPdf.id
    },
    body: "%PDF-1.4 annotated"
  });
  assert.equal(inferredAnnotatedResponse.status, 201);

  const unsafeResponse = await fetch(`${origin}${svg.url}`);
  assert.match(unsafeResponse.headers.get("content-disposition") ?? "", /^attachment;/);
  assert.equal(unsafeResponse.headers.get("x-content-type-options"), "nosniff");

  const deleteResponse = await fetch(`${origin}/api/references/${source.id}`, { method: "DELETE" });
  assert.equal(deleteResponse.status, 204);
  assert.equal(fileStore.get(source.id), null);
});
