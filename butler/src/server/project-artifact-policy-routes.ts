import path from "node:path";
import { promises as fs } from "node:fs";

import type { Express, Response } from "express";

import {
  applyServiceStartedPolicies,
  buildProjectPolicy,
  createProjectArtifactFromText,
  createProjectArtifactFromUrl,
  findProjectPolicyBySelector,
  invokeProjectPolicy,
  normalizeArtifactMetadata,
  resolveProjectPolicyArtifactIds,
  readProjectArtifactContent
} from "./project-artifacts-policies.js";
import { decorateProjectArtifactWithAccess } from "./project-artifact-access.js";
import type { RuntimeBrokerClient } from "./runtime-broker-client.js";
import type { ButlerStateStore } from "./state-store.js";
import { resolveProjectMetadata } from "./server-runtime-helpers.js";

function hasOwnBodyField(value: unknown, key: string): boolean {
  return Boolean(value) && typeof value === "object" && Object.prototype.hasOwnProperty.call(value, key);
}

export function registerProjectArtifactPolicyRoutes(input: {
  app: Express;
  artifactsDir: string;
  store: ButlerStateStore;
  runtimeBroker: RuntimeBrokerClient;
}) {
  const { app, artifactsDir, store, runtimeBroker } = input;

  function respondProjectPolicyError(response: Response, error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    const status = message.includes("ambiguous") || message.includes("Unknown project artifact id") ? 400 : 500;
    response.status(status).json({ error: message });
  }

  async function sendProjectArtifactFile(response: Response, artifact = null as ReturnType<typeof store.getProjectArtifact>) {
    if (!artifact) {
      response.status(404).json({ error: "Artifact not found" });
      return;
    }

    const filePath = path.resolve(artifact.filePath);
    const rootPath = path.resolve(artifactsDir);
    if (filePath !== rootPath && !filePath.startsWith(`${rootPath}${path.sep}`)) {
      response.status(400).json({ error: "Artifact path is invalid" });
      return;
    }

    try {
      await fs.access(filePath);
    } catch {
      response.status(404).json({ error: "Artifact file is missing" });
      return;
    }

    const downloadRequested = response.req.query.download === "1";
    response.setHeader("Cache-Control", "private, max-age=3600");
    if (downloadRequested) {
      response.download(filePath, artifact.fileName);
      return;
    }
    response.type(artifact.contentType);
    response.sendFile(filePath);
  }

  app.get("/api/project-artifacts/:projectId", (request, response) => {
    const projectId = typeof request.params.projectId === "string" ? request.params.projectId.trim() : "";
    if (!projectId) {
      response.status(400).json({ error: "projectId is required" });
      return;
    }

    response.json({ artifacts: store.listProjectArtifacts(projectId).map((artifact) => decorateProjectArtifactWithAccess(artifact)) });
  });

  app.get("/api/project-artifacts/:projectId/:artifactId", async (request, response) => {
    const projectId = typeof request.params.projectId === "string" ? request.params.projectId.trim() : "";
    const artifactId = typeof request.params.artifactId === "string" ? request.params.artifactId.trim() : "";
    if (!projectId || !artifactId) {
      response.status(400).json({ error: "projectId and artifactId are required" });
      return;
    }

    const artifact = store.getProjectArtifact(projectId, artifactId);
    if (!artifact) {
      response.status(404).json({ error: "Artifact not found" });
      return;
    }

    try {
      const content = await readProjectArtifactContent(artifact);
      response.json({ artifact: decorateProjectArtifactWithAccess(artifact), content: content.content, contentTruncated: content.truncated });
    } catch (error) {
      response.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  // Trusted appliance boundary: these file links are intentionally unauthenticated because
  // Butler, Codex, previews, and local operators all live inside the same control-plane trust zone.
  // If Butler is ever exposed outside that appliance boundary, move this route behind signed or scoped links.
  app.get("/api/project-artifacts/:projectId/:artifactId/file", async (request, response) => {
    const projectId = typeof request.params.projectId === "string" ? request.params.projectId.trim() : "";
    const artifactId = typeof request.params.artifactId === "string" ? request.params.artifactId.trim() : "";
    if (!projectId || !artifactId) {
      response.status(400).json({ error: "projectId and artifactId are required" });
      return;
    }

    const artifact = store.getProjectArtifact(projectId, artifactId);
    await sendProjectArtifactFile(response, artifact);
  });

  app.post("/api/project-artifacts/save-text", async (request, response) => {
    const title = typeof request.body?.title === "string" ? request.body.title.trim() : "";
    const text = typeof request.body?.text === "string" ? request.body.text : "";
    const kind =
      request.body?.kind === "seed" ||
      request.body?.kind === "reference" ||
      request.body?.kind === "download" ||
      request.body?.kind === "research" ||
      request.body?.kind === "report"
        ? request.body.kind
        : "other";
    const threadId = typeof request.body?.threadId === "string" ? request.body.threadId : null;
    const cwd = typeof request.body?.cwd === "string" ? request.body.cwd.trim() : "";
    const thread = threadId ? store.getThread(threadId) ?? null : null;
    const projectId = typeof request.body?.projectId === "string" ? request.body.projectId.trim() : "";
    const projectLabel = typeof request.body?.projectLabel === "string" ? request.body.projectLabel.trim() : "";
    if (!title || !text) {
      response.status(400).json({ error: "title and text are required" });
      return;
    }

    try {
      const project = resolveProjectMetadata(
        cwd || thread?.cwd || null,
        projectId || thread?.supervisor.projectId || "project",
        projectLabel || thread?.supervisor.projectLabel || "project"
      );
      const artifact = await createProjectArtifactFromText({
        artifactsDir,
        projectId: project.id,
        projectLabel: project.label,
        threadId,
        kind,
        title,
        description: typeof request.body?.description === "string" ? request.body.description : null,
        fileName: typeof request.body?.fileName === "string" ? request.body.fileName : null,
        contentType: typeof request.body?.contentType === "string" ? request.body.contentType : null,
        text,
        tags: Array.isArray(request.body?.tags) ? request.body.tags : [],
        metadata: normalizeArtifactMetadata(request.body?.metadata)
      });
      store.upsertProjectArtifact(artifact);
      if (threadId) {
        store.addEvent(threadId, "artifact/save-text", `Saved project artifact ${artifact.title}`);
      }
      response.json({ ok: true, artifact: decorateProjectArtifactWithAccess(artifact) });
    } catch (error) {
      response.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post("/api/project-artifacts/download", async (request, response) => {
    const title = typeof request.body?.title === "string" ? request.body.title.trim() : "";
    const url = typeof request.body?.url === "string" ? request.body.url.trim() : "";
    const kind =
      request.body?.kind === "seed" ||
      request.body?.kind === "reference" ||
      request.body?.kind === "download" ||
      request.body?.kind === "research" ||
      request.body?.kind === "report"
        ? request.body.kind
        : "download";
    const threadId = typeof request.body?.threadId === "string" ? request.body.threadId : null;
    const cwd = typeof request.body?.cwd === "string" ? request.body.cwd.trim() : "";
    const thread = threadId ? store.getThread(threadId) ?? null : null;
    const projectId = typeof request.body?.projectId === "string" ? request.body.projectId.trim() : "";
    const projectLabel = typeof request.body?.projectLabel === "string" ? request.body.projectLabel.trim() : "";
    if (!title || !url) {
      response.status(400).json({ error: "title and url are required" });
      return;
    }

    try {
      const project = resolveProjectMetadata(
        cwd || thread?.cwd || null,
        projectId || thread?.supervisor.projectId || "project",
        projectLabel || thread?.supervisor.projectLabel || "project"
      );
      const artifact = await createProjectArtifactFromUrl({
        artifactsDir,
        projectId: project.id,
        projectLabel: project.label,
        threadId,
        kind,
        title,
        description: typeof request.body?.description === "string" ? request.body.description : null,
        url,
        fileName: typeof request.body?.fileName === "string" ? request.body.fileName : null,
        contentType: typeof request.body?.contentType === "string" ? request.body.contentType : null,
        tags: Array.isArray(request.body?.tags) ? request.body.tags : [],
        metadata: normalizeArtifactMetadata(request.body?.metadata)
      });
      store.upsertProjectArtifact(artifact);
      if (threadId) {
        store.addEvent(threadId, "artifact/download", `Downloaded project artifact ${artifact.title}`);
      }
      response.json({ ok: true, artifact: decorateProjectArtifactWithAccess(artifact) });
    } catch (error) {
      response.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.get("/api/project-policies/:projectId", (request, response) => {
    const projectId = typeof request.params.projectId === "string" ? request.params.projectId.trim() : "";
    if (!projectId) {
      response.status(400).json({ error: "projectId is required" });
      return;
    }

    response.json({ policies: store.listProjectPolicies(projectId) });
  });

  app.post("/api/project-policies", (request, response) => {
    const title = typeof request.body?.title === "string" ? request.body.title.trim() : "";
    const instruction = typeof request.body?.instruction === "string" ? request.body.instruction.trim() : "";
    const threadId = typeof request.body?.threadId === "string" ? request.body.threadId : null;
    const cwd = typeof request.body?.cwd === "string" ? request.body.cwd.trim() : "";
    const thread = threadId ? store.getThread(threadId) ?? null : null;
    const projectId = typeof request.body?.projectId === "string" ? request.body.projectId.trim() : "";
    const projectLabel = typeof request.body?.projectLabel === "string" ? request.body.projectLabel.trim() : "";

    if (!title || !instruction) {
      response.status(400).json({ error: "title and instruction are required" });
      return;
    }

    try {
      const project = resolveProjectMetadata(
        cwd || thread?.cwd || null,
        projectId || thread?.supervisor.projectId || "project",
        projectLabel || thread?.supervisor.projectLabel || "project"
      );
      const existingId = typeof request.body?.policyId === "string" ? request.body.policyId.trim() : "";
      const existing = existingId ? store.getProjectPolicy(project.id, existingId) : null;
      const artifacts = resolveProjectPolicyArtifactIds({
        store,
        projectId: project.id,
        artifactIds: hasOwnBodyField(request.body, "artifacts")
          ? Array.isArray(request.body?.artifacts)
            ? request.body.artifacts
            : []
          : undefined
      });
      const policy = buildProjectPolicy({
        projectId: project.id,
        projectLabel: project.label,
        title,
        instruction,
        artifacts,
        triggers: hasOwnBodyField(request.body, "triggers")
          ? Array.isArray(request.body?.triggers)
            ? request.body.triggers
            : []
          : undefined,
        policyId: existingId || null,
        existing
      });
      const saved = store.upsertProjectPolicy(policy);
      if (threadId) {
        store.addEvent(threadId, "policy/remember", `Saved project policy ${saved.title}`);
      }
      response.json({ ok: true, policy: saved });
    } catch (error) {
      respondProjectPolicyError(response, error);
    }
  });

  app.post("/api/project-policies/invoke", async (request, response) => {
    const selector = typeof request.body?.selector === "string" ? request.body.selector.trim() : "";
    const serviceId = typeof request.body?.serviceId === "string" ? request.body.serviceId.trim() : "";
    const cwd = typeof request.body?.cwd === "string" ? request.body.cwd.trim() : "";
    const threadId = typeof request.body?.threadId === "string" ? request.body.threadId : null;
    const thread = threadId ? store.getThread(threadId) ?? null : null;
    const projectId = typeof request.body?.projectId === "string" ? request.body.projectId.trim() : "";
    const projectLabel = typeof request.body?.projectLabel === "string" ? request.body.projectLabel.trim() : "";
    if (!selector) {
      response.status(400).json({ error: "selector is required" });
      return;
    }

    try {
      const project = resolveProjectMetadata(
        cwd || thread?.cwd || null,
        projectId || thread?.supervisor.projectId || "project",
        projectLabel || thread?.supervisor.projectLabel || "project"
      );
      const policy = findProjectPolicyBySelector({ store, projectId: project.id, selector });
      if (!policy) {
        response.status(404).json({ error: "Policy not found" });
        return;
      }
      const service = serviceId ? store.getServiceLease(serviceId) ?? null : null;
      const stack = service?.stackId ? store.getStackLease(service.stackId) ?? null : null;
      const result = await invokeProjectPolicy({
        store,
        runtimeBroker,
        policy,
        service,
        stack
      });
      response.json({ ok: true, policy, result });
    } catch (error) {
      respondProjectPolicyError(response, error);
    }
  });

  return {
    applyServiceStartedPoliciesForServer: async (service: Parameters<typeof applyServiceStartedPolicies>[0]["service"], stack: Parameters<typeof applyServiceStartedPolicies>[0]["stack"]) =>
      applyServiceStartedPolicies({
        artifactsDir,
        store,
        runtimeBroker,
        service,
        stack
      })
  };
}
