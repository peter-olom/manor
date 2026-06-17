import assert from "node:assert/strict";
import test from "node:test";

import {
  readButlerComposerAttachments,
  readThreadComposerAttachments,
  updateButlerComposerAttachments,
  updateThreadComposerAttachments
} from "../../src/web/composer-attachment-cache";
import type { FileReference } from "../../src/web/types";

function attachment(id: string): FileReference {
  return {
    id,
    name: `${id}.png`,
    mimeType: "image/png",
    sizeBytes: 100,
    createdAt: 1234,
    url: `/api/images/${id}`
  };
}

test("Butler composer attachments persist outside the mounted surface", () => {
  updateButlerComposerAttachments([]);
  updateButlerComposerAttachments((current) => [...current, attachment("butler-1")]);

  assert.deepEqual(readButlerComposerAttachments().map((entry) => entry.id), ["butler-1"]);

  updateButlerComposerAttachments([]);
  assert.deepEqual(readButlerComposerAttachments(), []);
});

test("thread composer attachments are isolated by thread", () => {
  updateThreadComposerAttachments("thread-1", []);
  updateThreadComposerAttachments("thread-2", []);
  updateThreadComposerAttachments("thread-1", [attachment("thread-1-image")]);
  updateThreadComposerAttachments("thread-2", [attachment("thread-2-image")]);

  assert.deepEqual(readThreadComposerAttachments("thread-1").map((entry) => entry.id), ["thread-1-image"]);
  assert.deepEqual(readThreadComposerAttachments("thread-2").map((entry) => entry.id), ["thread-2-image"]);

  updateThreadComposerAttachments("thread-1", []);
  updateThreadComposerAttachments("thread-2", []);
});
