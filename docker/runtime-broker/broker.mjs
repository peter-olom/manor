import express from "express";
import crypto from "node:crypto";
import fs from "node:fs";
import Docker from "dockerode";

const port = Number(process.env.RUNTIME_BROKER_PORT ?? "8090");
const previewNetwork = process.env.RUNTIME_PREVIEW_NETWORK ?? "manor_work";
const previewImage = process.env.RUNTIME_PREVIEW_IMAGE ?? "node:22-bookworm-slim";
const routeBase = process.env.RUNTIME_ROUTE_BASE ?? "/preview";
const previewEgressConfigPath =
  process.env.RUNTIME_PREVIEW_EGRESS_CONFIG ?? "/opt/manor/config/preview-egress-profiles.json";
const previewEgressAdminUrl =
  process.env.RUNTIME_PREVIEW_EGRESS_ADMIN_URL ?? "http://preview-egress:8091";
const docker = new Docker({ socketPath: "/var/run/docker.sock" });

const app = express();
app.use(express.json());

function toContainerName(leaseId) {
  return `manor-preview-${leaseId.replace(/[^a-zA-Z0-9_.-]/g, "").slice(0, 32)}`;
}

function loadPreviewEgressProfiles() {
  const raw = fs.readFileSync(previewEgressConfigPath, "utf8");
  const parsed = JSON.parse(raw);
  const entries = Array.isArray(parsed?.profiles) ? parsed.profiles : [];
  return new Map(
    entries.map((entry) => [
      String(entry.name),
      {
        port: Number(entry.port)
      }
    ])
  );
}

const previewEgressProfiles = loadPreviewEgressProfiles();

async function requestPreviewEgress(pathname, init) {
  const response = await fetch(new URL(pathname, previewEgressAdminUrl), {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(init?.headers ?? {})
    }
  });
  const payload = await response.json();
  if (!response.ok) {
    throw new Error(payload.error || `Preview egress request failed with ${response.status}`);
  }
  return payload;
}

async function ensurePreviewEgressLeasePolicy(leaseId, domains) {
  const normalizedDomains = [...new Set((domains ?? []).map((value) => String(value).trim().toLowerCase()).filter(Boolean))];
  if (normalizedDomains.length === 0) {
    return null;
  }

  const profile = await requestPreviewEgress("/profiles", {
    method: "POST",
    body: JSON.stringify({
      name: `lease-${leaseId}`,
      domains: normalizedDomains
    })
  });

  return {
    name: profile.name,
    port: Number(profile.port),
    domains: normalizedDomains
  };
}

async function dropPreviewEgressLeasePolicy(leaseId) {
  try {
    await requestPreviewEgress(`/profiles/${encodeURIComponent(`lease-${leaseId}`)}`, {
      method: "DELETE"
    });
  } catch (error) {
    if (String(error).includes("was not found")) {
      return;
    }
    throw error;
  }
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
    egressDomains: Array.isArray(payload.egressDomains)
      ? [...new Set(payload.egressDomains.map((value) => String(value).trim().toLowerCase()).filter(Boolean))]
      : [],
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

async function requireContainer(leaseId, response) {
  const containerName = toContainerName(leaseId);
  const container = await inspectContainer(containerName);
  if (!container) {
    response.status(404).json({ error: "Lease not found" });
    return null;
  }
  return { containerName, containerRef: docker.getContainer(containerName), container };
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
  let proxyPort = null;
  let dynamicPolicyName = null;

  if (lease.egressDomains.length > 0) {
    const dynamicPolicy = await ensurePreviewEgressLeasePolicy(lease.id, lease.egressDomains);
    if (!dynamicPolicy) {
      response.status(400).json({ error: "Failed to create preview egress policy" });
      return;
    }
    proxyPort = dynamicPolicy.port;
    dynamicPolicyName = dynamicPolicy.name;
    lease.egressProfile = "custom";
  } else if (lease.egressProfile !== "none") {
    const profile = previewEgressProfiles.get(lease.egressProfile);
    if (!profile || !Number.isFinite(profile.port) || profile.port <= 0) {
      response.status(400).json({ error: `Unknown preview egress profile: ${lease.egressProfile}` });
      return;
    }
    proxyPort = profile.port;
  }

  if (proxyPort !== null) {
    const previewProxy = `http://preview-egress:${proxyPort}`;
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

  envVars.push(`MANOR_EGRESS_PROFILE=${lease.egressProfile}`);

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
        "manor.project-id": lease.projectId,
        "manor.egress-policy-name": dynamicPolicyName ?? "",
        "manor.egress-domains": lease.egressDomains.join(",")
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
    if (dynamicPolicyName) {
      await dropPreviewEgressLeasePolicy(lease.id).catch(() => {});
    }
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
  const required = await requireContainer(request.params.leaseId, response);
  if (!required) {
    return;
  }
  const { containerName, container } = required;

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
    egressProfile:
      container.Config?.Env?.find((entry) => entry.startsWith("MANOR_EGRESS_PROFILE="))?.slice("MANOR_EGRESS_PROFILE=".length) ||
      "none",
    egressDomains:
      container.Config?.Labels?.["manor.egress-domains"]
        ?.split(",")
        .map((value) => value.trim())
        .filter(Boolean) || [],
    status: container.State?.Running ? "running" : "stopped",
    createdAt: new Date(container.Created).getTime(),
    updatedAt: Date.now(),
    lastError: container.State?.Error || null,
    runtime: {
      running: Boolean(container.State?.Running),
      status: container.State?.Status || "unknown",
      startedAt: container.State?.StartedAt ? new Date(container.State.StartedAt).getTime() : null,
      finishedAt: container.State?.FinishedAt ? new Date(container.State.FinishedAt).getTime() : null,
      error: container.State?.Error || null
    }
  });
});

