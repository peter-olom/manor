import express from "express";
import crypto from "node:crypto";
import Docker from "dockerode";

const port = Number(process.env.RUNTIME_BROKER_PORT ?? "8090");
const previewNetwork = process.env.RUNTIME_PREVIEW_NETWORK ?? "manor_work";
const previewProxy = process.env.RUNTIME_PREVIEW_PROXY ?? "http://preview-egress:3128";
const previewImage = process.env.RUNTIME_PREVIEW_IMAGE ?? "node:22-bookworm-slim";
const routeBase = process.env.RUNTIME_ROUTE_BASE ?? "/preview";
const docker = new Docker({ socketPath: "/var/run/docker.sock" });

const app = express();
app.use(express.json());

function toContainerName(leaseId) {
  return `manor-preview-${leaseId.replace(/[^a-zA-Z0-9_.-]/g, "").slice(0, 32)}`;
}

function buildLease(payload) {
  const id = payload.leaseId || crypto.randomUUID();
  const containerName = toContainerName(id);
  const now = Date.now();

  return {
    id,
    threadId: payload.threadId ?? null,
    projectId: payload.projectId || "unknown",
    projectLabel: payload.projectLabel || payload.projectId || "Unknown",
    title: payload.title || `Preview ${id.slice(0, 8)}`,
    worktreePath: payload.worktreePath,
    branchName: payload.branchName ?? null,
    containerName,
    targetHost: containerName,
    targetPort: Number(payload.targetPort || 3000),
    routePrefix: `${routeBase}/${id}/`,
    operatorUrl: `${routeBase}/${id}/`,
    command: payload.command,
    image: payload.image || previewImage,
    egressProfile: payload.egressProfile || "none",
    status: "starting",
    createdAt: now,
    updatedAt: now,
    lastError: null
  };
}

async function inspectContainer(containerName) {
  try {
    return await docker.getContainer(containerName).inspect();
  } catch {
    return null;
  }
}

async function ensureImage(imageName) {
  try {
    await docker.getImage(imageName).inspect();
    return;
  } catch {
    const stream = await docker.pull(imageName);
    await new Promise((resolve, reject) => {
      docker.modem.followProgress(stream, (error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  }
}

app.get("/health", async (_request, response) => {
  try {
    await docker.ping();
    response.json({ ok: true });
  } catch (error) {
    response.status(500).json({ ok: false, error: error instanceof Error ? error.message : String(error) });
  }
});

app.post("/leases", async (request, response) => {
  const payload = request.body ?? {};
  if (typeof payload.worktreePath !== "string" || !payload.worktreePath) {
    response.status(400).json({ error: "worktreePath is required" });
    return;
  }

  if (typeof payload.command !== "string" || !payload.command) {
    response.status(400).json({ error: "command is required" });
    return;
  }

  const lease = buildLease(payload);
  const env = typeof payload.env === "object" && payload.env ? payload.env : {};
  const envVars = [`PORT=${lease.targetPort}`, "HOST=0.0.0.0"];

  if (lease.egressProfile === "builder") {
    envVars.push(
      `HTTP_PROXY=${previewProxy}`,
      `HTTPS_PROXY=${previewProxy}`,
      `ALL_PROXY=${previewProxy}`,
      `http_proxy=${previewProxy}`,
      `https_proxy=${previewProxy}`,
      `all_proxy=${previewProxy}`,
      "NODE_OPTIONS=--use-env-proxy"
    );
  }

  for (const [key, value] of Object.entries(env)) {
    if (typeof value === "string") {
      envVars.push(`${key}=${value}`);
    }
  }

  try {
    await ensureImage(lease.image);

    const existing = await inspectContainer(lease.containerName);
    if (existing) {
      await docker.getContainer(lease.containerName).remove({ force: true });
    }

    const runtimeContainer = await docker.createContainer({
      Image: lease.image,
      name: lease.containerName,
      Cmd: ["bash", "-lc", lease.command],
      WorkingDir: lease.worktreePath,
      Env: envVars,
      Labels: {
        "manor.managed": "true",
        "manor.lease-id": lease.id,
        "manor.thread-id": lease.threadId ?? "",
        "manor.project-id": lease.projectId
      },
      HostConfig: {
        AutoRemove: true,
        VolumesFrom: ["manor-codex-box"],
        NetworkMode: previewNetwork
      }
    });

    await runtimeContainer.start();
    const container = await inspectContainer(lease.containerName);
    if (!container) {
      throw new Error("Preview container did not start");
    }

    response.json({
      ...lease,
      status: container?.State?.Running ? "running" : "starting",
      updatedAt: Date.now()
    });
  } catch (error) {
    response.status(500).json({
      ...lease,
      status: "failed",
      updatedAt: Date.now(),
      lastError: error instanceof Error ? error.message : String(error),
      error: error instanceof Error ? error.message : String(error)
    });
  }
});

app.get("/leases/:leaseId", async (request, response) => {
  const containerName = toContainerName(request.params.leaseId);
  const container = await inspectContainer(containerName);
  if (!container) {
    response.status(404).json({ error: "Lease not found" });
    return;
  }

  response.json({
    id: request.params.leaseId,
    threadId: container.Config?.Labels?.["manor.thread-id"] || null,
    projectId: container.Config?.Labels?.["manor.project-id"] || "unknown",
    projectLabel: container.Config?.Labels?.["manor.project-id"] || "Unknown",
    title: `Preview ${request.params.leaseId.slice(0, 8)}`,
    worktreePath: container.Config?.WorkingDir || "/repos",
    branchName: null,
    containerName,
    targetHost: containerName,
    targetPort: Number(container.Config?.Env?.find((entry) => entry.startsWith("PORT="))?.slice(5) || "3000"),
    routePrefix: `${routeBase}/${request.params.leaseId}/`,
    operatorUrl: `${routeBase}/${request.params.leaseId}/`,
    command: Array.isArray(container.Config?.Cmd) ? container.Config.Cmd.join(" ") : "",
    image: container.Config?.Image || previewImage,
    egressProfile: container.Config?.Env?.some((entry) => entry.startsWith("HTTP_PROXY=")) ? "builder" : "none",
    status: container.State?.Running ? "running" : "stopped",
    createdAt: new Date(container.Created).getTime(),
    updatedAt: Date.now(),
    lastError: container.State?.Error || null
  });
});

app.delete("/leases/:leaseId", async (request, response) => {
  const containerName = toContainerName(request.params.leaseId);

  try {
    await docker.getContainer(containerName).remove({ force: true });
  } catch {
    // already gone
  }

  response.json({ ok: true, leaseId: request.params.leaseId });
});

app.listen(port, "0.0.0.0", () => {
  console.log(`Runtime broker listening on ${port}`);
});
