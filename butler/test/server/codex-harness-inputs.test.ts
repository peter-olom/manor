import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { handleHarnessInputAction } from "../../src/server/codex-harness-inputs.js";
import { formatHarnessRuntimeModel } from "../../src/server/codex-harness-format.js";
import { FileReferenceStore } from "../../src/server/file-store.js";
import { ImageReferenceStore } from "../../src/server/image-store.js";
import { deleteReference } from "../../src/server/reference-library.js";
import { ReferenceMutationQueue } from "../../src/server/reference-mutation-queue.js";

function legacyJobPayload(threadId: string, imageIds: string[], fileIds: string[]) {
  const currentAttemptId = `attempt-${threadId}-1`;
  return {
    threadId,
    protocol: { currentAttemptId, currentScopeId: `scope-legacy-${currentAttemptId}` },
    workspace: { outputDir: `/outputs/${threadId}` },
    attachments: { images: imageIds, files: fileIds }
  };
}

test("Worker guidance names immutable inputs, job outputs, and publishing", () => {
  const guidance = formatHarnessRuntimeModel().join("\n");
  assert.match(guidance, /Worker shell is a normal development environment/);
  assert.match(guidance, /Use previews when a clean runtime, service lifecycle, isolation, or browser proof is useful/);
  assert.match(guidance, /read-only at \/inputs/);
  assert.match(guidance, /exact workspace\.outputDir/);
  assert.match(guidance, /manor-harness input publish <path> --from <referenceId>/);
});

test("Worker outputs publish as linked immutable file and image versions", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "manor-publish-input-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const outputsDir = path.join(root, "outputs");
  const jobDir = path.join(outputsDir, "thread-1");
  await fs.mkdir(jobDir, { recursive: true });
  const referenceMutations = new ReferenceMutationQueue();
  const fileStore = new FileReferenceStore(path.join(root, "inputs", "files"), "/api/files", referenceMutations);
  const imageStore = new ImageReferenceStore(path.join(root, "inputs", "images"), "/api/images", referenceMutations);
  await Promise.all([fileStore.load(), imageStore.load()]);
  const sourceFile = await fileStore.createFromBuffer({ name: "cv.pdf", mimeType: "application/pdf", buffer: Buffer.from("v1") });
  const sourceImage = await imageStore.createFromBuffer({ name: "photo.png", mimeType: "image/png", buffer: Buffer.from("png-v1") });
  const events: string[] = [];
  const store = {
    addEvent: (_threadId: string, _type: string, message: string) => events.push(message),
    getThreadJobPayload: () => legacyJobPayload("thread-1", [sourceImage.id], [sourceFile.id])
  };

  const revisedPdf = path.join(jobDir, "cv-v2.pdf");
  await fs.writeFile(revisedPdf, "v2");
  const fileResult = await handleHarnessInputAction({
    action: "input.publish_version",
    threadId: "thread-1",
    params: { filePath: revisedPdf, sourceReferenceId: sourceFile.id },
    outputsDir,
    fileStore,
    imageStore,
    referenceMutations,
    store: store as never
  });
  const fileReference = fileResult?.data?.reference as { id: string; sourceReferenceId: string; version: number };
  assert.equal(fileReference.sourceReferenceId, sourceFile.id);
  assert.equal(fileReference.version, 2);
  assert.equal(fileResult?.data?.immutablePath, fileStore.getFilePath(fileReference.id));
  assert.equal((await fs.stat(fileStore.getFilePath(fileReference.id)!)).mode & 0o777, 0o444);

  const revisedImage = path.join(jobDir, "photo-v2.png");
  await fs.writeFile(revisedImage, "png-v2");
  const imageResult = await handleHarnessInputAction({
    action: "input.publish_version",
    threadId: "thread-1",
    params: { filePath: revisedImage, sourceReferenceId: sourceImage.id },
    outputsDir,
    fileStore,
    imageStore,
    referenceMutations,
    store: store as never
  });
  const imageReference = imageResult?.data?.reference as { id: string; sourceReferenceId: string; version: number };
  assert.equal(imageResult?.data?.kind, "image");
  assert.equal(imageReference.sourceReferenceId, sourceImage.id);
  assert.equal(imageReference.version, 2);
  assert.ok(imageStore.get(imageReference.id));
  assert.equal(events.length, 2);
});

