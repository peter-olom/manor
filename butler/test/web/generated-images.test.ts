import test from "node:test";
import assert from "node:assert/strict";

import { groupGeneratedImagesByTimeline } from "../../src/web/utils.js";

test("generated images attach after the nearest earlier timeline item", () => {
  const placement = groupGeneratedImagesByTimeline(
    [
      { id: "user", at: 100 },
      { id: "imagegen-note", at: 200 },
      { id: "next-user", at: 500 }
    ],
    [
      { id: "mockup", createdAt: 300 },
      { id: "late-proof", createdAt: 700 }
    ]
  );

  assert.deepEqual(placement.before, []);
  assert.deepEqual(placement.byAnchorId["imagegen-note"]?.map((image) => image.id), ["mockup"]);
  assert.deepEqual(placement.byAnchorId["next-user"]?.map((image) => image.id), ["late-proof"]);
});

test("generated images before known history stay before the first row", () => {
  const placement = groupGeneratedImagesByTimeline([{ id: "first", at: 200 }], [{ id: "early", createdAt: 100 }]);

  assert.deepEqual(placement.before.map((image) => image.id), ["early"]);
  assert.deepEqual(placement.byAnchorId, {});
});

test("generated images from rehydrated history anchor to the imagegen note", () => {
  const placement = groupGeneratedImagesByTimeline(
    [
      { id: "item-1", at: 1_000_000, text: "User asked for a mockup." },
      { id: "item-2", at: 1_000_000, text: "Using $imagegen to create a high-fidelity visual direction first." },
      { id: "item-3", at: 1_000_000, text: "Continue the task and use the generated image as reference." }
    ],
    [{ id: "ig_0248006ee74e7ab10169fb3541fa088191a37c4e8559d0fe94", createdAt: 1_000 }]
  );

  assert.deepEqual(placement.before, []);
  assert.deepEqual(placement.byAnchorId["item-2"]?.map((image) => image.id), [
    "ig_0248006ee74e7ab10169fb3541fa088191a37c4e8559d0fe94"
  ]);
});

test("generated images prefer matching stable message prefixes when available", () => {
  const placement = groupGeneratedImagesByTimeline(
    [
      { id: "msg_0248006ee74e7ab10169fb35411bf88191a00b8af0302a2657", at: 10_000 },
      { id: "msg_different", at: 20_000 }
    ],
    [{ id: "ig_0248006ee74e7ab10169fb3541fa088191a37c4e8559d0fe94", createdAt: 30_000 }]
  );

  assert.deepEqual(placement.byAnchorId["msg_0248006ee74e7ab10169fb35411bf88191a00b8af0302a2657"]?.map((image) => image.id), [
    "ig_0248006ee74e7ab10169fb3541fa088191a37c4e8559d0fe94"
  ]);
});
