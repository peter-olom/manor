import { promises as fs } from "node:fs";
import http from "node:http";
import path from "node:path";

import type { Express, Request, RequestHandler } from "express";

import { resolveProofBundleKey } from "./butler-agent-helpers.js";
import { type FileReferenceStore } from "./file-store.js";
import { type ImageReferenceStore } from "./image-store.js";
import { type PairStore } from "./pair-store.js";
import { deleteReference, listReferenceLibrary, ReferenceHasChildrenError } from "./reference-library.js";
import { normalizeReferenceMetadata } from "./reference-metadata.js";
import { resolveWorkspaceProjectInfo } from "./repo-worktree.js";
import type { ReferenceMutationQueue } from "./reference-mutation-queue.js";
import { resolveReferencePreviewKind, type ReferenceMetadata } from "../shared/references.js";
import { InvalidTextPreviewError, readTextPreview } from "./text-preview.js";
import {
  decodeArtifactRelativePath,
  pruneEmptyArtifactParents,
  sendUnavailableArtifactResponse
} from "./server-runtime-helpers.js";
import { ButlerStateStore } from "./state-store.js";

const INLINE_IMAGE_MIME_TYPES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp", "image/avif"]);

function readHeaderValue(value: string | string[] | undefined): string {
  if (Array.isArray(value)) {
    return typeof value[0] === "string" ? value[0] : "";
  }
  return typeof value === "string" ? value : "";
}

function readUploadName(request: http.IncomingMessage): string {
  const encoded = readHeaderValue(request.headers["x-manor-upload-name"]).trim();
  if (!encoded) {
    return "";
  }

  try {
    return decodeURIComponent(encoded);
  } catch {
    return encoded;
  }
}

function readUploadMimeType(request: http.IncomingMessage): string {
  const explicit = readHeaderValue(request.headers["x-manor-upload-mime-type"]).trim();
  if (explicit) {
    return explicit;
  }
  const contentType = readHeaderValue(request.headers["content-type"]).trim();
  return contentType.split(";", 1)[0] ?? contentType;
}

