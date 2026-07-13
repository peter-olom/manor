import { promises as fs } from "node:fs";
import path from "node:path";
import { MAX_FILE_BYTES, type FileReferenceStore, type FileReferenceView } from "./file-store.js";
import { MAX_IMAGE_BYTES, type ImageReferenceStore, type ImageReferenceView } from "./image-store.js";
import type { ReferenceMutationQueue } from "./reference-mutation-queue.js";
import type { ButlerStateStore } from "./state-store.js";
import { normalizeString } from "./codex-harness-helpers.js";

export type HarnessInputActionAccess = {
  outputsDir: string;
  fileStore: FileReferenceStore;
  imageStore: ImageReferenceStore;
  referenceMutations: ReferenceMutationQueue;
};

const lineageLocks = new Map<string, Promise<void>>();

async function withLineageLock<T>(lineageId: string, work: () => Promise<T>): Promise<T> {
  const previous = lineageLocks.get(lineageId) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => { release = resolve; });
  const tail = previous.then(() => current);
  lineageLocks.set(lineageId, tail);
  await previous;
  try {
    return await work();
  } finally {
    release();
    if (lineageLocks.get(lineageId) === tail) lineageLocks.delete(lineageId);
  }
}

function inferredMimeType(fileName: string): string | null {
  switch (path.extname(fileName).toLowerCase()) {
    case ".png": return "image/png";
    case ".jpg": case ".jpeg": return "image/jpeg";
    case ".gif": return "image/gif";
    case ".webp": return "image/webp";
    case ".svg": return "image/svg+xml";
    case ".avif": return "image/avif";
    case ".pdf": return "application/pdf";
    case ".csv": return "text/csv";
    case ".txt": return "text/plain";
    case ".json": return "application/json";
    case ".xlsx": return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
    case ".docx": return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    default: return null;
  }
}

function sourceReference(input: { sourceReferenceId: string; fileStore: FileReferenceStore; imageStore: ImageReferenceStore }): FileReferenceView | ImageReferenceView {
  const source = input.imageStore.get(input.sourceReferenceId) ?? input.fileStore.get(input.sourceReferenceId);
  if (!source) throw new Error(`Source reference ${input.sourceReferenceId} was not found`);
  return source;
}

function lineageRoot(reference: FileReferenceView | ImageReferenceView, access: HarnessInputActionAccess): string {
  const seen = new Set<string>();
  let current = reference;
  while (current.sourceReferenceId && !seen.has(current.sourceReferenceId)) {
    seen.add(current.id);
    const parent = access.imageStore.get(current.sourceReferenceId) ?? access.fileStore.get(current.sourceReferenceId);
    if (!parent) break;
    current = parent;
  }
  return current.id;
}

function nextLineageVersion(rootId: string, access: HarnessInputActionAccess): number {
  const references = [...access.imageStore.list(Number.MAX_SAFE_INTEGER), ...access.fileStore.list(Number.MAX_SAFE_INTEGER)];
  return references.reduce((maximum, reference) => lineageRoot(reference, access) === rootId ? Math.max(maximum, reference.version ?? 1) : maximum, 1) + 1;
}

async function readBoundedFile(filePath: string, maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let sizeBytes = 0;
  const stream = (await fs.open(filePath, "r")).createReadStream();
  try {
    for await (const chunk of stream) {
      const buffer = Buffer.from(chunk);
      sizeBytes += buffer.byteLength;
      if (sizeBytes > maxBytes) throw new Error(`Published output grew beyond the ${maxBytes / (1024 * 1024)} MB limit`);
      chunks.push(buffer);
    }
  } finally {
    stream.destroy();
  }
  return Buffer.concat(chunks, sizeBytes);
}

export async function handleHarnessInputAction(input: {
  action: string;
  threadId: string;
  params: Record<string, unknown>;
  store: ButlerStateStore;
} & HarnessInputActionAccess): Promise<{ text: string; data?: Record<string, unknown> } | null> {
  if (input.action !== "input.publish_version") return null;
  const outputPath = normalizeString(input.params.filePath);
  const sourceReferenceId = normalizeString(input.params.sourceReferenceId);
  if (!outputPath || !sourceReferenceId) {
    throw new Error("input publish requires an output path and --from <referenceId>");
  }
  const payload = input.store.getThreadJobPayload(input.threadId);
  const grantedReferences = new Set([...(payload?.attachments.images ?? []), ...(payload?.attachments.files ?? [])]);
  if (!grantedReferences.has(sourceReferenceId)) throw new Error(`Source reference ${sourceReferenceId} is not granted to job ${input.threadId}`);
  const jobOutputDir = path.resolve(input.outputsDir, input.threadId);
  const realJobOutputDir = await fs.realpath(jobOutputDir).catch(() => "");
  const realOutputPath = await fs.realpath(outputPath).catch(() => "");
  if (!realJobOutputDir || !realOutputPath || (realOutputPath !== realJobOutputDir && !realOutputPath.startsWith(`${realJobOutputDir}${path.sep}`))) {
    throw new Error(`Published files must be inside ${jobOutputDir}`);
  }
  const stats = await fs.stat(realOutputPath);
  if (!stats.isFile()) throw new Error("Published output must be a regular file");
  const source = sourceReference({ sourceReferenceId, fileStore: input.fileStore, imageStore: input.imageStore });
  const name = path.basename(normalizeString(input.params.name) || realOutputPath);
  const mimeType = normalizeString(input.params.contentType) || inferredMimeType(name) || source.mimeType || "application/octet-stream";
  const maxBytes = mimeType.startsWith("image/") ? MAX_IMAGE_BYTES : MAX_FILE_BYTES;
  if (stats.size > maxBytes) throw new Error(`Published output exceeds the ${maxBytes / (1024 * 1024)} MB ${mimeType.startsWith("image/") ? "image" : "file"} limit`);
  const buffer = await readBoundedFile(realOutputPath, maxBytes);
  return input.referenceMutations.run(async () => {
    const currentSource = sourceReference({ sourceReferenceId, fileStore: input.fileStore, imageStore: input.imageStore });
    const rootId = lineageRoot(currentSource, input);
    return withLineageLock(rootId, async () => {
      const version = nextLineageVersion(rootId, input);
      const reference = mimeType.startsWith("image/")
        ? await input.imageStore.createFromBuffer({ name, mimeType, buffer, sourceReferenceId, version })
        : await input.fileStore.createFromBuffer({ name, mimeType, buffer, sourceReferenceId, version });
      const immutablePath = mimeType.startsWith("image/")
        ? input.imageStore.getFilePath(reference.id)
        : input.fileStore.getFilePath(reference.id);
      input.store.addEvent(input.threadId, "harness/input/published", `Published ${reference.name} as version ${version} of ${sourceReferenceId}`);
      return {
        text: `Published ${reference.name} as immutable input ${reference.id}, version ${version} of ${sourceReferenceId}. Path: ${immutablePath}.`,
        data: { reference, immutablePath, sourceReferenceId, version, kind: mimeType.startsWith("image/") ? "image" : "file" }
      };
    });
  });
}
