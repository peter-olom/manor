import { promises as fs } from "node:fs";
import crypto from "node:crypto";
import http from "node:http";
import path from "node:path";

import express from "express";
import httpProxy from "http-proxy";

import { ButlerAgentService } from "./butler-agent.js";
import { CodexAppServerClient } from "./codex-client.js";
import { CodexHarnessService } from "./codex-harness.js";
import { ImageReferenceStore } from "./image-store.js";
import { decoratePreviewVerification } from "./preview-verification.js";
import { resolveWorkspaceProjectInfo } from "./repo-worktree.js";
import { RuntimeBrokerClient } from "./runtime-broker-client.js";
import { loadServiceTemplates, toServiceLeaseView } from "./service-templates.js";
import { ButlerStateStore } from "./state-store.js";

const port = Number(process.env.BUTLER_PORT ?? "8080");
const codexBaseUrl = process.env.CODEX_BASE_URL ?? "ws://codex-box:8080";
const piAgentDir = process.env.PI_AGENT_DIR ?? "/home/butler/.pi/agent";
const stateDir = process.env.MANOR_STATE_DIR ?? "/state";
const codexHomeDir = process.env.CODEX_SHARED_HOME_DIR ?? "/codex-home";
const codexConfigDir = process.env.CODEX_SHARED_CONFIG_DIR ?? "/codex-config";
const runtimeBrokerUrl = process.env.RUNTIME_BROKER_URL ?? "http://runtime-broker:8090";
const runtimeBrokerToken = process.env.RUNTIME_BROKER_TOKEN ?? null;
const serviceTemplateConfigPath = process.env.MANOR_SERVICE_TEMPLATE_CONFIG ?? "/opt/manor/config/service-templates.json";
const hotReloadEnabled = process.env.BUTLER_HOT_RELOAD === "1";
const publicPort = Number(process.env.BUTLER_PUBLIC_PORT ?? port);
const previewLeaseTtlMs = Number(process.env.MANOR_PREVIEW_LEASE_TTL_MS ?? `${30 * 60 * 1000}`);
const stackLeaseTtlMs = Number(process.env.MANOR_STACK_LEASE_TTL_MS ?? `${120 * 60 * 1000}`);
const serviceLeaseTtlMs = Number(process.env.MANOR_SERVICE_LEASE_TTL_MS ?? `${120 * 60 * 1000}`);
const leaseReapGraceMs = Number(process.env.MANOR_LEASE_REAP_GRACE_MS ?? `${10 * 60 * 1000}`);
const leaseSweepIntervalMs = Number(process.env.MANOR_LEASE_SWEEP_INTERVAL_MS ?? "60000");
const artifactRetentionMs = Number(process.env.MANOR_ARTIFACT_RETENTION_MS ?? `${14 * 24 * 60 * 60 * 1000}`);
const artifactSweepIntervalMs = Number(process.env.MANOR_ARTIFACT_SWEEP_INTERVAL_MS ?? `${60 * 60 * 1000}`);
const imageReferenceDir = process.env.MANOR_IMAGE_REFERENCE_DIR ?? path.resolve(process.cwd(), "../artifacts/manor-images");
const artifactsDir = path.resolve(process.env.MANOR_ARTIFACTS_DIR ?? "/artifacts");

const uiStatePath = path.join(stateDir, "butler-ui.json");
const sessionDir = path.join(stateDir, "pi-sessions");
const staticDir = path.resolve(process.cwd(), "dist/web");
const indexTemplatePath = path.resolve(process.cwd(), "index.html");

const store = new ButlerStateStore(uiStatePath, {
  previewLeaseTtlMs,
  stackLeaseTtlMs,
  serviceLeaseTtlMs,
  leaseReapGraceMs,
  artifactRetentionMs
});
await store.load();
const imageStore = new ImageReferenceStore(imageReferenceDir);
await imageStore.load();
const runtimeBroker = new RuntimeBrokerClient(runtimeBrokerUrl, runtimeBrokerToken);
const serviceTemplates = await loadServiceTemplates(serviceTemplateConfigPath);
const serviceTemplateMap = new Map(serviceTemplates.map((template) => [template.id, template]));
const codexHarness = new CodexHarnessService({
  codexHomeDir,
  stateDir,
  store,
  runtimeBroker,
  serviceTemplates
});
await codexHarness.load();
const codexClient = new CodexAppServerClient(codexBaseUrl, store, codexHomeDir, {
  onThreadCapabilityReady: async (threadId, cwd) => {
    await codexHarness.ensureThreadCapability(threadId, cwd);
  },
  onThreadCapabilityRemoved: async (threadId) => {
    await codexHarness.revokeThreadCapability(threadId);
  }
});
const butlerAgent = new ButlerAgentService({
  store,
  codexClient,
  runtimeBroker,
  serviceTemplates,
  piAuthPath: path.join(piAgentDir, "auth.json"),
  codexAuthPath: path.join(codexHomeDir, "auth.json"),
  codexConfigDir,
  sessionDir,
  imageStore
});

await fs.mkdir(stateDir, { recursive: true });
await fs.mkdir(piAgentDir, { recursive: true });

await butlerAgent.start();
codexClient.start();

const app = express();
app.use(express.json({ limit: "20mb" }));
const server = http.createServer(app);
const previewProxy = httpProxy.createProxyServer({
  changeOrigin: false,
  ws: true
});

