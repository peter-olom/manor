import assert from "node:assert/strict";
import test from "node:test";

import {
  deleteStoredReference,
  listStoredReferences,
  uploadAttachment,
  type FileReference,
  type StoredReference
} from "../../src/web/api.js";

const uploaded: FileReference = {
  id: "reference-1",
  name: "reference",
  mimeType: "application/octet-stream",
  sizeBytes: 4,
  createdAt: 1,
  url: "/api/files/reference-1"
};

test("uploadAttachment routes general files and inferred images correctly", async () => {
  const originalFetch = globalThis.fetch;
  const requests: Array<{ url: string; headers: Headers }> = [];
  globalThis.fetch = async (input, init) => {
    requests.push({ url: String(input), headers: new Headers(init?.headers) });
    const isImage = String(input).includes("/images/");
    return new Response(JSON.stringify(isImage ? { ok: true, image: uploaded } : { ok: true, file: uploaded }), {
      status: 201,
      headers: { "Content-Type": "application/json" }
    });
  };

  try {
    await uploadAttachment(new File(["pdf"], "report.pdf", { type: "application/pdf" }));
    await uploadAttachment(new File(["png"], "diagram.png"));
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(requests[0]?.url, "/api/files/upload");
  assert.equal(requests[0]?.headers.get("content-type"), "application/pdf");
  assert.equal(requests[1]?.url, "/api/images/upload");
  assert.equal(requests[1]?.headers.get("content-type"), "image/png");
});

test("stored reference API lists and deletes durable files", async () => {
  const originalFetch = globalThis.fetch;
  const item: StoredReference = { ...uploaded, kind: "file", downloadUrl: uploaded.url, version: 1, hasChildren: false };
  const requests: Array<{ url: string; method: string }> = [];
  globalThis.fetch = async (input, init) => {
    requests.push({ url: String(input), method: init?.method ?? "GET" });
    if (init?.method === "DELETE") return new Response(null, { status: 204 });
    return Response.json({ items: [item] });
  };

  try {
    assert.deepEqual(await listStoredReferences(), [item]);
    await deleteStoredReference(item.id);
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.deepEqual(requests, [
    { url: "/api/references", method: "GET" },
    { url: "/api/references/reference-1", method: "DELETE" }
  ]);
});
