import { promises as fs } from "node:fs";
import crypto from "node:crypto";
import http from "node:http";
import path from "node:path";

import express from "express";
import httpProxy from "http-proxy";

import { ButlerAgentService } from "./butler-agent.js";
import { CodexAppServerClient } from "./codex-client.js";
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
const serviceTemplateConfigPath = process.env.MANOR_SERVICE_TEMPLATE_CONFIG ?? "/opt/manor/config/service-templates.json";
const hotReloadEnabled = process.env.BUTLER_HOT_RELOAD === "1";
const publicPort = Number(process.env.BUTLER_PUBLIC_PORT ?? port);

const uiStatePath = path.join(stateDir, "butler-ui.json");
const sessionDir = path.join(stateDir, "pi-sessions");
const staticDir = path.resolve(process.cwd(), "dist/web");
const indexTemplatePath = path.resolve(process.cwd(), "index.html");

const store = new ButlerStateStore(uiStatePath);
await store.load();

const codexClient = new CodexAppServerClient(codexBaseUrl, store, codexHomeDir);
const runtimeBroker = new RuntimeBrokerClient(runtimeBrokerUrl);
const serviceTemplates = await loadServiceTemplates(serviceTemplateConfigPath);
const serviceTemplateMap = new Map(serviceTemplates.map((template) => [template.id, template]));
const butlerAgent = new ButlerAgentService({
  store,
  codexClient,
  runtimeBroker,
  serviceTemplates,
  piAuthPath: path.join(piAgentDir, "auth.json"),
  codexAuthPath: path.join(codexHomeDir, "auth.json"),
  codexConfigDir,
  sessionDir
});

await fs.mkdir(stateDir, { recursive: true });
await fs.mkdir(piAgentDir, { recursive: true });

await butlerAgent.start();
codexClient.start();

const app = express();
app.use(express.json());
const server = http.createServer(app);
const previewProxy = httpProxy.createProxyServer({
  changeOrigin: false,
  ws: true
});

function resolvePreviewProxyTarget(leaseId: string): string | null {
  const lease = store.getPreviewLease(leaseId);
  if (!lease || lease.status === "stopped") {
    return null;
  }

  return `http://${lease.targetHost}:${lease.targetPort}`;
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

app.get("/api/bootstrap", (_request, response) => {
  response.json(currentSnapshot());
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
  const text = typeof request.body?.text === "string" ? request.body.text.trim() : "";
  if (!text) {
    response.status(400).json({ error: "text is required" });
    return;
  }

  try {
    butlerAgent.prompt(text);
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
  const text = typeof request.body?.text === "string" ? request.body.text.trim() : "";
  if (!threadId || !text) {
    response.status(400).json({ error: "threadId and text are required" });
    return;
  }

  try {
    await codexClient.sendMessage(threadId, text);
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

app.post("/api/previews/start", async (request, response) => {
  const title = typeof request.body?.title === "string" ? request.body.title.trim() : "";
  const cwd = typeof request.body?.cwd === "string" ? request.body.cwd.trim() : "";
  const command = typeof request.body?.command === "string" ? request.body.command.trim() : "";
  const portValue = typeof request.body?.port === "number" ? request.body.port : Number(request.body?.port ?? 0);
  const threadId = typeof request.body?.threadId === "string" ? request.body.threadId : null;
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

  if (!title || !cwd || !command || !Number.isFinite(portValue) || portValue <= 0) {
    response.status(400).json({ error: "title, cwd, command, and port are required" });
    return;
  }

  try {
    const thread = threadId ? store.getThread(threadId) ?? null : null;
    const lease = await runtimeBroker.createLease({
      leaseId: crypto.randomUUID(),
      threadId,
      projectId: thread?.supervisor.projectId ?? "preview",
      projectLabel: thread?.supervisor.projectLabel ?? "preview",
      title,
      worktreePath: cwd,
      branchName: null,
      targetPort: portValue,
      command,
      image,
      egressProfile,
      egressDomains
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
    await runtimeBroker.stopLease(leaseId);
    store.removePreviewLease(leaseId);
    response.json({ ok: true });
  } catch (error) {
    response.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

app.post("/api/services/start", async (request, response) => {
  const templateId = typeof request.body?.templateId === "string" ? request.body.templateId.trim() : "";
  const title = typeof request.body?.title === "string" ? request.body.title.trim() : "";
  const threadId = typeof request.body?.threadId === "string" ? request.body.threadId : null;
  const cwd = typeof request.body?.cwd === "string" ? request.body.cwd.trim() : "";
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
    const serviceId = crypto.randomUUID();
    const mergedEnv = { ...template.envDefaults, ...env };
    const effectiveTitle = title || `${template.label} ${serviceId.slice(0, 8)}`;

    if (template.runtimeKind === "embedded") {
      const worktreePath = cwd || thread?.cwd || "/repos";
      const relativePath = template.fileName ?? ".manor/sqlite/app.db";
      const absolutePath = path.join(worktreePath, relativePath);
      await fs.mkdir(path.dirname(absolutePath), { recursive: true });
      const handle = await fs.open(absolutePath, "a");
      await handle.close();

      const now = Date.now();
      const lease = toServiceLeaseView({
        id: serviceId,
        threadId,
        projectId: thread?.supervisor.projectId ?? "service",
        projectLabel: thread?.supervisor.projectLabel ?? "service",
        title: effectiveTitle,
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
      projectId: thread?.supervisor.projectId ?? "service",
      projectLabel: thread?.supervisor.projectLabel ?? "service",
      title: effectiveTitle,
      templateId: template.id,
      templateLabel: template.label,
      runtimeKind: template.runtimeKind,
      targetPort: template.defaultPort,
      image: template.image,
      command: template.command,
      env: mergedEnv
    });
    const lease = toServiceLeaseView({
      id: service.id,
      threadId: service.threadId,
      projectId: service.projectId,
      projectLabel: service.projectLabel,
      title: service.title,
      template,
      containerName: service.containerName,
      targetHost: service.targetHost,
      targetPort: service.targetPort,
      worktreePath: service.worktreePath,
      status: service.status,
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

  const suffix = match?.[2] ?? "/";
  const search = request.url.includes("?") ? request.url.slice(request.url.indexOf("?")) : "";
  request.url = `${suffix}${search}`;
  previewProxy.web(request, response, { target }, (error: Error) => {
    response.status(502).json({ error: error instanceof Error ? error.message : "Preview proxy failed" });
  });
});

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
