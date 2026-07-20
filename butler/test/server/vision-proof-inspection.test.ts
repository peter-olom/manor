import assert from "node:assert/strict";
import test from "node:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { handleHarnessVisionAction } from "../../src/server/codex-harness-vision.js";
import type { PreviewProofRecordView, PreviewVerificationArtifactView, PreviewVerificationView } from "../../src/server/types.js";

type FakeVisionCall =
  | { mode: "references"; referenceIds: string[]; question: string }
  | { mode: "images"; images: Array<{ id: string; name: string; mimeType: string; buffer: Buffer }>; question: string };

function fakeVisionInspection(record: FakeVisionCall) {
  return {
    inspect: async (input: { imageReferenceIds: string[]; question: string }) => {
      record.mode = "references";
      record.referenceIds = [...input.imageReferenceIds];
      record.question = input.question;
      return {
        summary: "ok",
        visibleText: [],
        observations: [],
        spatialRelationships: [],
        uncertainties: [],
        images: input.imageReferenceIds.map((id) => ({ id, name: `${id}.png` })),
        model: { provider: "test", id: "vision" },
        analyzedAt: 1
      };
    },
    inspectImages: async (input: { images: Array<{ id: string; name: string }>; question: string }) => {
      record.mode = "images";
      record.images = input.images.map((image) => ({ id: image.id, name: image.name, mimeType: (image as { mimeType?: string }).mimeType ?? "image/png", buffer: (image as { buffer?: Buffer }).buffer ?? Buffer.alloc(0) }));
      record.question = input.question;
      return {
        summary: "ok",
        visibleText: [],
        observations: [],
        spatialRelationships: [],
        uncertainties: [],
        images: input.images.map((image) => ({ id: image.id, name: image.name })),
        model: { provider: "test", id: "vision" },
        analyzedAt: 1
      };
    }
  } as never;
}

type FakeImageStore = {
  records: Map<string, { id: string; name: string; mimeType: string; sizeBytes: number; sourceReferenceId?: string; filePath?: string }>;
  get: (id: string) => { id: string; name: string; mimeType: string; sizeBytes: number; createdAt: number; url: string; sourceReferenceId?: string } | null;
  getFilePath: (id: string) => string | null;
};

function fakeImageStore(records: FakeImageStore["records"]): never {
  return {
    records,
    get: (id: string) => {
      const record = records.get(id);
      if (!record) return null;
      return { id: record.id, name: record.name, mimeType: record.mimeType, sizeBytes: record.sizeBytes, createdAt: 1, url: `/images/${id}`, ...(record.sourceReferenceId ? { sourceReferenceId: record.sourceReferenceId } : {}) };
    },
    getFilePath: (id: string) => records.get(id)?.filePath ?? null
  } as never;
}

function fakeFileStore(records: Map<string, { id: string; sourceReferenceId?: string }>): never {
  return {
    get: (id: string) => records.get(id) ? { id, name: `${id}.txt`, mimeType: "text/plain", sizeBytes: 0, createdAt: 1, url: `/files/${id}` } : null
  } as never;
}

function makeArtifact(overrides: Partial<PreviewVerificationArtifactView>): PreviewVerificationArtifactView {
  return {
    kind: "screenshot",
    label: "screenshot.png",
    fileName: "screenshot.png",
    filePath: "",
    contentType: "image/png",
    sizeBytes: 0,
    url: null,
    downloadUrl: null,
    availability: "available",
    retainedUntilAt: null,
    expiredAt: null,
    ...overrides
  };
}

