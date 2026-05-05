import { promises as fs } from "node:fs";
import path from "node:path";

import type { Express } from "express";

import { decorateProjectArtifactWithAccess } from "./project-artifact-access.js";
import { createProjectArtifactFromFile, normalizeArtifactMetadata } from "./project-artifacts-policies.js";
import type { ButlerStateStore } from "./state-store.js";

type ThreadArtifactSource = "generated-image";
type ThreadArtifactKind = "image" | "video" | "markdown" | "pdf" | "html" | "other";

type ThreadArtifactView = {
  id: string;
  threadId: string;
  source: ThreadArtifactSource;
  kind: ThreadArtifactKind;
  label: string;
  fileName: string;
  contentType: string;
  sizeBytes: number | null;
  createdAt: number;
  url: string | null;
  downloadUrl: string | null;
  previewKind: "image" | "video" | null;
  promotedProjectArtifactId: string | null;
};

function generatedImageContentType(fileName: string): string {
  const lower = fileName.toLowerCase();
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".webp")) return "image/webp";
  return "application/octet-stream";
}

function threadArtifactId(source: ThreadArtifactSource, key: string): string {
  return `${source}:${Buffer.from(key).toString("base64url")}`;
}

export function registerThreadArtifactRoutes(input: {
  app: Express;
  artifactsDir: string;
  codexHomeDir: string;
  store: ButlerStateStore;
}): void {
  const { app, artifactsDir, codexHomeDir, store } = input;

  async function listThreadGeneratedImageArtifacts(threadId: string): Promise<Array<ThreadArtifactView & { filePath: string }>> {
    const threadImageDir = path.join(codexHomeDir, "generated_images", threadId);
    const entries = await fs.readdir(threadImageDir, { withFileTypes: true }).catch(() => []);
    const encodedThreadId = encodeURIComponent(threadId);
    return Promise.all(
      entries
        .filter((entry) => entry.isFile() && /\.(?:png|jpe?g|webp)$/i.test(entry.name))
        .map(async (entry) => {
          const filePath = path.join(threadImageDir, entry.name);
          const stats = await fs.stat(filePath);
          const encodedName = encodeURIComponent(entry.name);
          return {
            id: threadArtifactId("generated-image", entry.name),
            threadId,
            source: "generated-image" as const,
            kind: "image" as const,
            label: entry.name,
            fileName: entry.name,
            contentType: generatedImageContentType(entry.name),
            sizeBytes: stats.size,
            createdAt: stats.birthtimeMs || stats.mtimeMs,
            url: `/api/threads/${encodedThreadId}/generated-images/${encodedName}`,
            downloadUrl: `/api/threads/${encodedThreadId}/generated-images/${encodedName}?download=1`,
            previewKind: "image" as const,
            promotedProjectArtifactId: null,
            filePath
          };
        })
    );
  }

  async function listThreadArtifacts(threadId: string): Promise<Array<ThreadArtifactView & { filePath: string }>> {
    const thread = store.getThread(threadId);
    const projectArtifacts = thread ? store.listProjectArtifacts(thread.supervisor.projectId) : [];
    const promotedByThreadArtifactId = new Map(
      projectArtifacts
        .filter((artifact) => artifact.source.createdByThreadId === threadId && artifact.metadata.threadArtifactId)
        .map((artifact) => [artifact.metadata.threadArtifactId, artifact.id])
    );
    const artifacts = (await listThreadGeneratedImageArtifacts(threadId)).sort((left, right) => left.createdAt - right.createdAt);
    return artifacts.map((artifact) => ({
      ...artifact,
      promotedProjectArtifactId: promotedByThreadArtifactId.get(artifact.id) ?? null
    }));
  }

  app.get("/api/threads/:threadId/artifacts", async (request, response) => {
    const threadId = typeof request.params.threadId === "string" ? request.params.threadId : "";
    if (!/^[a-z0-9-]+$/i.test(threadId)) {
      response.status(400).json({ error: "threadId is invalid" });
      return;
    }

    const artifacts = await listThreadArtifacts(threadId);
    response.json({ artifacts: artifacts.map(({ filePath: _filePath, ...artifact }) => artifact) });
  });

  app.post("/api/threads/:threadId/artifacts/promote", async (request, response) => {
    const threadId = typeof request.params.threadId === "string" ? request.params.threadId : "";
    const artifactId = typeof request.body?.artifactId === "string" ? request.body.artifactId.trim() : "";
    if (!/^[a-z0-9-]+$/i.test(threadId) || !artifactId) {
      response.status(400).json({ error: "threadId and artifactId are required" });
      return;
    }

    const thread = store.getThread(threadId);
    if (!thread) {
      response.status(404).json({ error: "Thread not found" });
      return;
    }

    const threadArtifact = (await listThreadArtifacts(threadId)).find((artifact) => artifact.id === artifactId) ?? null;
    if (!threadArtifact) {
      response.status(404).json({ error: "Thread artifact not found" });
      return;
    }

    if (threadArtifact.promotedProjectArtifactId) {
      const existing = store.getProjectArtifact(thread.supervisor.projectId, threadArtifact.promotedProjectArtifactId);
      response.json({ ok: true, artifact: existing ? decorateProjectArtifactWithAccess(existing) : null });
      return;
    }

    try {
      const artifact = await createProjectArtifactFromFile({
        artifactsDir,
        projectId: thread.supervisor.projectId,
        projectLabel: thread.supervisor.projectLabel,
        threadId,
        kind: "reference",
        title: typeof request.body?.title === "string" && request.body.title.trim() ? request.body.title.trim() : threadArtifact.label,
        description: typeof request.body?.description === "string" ? request.body.description : null,
        sourceFilePath: threadArtifact.filePath,
        fileName: threadArtifact.fileName,
        contentType: threadArtifact.contentType,
        tags: Array.isArray(request.body?.tags) ? request.body.tags : ["thread-artifact"],
        metadata: {
          ...normalizeArtifactMetadata(request.body?.metadata),
          threadArtifactId: threadArtifact.id,
          threadArtifactSource: threadArtifact.source,
          threadArtifactKind: threadArtifact.kind
        }
      });
      const saved = store.upsertProjectArtifact(artifact);
      store.addEvent(threadId, "artifact/promote", `Kept artifact ${saved.title}`);
      response.json({ ok: true, artifact: decorateProjectArtifactWithAccess(saved) });
    } catch (error) {
      response.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.get("/api/threads/:threadId/generated-images", async (request, response) => {
    const threadId = typeof request.params.threadId === "string" ? request.params.threadId : "";
    if (!/^[a-z0-9-]+$/i.test(threadId)) {
      response.status(400).json({ error: "threadId is invalid" });
      return;
    }

    const images = (await listThreadGeneratedImageArtifacts(threadId)).map((artifact) => ({
      id: artifact.fileName.replace(/\.[^.]+$/, ""),
      fileName: artifact.fileName,
      sizeBytes: artifact.sizeBytes ?? 0,
      createdAt: artifact.createdAt,
      url: artifact.url,
      downloadUrl: artifact.downloadUrl
    }));
    response.json({ images });
  });

  app.get("/api/threads/:threadId/generated-images/:fileName", async (request, response) => {
    const threadId = typeof request.params.threadId === "string" ? request.params.threadId : "";
    const fileName = typeof request.params.fileName === "string" ? request.params.fileName : "";
    if (!/^[a-z0-9-]+$/i.test(threadId) || !/^[a-z0-9_.-]+\.(?:png|jpe?g|webp)$/i.test(fileName)) {
      response.status(400).json({ error: "generated image path is invalid" });
      return;
    }

    const threadImageDir = path.resolve(codexHomeDir, "generated_images", threadId);
    const filePath = path.resolve(threadImageDir, fileName);
    if (filePath !== threadImageDir && !filePath.startsWith(`${threadImageDir}${path.sep}`)) {
      response.status(400).json({ error: "generated image path is invalid" });
      return;
    }

    const stats = await fs.stat(filePath).catch(() => null);
    if (!stats?.isFile()) {
      response.status(404).json({ error: "Generated image not found" });
      return;
    }

    if (request.query.download === "1") {
      response.download(filePath, fileName);
      return;
    }

    response.type(path.extname(fileName).slice(1));
    response.sendFile(filePath);
  });
}