function readUploadSizeBytes(request: http.IncomingMessage): number | undefined {
  const raw = readHeaderValue(request.headers["x-manor-upload-size"]).trim();
  if (!raw) {
    return undefined;
  }
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

function readUploadSourceReferenceId(request: http.IncomingMessage): string {
  return readHeaderValue(request.headers["x-manor-source-reference-id"]).trim();
}

function readDecodedHeader(request: http.IncomingMessage, name: string): string {
  const encoded = readHeaderValue(request.headers[name]).trim();
  if (!encoded) return "";
  try {
    return decodeURIComponent(encoded);
  } catch {
    return encoded;
  }
}

function currentReferenceMetadata(metadata: ReferenceMetadata | undefined, pairStore: PairStore, store: ButlerStateStore) {
  const pair = metadata?.sessionId ? pairStore.getPair(metadata.sessionId) : null;
  const workerPayload = pair?.worker?.threadId ? store.getThreadJobPayload(pair.worker.threadId) : null;
  const workspaceProject = resolveWorkspaceProjectInfo(pair?.defaultCwd);
  return normalizeReferenceMetadata({
    ...metadata,
    sessionId: pair?.id ?? metadata?.sessionId,
    sessionTitle: pair?.title ?? metadata?.sessionTitle,
    projectId: pair?.projectId ?? metadata?.projectId ?? workerPayload?.project.id ?? (workspaceProject.kind === "project" ? workspaceProject.id : undefined),
    projectLabel: pair?.projectLabel ?? metadata?.projectLabel ?? workerPayload?.project.label ?? (workspaceProject.kind === "project" ? workspaceProject.label : undefined)
  });
}

function readUploadMetadata(request: http.IncomingMessage, pairStore: PairStore, store: ButlerStateStore) {
  return currentReferenceMetadata(normalizeReferenceMetadata({
    sessionId: readDecodedHeader(request, "x-manor-session-id"),
    origin: readDecodedHeader(request, "x-manor-reference-origin")
  }), pairStore, store);
}

function readUploadBuffer(request: Request): Buffer | null {
  return Buffer.isBuffer(request.body) ? request.body : null;
}

async function deletePreviewProofFiles(store: ButlerStateStore, artifactsDir: string, proofId: string): Promise<{ removedFiles: number }> {
  const proof = store.getPreviewProofById(proofId);
  if (!proof) {
    const error = new Error("Proof was not found");
    (error as Error & { statusCode?: number }).statusCode = 404;
    throw error;
  }

  const bundleKey = resolveProofBundleKey(proof);
  const bundleProofs =
    bundleKey && proof.threadId
      ? store.listPreviewProofs().filter((entry) => entry.threadId === proof.threadId && resolveProofBundleKey(entry) === bundleKey)
      : [proof];
  const filePaths = [
    ...new Set(
      bundleProofs.flatMap((entry) =>
        entry.verification.artifacts
          .map((artifact) => artifact.filePath)
          .filter((filePath): filePath is string => Boolean(filePath))
      )
    )
  ];

  let removedFiles = 0;
  for (const filePath of filePaths) {
    const resolvedPath = path.resolve(filePath);
    if (resolvedPath !== artifactsDir && !resolvedPath.startsWith(`${artifactsDir}${path.sep}`)) {
      continue;
    }

    await fs.rm(resolvedPath, { force: true }).catch(() => {});
    await pruneEmptyArtifactParents(artifactsDir, resolvedPath).catch(() => {});
    removedFiles += 1;
  }

  for (const entry of bundleProofs) {
    store.removePreviewProof(entry.id);
  }

  return { removedFiles };
}

export function registerServerAssetRoutes(options: {
  app: Express;
  artifactsDir: string;
  store: ButlerStateStore;
  pairStore: PairStore;
  imageStore: ImageReferenceStore;
  fileStore: FileReferenceStore;
  referenceMutations: ReferenceMutationQueue;
  imageUploadBinaryParser: RequestHandler;
  fileUploadBinaryParser: RequestHandler;
}): void {
  const {
    app,
    artifactsDir,
    store,
    pairStore,
    imageStore,
    fileStore,
    referenceMutations,
    imageUploadBinaryParser,
    fileUploadBinaryParser
  } = options;

  app.post("/api/images/upload", imageUploadBinaryParser, async (request, response) => {
    const uploadBuffer = readUploadBuffer(request);
    const name = uploadBuffer ? readUploadName(request) : typeof request.body?.name === "string" ? request.body.name : "";
    const mimeType = uploadBuffer ? readUploadMimeType(request) : typeof request.body?.mimeType === "string" ? request.body.mimeType : "";
    const data = uploadBuffer ? "" : typeof request.body?.data === "string" ? request.body.data : "";
    const sizeBytes = uploadBuffer ? readUploadSizeBytes(request) : typeof request.body?.sizeBytes === "number" ? request.body.sizeBytes : undefined;
    const metadata = uploadBuffer ? readUploadMetadata(request, pairStore, store) : undefined;

    if (!name || !mimeType || (!uploadBuffer && !data)) {
      response.status(400).json({ error: "name, mimeType, and data are required" });
      return;
    }

    try {
      const image = uploadBuffer
        ? await imageStore.createFromBuffer({ name, mimeType, buffer: uploadBuffer, sizeBytes, metadata })
        : await imageStore.create({ name, mimeType, data, sizeBytes, metadata });
      response.status(201).json({ ok: true, image });
    } catch (error) {
      response.status(400).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.get("/api/images", (request, response) => {
    const limitRaw = Array.isArray(request.query.limit) ? request.query.limit[0] : request.query.limit;
    const limit = typeof limitRaw === "string" && limitRaw.length > 0 ? Number(limitRaw) : 200;

    if (!Number.isFinite(limit) || limit <= 0) {
      response.status(400).json({ error: "limit must be a positive number" });
      return;
    }

    response.json({ images: imageStore.list(limit).map((image) => ({
      ...image,
      ...(image.metadata ? { metadata: currentReferenceMetadata(image.metadata, pairStore, store) } : {})
    })) });
  });

  app.get("/api/images/:imageId", (request, response) => {
    const imageId = typeof request.params.imageId === "string" ? request.params.imageId : "";
    const filePath = imageStore.getFilePath(imageId);
    const image = imageStore.get(imageId);

    if (!filePath || !image) {
      response.status(404).json({ error: "Image reference was not found" });
      return;
    }

    const downloadRequested = Array.isArray(request.query.download)
      ? request.query.download[0] === "1"
      : request.query.download === "1";
    response.setHeader("Cache-Control", "private, max-age=31536000, immutable");
    response.setHeader("X-Content-Type-Options", "nosniff");
    if (downloadRequested || !INLINE_IMAGE_MIME_TYPES.has(image.mimeType)) {
      response.download(filePath, image.name);
      return;
    }
    response.setHeader("Content-Security-Policy", "sandbox; default-src 'none'");
    response.type(image.mimeType);
    response.sendFile(filePath);
  });

  app.post("/api/files/upload", fileUploadBinaryParser, async (request, response) => {
    const uploadBuffer = readUploadBuffer(request);
    const name = uploadBuffer ? readUploadName(request) : typeof request.body?.name === "string" ? request.body.name : "";
    const mimeType = uploadBuffer ? readUploadMimeType(request) : typeof request.body?.mimeType === "string" ? request.body.mimeType : "";
    const data = uploadBuffer ? "" : typeof request.body?.data === "string" ? request.body.data : "";
    const sizeBytes = uploadBuffer ? readUploadSizeBytes(request) : typeof request.body?.sizeBytes === "number" ? request.body.sizeBytes : undefined;
    const sourceReferenceId = uploadBuffer ? readUploadSourceReferenceId(request) : "";
    const metadata = uploadBuffer ? readUploadMetadata(request, pairStore, store) : undefined;

    if (!name || (!uploadBuffer && !data)) {
      response.status(400).json({ error: "name and data are required" });
      return;
    }

    try {
      const source = sourceReferenceId ? fileStore.get(sourceReferenceId) : null;
      if (sourceReferenceId && (resolveReferencePreviewKind(name, mimeType) !== "pdf" || !source || resolveReferencePreviewKind(source.name, source.mimeType) !== "pdf")) {
        response.status(400).json({ error: "Annotated PDF versions require a PDF source and PDF output" });
        return;
      }
      const file = uploadBuffer
        ? sourceReferenceId
          ? await fileStore.createVersionFromBuffer({ name, mimeType, buffer: uploadBuffer, sizeBytes, sourceReferenceId, metadata })
          : await fileStore.createFromBuffer({ name, mimeType, buffer: uploadBuffer, sizeBytes, metadata })
        : await fileStore.create({ name, mimeType, data, sizeBytes, metadata });
      response.status(201).json({ ok: true, file });
    } catch (error) {
      response.status(400).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.get("/api/files", (request, response) => {
    const limitRaw = Array.isArray(request.query.limit) ? request.query.limit[0] : request.query.limit;
    const limit = typeof limitRaw === "string" && limitRaw.length > 0 ? Number(limitRaw) : 200;

    if (!Number.isFinite(limit) || limit <= 0) {
      response.status(400).json({ error: "limit must be a positive number" });
      return;
    }

    response.json({ files: fileStore.list(limit).map((file) => ({
      ...file,
      ...(file.metadata ? { metadata: currentReferenceMetadata(file.metadata, pairStore, store) } : {})
    })) });
  });

  app.get("/api/files/:fileId", async (request, response) => {
    const fileId = typeof request.params.fileId === "string" ? request.params.fileId : "";
    const filePath = fileStore.getFilePath(fileId);
    const file = fileStore.get(fileId);

    if (!filePath || !file) {
      response.status(404).json({ error: "File reference was not found" });
      return;
    }

    response.setHeader("Cache-Control", "private, max-age=31536000, immutable");
    response.setHeader("X-Content-Type-Options", "nosniff");
    const previewRequested = Array.isArray(request.query.preview)
      ? request.query.preview[0] === "1"
      : request.query.preview === "1";
    if (previewRequested) {
      const previewKind = resolveReferencePreviewKind(file.name, file.mimeType);
      if (!previewKind) {
        response.status(415).json({ error: "This file type cannot be previewed" });
        return;
      }
      if (previewKind === "pdf") {
        response.setHeader("Content-Security-Policy", "sandbox; default-src 'none'");
        response.setHeader("Cross-Origin-Resource-Policy", "same-origin");
        response.setHeader("Content-Disposition", "inline");
        response.type("application/pdf");
        response.sendFile(filePath);
        return;
      }
      response.setHeader("Content-Security-Policy", "default-src 'none'");
      response.type("application/json");
      try {
        response.json(await readTextPreview(filePath));
      } catch (error) {
        if (error instanceof InvalidTextPreviewError) {
          response.status(415).json({ error: error.message });
          return;
        }
        console.error("Failed to read stored text preview", error);
        response.status(500).json({ error: "The file preview could not be read" });
      }
      return;
    }
    response.download(filePath, file.name);
  });

  app.get("/api/references", (_request, response) => {
    const library = listReferenceLibrary(imageStore, fileStore);
    response.json({
      items: library.items.map((item) => ({
        ...item,
        ...(item.metadata ? { metadata: currentReferenceMetadata(item.metadata, pairStore, store) } : {})
      }))
    });
  });

  app.delete("/api/references/:referenceId", async (request, response) => {
    const referenceId = typeof request.params.referenceId === "string" ? request.params.referenceId : "";
    try {
      const deleted = await deleteReference(referenceId, imageStore, fileStore, referenceMutations);
      if (!deleted) {
        response.status(404).json({ error: "File was not found" });
        return;
      }
      response.status(204).end();
    } catch (error) {
      if (error instanceof ReferenceHasChildrenError) {
        response.status(409).json({ error: error.message });
        return;
      }
      response.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.get(/^\/api\/artifacts\/(.+)$/, (request, response) => {
    const relativePath =
      typeof request.params?.["0"] === "string"
        ? request.params["0"]
        : Array.isArray(request.params)
          ? request.params[0]
          : "";
    if (!relativePath) {
      response.status(404).json({ error: "Artifact was not found" });
      return;
    }

    const decodedPath = decodeArtifactRelativePath(relativePath);
    const filePath = path.resolve(artifactsDir, decodedPath);
    if (filePath !== artifactsDir && !filePath.startsWith(`${artifactsDir}${path.sep}`)) {
      response.status(400).json({ error: "Artifact path is invalid" });
      return;
    }

    const downloadRequested = Array.isArray(request.query.download)
      ? request.query.download[0] === "1"
      : request.query.download === "1";
    const knownArtifact = store.findPreviewProofArtifactByFilePath(filePath);
    const retainedUntilAt =
      typeof knownArtifact?.artifact.retainedUntilAt === "number" && Number.isFinite(knownArtifact.artifact.retainedUntilAt)
        ? knownArtifact.artifact.retainedUntilAt
        : null;

    const sendUnavailable = () => {
      if (!knownArtifact) {
        response.status(404).json({ error: "Artifact was not found" });
        return;
      }

      const refreshedArtifact = store.findPreviewProofArtifactByFilePath(filePath)?.artifact ?? knownArtifact.artifact;
      const availability = refreshedArtifact.availability === "expired" ? "expired" : "missing";
      sendUnavailableArtifactResponse(response, availability, refreshedArtifact);
    };

    const handleSendError = (error?: NodeJS.ErrnoException | null) => {
      if (!error || response.headersSent || response.writableEnded || response.destroyed) {
        return;
      }

      if ("statusCode" in error && error.statusCode === 404) {
        if (knownArtifact) {
          store.markPreviewProofArtifactMissing(filePath);
          sendUnavailable();
          return;
        }

        response.status(404).json({ error: "Artifact was not found" });
        return;
      }

      response.status(500).json({ error: "Artifact could not be read" });
    };

    if (retainedUntilAt !== null && retainedUntilAt <= Date.now()) {
      void fs.rm(filePath, { force: true }).catch(() => {});
      store.markPreviewProofArtifactExpired(filePath, Date.now());
      void pruneEmptyArtifactParents(artifactsDir, filePath).catch(() => {});
      sendUnavailable();
      return;
    }

    void fs
      .access(filePath)
      .then(() => {
        response.setHeader("Cache-Control", "private, max-age=3600");
        response.setHeader("X-Artifact-Availability", "available");
        if (downloadRequested) {
          response.download(filePath, path.basename(filePath), handleSendError);
          return;
        }

        if (knownArtifact?.artifact.contentType) {
          response.setHeader("Content-Type", knownArtifact.artifact.contentType);
        }
        response.sendFile(filePath, handleSendError);
      })
      .catch(() => {
        if (knownArtifact) {
          store.markPreviewProofArtifactMissing(filePath);
          sendUnavailable();
          return;
        }
        response.status(404).json({ error: "Artifact was not found" });
      });
  });

  app.post("/api/proofs/delete", async (request, response) => {
    const proofId = typeof request.body?.proofId === "string" ? request.body.proofId : "";
    if (!proofId) {
      response.status(400).json({ error: "proofId is required" });
      return;
    }

    try {
      const result = await deletePreviewProofFiles(store, artifactsDir, proofId);
      response.json({ ok: true, proofId, removedFiles: result.removedFiles });
    } catch (error) {
      const statusCode =
        typeof (error as { statusCode?: unknown })?.statusCode === "number"
          ? Number((error as { statusCode?: number }).statusCode)
          : 500;
      response.status(statusCode).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });
}