function makeProof(threadId: string, runId: string, artifacts: PreviewVerificationArtifactView[]): PreviewProofRecordView {
  const verification = {
    runId,
    mode: "headless",
    checkedAt: 1,
    durationMs: 0,
    ok: true,
    status: null,
    title: "test",
    url: "",
    error: null,
    failureKind: "none",
    summary: { consoleMessageCount: 0, pageErrorCount: 0, failedRequestCount: 0, responseErrorCount: 0, assetFailureCount: 0, phaseCount: 1 },
    phases: [],
    readiness: {
      initialUrl: "", finalUrl: "", expectedPath: null, selector: null, selectorSatisfied: null,
      routeStatus: null, routeOk: true, loginRedirectDetected: false, htmlErrorSignals: [],
      sameOriginAssetFailureCount: 0, websocketFailureCount: 0, notes: []
    },
    auth: { headerCount: 0, cookieCount: 0, cookieNames: [], usedSessionCookie: false },
    artifacts,
    consoleMessages: [],
    pageErrors: [],
    failedRequests: []
  } as PreviewVerificationView;
  return {
    id: `browser:${threadId}:${runId}`,
    previewId: `browser:${threadId}`,
    threadId,
    projectId: "project-1",
    projectLabel: "Project 1",
    previewTitle: "Browser proof",
    stackId: null,
    verification,
    proofReviews: [],
    createdAt: 1,
    updatedAt: 1
  };
}

async function withTempFile(bytes: Buffer, work: (filePath: string) => Promise<void>): Promise<void> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "vision-proof-"));
  const filePath = path.join(dir, "screenshot.png");
  await fs.writeFile(filePath, bytes);
  try {
    await work(filePath);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

test("vision.inspect inspects a same-job proof artifact by run id and label", async () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01, 0x02, 0x03, 0x04]);
  await withTempFile(png, async (filePath) => {
    const artifact = makeArtifact({ label: "Home page", fileName: "home.png", filePath, sizeBytes: png.byteLength });
    const proof = makeProof("thread-1", "run-1", [artifact]);
    const call = {} as FakeVisionCall;
    const result = await handleHarnessVisionAction({
      action: "vision.inspect",
      params: { proofRunId: "run-1", proofArtifacts: ["Home page"], question: "Describe the page" },
      threadId: "thread-1",
      allowedImageReferenceIds: [],
      store: { addEvent() {}, listPreviewProofs: () => [proof] } as never,
      visionInspection: fakeVisionInspection(call),
      access: { imageStore: fakeImageStore(new Map()), fileStore: fakeFileStore(new Map()) }
    });
    assert.equal(call.mode, "images");
    assert.equal((call as { images?: Array<{ name: string }> }).images?.[0].name, "home.png");
    assert.match(result?.text ?? "", /ok/);
  });
});

test("vision.inspect inspects all image artifacts when no label is given", async () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  await withTempFile(png, async (filePath) => {
    const artifact = makeArtifact({ label: "screenshot.png", fileName: "screenshot.png", filePath, sizeBytes: png.byteLength });
    const proof = makeProof("thread-1", "run-2", [artifact]);
    const call = {} as FakeVisionCall;
    await handleHarnessVisionAction({
      action: "vision.inspect",
      params: { proofRunId: "run-2", question: "Describe" },
      threadId: "thread-1",
      allowedImageReferenceIds: [],
      store: { addEvent() {}, listPreviewProofs: () => [proof] } as never,
      visionInspection: fakeVisionInspection(call),
      access: { imageStore: fakeImageStore(new Map()), fileStore: fakeFileStore(new Map()) }
    });
    assert.equal(call.mode, "images");
    assert.equal((call as { images?: unknown[] }).images?.length, 1);
  });
});

test("vision.inspect rejects a proof run that belongs to a different job", async () => {
  const png = Buffer.from([0x01]);
  await withTempFile(png, async (filePath) => {
    const artifact = makeArtifact({ filePath, sizeBytes: png.byteLength });
    const proof = makeProof("other-thread", "run-x", [artifact]);
    await assert.rejects(handleHarnessVisionAction({
      action: "vision.inspect",
      params: { proofRunId: "run-x", question: "Describe" },
      threadId: "thread-1",
      allowedImageReferenceIds: [],
      store: { addEvent() {}, listPreviewProofs: () => [proof] } as never,
      visionInspection: fakeVisionInspection({} as FakeVisionCall),
      access: { imageStore: fakeImageStore(new Map()), fileStore: fakeFileStore(new Map()) }
    }), /not found for job thread-1/);
  });
});