test("publishing rejects files outside the job output directory", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "manor-publish-escape-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const referenceMutations = new ReferenceMutationQueue();
  const fileStore = new FileReferenceStore(path.join(root, "inputs", "files"), "/api/files", referenceMutations);
  const imageStore = new ImageReferenceStore(path.join(root, "inputs", "images"), "/api/images", referenceMutations);
  await Promise.all([fileStore.load(), imageStore.load()]);
  const source = await fileStore.createFromBuffer({ name: "source.txt", mimeType: "text/plain", buffer: Buffer.from("source") });
  const outside = path.join(root, "outside.txt");
  await fs.writeFile(outside, "changed");
  await assert.rejects(
    handleHarnessInputAction({
      action: "input.publish_version",
      threadId: "thread-1",
      params: { filePath: outside, sourceReferenceId: source.id },
      outputsDir: path.join(root, "outputs"),
      fileStore,
      imageStore,
      referenceMutations,
      store: { addEvent: () => undefined, getThreadJobPayload: () => legacyJobPayload("thread-1", [], [source.id]) } as never
    }),
    /must be inside/
  );
});

test("publishing rejects a payload output directory outside its current thread scope", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "manor-publish-payload-escape-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const outputsDir = path.join(root, "outputs");
  const escapedDir = path.join(root, "escaped");
  await fs.mkdir(escapedDir, { recursive: true });
  const referenceMutations = new ReferenceMutationQueue();
  const fileStore = new FileReferenceStore(path.join(root, "inputs", "files"), "/api/files", referenceMutations);
  const imageStore = new ImageReferenceStore(path.join(root, "inputs", "images"), "/api/images", referenceMutations);
  await Promise.all([fileStore.load(), imageStore.load()]);
  const source = await fileStore.createFromBuffer({ name: "source.txt", mimeType: "text/plain", buffer: Buffer.from("source") });
  const output = path.join(escapedDir, "changed.txt");
  await fs.writeFile(output, "changed");
  const malformed = {
    ...legacyJobPayload("thread-1", [], [source.id]),
    protocol: { currentAttemptId: "attempt-thread-1-1", currentScopeId: "scope-current" },
    workspace: { outputDir: "/outputs/../escaped" }
  };

  await assert.rejects(handleHarnessInputAction({
    action: "input.publish_version",
    threadId: "thread-1",
    params: { filePath: output, sourceReferenceId: source.id },
    outputsDir,
    fileStore,
    imageStore,
    referenceMutations,
    store: { addEvent: () => undefined, getThreadJobPayload: () => malformed } as never
  }), /does not match the current job scope/);
});

test("publishing rejects source references not granted to the job", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "manor-publish-grant-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const jobDir = path.join(root, "outputs", "thread-1");
  await fs.mkdir(jobDir, { recursive: true });
  const referenceMutations = new ReferenceMutationQueue();
  const fileStore = new FileReferenceStore(path.join(root, "inputs", "files"), "/api/files", referenceMutations);
  const imageStore = new ImageReferenceStore(path.join(root, "inputs", "images"), "/api/images", referenceMutations);
  await Promise.all([fileStore.load(), imageStore.load()]);
  const source = await fileStore.createFromBuffer({ name: "private.txt", mimeType: "text/plain", buffer: Buffer.from("source") });
  const output = path.join(jobDir, "changed.txt");
  await fs.writeFile(output, "changed");
  await assert.rejects(handleHarnessInputAction({
    action: "input.publish_version",
    threadId: "thread-1",
    params: { filePath: output, sourceReferenceId: source.id },
    outputsDir: path.join(root, "outputs"),
    fileStore,
    imageStore,
    referenceMutations,
    store: { addEvent: () => undefined, getThreadJobPayload: () => legacyJobPayload("thread-1", [], []) } as never
  }), /is not granted to job/);
});

test("concurrent publications allocate unique monotonic lineage versions", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "manor-publish-lineage-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const outputsDir = path.join(root, "outputs");
  const jobDir = path.join(outputsDir, "thread-1");
  await fs.mkdir(jobDir, { recursive: true });
  const referenceMutations = new ReferenceMutationQueue();
  const fileStore = new FileReferenceStore(path.join(root, "inputs", "files"), "/api/files", referenceMutations);
  const imageStore = new ImageReferenceStore(path.join(root, "inputs", "images"), "/api/images", referenceMutations);
  await Promise.all([fileStore.load(), imageStore.load()]);
  const source = await fileStore.createFromBuffer({ name: "source.txt", mimeType: "text/plain", buffer: Buffer.from("v1") });
  const paths = [path.join(jobDir, "v2.txt"), path.join(jobDir, "v3.txt")];
  await Promise.all(paths.map((filePath, index) => fs.writeFile(filePath, `v${index + 2}`)));
  const store = { addEvent: () => undefined, getThreadJobPayload: () => legacyJobPayload("thread-1", [], [source.id]) };
  const results = await Promise.all(paths.map((filePath) => handleHarnessInputAction({
    action: "input.publish_version", threadId: "thread-1", params: { filePath, sourceReferenceId: source.id },
    outputsDir, fileStore, imageStore, referenceMutations, store: store as never
  })));
  assert.deepEqual(results.map((result) => result?.data?.version).sort(), [2, 3]);
  assert.equal(new Set(results.map((result) => (result?.data?.reference as { id: string }).id)).size, 2);
});

