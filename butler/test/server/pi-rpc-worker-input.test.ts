import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, truncate, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { resolvePiWorkerInput } from "../../src/server/pi-rpc-worker-client.js";
import { buildWorkerInputWithReferences } from "../../src/server/reference-inputs.js";

test("Pi Worker sends local images as image content and preserves structured context", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "manor-pi-worker-input-"));
  try {
    const imagePath = path.join(tempDir, "reference.png");
    const imageBytes = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
    await writeFile(imagePath, imageBytes);

    const result = await resolvePiWorkerInput([
      { type: "text", text: "Review this reference." },
      { type: "localImage", path: imagePath },
      { type: "skill", name: "review", path: "/skills/review" },
      { type: "mention", name: "Figma", path: "app://figma" }
    ]);

    assert.match(result.text, /Review this reference/);
    assert.match(result.text, /Selected skill: review/);
    assert.match(result.text, /Selected app: Figma/);
    assert.deepEqual(result.images, [
      { type: "image", data: imageBytes.toString("base64"), mimeType: "image/png" }
    ]);
    assert.doesNotMatch(result.text, /Attached localImage/);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("Pi Worker accepts every image MIME type supported by Pi", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "manor-pi-worker-mime-"));
  try {
    const imagePath = path.join(tempDir, "reference");
    const imageBytes = Buffer.from([1, 2, 3, 4]);
    await writeFile(imagePath, imageBytes);

    for (const mimeType of ["image/jpeg", "image/png", "image/gif", "image/webp"]) {
      const result = await resolvePiWorkerInput([
        { type: "localImage", path: imagePath, mimeType }
      ]);
      assert.deepEqual(result.images, [
        { type: "image", data: imageBytes.toString("base64"), mimeType }
      ]);
    }
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("Pi Worker rejects image MIME types that Pi cannot send", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "manor-pi-worker-unsupported-mime-"));
  try {
    const imagePath = path.join(tempDir, "reference");
    await writeFile(imagePath, Buffer.from([1, 2, 3, 4]));

    for (const mimeType of ["image/tiff", "image/svg+xml", "image/avif"]) {
      await assert.rejects(
        resolvePiWorkerInput([{ type: "localImage", path: imagePath, mimeType }]),
        new RegExp(`Unsupported Pi image MIME type .*${mimeType.replace(/[+]/g, "\\+")}`)
      );
    }
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("Pi Worker rejects oversized images before reading their contents", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "manor-pi-worker-oversize-"));
  try {
    const imagePath = path.join(tempDir, "large.png");
    await writeFile(imagePath, Buffer.alloc(0));
    await truncate(imagePath, 3 * 1024 * 1024 + 1);

    await assert.rejects(
      resolvePiWorkerInput([{ type: "localImage", path: imagePath }]),
      /Pi image attachment exceeds the 3 MiB limit: .* is 3145729 bytes/
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("stored image references carry their MIME type into Worker input", () => {
  const input = buildWorkerInputWithReferences({
    text: "Review the image.",
    imageStore: {
      resolveViews: () => [{ id: "image-1", name: "scan", mimeType: "image/tiff" }],
      getFilePath: () => "/artifacts/image-1"
    } as never,
    imageReferenceIds: ["image-1"],
    fileStore: { resolveViews: () => [] } as never,
    fileReferenceIds: []
  });

  assert.deepEqual(input.find((item) => item.type === "localImage"), {
    type: "localImage",
    path: "/artifacts/image-1",
    mimeType: "image/tiff"
  });
});