test("vision.inspect rejects an unknown proof run id", async () => {
  await assert.rejects(handleHarnessVisionAction({
    action: "vision.inspect",
    params: { proofRunId: "missing", question: "Describe" },
    threadId: "thread-1",
    allowedImageReferenceIds: [],
    store: { addEvent() {}, listPreviewProofs: () => [] } as never,
    visionInspection: fakeVisionInspection({} as FakeVisionCall),
    access: { imageStore: fakeImageStore(new Map()), fileStore: fakeFileStore(new Map()) }
  }), /not found for job thread-1/);
});

test("vision.inspect ignores non-image proof artifacts (video/trace/html)", async () => {
  const video = makeArtifact({ kind: "video", label: "video.mp4", fileName: "video.mp4", contentType: "video/mp4", sizeBytes: 10, filePath: "/tmp/x" });
  const trace = makeArtifact({ kind: "trace", label: "trace.zip", fileName: "trace.zip", contentType: "application/zip", sizeBytes: 10, filePath: "/tmp/x" });
  const proof = makeProof("thread-1", "run-vid", [video, trace]);
  await assert.rejects(handleHarnessVisionAction({
    action: "vision.inspect",
    params: { proofRunId: "run-vid", question: "Describe" },
    threadId: "thread-1",
    allowedImageReferenceIds: [],
    store: { addEvent() {}, listPreviewProofs: () => [proof] } as never,
    visionInspection: fakeVisionInspection({} as FakeVisionCall),
    access: { imageStore: fakeImageStore(new Map()), fileStore: fakeFileStore(new Map()) }
  }), /no inspectable image artifacts/);
});

test("vision.inspect rejects proof artifacts whose MIME type is outside the PI image allowlist (svg/bmp)", async () => {
  for (const mimeType of ["image/svg+xml", "image/bmp", "image/tiff", "image/avif"]) {
    const svg = makeArtifact({
      kind: "screenshot",
      label: `render.${mimeType.split("/")[1]}`,
      fileName: `render.${mimeType.split("/")[1]}`,
      contentType: mimeType,
      sizeBytes: 4,
      filePath: "/tmp/rendered",
      availability: "available"
    });
    const proof = makeProof("thread-1", `run-mime-${mimeType}`, [svg]);
    await assert.rejects(handleHarnessVisionAction({
      action: "vision.inspect",
      params: { proofRunId: `run-mime-${mimeType}`, question: "Describe" },
      threadId: "thread-1",
      allowedImageReferenceIds: [],
      store: { addEvent() {}, listPreviewProofs: () => [proof] } as never,
      visionInspection: fakeVisionInspection({} as FakeVisionCall),
      access: { imageStore: fakeImageStore(new Map()), fileStore: fakeFileStore(new Map()) }
    }), /no inspectable image artifacts/);
  }
});

test("vision.inspect rejects a selected proof artifact with an unsupported MIME type even when other artifacts are valid", async () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
  await withTempFile(png, async (filePath) => {
    const good = makeArtifact({ label: "good.png", fileName: "good.png", filePath, sizeBytes: png.byteLength });
    const svg = makeArtifact({ kind: "screenshot", label: "logo.svg", fileName: "logo.svg", contentType: "image/svg+xml", sizeBytes: 20, filePath: "/tmp/logo.svg", availability: "available" });
    const proof = makeProof("thread-1", "run-mix-mime", [good, svg]);
    await assert.rejects(handleHarnessVisionAction({
      action: "vision.inspect",
      params: { proofRunId: "run-mix-mime", proofArtifacts: ["logo.svg"], question: "Describe" },
      threadId: "thread-1",
      allowedImageReferenceIds: [],
      store: { addEvent() {}, listPreviewProofs: () => [proof] } as never,
      visionInspection: fakeVisionInspection({} as FakeVisionCall),
      access: { imageStore: fakeImageStore(new Map()), fileStore: fakeFileStore(new Map()) }
    }), /no inspectable image artifacts/i);
  });
});