app.get("/leases/:leaseId/processes", async (request, response) => {
  const required = await requireContainer(request.params.leaseId, response);
  if (!required) {
    return;
  }

  try {
    const top = await required.containerRef.top();
    response.json({
      titles: Array.isArray(top.Titles) ? top.Titles : [],
      processes: Array.isArray(top.Processes) ? top.Processes : []
    });
  } catch (error) {
    response.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

app.get("/leases/:leaseId/logs", async (request, response) => {
  const required = await requireContainer(request.params.leaseId, response);
  if (!required) {
    return;
  }

  const tailRaw = Number(request.query.tail ?? "200");
  const tail = Number.isFinite(tailRaw) && tailRaw > 0 ? Math.min(Math.trunc(tailRaw), 1000) : 200;

  try {
    const stream = await required.containerRef.logs({
      stdout: true,
      stderr: true,
      tail,
      timestamps: false
    });
    const logs =
      Buffer.isBuffer(stream)
        ? stream.toString("utf8")
        : await new Promise((resolve, reject) => {
            const chunks = [];
            stream.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
            stream.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
            stream.on("error", reject);
          });

    response.json({
      leaseId: request.params.leaseId,
      logs
    });
  } catch (error) {
    response.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

app.post("/leases/:leaseId/exec", async (request, response) => {
  const required = await requireContainer(request.params.leaseId, response);
  if (!required) {
    return;
  }

  const command = typeof request.body?.command === "string" ? request.body.command.trim() : "";
  const cwd = typeof request.body?.cwd === "string" ? request.body.cwd.trim() : "";
  if (!command) {
    response.status(400).json({ error: "command is required" });
    return;
  }

  try {
    const exec = await required.containerRef.exec({
      AttachStdout: true,
      AttachStderr: true,
      Cmd: ["bash", "-lc", cwd ? `cd ${JSON.stringify(cwd)} && ${command}` : command],
      WorkingDir: cwd || undefined,
      Tty: false
    });
    const stream = await exec.start({ hijack: true, stdin: false });
    const output = await new Promise((resolve, reject) => {
      const stdout = [];
      const stderr = [];
      required.containerRef.modem.demuxStream(stream, {
        write(chunk) {
          stdout.push(Buffer.from(chunk));
        }
      }, {
        write(chunk) {
          stderr.push(Buffer.from(chunk));
        }
      });
      stream.on("end", () =>
        resolve({
          stdout: Buffer.concat(stdout).toString("utf8"),
          stderr: Buffer.concat(stderr).toString("utf8")
        })
      );
      stream.on("error", reject);
    });
    const execInspect = await exec.inspect();
    response.json({
      leaseId: request.params.leaseId,
      command,
      exitCode: typeof execInspect.ExitCode === "number" ? execInspect.ExitCode : null,
      stdout: output.stdout,
      stderr: output.stderr
    });
  } catch (error) {
    response.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

app.delete("/leases/:leaseId", async (request, response) => {
  const containerName = toContainerName(request.params.leaseId);

  try {
    await docker.getContainer(containerName).remove({ force: true });
  } catch {
    // already gone
  }

  await dropPreviewEgressLeasePolicy(request.params.leaseId).catch(() => {});

  response.json({ ok: true, leaseId: request.params.leaseId });
});

app.listen(port, "0.0.0.0", () => {
  console.log(`Runtime broker listening on ${port}`);
});