function resolvePreviewProxyTarget(leaseId: string): string | null {
  const lease = store.getPreviewLease(leaseId);
  if (!lease || lease.status === "stopped" || lease.status === "stopping") {
    return null;
  }

  return runtimeBrokerUrl;
}

let viteDevServer: import("vite").ViteDevServer | null = null;

if (hotReloadEnabled) {
  const { createServer } = await import("vite");
  viteDevServer = await createServer({
    root: process.cwd(),
    appType: "custom",
    server: {
      middlewareMode: true,
      host: "0.0.0.0",
      watch: {
        usePolling: false
      },
      hmr: {
        protocol: "ws",
        clientPort: publicPort
      }
    }
  });
}

const sseClients = new Set<express.Response>();
const sseHeartbeatMs = 15000;

function currentSnapshot() {
  return store.getSnapshot(butlerAgent.getSnapshot(), codexClient.getConnectionState());
}

function matchStackSelector<T extends { id: string; title: string }>(stacks: T[], selector: string): T | null {
  const normalizedSelector = selector.trim();
  if (!normalizedSelector) {
    return null;
  }

  const directIdMatch = stacks.find((stack) => stack.id === normalizedSelector);
  if (directIdMatch) {
    return directIdMatch;
  }

  const exactTitleMatches = stacks.filter((stack) => stack.title === normalizedSelector);
  if (exactTitleMatches.length === 1) {
    return exactTitleMatches[0];
  }

  const foldedSelector = normalizedSelector.toLowerCase();
  const foldedTitleMatches = stacks.filter((stack) => stack.title.trim().toLowerCase() === foldedSelector);
  if (foldedTitleMatches.length === 1) {
    return foldedTitleMatches[0];
  }

  return null;
}

function resolveProjectMetadata(cwd: string | null | undefined, fallbackId: string, fallbackLabel: string) {
  const project = resolveWorkspaceProjectInfo(cwd);
  if (project.id === "unknown") {
    return {
      id: fallbackId,
      label: fallbackLabel
    };
  }
  return project;
}

async function resolveRequestedStack(stackSelector: string | null, threadId: string | null): Promise<{
  id: string;
  threadId: string | null;
  worktreePath: string | null;
  title: string;
} | null> {
  if (!stackSelector) {
    return null;
  }

  const visibleStacks = store
    .listStackLeases()
    .filter((stack) => !threadId || stack.threadId === threadId || !stack.threadId);
  const storedMatch = matchStackSelector(visibleStacks, stackSelector);
  if (storedMatch) {
    return storedMatch;
  }

  const brokerMatch = matchStackSelector(await runtimeBroker.listStacks(threadId), stackSelector);
  if (brokerMatch) {
    store.upsertStackLease(brokerMatch);
    return brokerMatch;
  }

  const stack = await runtimeBroker.inspectStack(stackSelector);
  store.upsertStackLease(stack);
  return stack;
}

async function validateRequestedStack(stackId: string | null, threadId: string | null) {
  const stack = await resolveRequestedStack(stackId, threadId);
  if (!stack) {
    return null;
  }

  if (threadId && stack.threadId && stack.threadId !== threadId) {
    throw new Error(`Stack ${stack.id} belongs to a different job`);
  }

  return stack;
}

function removeStackArtifactsFromStore(stackId: string): void {
  for (const lease of store.listPreviewLeases()) {
    if (lease.stackId === stackId) {
      store.removePreviewLease(lease.id);
    }
  }

  for (const lease of store.listServiceLeases()) {
    if (lease.stackId === stackId) {
      store.removeServiceLease(lease.id);
    }
  }

  store.removeStackLease(stackId);
}

function readImageReferenceIds(body: unknown): string[] {
  if (!body || typeof body !== "object" || !("imageReferenceIds" in body)) {
    return [];
  }

  const value = (body as { imageReferenceIds?: unknown }).imageReferenceIds;
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0);
}

function decodeArtifactRelativePath(relativePath: string): string {
  return relativePath
    .split("/")
    .map((segment: string) => {
      try {
        return decodeURIComponent(segment);
      } catch {
        return segment;
      }
    })
    .join(path.sep);
}

async function pruneEmptyArtifactParents(startPath: string): Promise<void> {
  let currentPath = path.dirname(startPath);
  while (currentPath.startsWith(`${artifactsDir}${path.sep}`)) {
    try {
      const entries = await fs.readdir(currentPath);
      if (entries.length > 0) {
        return;
      }
      await fs.rmdir(currentPath);
      currentPath = path.dirname(currentPath);
    } catch {
      return;
    }
  }
}

function sendUnavailableArtifactResponse(
  response: express.Response,
  availability: "expired" | "missing",
  artifact: {
    label: string;
    fileName: string;
    retainedUntilAt: number | null;
    expiredAt: number | null;
  }
): void {
  const expired = availability === "expired";
  const message = expired
    ? "Artifact expired after the 14 day retention window."
    : "Artifact metadata is still available, but the file itself is no longer present.";
  response.setHeader("Cache-Control", "private, no-store");
  response.setHeader("X-Artifact-Availability", availability);
  response.setHeader("X-Artifact-Error", message);
  response.status(410).json({
    error: message,
    availability,
    label: artifact.label,
    fileName: artifact.fileName,
    retainedUntilAt: artifact.retainedUntilAt,
    expiredAt: artifact.expiredAt
  });
}