test("vision.inspect rejects an expired proof artifact", async () => {
  const png = Buffer.from([0x01]);
  await withTempFile(png, async (filePath) => {
    const artifact = makeArtifact({ filePath, sizeBytes: png.byteLength, availability: "expired" });
    const proof = makeProof("thread-1", "run-exp", [artifact]);
    await assert.rejects(handleHarnessVisionAction({
      action: "vision.inspect",
      params: { proofRunId: "run-exp", question: "Describe" },
      threadId: "thread-1",
      allowedImageReferenceIds: [],
      store: { addEvent() {}, listPreviewProofs: () => [proof] } as never,
      visionInspection: fakeVisionInspection({} as FakeVisionCall),
      access: { imageStore: fakeImageStore(new Map()), fileStore: fakeFileStore(new Map()) }
    }), /expired/);
  });
});

test("vision.inspect rejects a proof artifact whose file size no longer matches", async () => {
  const png = Buffer.from([0x01, 0x02, 0x03]);
  await withTempFile(png, async (filePath) => {
    const artifact = makeArtifact({ filePath, sizeBytes: 999, availability: "available" });
    const proof = makeProof("thread-1", "run-size", [artifact]);
    await assert.rejects(handleHarnessVisionAction({
      action: "vision.inspect",
      params: { proofRunId: "run-size", question: "Describe" },
      threadId: "thread-1",
      allowedImageReferenceIds: [],
      store: { addEvent() {}, listPreviewProofs: () => [proof] } as never,
      visionInspection: fakeVisionInspection({} as FakeVisionCall),
      access: { imageStore: fakeImageStore(new Map()), fileStore: fakeFileStore(new Map()) }
    }), /no longer matches its recorded size/);
  });
});

test("vision.inspect rejects a proof artifact larger than 3 MiB", async () => {
  const artifact = makeArtifact({ sizeBytes: 3 * 1024 * 1024 + 1, availability: "available" });
  const proof = makeProof("thread-1", "run-big", [artifact]);
  await assert.rejects(handleHarnessVisionAction({
    action: "vision.inspect",
    params: { proofRunId: "run-big", question: "Describe" },
    threadId: "thread-1",
    allowedImageReferenceIds: [],
    store: { addEvent() {}, listPreviewProofs: () => [proof] } as never,
    visionInspection: fakeVisionInspection({} as FakeVisionCall),
    access: { imageStore: fakeImageStore(new Map()), fileStore: fakeFileStore(new Map()) }
  }), /3 MiB/);
});

test("vision.inspect rejects a proof artifact whose file path is missing", async () => {
  const artifact = makeArtifact({ filePath: "/nonexistent/missing.png", sizeBytes: 1, availability: "available" });
  const proof = makeProof("thread-1", "run-missing", [artifact]);
  await assert.rejects(handleHarnessVisionAction({
    action: "vision.inspect",
    params: { proofRunId: "run-missing", question: "Describe" },
    threadId: "thread-1",
    allowedImageReferenceIds: [],
    store: { addEvent() {}, listPreviewProofs: () => [proof] } as never,
    visionInspection: fakeVisionInspection({} as FakeVisionCall),
    access: { imageStore: fakeImageStore(new Map()), fileStore: fakeFileStore(new Map()) }
  }), /not a regular file/);
});

test("vision.inspect allows an image published from a job-granted source through the output flow", async () => {
  const png = Buffer.from([0x01, 0x02]);
  await withTempFile(png, async (filePath) => {
    const imageRecords = new Map();
    imageRecords.set("granted-1", { id: "granted-1", name: "original.png", mimeType: "image/png", sizeBytes: png.byteLength });
    imageRecords.set("pub-1", { id: "pub-1", name: "published.png", mimeType: "image/png", sizeBytes: png.byteLength, sourceReferenceId: "granted-1", filePath });
    const call = {} as FakeVisionCall;
    const result = await handleHarnessVisionAction({
      action: "vision.inspect",
      params: { imageReferenceIds: ["pub-1"], question: "Describe" },
      threadId: "thread-1",
      allowedImageReferenceIds: ["granted-1"],
      store: { addEvent() {}, listPreviewProofs: () => [] } as never,
      visionInspection: fakeVisionInspection(call),
      access: { imageStore: fakeImageStore(imageRecords), fileStore: fakeFileStore(new Map()) }
    });
    // Reference-only path should use the store-backed inspect() with the published reference id.
    assert.equal(call.mode, "references");
    assert.deepEqual((call as { referenceIds?: string[] }).referenceIds, ["pub-1"]);
    assert.match(result?.text ?? "", /ok/);
  });
});

