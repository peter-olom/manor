import assert from "node:assert/strict";
import test from "node:test";

import { handleHarnessVisionAction } from "../../src/server/codex-harness-vision.js";
import { syncVisionToolForSession } from "../../src/server/butler-agent-vision-tools.js";
import { VisionInspectionService } from "../../src/server/vision-inspection.js";
import { prepareWorkerInputForModel } from "../../src/server/worker-client-router.js";
import type { ModelOption } from "../../src/server/types.js";

function model(image: ModelOption["inputCapabilities"]["image"]): ModelOption {
  return {
    id: "test-model",
    label: "Test model",
    provider: "test-provider",
    inputCapabilities: { image, source: image === "unknown" ? "unknown" : "manifest" },
    supportsReasoning: false,
    supportedThinkingLevels: [],
    supportedReasoningEfforts: [],
    defaultReasoningEffort: null
  };
}

const imageInput = [
  { type: "text" as const, text: "Stored reference images:\n- image-1 | screenshot.png" },
  { type: "localImage" as const, path: "/tmp/screenshot.png", mimeType: "image/png" }
];

test("vision-capable Workers keep direct image input", () => {
  assert.equal(prepareWorkerInputForModel(imageInput, model("supported")), imageInput);
});

test("text-only and unknown Workers receive references plus vision tool guidance", () => {
  for (const capability of ["unsupported", "unknown"] as const) {
    const prepared = prepareWorkerInputForModel(imageInput, model(capability));
    assert.equal(prepared.some((item) => item.type === "localImage"), false);
    assert.match(prepared.filter((item) => item.type === "text").map((item) => item.text).join("\n"), /vision inspect/);
  }
});

test("Butler activates inspect_images only for models without confirmed image input", () => {
  for (const input of [["text"], ["text", "image"]] as const) {
    let active = ["existing"];
    syncVisionToolForSession({
      model: { id: "test", name: "Test", provider: "test", input } as never,
      getActiveToolNames: () => active,
      setActiveToolsByName: (names) => { active = names; }
    });
    assert.equal(active.includes("inspect_images"), !input.includes("image"));
  }
});

test("vision inspection enforces image count and size limits before model execution", async () => {
  const service = new VisionInspectionService({
    piAuthPath: "/tmp/unused",
    imageStore: {
      resolveViews: (ids: string[]) => ids.map((id) => ({ id, name: `${id}.png`, mimeType: "image/png", sizeBytes: 1, createdAt: 1, url: `/images/${id}` }))
    } as never
  });
  await assert.rejects(service.inspect({ imageReferenceIds: ["1", "2", "3", "4", "5"], question: "Inspect" }), /at most 4 images/);
  const oversized = new VisionInspectionService({
    piAuthPath: "/tmp/unused",
    imageStore: { resolveViews: () => [{ id: "1", name: "large.png", mimeType: "image/png", sizeBytes: 3 * 1024 * 1024 + 1, createdAt: 1, url: "/images/1" }] } as never
  });
  await assert.rejects(oversized.inspect({ imageReferenceIds: ["1"], question: "Inspect" }), /3 MiB/);
});

test("Worker vision inspection rejects image ids outside the job payload", async () => {
  await assert.rejects(handleHarnessVisionAction({
    action: "vision.inspect",
    params: { imageReferenceIds: ["image-other"], question: "What is visible?" },
    threadId: "thread-1",
    allowedImageReferenceIds: ["image-1"],
    store: { addEvent() {} } as never,
    visionInspection: { inspect: async () => { throw new Error("should not run"); } } as never
  }), /registered to this job/);
});

test("Worker vision inspection returns structured companion evidence", async () => {
  const result = await handleHarnessVisionAction({
    action: "vision.inspect",
    params: { imageReferenceIds: ["image-1"], question: "What is visible?" },
    threadId: "thread-1",
    allowedImageReferenceIds: ["image-1"],
    store: { addEvent() {} } as never,
    visionInspection: {
      inspect: async () => ({
        summary: "A failed sign-in form.",
        visibleText: ["Invalid password"],
        observations: ["The password field is highlighted."],
        spatialRelationships: [],
        uncertainties: [],
        images: [{ id: "image-1", name: "screenshot.png" }],
        model: { provider: "ollama-cloud", id: "gemma4" },
        analyzedAt: 1
      })
    } as never
  });
  assert.match(result?.text ?? "", /Invalid password/);
  assert.equal((result?.data.inspection as { model: { id: string } }).model.id, "gemma4");
});