function broadcastSnapshot(): void {
  const payload = `data: ${JSON.stringify(currentSnapshot())}\n\n`;
  for (const client of sseClients) {
    client.write(payload);
  }
}

store.on("change", broadcastSnapshot);
codexClient.on("change", broadcastSnapshot);
butlerAgent.on("change", broadcastSnapshot);

app.get("/api/health", (_request, response) => {
  response.json({
    ok: true,
    codex: codexClient.getConnectionState(),
    butler: butlerAgent.getSnapshot()
  });
});

app.get("/livez", (_request, response) => {
  response.json({ ok: true });
});

app.get("/api/bootstrap", (_request, response) => {
  response.json(currentSnapshot());
});

app.post("/api/images/upload", async (request, response) => {
  const name = typeof request.body?.name === "string" ? request.body.name : "";
  const mimeType = typeof request.body?.mimeType === "string" ? request.body.mimeType : "";
  const data = typeof request.body?.data === "string" ? request.body.data : "";
  const sizeBytes = typeof request.body?.sizeBytes === "number" ? request.body.sizeBytes : undefined;

  if (!name || !mimeType || !data) {
    response.status(400).json({ error: "name, mimeType, and data are required" });
    return;
  }

  try {
    const image = await imageStore.create({ name, mimeType, data, sizeBytes });
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

  response.json({ images: imageStore.list(limit) });
});

app.get("/api/images/:imageId", (request, response) => {
  const imageId = typeof request.params.imageId === "string" ? request.params.imageId : "";
  const filePath = imageStore.getFilePath(imageId);
  const image = imageStore.get(imageId);

  if (!filePath || !image) {
    response.status(404).json({ error: "Image reference was not found" });
    return;
  }

  response.setHeader("Cache-Control", "private, max-age=31536000, immutable");
  response.type(image.mimeType);
  response.sendFile(filePath);
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
    if (!error) {
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
    void pruneEmptyArtifactParents(filePath).catch(() => {});
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

app.get("/api/chat/history", (request, response) => {
  const beforeRaw = Array.isArray(request.query.before) ? request.query.before[0] : request.query.before;
  const limitRaw = Array.isArray(request.query.limit) ? request.query.limit[0] : request.query.limit;
  const before = typeof beforeRaw === "string" && beforeRaw.length > 0 ? Number(beforeRaw) : null;
  const limit = typeof limitRaw === "string" && limitRaw.length > 0 ? Number(limitRaw) : 250;

  if (before !== null && !Number.isFinite(before)) {
    response.status(400).json({ error: "before must be a number" });
    return;
  }

  if (!Number.isFinite(limit)) {
    response.status(400).json({ error: "limit must be a number" });
    return;
  }

  response.json(butlerAgent.getMessagePage(before, limit));
});

app.post("/api/codex-harness/action", async (request, response) => {
  const token = typeof request.body?.token === "string" ? request.body.token : "";
  const action = typeof request.body?.action === "string" ? request.body.action : "";
  const params = request.body?.params && typeof request.body.params === "object" ? (request.body.params as Record<string, unknown>) : {};

  if (!token || !action) {
    response.status(400).json({ error: "token and action are required" });
    return;
  }

  try {
    const result = await codexHarness.handleAction({ token, action, params });
    response.json({ ok: true, ...result });
  } catch (error) {
    response.status(400).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

app.get("/api/events", (request, response) => {
  response.setHeader("Content-Type", "text/event-stream");
  response.setHeader("Cache-Control", "no-cache");
  response.setHeader("Connection", "keep-alive");
  response.setHeader("X-Accel-Buffering", "no");
  response.flushHeaders();
  response.write(`data: ${JSON.stringify(currentSnapshot())}\n\n`);
  sseClients.add(response);
  const heartbeat = setInterval(() => {
    response.write(`event: heartbeat\ndata: ${Date.now()}\n\n`);
  }, sseHeartbeatMs);

  request.on("close", () => {
    clearInterval(heartbeat);
    sseClients.delete(response);
  });
});

app.post("/api/chat/messages", async (request, response) => {
  const text = typeof request.body?.text === "string" ? request.body.text : "";
  const imageReferenceIds = readImageReferenceIds(request.body);
  if (!text.trim() && imageReferenceIds.length === 0) {
    response.status(400).json({ error: "text or imageReferenceIds is required" });
    return;
  }

  try {
    const promptText = imageStore.buildPromptText(text, imageReferenceIds, { includeIds: true });
    butlerAgent.prompt(promptText, imageReferenceIds);
    response.status(202).json({ ok: true });
  } catch (error) {
    response.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

app.post("/api/chat/settings", async (request, response) => {
  const model = typeof request.body?.model === "string" ? request.body.model : "";
  const provider = typeof request.body?.provider === "string" ? request.body.provider : "";
  const thinkingLevel = typeof request.body?.thinkingLevel === "string" ? request.body.thinkingLevel : "medium";
  if (!model) {
    response.status(400).json({ error: "model is required" });
    return;
  }

  try {
    await butlerAgent.updateComposeSettings(provider, model, thinkingLevel);
    response.json({ ok: true });
  } catch (error) {
    response.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

app.post("/api/threads/messages", async (request, response) => {
  const threadId = typeof request.body?.threadId === "string" ? request.body.threadId : "";
  const text = typeof request.body?.text === "string" ? request.body.text : "";
  const imageReferenceIds = readImageReferenceIds(request.body);
  if (!threadId || (!text.trim() && imageReferenceIds.length === 0)) {
    response.status(400).json({ error: "threadId plus text or imageReferenceIds is required" });
    return;
  }

  try {
    await codexClient.sendMessage(threadId, imageStore.buildCodexInput(text, imageReferenceIds));
    response.status(202).json({ ok: true });
  } catch (error) {
    response.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

app.post("/api/threads/settings", async (request, response) => {
  const model = typeof request.body?.model === "string" ? request.body.model : "";
  const effort = typeof request.body?.effort === "string" ? request.body.effort : null;
  if (!model) {
    response.status(400).json({ error: "model is required" });
    return;
  }

  try {
    await codexClient.updateComposeSettings(model, effort);
    response.json({ ok: true });
  } catch (error) {
    response.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

app.post("/api/threads/supervision", (request, response) => {
  const threadId = typeof request.body?.threadId === "string" ? request.body.threadId : "";
  const rawLimit = request.body?.maxButlerTurns;

  if (!threadId) {
    response.status(400).json({ error: "threadId is required" });
    return;
  }

  const maxButlerTurns =
    rawLimit === null || rawLimit === "null"
      ? null
      : typeof rawLimit === "number" && Number.isFinite(rawLimit) && rawLimit > 0
        ? Math.floor(rawLimit)
        : null;

  const supervision = store.setThreadSupervisionLimit(threadId, maxButlerTurns);
  response.json({ ok: true, supervision });
});

app.post("/api/threads/delete", async (request, response) => {
  const threadId = typeof request.body?.threadId === "string" ? request.body.threadId : "";
  if (!threadId) {
    response.status(400).json({ error: "threadId is required" });
    return;
  }

  try {
    const result = await codexClient.deleteThread(threadId);
    response.json({ ok: true, ...result });
  } catch (error) {
    response.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

app.post("/api/threads/delete-all", async (_request, response) => {
  try {
    const result = await codexClient.deleteAllThreads();
    response.json({ ok: true, ...result });
  } catch (error) {
    response.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

app.post("/api/windows/open", async (request, response) => {
  const threadId = typeof request.body?.threadId === "string" ? request.body.threadId : "";
  if (!threadId) {
    response.status(400).json({ error: "threadId is required" });
    return;
  }

  try {
    await codexClient.loadThread(threadId);
    store.openWindow(threadId);
    response.json({ ok: true });
  } catch (error) {
    response.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

app.post("/api/workspace/focus", (_request, response) => {
  store.focusButler();
  response.json({ ok: true });
});

app.post("/api/windows/focus", async (request, response) => {
  const threadId = typeof request.body?.threadId === "string" ? request.body.threadId : "";
  if (!threadId) {
    response.status(400).json({ error: "threadId is required" });
    return;
  }

  try {
    await codexClient.loadThread(threadId);
    store.focusWindow(threadId);
    response.json({ ok: true });
  } catch (error) {
    response.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

app.post("/api/windows/close", (request, response) => {
  const threadId = typeof request.body?.threadId === "string" ? request.body.threadId : "";
  if (!threadId) {
    response.status(400).json({ error: "threadId is required" });
    return;
  }

  store.closeWindow(threadId);
  response.json({ ok: true });
});

app.post("/api/stacks/start", async (request, response) => {
  const title = typeof request.body?.title === "string" ? request.body.title.trim() : "";
  const threadId = typeof request.body?.threadId === "string" ? request.body.threadId : null;
  const cwd = typeof request.body?.cwd === "string" ? request.body.cwd.trim() : "";
  const storageMode = typeof request.body?.storageMode === "string" ? request.body.storageMode.trim() : "";
  const retainsVolumes = Boolean(request.body?.retainsVolumes);
  const storageKey = typeof request.body?.storageKey === "string" ? request.body.storageKey.trim() : "";
  const cloneFromStorageKey =
    typeof request.body?.cloneFromStorageKey === "string" ? request.body.cloneFromStorageKey.trim() : "";
  if (!title) {
    response.status(400).json({ error: "title is required" });
    return;
  }

  try {
    const thread = threadId ? store.getThread(threadId) ?? null : null;
    const worktreePath = cwd || thread?.cwd || null;
    const project = resolveProjectMetadata(worktreePath, thread?.supervisor.projectId ?? "stack", thread?.supervisor.projectLabel ?? "stack");
    const stack = await runtimeBroker.createStack({
      stackId: crypto.randomUUID(),
      threadId,
      projectId: project.id,
      projectLabel: project.label,
      title,
      worktreePath,
      storageMode: storageMode || null,
      retainsVolumes,
      storageKey: storageKey || null,
      cloneFromStorageKey: cloneFromStorageKey || null
    });
    store.upsertStackLease(stack);
    response.json({ ok: true, stack });
  } catch (error) {
    response.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

app.post("/api/stacks/stop", async (request, response) => {
  const stackId = typeof request.body?.stackId === "string" ? request.body.stackId : "";
  const dropVolumes = Boolean(request.body?.dropVolumes);
  if (!stackId) {
    response.status(400).json({ error: "stackId is required" });
    return;
  }

  try {
    await runtimeBroker.stopStack(stackId, { dropVolumes });
    removeStackArtifactsFromStore(stackId);
    response.json({ ok: true });
  } catch (error) {
    response.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

app.post("/api/stacks/promote", async (request, response) => {
  const stackId = typeof request.body?.stackId === "string" ? request.body.stackId.trim() : "";
  const targetStorageKey =
    typeof request.body?.targetStorageKey === "string" ? request.body.targetStorageKey.trim() : "";
  if (!stackId) {
    response.status(400).json({ error: "stackId is required" });
    return;
  }

  try {
    const result = await runtimeBroker.promoteStack({
      stackId,
      targetStorageKey: targetStorageKey || null
    });
    const stack = await runtimeBroker.inspectStack(stackId);
    store.upsertStackLease(stack);
    response.json({ ok: true, promotion: result, stack });
  } catch (error) {
    response.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

app.post("/api/stacks/pin", (request, response) => {
  const stackId = typeof request.body?.stackId === "string" ? request.body.stackId : "";
  const pinned = Boolean(request.body?.pinned);
  if (!stackId) {
    response.status(400).json({ error: "stackId is required" });
    return;
  }

  const stack = store.setStackLeasePinned(stackId, pinned);
  if (!stack) {
    response.status(404).json({ error: "Stack lease not found" });
    return;
  }

  response.json({ ok: true, stack });
});

app.post("/api/previews/start", async (request, response) => {
  const title = typeof request.body?.title === "string" ? request.body.title.trim() : "";
  const cwd = typeof request.body?.cwd === "string" ? request.body.cwd.trim() : "";
  const command = typeof request.body?.command === "string" ? request.body.command.trim() : "";
  const portValue = typeof request.body?.port === "number" ? request.body.port : Number(request.body?.port ?? 0);
  const threadId = typeof request.body?.threadId === "string" ? request.body.threadId : null;
  const stackId = typeof request.body?.stackId === "string" ? request.body.stackId.trim() : "";
  const aliases = Array.isArray(request.body?.aliases)
    ? request.body.aliases
        .map((value: unknown) => (typeof value === "string" ? value.trim() : ""))
        .filter((value: string) => value.length > 0)
    : [];
  const env =
    request.body?.env && typeof request.body.env === "object"
      ? Object.fromEntries(
          Object.entries(request.body.env as Record<string, unknown>)
            .filter((entry): entry is [string, string] => typeof entry[0] === "string" && typeof entry[1] === "string")
            .map(([key, value]) => [key.trim(), value.trim()])
            .filter(([key, value]) => key && value)
        )
      : {};
  const image = typeof request.body?.image === "string" ? request.body.image.trim() : undefined;
  const egressDomains = Array.isArray(request.body?.egressDomains)
    ? request.body.egressDomains
        .map((value: unknown) => (typeof value === "string" ? value.trim() : ""))
        .filter((value: string) => value.length > 0)
    : [];
  const egressProfile =
    typeof request.body?.egressProfile === "string" && request.body.egressProfile.trim()
      ? request.body.egressProfile.trim()
      : "none";
  const bootstrapWaitSeconds =
    typeof request.body?.bootstrapWaitSeconds === "number"
      ? request.body.bootstrapWaitSeconds
      : Number(request.body?.bootstrapWaitSeconds ?? 0);
  const bootstrapHint = typeof request.body?.bootstrapHint === "string" ? request.body.bootstrapHint.trim() : "";
  const heartbeatKind =
    typeof request.body?.heartbeatKind === "string" && request.body.heartbeatKind.trim()
      ? request.body.heartbeatKind.trim()
      : "";
  const heartbeatTarget = typeof request.body?.heartbeatTarget === "string" ? request.body.heartbeatTarget.trim() : "";
  const heartbeatIntervalSeconds =
    typeof request.body?.heartbeatIntervalSeconds === "number"
      ? request.body.heartbeatIntervalSeconds
      : Number(request.body?.heartbeatIntervalSeconds ?? 0);

  try {
    const thread = threadId ? store.getThread(threadId) ?? null : null;
    const requestedStack = await validateRequestedStack(stackId || null, threadId);
    const worktreePath = cwd || requestedStack?.worktreePath || thread?.cwd || "";
    const project = resolveProjectMetadata(worktreePath, thread?.supervisor.projectId ?? "preview", thread?.supervisor.projectLabel ?? "preview");

    if (!title || !worktreePath || !command || !Number.isFinite(portValue) || portValue <= 0) {
      response.status(400).json({ error: "title, cwd, command, and port are required" });
      return;
    }

    const lease = await runtimeBroker.createLease({
      leaseId: crypto.randomUUID(),
      threadId,
      projectId: project.id,
      projectLabel: project.label,
      title,
      stackId: requestedStack?.id ?? null,
      aliases,
      worktreePath,
      branchName: null,
      targetPort: portValue,
      command,
      image,
      egressProfile,
      egressDomains,
      bootstrapWaitSeconds: Number.isFinite(bootstrapWaitSeconds) && bootstrapWaitSeconds > 0 ? bootstrapWaitSeconds : undefined,
      bootstrapHint: bootstrapHint || undefined,
      heartbeatKind: heartbeatKind || undefined,
      heartbeatTarget: heartbeatTarget || undefined,
      heartbeatIntervalSeconds:
        Number.isFinite(heartbeatIntervalSeconds) && heartbeatIntervalSeconds > 0 ? heartbeatIntervalSeconds : undefined,
      env
    });
    store.upsertPreviewLease(lease);
    response.json({ ok: true, lease });
  } catch (error) {
    response.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

app.post("/api/previews/stop", async (request, response) => {
  const leaseId = typeof request.body?.leaseId === "string" ? request.body.leaseId : "";
  if (!leaseId) {
    response.status(400).json({ error: "leaseId is required" });
    return;
  }

  try {
    store.markPreviewLeaseStopping(leaseId);
    await runtimeBroker.stopLease(leaseId);
    store.removePreviewLease(leaseId);
    response.json({ ok: true });
  } catch (error) {
    response.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

app.post("/api/previews/verify", async (request, response) => {
  const leaseId = typeof request.body?.leaseId === "string" ? request.body.leaseId : "";
  const mode = request.body?.mode === "headful" ? "headful" : "headless";
  if (!leaseId) {
    response.status(400).json({ error: "leaseId is required" });
    return;
  }

  try {
    store.notePreviewLeaseActivity(leaseId);
    const result = decoratePreviewVerification(await runtimeBroker.verifyLease({ leaseId, mode }));
    const lease = store.recordPreviewLeaseVerification(leaseId, result);
    response.json({ ok: true, verification: result, lease });
  } catch (error) {
    response.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

app.post("/api/previews/pin", (request, response) => {
  const leaseId = typeof request.body?.leaseId === "string" ? request.body.leaseId : "";
  const pinned = Boolean(request.body?.pinned);
  if (!leaseId) {
    response.status(400).json({ error: "leaseId is required" });
    return;
  }

  const lease = store.setPreviewLeasePinned(leaseId, pinned);
  if (!lease) {
    response.status(404).json({ error: "Preview lease not found" });
    return;
  }

  response.json({ ok: true, lease });
});

app.post("/api/services/start", async (request, response) => {
  const templateId = typeof request.body?.templateId === "string" ? request.body.templateId.trim() : "";
  const title = typeof request.body?.title === "string" ? request.body.title.trim() : "";
  const threadId = typeof request.body?.threadId === "string" ? request.body.threadId : null;
  const cwd = typeof request.body?.cwd === "string" ? request.body.cwd.trim() : "";
  const stackId = typeof request.body?.stackId === "string" ? request.body.stackId.trim() : "";
  const aliases = Array.isArray(request.body?.aliases)
    ? request.body.aliases
        .map((value: unknown) => (typeof value === "string" ? value.trim() : ""))
        .filter((value: string) => value.length > 0)
    : [];
  const env =
    request.body?.env && typeof request.body.env === "object"
      ? Object.fromEntries(
          Object.entries(request.body.env as Record<string, unknown>)
            .filter((entry): entry is [string, string] => typeof entry[0] === "string" && typeof entry[1] === "string")
            .map(([key, value]) => [key.trim(), value.trim()])
            .filter(([key, value]) => key && value)
        )
      : {};

  const template = serviceTemplateMap.get(templateId);
  if (!template) {
    response.status(400).json({ error: `Unknown service template: ${templateId}` });
    return;
  }

  try {
    const thread = threadId ? store.getThread(threadId) ?? null : null;
    const requestedStack = await validateRequestedStack(stackId || null, threadId);
    const serviceId = crypto.randomUUID();
    const mergedEnv = { ...template.envDefaults, ...env };
    const effectiveTitle = title || `${template.label} ${serviceId.slice(0, 8)}`;
    const worktreePath = cwd || requestedStack?.worktreePath || thread?.cwd || "/repos";
    const project = resolveProjectMetadata(worktreePath, thread?.supervisor.projectId ?? "service", thread?.supervisor.projectLabel ?? "service");

    if (template.runtimeKind === "embedded") {
      const relativePath = template.fileName ?? ".manor/sqlite/app.db";
      const absolutePath = path.join(worktreePath, relativePath);
      await fs.mkdir(path.dirname(absolutePath), { recursive: true });
      const handle = await fs.open(absolutePath, "a");
      await handle.close();

      const now = Date.now();
      const lease = toServiceLeaseView({
        id: serviceId,
        threadId,
        projectId: project.id,
        projectLabel: project.label,
        title: effectiveTitle,
        stackId: requestedStack?.id ?? null,
        aliases,
        template,
        containerName: `embedded-${serviceId}`,
        targetHost: "local-file",
        targetPort: 0,
        worktreePath: absolutePath,
        status: "running",
        createdAt: now,
        updatedAt: now,
        lastError: null,
        env: mergedEnv
      });
      store.upsertServiceLease(lease);
      response.json({ ok: true, service: lease });
      return;
    }

    const service = await runtimeBroker.createService({
      serviceId,
      threadId,
      projectId: project.id,
      projectLabel: project.label,
      title: effectiveTitle,
      stackId: requestedStack?.id ?? null,
      aliases,
      templateId: template.id,
      templateLabel: template.label,
      runtimeKind: template.runtimeKind,
      worktreePath,
      targetPort: template.defaultPort,
      image: template.image,
      command: template.command,
      stackVolumePath: template.stackVolumePath,
      env: mergedEnv
    });
    const lease = toServiceLeaseView({
      id: service.id,
      threadId: service.threadId,
      projectId: service.projectId,
      projectLabel: service.projectLabel,
      title: service.title,
      stackId: service.stackId,
      aliases: service.aliases,
      template,
      containerName: service.containerName,
      targetHost: service.targetHost,
      targetPort: service.targetPort,
      worktreePath: service.worktreePath,
      status: service.status,
      storageKind: service.storageKind,
      sticky: service.sticky,
      volumeName: service.volumeName,
      volumeMountPath: service.volumeMountPath,
      createdAt: service.createdAt,
      updatedAt: service.updatedAt,
      lastError: service.lastError,
      env: service.env
    });
    store.upsertServiceLease(lease);
    response.json({ ok: true, service: lease });
  } catch (error) {
    response.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

app.post("/api/services/stop", async (request, response) => {
  const serviceId = typeof request.body?.serviceId === "string" ? request.body.serviceId : "";
  if (!serviceId) {
    response.status(400).json({ error: "serviceId is required" });
    return;
  }

  const lease = store.getServiceLease(serviceId);
  if (!lease) {
    response.status(404).json({ error: "Service not found" });
    return;
  }

  try {
    if (lease.runtimeKind === "container") {
      await runtimeBroker.stopService(serviceId);
    }
    store.removeServiceLease(serviceId);
    response.json({ ok: true });
  } catch (error) {
    response.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

app.post("/api/services/pin", (request, response) => {
  const serviceId = typeof request.body?.serviceId === "string" ? request.body.serviceId : "";
  const pinned = Boolean(request.body?.pinned);
  if (!serviceId) {
    response.status(400).json({ error: "serviceId is required" });
    return;
  }

  const lease = store.setServiceLeasePinned(serviceId, pinned);
  if (!lease) {
    response.status(404).json({ error: "Service not found" });
    return;
  }

  response.json({ ok: true, service: lease });
});

app.use(/^\/preview\/([^/]+)(\/.*)?$/, (request, response) => {
  const originalPath = request.originalUrl.split("?")[0] ?? request.originalUrl;
  const match = originalPath.match(/^\/preview\/([^/]+)(\/.*)?$/);
  const leaseId = match?.[1];
  if (!leaseId) {
    response.status(404).end();
    return;
  }

  const target = resolvePreviewProxyTarget(leaseId);
  if (!target) {
    response.status(404).json({ error: "Preview lease not found" });
    return;
  }

  store.notePreviewLeaseActivity(leaseId);
  const suffix = match?.[2] ?? "/";
  const search = request.url.includes("?") ? request.url.slice(request.url.indexOf("?")) : "";
  request.url = `/routes/preview/${leaseId}${suffix}${search}`;
  previewProxy.web(request, response, { target }, (error: Error) => {
    response.status(502).json({ error: error instanceof Error ? error.message : "Preview proxy failed" });
  });
});

let leaseSweepInFlight = false;
let artifactSweepInFlight = false;
let previewReconcileInFlight = false;
let serviceReconcileInFlight = false;
let stackReconcileInFlight = false;

async function sweepExpiredLeases(): Promise<void> {
  if (leaseSweepInFlight) {
    return;
  }

  leaseSweepInFlight = true;
  const expired = store.listExpiredLeaseIds();

  try {
    for (const stackId of expired.stacks) {
      try {
        const stack = store.getStackLease(stackId);
        await runtimeBroker.stopStack(stackId, { dropVolumes: Boolean(stack?.retainsVolumes) });
      } catch {
        // ignore broker cleanup failures and still evict the local lease
      }
      removeStackArtifactsFromStore(stackId);
    }

    for (const leaseId of expired.previews) {
      try {
        await runtimeBroker.stopLease(leaseId);
      } catch {
        // ignore broker cleanup failures and still evict the local lease
      }
      store.removePreviewLease(leaseId);
    }

    for (const serviceId of expired.services) {
      const lease = store.getServiceLease(serviceId);
      if (!lease) {
        continue;
      }

      if (lease.runtimeKind === "container") {
        try {
          await runtimeBroker.stopService(serviceId);
        } catch {
          // ignore broker cleanup failures and still evict the local lease
        }
      }

      store.removeServiceLease(serviceId);
    }
  } finally {
    leaseSweepInFlight = false;
  }
}

const leaseReaper = setInterval(() => {
  void sweepExpiredLeases().catch((error) => {
    console.error("Lease sweep failed", error);
  });
}, leaseSweepIntervalMs);

void sweepExpiredLeases().catch((error) => {
  console.error("Initial lease sweep failed", error);
});

async function sweepExpiredArtifacts(): Promise<void> {
  if (artifactSweepInFlight) {
    return;
  }

  artifactSweepInFlight = true;
  try {
    const now = Date.now();
    for (const proof of store.listPreviewProofs()) {
      for (const artifact of proof.verification.artifacts) {
        if (!artifact.filePath || artifact.availability !== "available") {
          continue;
        }

        const retainedUntilAt =
          typeof artifact.retainedUntilAt === "number" && Number.isFinite(artifact.retainedUntilAt)
            ? artifact.retainedUntilAt
            : proof.verification.checkedAt + artifactRetentionMs;

        if (retainedUntilAt <= now) {
          await fs.rm(artifact.filePath, { force: true }).catch(() => {});
          store.markPreviewProofArtifactExpired(artifact.filePath, now);
          await pruneEmptyArtifactParents(artifact.filePath);
          continue;
        }

        const exists = await fs
          .access(artifact.filePath)
          .then(() => true)
          .catch(() => false);
        if (!exists) {
          store.markPreviewProofArtifactMissing(artifact.filePath, now);
        }
      }
    }
  } finally {
    artifactSweepInFlight = false;
  }
}

const artifactReaper = setInterval(() => {
  void sweepExpiredArtifacts().catch((error) => {
    console.error("Artifact sweep failed", error);
  });
}, artifactSweepIntervalMs);

void sweepExpiredArtifacts().catch((error) => {
  console.error("Initial artifact sweep failed", error);
});

async function reconcileStackLeases(): Promise<void> {
  if (stackReconcileInFlight) {
    return;
  }

  stackReconcileInFlight = true;
  try {
    const brokerStacks = await runtimeBroker.listStacks();
    const brokerStackIds = new Set(brokerStacks.map((stack) => stack.id));
    const storedStacks = store.listStackLeases().filter((lease) => lease.status !== "stopped");

    for (const lease of storedStacks) {
      if (!brokerStackIds.has(lease.id)) {
        removeStackArtifactsFromStore(lease.id);
      }
    }

    for (const stack of brokerStacks) {
      store.upsertStackLease(stack);
    }
  } catch (error) {
    console.error("Stack reconcile failed", error);
  } finally {
    stackReconcileInFlight = false;
  }
}

async function reconcilePreviewLeases(): Promise<void> {
  if (previewReconcileInFlight) {
    return;
  }

  previewReconcileInFlight = true;
  try {
    const brokerLeases = await runtimeBroker.listLeases();
    const brokerLeaseIds = new Set(brokerLeases.map((lease) => lease.id));
    const storedLeases = store.listPreviewLeases().filter((lease) => lease.status !== "stopped");

    for (const lease of storedLeases) {
      if (!brokerLeaseIds.has(lease.id)) {
        store.removePreviewLease(lease.id);
      }
    }

    for (const lease of brokerLeases) {
      store.upsertPreviewLease(lease);
    }
  } catch (error) {
    console.error("Preview reconcile failed", error);
  } finally {
    previewReconcileInFlight = false;
  }
}

async function reconcileServiceLeases(): Promise<void> {
  if (serviceReconcileInFlight) {
    return;
  }

  serviceReconcileInFlight = true;
  try {
    const brokerServices = await runtimeBroker.listServices();
    const brokerServiceIds = new Set(brokerServices.map((service) => service.id));
    const storedServices = store.listServiceLeases().filter((lease) => lease.status !== "stopped" && lease.runtimeKind === "container");

    for (const lease of storedServices) {
      if (!brokerServiceIds.has(lease.id)) {
        store.removeServiceLease(lease.id);
      }
    }

    for (const service of brokerServices) {
      const template = serviceTemplateMap.get(service.templateId);
      if (!template) {
        continue;
      }
      store.upsertServiceLease(
        toServiceLeaseView({
          id: service.id,
          threadId: service.threadId,
          projectId: service.projectId,
          projectLabel: service.projectLabel,
          title: service.title,
          stackId: service.stackId,
          aliases: service.aliases,
          template,
          containerName: service.containerName,
          targetHost: service.targetHost,
          targetPort: service.targetPort,
          worktreePath: service.worktreePath,
          status: service.status,
          storageKind: service.storageKind,
          sticky: service.sticky,
          volumeName: service.volumeName,
          volumeMountPath: service.volumeMountPath,
          createdAt: service.createdAt,
          updatedAt: service.updatedAt,
          lastError: service.lastError,
          env: service.env
        })
      );
    }
  } catch (error) {
    console.error("Service reconcile failed", error);
  } finally {
    serviceReconcileInFlight = false;
  }
}

const runtimeReconciler = setInterval(() => {
  void reconcileStackLeases();
  void reconcilePreviewLeases();
  void reconcileServiceLeases();
}, 5_000);

void reconcileStackLeases();
void reconcilePreviewLeases();
void reconcileServiceLeases();

if (viteDevServer) {
  app.use(viteDevServer.middlewares);
  app.get(/.*/, async (request, response, next) => {
    try {
      const template = await fs.readFile(indexTemplatePath, "utf8");
      const html = await viteDevServer!.transformIndexHtml(request.originalUrl, template);
      response.status(200).type("html").send(html);
    } catch (error) {
      viteDevServer!.ssrFixStacktrace(error as Error);
      next(error);
    }
  });
} else {
  app.use(express.static(staticDir));
  app.get(/.*/, async (_request, response) => {
    response.sendFile(path.join(staticDir, "index.html"));
  });
}

server.listen(port, "0.0.0.0", () => {
  console.log(`Butler listening on ${port} (${hotReloadEnabled ? "hot reload" : "static"})`);
});

server.on("close", () => {
  clearInterval(leaseReaper);
  clearInterval(artifactReaper);
  clearInterval(runtimeReconciler);
});