test("vision.inspect rejects a published image whose lineage root is not granted to the job", async () => {
  const imageRecords = new Map();
  imageRecords.set("root-other", { id: "root-other", name: "secret.png", mimeType: "image/png", sizeBytes: 1 });
  imageRecords.set("pub-2", { id: "pub-2", name: "leak.png", mimeType: "image/png", sizeBytes: 1, sourceReferenceId: "root-other" });
  await assert.rejects(handleHarnessVisionAction({
    action: "vision.inspect",
    params: { imageReferenceIds: ["pub-2"], question: "Describe" },
    threadId: "thread-1",
    allowedImageReferenceIds: ["granted-1"],
    store: { addEvent() {}, listPreviewProofs: () => [] } as never,
    visionInspection: fakeVisionInspection({} as FakeVisionCall),
    access: { imageStore: fakeImageStore(imageRecords), fileStore: fakeFileStore(new Map()) }
  }), /registered to this job/);
});

test("vision.inspect rejects more than four images in one request", async () => {
  const ids = ["a", "b", "c", "d", "e"];
  const imageRecords = new Map();
  for (const id of ids) imageRecords.set(id, { id, name: `${id}.png`, mimeType: "image/png", sizeBytes: 1 });
  await assert.rejects(handleHarnessVisionAction({
    action: "vision.inspect",
    params: { imageReferenceIds: ids, question: "Describe" },
    threadId: "thread-1",
    allowedImageReferenceIds: ids,
    store: { addEvent() {}, listPreviewProofs: () => [] } as never,
    visionInspection: fakeVisionInspection({} as FakeVisionCall),
    access: { imageStore: fakeImageStore(imageRecords), fileStore: fakeFileStore(new Map()) }
  }), /at most 4 images/);
});

test("vision.inspect mixes reference attachments and proof artifacts in one request", async () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
  await withTempFile(png, async (proofPath) => {
    const refPath = path.join(path.dirname(proofPath), "ref.png");
    await fs.writeFile(refPath, png);
    const artifact = makeArtifact({ label: "proof-shot", fileName: "proof.png", filePath: proofPath, sizeBytes: png.byteLength });
    const proof = makeProof("thread-1", "run-mix", [artifact]);
    const imageRecords = new Map();
    imageRecords.set("image-1", { id: "image-1", name: "ref.png", mimeType: "image/png", sizeBytes: png.byteLength, filePath: refPath });
    const call = {} as FakeVisionCall;
    await handleHarnessVisionAction({
      action: "vision.inspect",
      params: { imageReferenceIds: ["image-1"], proofRunId: "run-mix", proofArtifacts: ["proof-shot"], question: "Compare" },
      threadId: "thread-1",
      allowedImageReferenceIds: ["image-1"],
      store: { addEvent() {}, listPreviewProofs: () => [proof] } as never,
      visionInspection: fakeVisionInspection(call),
      access: { imageStore: fakeImageStore(imageRecords), fileStore: fakeFileStore(new Map()) }
    });
    assert.equal(call.mode, "images");
    const images = (call as { images?: Array<{ name: string }> }).images ?? [];
    assert.equal(images.length, 2);
    assert.deepEqual(images.map((image) => image.name).sort(), ["proof.png", "ref.png"]);
  });
});

test("vision.inspect rejects --proof-artifact without --proof-run", async () => {
  await assert.rejects(handleHarnessVisionAction({
    action: "vision.inspect",
    params: { proofArtifacts: ["x"], imageReferenceIds: ["image-1"], question: "Describe" },
    threadId: "thread-1",
    allowedImageReferenceIds: ["image-1"],
    store: { addEvent() {}, listPreviewProofs: () => [] } as never,
    visionInspection: fakeVisionInspection({} as FakeVisionCall),
    access: {
      imageStore: fakeImageStore(new Map([["image-1", { id: "image-1", name: "a.png", mimeType: "image/png", sizeBytes: 1 }]])),
      fileStore: fakeFileStore(new Map())
    }
  }), /requires --proof-run/);
});