test("deleting a source while publication is queued cannot create an orphaned version", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "manor-publish-delete-race-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const outputsDir = path.join(root, "outputs");
  const jobDir = path.join(outputsDir, "thread-1");
  await fs.mkdir(jobDir, { recursive: true });
  const referenceMutations = new ReferenceMutationQueue();
  const fileStore = new FileReferenceStore(path.join(root, "inputs", "files"), "/api/files", referenceMutations);
  const imageStore = new ImageReferenceStore(path.join(root, "inputs", "images"), "/api/images", referenceMutations);
  await Promise.all([fileStore.load(), imageStore.load()]);
  const source = await fileStore.createFromBuffer({ name: "source.txt", mimeType: "text/plain", buffer: Buffer.from("v1") });
  const output = path.join(jobDir, "v2.txt");
  await fs.writeFile(output, "v2");

  let releaseQueue!: () => void;
  const queueHeld = new Promise<void>((resolve) => { releaseQueue = resolve; });
  let queuedOperations = 0;
  let signalPublicationQueued!: () => void;
  const publicationQueued = new Promise<void>((resolve) => { signalPublicationQueued = resolve; });
  const originalRun = referenceMutations.run.bind(referenceMutations);
  referenceMutations.run = ((operation) => {
    queuedOperations += 1;
    if (queuedOperations === 3) signalPublicationQueued();
    return originalRun(operation);
  }) as typeof referenceMutations.run;

  const hold = referenceMutations.run(async () => queueHeld);
  const deletion = deleteReference(source.id, imageStore, fileStore, referenceMutations);
  const publication = handleHarnessInputAction({
    action: "input.publish_version",
    threadId: "thread-1",
    params: { filePath: output, sourceReferenceId: source.id },
    outputsDir,
    fileStore,
    imageStore,
    referenceMutations,
    store: { addEvent: () => undefined, getThreadJobPayload: () => legacyJobPayload("thread-1", [], [source.id]) } as never
  });

  await publicationQueued;
  releaseQueue();
  await hold;
  const [deleteResult, publishResult] = await Promise.allSettled([deletion, publication]);
  assert.deepEqual(deleteResult, { status: "fulfilled", value: true });
  assert.equal(publishResult.status, "rejected");
  if (publishResult.status === "rejected") assert.match(String(publishResult.reason), /was not found/);
  assert.equal(fileStore.list().length, 0);
});

test("oversized outputs are rejected from stat metadata before publication", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "manor-publish-size-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const outputsDir = path.join(root, "outputs");
  const jobDir = path.join(outputsDir, "thread-1");
  await fs.mkdir(jobDir, { recursive: true });
  const referenceMutations = new ReferenceMutationQueue();
  const fileStore = new FileReferenceStore(path.join(root, "inputs", "files"), "/api/files", referenceMutations);
  const imageStore = new ImageReferenceStore(path.join(root, "inputs", "images"), "/api/images", referenceMutations);
  await Promise.all([fileStore.load(), imageStore.load()]);
  const source = await fileStore.createFromBuffer({ name: "source.bin", mimeType: "application/octet-stream", buffer: Buffer.from("v1") });
  const output = path.join(jobDir, "too-large.bin");
  await fs.writeFile(output, "x");
  await fs.truncate(output, 40 * 1024 * 1024 + 1);
  await assert.rejects(handleHarnessInputAction({
    action: "input.publish_version", threadId: "thread-1", params: { filePath: output, sourceReferenceId: source.id },
    outputsDir, fileStore, imageStore, referenceMutations,
    store: { addEvent: () => undefined, getThreadJobPayload: () => legacyJobPayload("thread-1", [], [source.id]) } as never
  }), /exceeds the 40 MB file limit/);
  assert.equal(fileStore.list().length, 1);
});
