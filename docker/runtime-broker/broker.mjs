import express from "express";
import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import { Readable } from "node:stream";
import Docker from "dockerode";

const port = Number(process.env.RUNTIME_BROKER_PORT ?? "8090");
const previewNetwork = process.env.RUNTIME_PREVIEW_NETWORK ?? "manor_work";
const sharedWorkNetwork = process.env.RUNTIME_SERVICE_SHARED_NETWORK ?? "manor_work";
const previewImage = process.env.RUNTIME_PREVIEW_IMAGE ?? "node:22-bookworm-slim";
const routeBase = process.env.RUNTIME_ROUTE_BASE ?? "/preview";
const previewEgressConfigPath =
  process.env.RUNTIME_PREVIEW_EGRESS_CONFIG ?? "/opt/manor/config/preview-egress-profiles.json";
const previewEgressAdminUrl =
  process.env.RUNTIME_PREVIEW_EGRESS_ADMIN_URL ?? "http://preview-egress:8091";
const brokerToken = process.env.RUNTIME_BROKER_TOKEN ?? null;
const codexAccessRegistryPath = process.env.RUNTIME_CODEX_ACCESS_FILE ?? "/state/codex-broker-access.json";
const internalOperatorBaseUrl = process.env.RUNTIME_OPERATOR_BASE_URL_INTERNAL ?? "http://butler:8080";
const playwrightContainerName = process.env.RUNTIME_PLAYWRIGHT_CONTAINER ?? "manor-playwright";
const docker = new Docker({ socketPath: "/var/run/docker.sock" });
const leaseTransitions = new Map();
const leaseBootstrapStates = new Map();
const pendingPreviewLeases = new Map();
const retainedPreviewLeases = new Map();
const noHeartbeatReadyDelayMs = Number(process.env.RUNTIME_NO_HEARTBEAT_READY_DELAY_MS ?? "2000");

const app = express();
app.use(express.json());

function hasBrokerAccess(request) {
  return !brokerToken || request.header("x-manor-broker-token") === brokerToken;
}

function loadCodexAccessRegistry() {
  try {
    const raw = fs.readFileSync(codexAccessRegistryPath, "utf8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed?.grants) ? parsed.grants : [];
  } catch {
    return [];
  }
}

function getCodexGrant(request) {
  const token = request.header("x-manor-codex-token");
  if (!token) {
    return null;
  }

  const grants = loadCodexAccessRegistry();
  const grant = grants.find(
    (entry) => entry && typeof entry.token === "string" && typeof entry.threadId === "string" && entry.token === token
  );
  return grant ?? null;
}

function authorizeScopedThread(request, response, threadId) {
  if (hasBrokerAccess(request)) {
    return true;
  }

  const grant = getCodexGrant(request);
  if (!grant) {
    response.status(403).json({ error: "Forbidden" });
    return false;
  }

  if (!threadId || grant.threadId !== threadId) {
    response.status(403).json({ error: "Lease is not attached to this Codex job" });
    return false;
  }

  return true;
}

app.use((request, response, next) => {
  if (request.path === "/health" || request.path.startsWith("/routes/preview/")) {
    next();
    return;
  }

  if (hasBrokerAccess(request) || request.header("x-manor-codex-token")) {
    next();
    return;
  }
  response.status(403).json({ error: "Forbidden" });
});

function toContainerName(leaseId) {
  return `manor-preview-${leaseId.replace(/[^a-zA-Z0-9_.-]/g, "").slice(0, 32)}`;
}

function toServiceContainerName(serviceId) {
  return `manor-service-${serviceId.replace(/[^a-zA-Z0-9_.-]/g, "").slice(0, 32)}`;
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
  const targetPort = Number(payload.targetPort || 3000);
  const bootstrap = buildBootstrapConfig(payload, targetPort);

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
    targetPort,
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
    lastError: null,
    bootstrap
  };
}

function normalizeBootstrapHeartbeatKind(value) {
  return value === "http" || value === "tcp" || value === "command" || value === "none" ? value : null;
}

function normalizePositiveInteger(value, fallback) {
  const numeric = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return fallback;
  }
  return Math.max(1, Math.trunc(numeric));
}

function normalizeBootstrapTarget(value) {
  const normalized = typeof value === "string" ? value.trim() : "";
  return normalized || null;
}

function buildBootstrapConfig(payload, targetPort) {
  const explicitKind = normalizeBootstrapHeartbeatKind(payload.heartbeatKind);
  const defaultKind = explicitKind ?? "http";
  const defaultTarget =
    defaultKind === "http"
      ? "/"
      : defaultKind === "tcp"
        ? `127.0.0.1:${targetPort}`
        : null;

  return {
    waitSeconds: normalizePositiveInteger(payload.bootstrapWaitSeconds, 120),
    hint: normalizeBootstrapTarget(payload.bootstrapHint),
    heartbeatKind: defaultKind,
    heartbeatTarget: normalizeBootstrapTarget(payload.heartbeatTarget) ?? defaultTarget,
    heartbeatIntervalSeconds: normalizePositiveInteger(payload.heartbeatIntervalSeconds, 5),
    phase: "pulling_image",
    startedAt: Date.now(),
    readyAt: null,
    lastHeartbeatAt: null,
    lastHeartbeatError: null,
    targetPort
  };
}

function bootstrapConfigFromLabels(labels, targetPort) {
  const explicitKind = normalizeBootstrapHeartbeatKind(labels?.["manor.bootstrap-heartbeat-kind"]);
  const defaultKind = explicitKind ?? "http";
  const defaultTarget =
    defaultKind === "http"
      ? "/"
      : defaultKind === "tcp"
        ? `127.0.0.1:${targetPort}`
        : null;

  return {
    waitSeconds: normalizePositiveInteger(labels?.["manor.bootstrap-wait-seconds"], 120),
    hint: normalizeBootstrapTarget(labels?.["manor.bootstrap-hint"]),
    heartbeatKind: defaultKind,
    heartbeatTarget: normalizeBootstrapTarget(labels?.["manor.bootstrap-heartbeat-target"]) ?? defaultTarget,
    heartbeatIntervalSeconds: normalizePositiveInteger(labels?.["manor.bootstrap-heartbeat-interval"], 5),
    targetPort
  };
}

function buildBootstrapFallback(labels, targetPort, status, containerRunning) {
  const config = bootstrapConfigFromLabels(labels, targetPort);
  let phase = "starting_container";
  if (status === "failed") {
    phase = "failed";
  } else if (containerRunning) {
    phase = config.heartbeatKind === "none" ? "ready" : "waiting_for_heartbeat";
  }

  return {
    ...config,
    phase,
    startedAt: null,
    readyAt: phase === "ready" ? Date.now() : null,
    lastHeartbeatAt: null,
    lastHeartbeatError: null
  };
}

function getLeaseBootstrapState(leaseId, labels, targetPort, status, containerRunning) {
  return leaseBootstrapStates.get(leaseId) ?? buildBootstrapFallback(labels, targetPort, status, containerRunning);
}

function serializeBootstrapState(bootstrap) {
  return {
    waitSeconds: bootstrap.waitSeconds,
    hint: bootstrap.hint,
    heartbeatKind: bootstrap.heartbeatKind,
    heartbeatTarget: bootstrap.heartbeatTarget,
    heartbeatIntervalSeconds: bootstrap.heartbeatIntervalSeconds,
    phase: bootstrap.phase,
    startedAt: bootstrap.startedAt,
    readyAt: bootstrap.readyAt,
    lastHeartbeatAt: bootstrap.lastHeartbeatAt,
    lastHeartbeatError: bootstrap.lastHeartbeatError
  };
}

function setLeaseBootstrapState(leaseId, state) {
  leaseBootstrapStates.set(leaseId, state);
  return state;
}

function mergeLeaseBootstrapState(leaseId, patch) {
  const current = leaseBootstrapStates.get(leaseId);
  if (!current) {
    return null;
  }

  const next = {
    ...current,
    ...patch
  };
  leaseBootstrapStates.set(leaseId, next);
  return next;
}

function clearLeaseBootstrapState(leaseId) {
  leaseBootstrapStates.delete(leaseId);
}

function retainPreviewLease(lease, runtime = {}) {
  retainedPreviewLeases.set(lease.id, {
    lease: {
      ...lease,
      updatedAt: Date.now()
    },
    runtime: {
      running: false,
      status: runtime.status || lease.status || "failed",
      startedAt: runtime.startedAt ?? null,
      finishedAt: runtime.finishedAt ?? Date.now(),
      error: runtime.error ?? lease.lastError ?? null
    }
  });
}

function getRetainedPreviewLease(leaseId) {
  return retainedPreviewLeases.get(leaseId) ?? null;
}

function clearRetainedPreviewLease(leaseId) {
  retainedPreviewLeases.delete(leaseId);
}

function retainFailedLease(lease, message, runtime = {}) {
  const error = message || lease.lastError || "Preview failed during bootstrap.";
  retainPreviewLease(
    {
      ...lease,
      status: "failed",
      updatedAt: Date.now(),
      lastError: error
    },
    {
      status: "failed",
      error,
      ...runtime
    }
  );
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

function getLeaseTransition(leaseId) {
  return leaseTransitions.get(leaseId) ?? null;
}

function setLeaseTransition(leaseId, state) {
  leaseTransitions.set(leaseId, { state, at: Date.now() });
}

function clearLeaseTransition(leaseId) {
  leaseTransitions.delete(leaseId);
}

function resolveLeaseStatus(containerState, leaseId) {
  const bootstrap = leaseBootstrapStates.get(leaseId);
  if (bootstrap?.phase === "failed") {
    return "failed";
  }
  const transition = getLeaseTransition(leaseId);
  if (transition?.state === "stopping") {
    return "stopping";
  }
  if (transition?.state === "starting") {
    return "starting";
  }
  return containerState === "running" ? "running" : "stopped";
}

function rejectIfLeaseStopping(leaseId, response) {
  if (getLeaseTransition(leaseId)?.state !== "stopping") {
    return false;
  }

  response.status(409).json({
    error: `Preview ${leaseId} is stopping. Retry in a moment.`,
    retryable: true,
    state: "stopping"
  });
  return true;
}

function rejectIfLeaseUnavailable(required, leaseId, response) {
  if (getLeaseTransition(leaseId)?.state === "stopping") {
    response.status(409).json({
      error: `Preview ${leaseId} is stopping. Retry in a moment.`,
      retryable: true,
      state: "stopping"
    });
    return true;
  }

  if (!required.container.State?.Running) {
    response.status(409).json({
      error: `Preview ${leaseId} is still starting. Retry in a moment.`,
      retryable: true,
      state: "starting"
    });
    return true;
  }

  return false;
}

function rejectIfLeaseRetainedFailed(leaseId, response) {
  const retained = getRetainedPreviewLease(leaseId);
  if (!retained || retained.lease.status !== "failed") {
    return false;
  }

  response.status(409).json({
    error: retained.lease.lastError || `Preview ${leaseId} failed during bootstrap.`,
    retryable: false,
    state: "failed",
    lease: {
      ...serializeLease(retained.lease, {
        containerState: "failed",
        containerRunning: false
      }),
      runtime: retained.runtime
    }
  });
  return true;
}

async function requireServiceContainer(serviceId, response) {
  const containerName = toServiceContainerName(serviceId);
  const container = await inspectContainer(containerName);
  if (!container) {
    response.status(404).json({ error: "Service not found" });
    return null;
  }
  return { containerName, containerRef: docker.getContainer(containerName), container };
}

async function listManagedContainers(filter) {
  const containers = await docker.listContainers({
    all: true,
    filters: {
      label: ["manor.managed=true"]
    }
  });

  return containers.filter((container) => {
    const labels = container.Labels || {};
    return filter(labels, container);
  });
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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runHeartbeatCheck(lease) {
  const bootstrap = leaseBootstrapStates.get(lease.id) ?? lease.bootstrap;
  if (!bootstrap || bootstrap.heartbeatKind === "none") {
    return;
  }

  if (bootstrap.heartbeatKind === "http") {
    const target = bootstrap.heartbeatTarget || "/";
    const url = new URL(target, `http://${lease.containerName}:${lease.targetPort}/`);
    const response = await fetch(url, {
      method: "GET",
      redirect: "manual",
      signal: AbortSignal.timeout(5_000)
    });
    if (!response.ok) {
      throw new Error(`HTTP heartbeat returned ${response.status}`);
    }
    return;
  }

  if (bootstrap.heartbeatKind === "tcp") {
    const rawTarget = bootstrap.heartbeatTarget || `${lease.containerName}:${lease.targetPort}`;
    const marker = rawTarget.lastIndexOf(":");
    const host = marker === -1 ? lease.containerName : rawTarget.slice(0, marker) || lease.containerName;
    const port = marker === -1 ? lease.targetPort : Number(rawTarget.slice(marker + 1));
    await new Promise((resolve, reject) => {
      const socket = net.createConnection({ host, port });
      const timer = setTimeout(() => {
        socket.destroy();
        reject(new Error("TCP heartbeat timed out"));
      }, 5_000);
      socket.once("connect", () => {
        clearTimeout(timer);
        socket.end();
        resolve();
      });
      socket.once("error", (error) => {
        clearTimeout(timer);
        socket.destroy();
        reject(error);
      });
    });
    return;
  }

  if (bootstrap.heartbeatKind === "command") {
    const command = bootstrap.heartbeatTarget;
    if (!command) {
      throw new Error("Command heartbeat target is required");
    }
    const containerRef = docker.getContainer(lease.containerName);
    const exec = await containerRef.exec({
      AttachStdout: true,
      AttachStderr: true,
      Cmd: ["bash", "-lc", command],
      Tty: false
    });
    const output = await collectExecOutput(containerRef, exec);
    if (output.exitCode !== 0) {
      throw new Error(output.stderr.trim() || output.stdout.trim() || `Command heartbeat exited ${output.exitCode}`);
    }
  }
}

async function monitorLeaseBootstrap(lease) {
  const bootstrap = leaseBootstrapStates.get(lease.id) ?? lease.bootstrap;
  if (!bootstrap) {
    return;
  }

  if (bootstrap.heartbeatKind === "none") {
    mergeLeaseBootstrapState(lease.id, {
      phase: bootstrap.hint ? "bootstrapping" : "starting_container",
      lastHeartbeatError: null
    });

    const delayMs = Math.min(Math.max(noHeartbeatReadyDelayMs, 250), bootstrap.waitSeconds * 1000);
    const deadline = Date.now() + bootstrap.waitSeconds * 1000;
    const stableAt = Date.now() + delayMs;

    while (Date.now() <= deadline) {
      if (getLeaseTransition(lease.id)?.state === "stopping") {
        return;
      }

      const container = await inspectContainer(lease.containerName);
      if (!container) {
        const state = mergeLeaseBootstrapState(lease.id, {
          phase: "failed",
          lastHeartbeatError: "Preview container disappeared during bootstrap."
        });
        retainFailedLease(lease, state?.lastHeartbeatError);
        return;
      }

      if (!container.State?.Running) {
        const state = mergeLeaseBootstrapState(lease.id, {
          phase: "failed",
          lastHeartbeatError: container.State?.Error || `Preview stopped before becoming ready (${container.State?.Status || "unknown"}).`
        });
        retainFailedLease(lease, state?.lastHeartbeatError, {
          startedAt: container.State?.StartedAt ? new Date(container.State.StartedAt).getTime() : null,
          finishedAt: container.State?.FinishedAt ? new Date(container.State.FinishedAt).getTime() : Date.now()
        });
        return;
      }

      if (Date.now() >= stableAt) {
        mergeLeaseBootstrapState(lease.id, {
          phase: "ready",
          readyAt: Date.now(),
          lastHeartbeatAt: Date.now(),
          lastHeartbeatError: null
        });
        return;
      }

      await sleep(500);
    }

    mergeLeaseBootstrapState(lease.id, {
      phase: "failed",
      lastHeartbeatError: `Bootstrap timed out after ${bootstrap.waitSeconds}s.`
    });
    retainFailedLease(lease, `Bootstrap timed out after ${bootstrap.waitSeconds}s.`);
    return;
  }

  mergeLeaseBootstrapState(lease.id, {
    phase: bootstrap.hint ? "bootstrapping" : "waiting_for_heartbeat",
    lastHeartbeatError: null
  });

  const deadline = Date.now() + bootstrap.waitSeconds * 1000;
  while (Date.now() <= deadline) {
    if (getLeaseTransition(lease.id)?.state === "stopping") {
      return;
    }

    const container = await inspectContainer(lease.containerName);
    if (!container) {
      const state = mergeLeaseBootstrapState(lease.id, {
        phase: "failed",
        lastHeartbeatError: "Preview container disappeared during bootstrap."
      });
      retainFailedLease(lease, state?.lastHeartbeatError);
      return;
    }

    if (!container.State?.Running) {
      const state = mergeLeaseBootstrapState(lease.id, {
        phase: "failed",
        lastHeartbeatError: container.State?.Error || `Preview stopped before becoming ready (${container.State?.Status || "unknown"}).`
      });
      retainFailedLease(lease, state?.lastHeartbeatError, {
        startedAt: container.State?.StartedAt ? new Date(container.State.StartedAt).getTime() : null,
        finishedAt: container.State?.FinishedAt ? new Date(container.State.FinishedAt).getTime() : Date.now()
      });
      return;
    }

    try {
      await runHeartbeatCheck(lease);
      mergeLeaseBootstrapState(lease.id, {
        phase: "ready",
        readyAt: Date.now(),
        lastHeartbeatAt: Date.now(),
        lastHeartbeatError: null
      });
      return;
    } catch (error) {
      mergeLeaseBootstrapState(lease.id, {
        phase: bootstrap.hint ? "bootstrapping" : "waiting_for_heartbeat",
        lastHeartbeatAt: Date.now(),
        lastHeartbeatError: error instanceof Error ? error.message : String(error)
      });
    }

    await sleep(bootstrap.heartbeatIntervalSeconds * 1000);
  }

  const state = mergeLeaseBootstrapState(lease.id, {
    phase: "failed",
    lastHeartbeatError: `Bootstrap heartbeat timed out after ${bootstrap.waitSeconds}s.`
  });
  retainFailedLease(lease, state?.lastHeartbeatError);
}

function serializeLease(lease, options = {}) {
  const targetPort = Number(options.targetPort ?? lease.targetPort ?? 3000);
  const status = resolveLeaseStatus(options.containerState ?? lease.status ?? "stopped", lease.id);
  const bootstrap = getLeaseBootstrapState(
    lease.id,
    options.labels ?? null,
    targetPort,
    status,
    Boolean(options.containerRunning)
  );

  return {
    ...lease,
    targetPort,
    status,
    bootstrap: serializeBootstrapState(bootstrap)
  };
}

async function collectExecOutput(containerRef, exec) {
  const stream = await exec.start({ hijack: true, stdin: false });
  const output = await new Promise((resolve, reject) => {
    const stdout = [];
    const stderr = [];
    containerRef.modem.demuxStream(
      stream,
      {
        write(chunk) {
          stdout.push(Buffer.from(chunk));
        }
      },
      {
        write(chunk) {
          stderr.push(Buffer.from(chunk));
        }
      }
    );
    stream.on("end", () =>
      resolve({
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8")
      })
    );
    stream.on("error", reject);
  });
  const execInspect = await exec.inspect();
  return {
    exitCode: typeof execInspect.ExitCode === "number" ? execInspect.ExitCode : null,
    stdout: output.stdout,
    stderr: output.stderr
  };
}

app.get("/health", async (_request, response) => {
  try {
    await docker.ping();
    response.json({ ok: true });
  } catch (error) {
    response.status(500).json({ ok: false, error: error instanceof Error ? error.message : String(error) });
  }
});

app.use("/routes/preview/:leaseId", async (request, response) => {
  const required = await requireContainer(request.params.leaseId, response);
  if (!required) {
    return;
  }

  const targetPort =
    Number(required.container.Config?.Env?.find((entry) => entry.startsWith("PORT="))?.slice(5) || "3000");
  const prefix = `/routes/preview/${request.params.leaseId}`;
  const suffix = request.originalUrl.startsWith(prefix) ? request.originalUrl.slice(prefix.length) || "/" : "/";
  const upstreamUrl = new URL(`http://${required.containerName}:${targetPort}${suffix}`);
  const headers = new Headers();

  for (const [key, value] of Object.entries(request.headers)) {
    if (!value) {
      continue;
    }
    if (["host", "connection", "content-length"].includes(key.toLowerCase())) {
      continue;
    }
    if (Array.isArray(value)) {
      for (const entry of value) {
        headers.append(key, entry);
      }
    } else {
      headers.set(key, value);
    }
  }

  try {
    const upstream = await fetch(upstreamUrl, {
      method: request.method,
      headers,
      body: request.method === "GET" || request.method === "HEAD" ? undefined : request,
      duplex: request.method === "GET" || request.method === "HEAD" ? undefined : "half",
      redirect: "manual"
    });

    response.status(upstream.status);
    upstream.headers.forEach((value, key) => {
      if (["connection", "content-length", "transfer-encoding"].includes(key.toLowerCase())) {
        return;
      }
      response.setHeader(key, value);
    });

    if (!upstream.body) {
      response.end();
      return;
    }

    Readable.fromWeb(upstream.body).pipe(response);
  } catch (error) {
    response.status(502).json({ error: error instanceof Error ? error.message : "Preview proxy failed" });
  }
});

app.post("/leases", async (request, response) => {
  if (!hasBrokerAccess(request)) {
    response.status(403).json({ error: "Forbidden" });
    return;
  }
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
  setLeaseTransition(lease.id, "starting");
  setLeaseBootstrapState(lease.id, lease.bootstrap);
  pendingPreviewLeases.set(lease.id, lease);
  clearRetainedPreviewLease(lease.id);
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
    mergeLeaseBootstrapState(lease.id, { phase: "pulling_image" });
    await ensureImage(lease.image);

    if (getLeaseTransition(lease.id)?.state === "stopping") {
      throw new Error("Preview creation was cancelled before the container started.");
    }

    mergeLeaseBootstrapState(lease.id, { phase: "starting_container" });

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
        "manor.title": lease.title,
        "manor.worktree-path": lease.worktreePath,
        "manor.target-port": String(lease.targetPort),
        "manor.egress-profile": lease.egressProfile,
        "manor.egress-policy-name": dynamicPolicyName ?? "",
        "manor.egress-domains": lease.egressDomains.join(","),
        "manor.bootstrap-wait-seconds": String(lease.bootstrap.waitSeconds),
        "manor.bootstrap-hint": lease.bootstrap.hint ?? "",
        "manor.bootstrap-heartbeat-kind": lease.bootstrap.heartbeatKind,
        "manor.bootstrap-heartbeat-target": lease.bootstrap.heartbeatTarget ?? "",
        "manor.bootstrap-heartbeat-interval": String(lease.bootstrap.heartbeatIntervalSeconds)
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

    pendingPreviewLeases.delete(lease.id);
    void monitorLeaseBootstrap(lease).catch((error) => {
      const bootstrapState = mergeLeaseBootstrapState(lease.id, {
        phase: "failed",
        lastHeartbeatError: error instanceof Error ? error.message : String(error)
      });
      retainPreviewLease(
        {
          ...lease,
          status: "failed",
          updatedAt: Date.now(),
          lastError: bootstrapState?.lastHeartbeatError || (error instanceof Error ? error.message : String(error))
        },
        {
          status: "failed",
          error: bootstrapState?.lastHeartbeatError || (error instanceof Error ? error.message : String(error))
        }
      );
    });

    response.json({
      ...serializeLease(
        {
          ...lease,
          updatedAt: Date.now()
        },
        {
          labels: container.Config?.Labels ?? null,
          targetPort: lease.targetPort,
          containerState: container?.State?.Running ? "running" : "starting",
          containerRunning: Boolean(container?.State?.Running)
        }
      ),
      updatedAt: Date.now()
    });
  } catch (error) {
    pendingPreviewLeases.delete(lease.id);
    const bootstrapState = mergeLeaseBootstrapState(lease.id, {
      phase: "failed",
      lastHeartbeatError: error instanceof Error ? error.message : String(error)
    });
    if (dynamicPolicyName) {
      await dropPreviewEgressLeasePolicy(lease.id).catch(() => {});
    }
    retainPreviewLease(
      {
        ...lease,
        status: "failed",
        updatedAt: Date.now(),
        lastError: bootstrapState?.lastHeartbeatError || (error instanceof Error ? error.message : String(error))
      },
      {
        status: "failed",
        error: bootstrapState?.lastHeartbeatError || (error instanceof Error ? error.message : String(error))
      }
    );
    response.status(500).json({
      ...lease,
      status: "failed",
      updatedAt: Date.now(),
      lastError: error instanceof Error ? error.message : String(error),
      error: error instanceof Error ? error.message : String(error)
    });
  } finally {
    clearLeaseTransition(lease.id);
  }
});

app.get("/leases", async (request, response) => {
  const requestedThreadId = typeof request.query.threadId === "string" ? request.query.threadId : null;
  if (!authorizeScopedThread(request, response, requestedThreadId)) {
    return;
  }

  try {
    const containers = await listManagedContainers(
      (labels) => labels["manor.runtime-kind"] !== "service" && (!requestedThreadId || (labels["manor.thread-id"] || "") === requestedThreadId)
    );
    const liveLeases = containers.map((container) =>
      serializeLease(
        {
          id: container.Labels?.["manor.lease-id"] || "",
          threadId: container.Labels?.["manor.thread-id"] || null,
          projectId: container.Labels?.["manor.project-id"] || "unknown",
          projectLabel: container.Labels?.["manor.project-id"] || "Unknown",
          title: container.Labels?.["manor.title"] || `Preview ${(container.Labels?.["manor.lease-id"] || "").slice(0, 8)}`,
          worktreePath: container.Labels?.["manor.worktree-path"] || container.Names?.[0]?.replace(/^\//, "") || "/repos",
          branchName: null,
          containerName: container.Names?.[0]?.replace(/^\//, "") || "",
          targetHost: container.Names?.[0]?.replace(/^\//, "") || "",
          targetPort: Number(container.Labels?.["manor.target-port"] || container.Labels?.["manor.port"] || "3000"),
          routePrefix: `${routeBase}/${container.Labels?.["manor.lease-id"] || ""}/`,
          operatorUrl: `${routeBase}/${container.Labels?.["manor.lease-id"] || ""}/`,
          command: Array.isArray(container.Command) ? container.Command.join(" ") : container.Command || "",
          image: container.Image || previewImage,
          egressProfile: container.Labels?.["manor.egress-profile"] || "none",
          egressDomains:
            container.Labels?.["manor.egress-domains"]
              ?.split(",")
              .map((value) => value.trim())
              .filter(Boolean) || [],
          status: container.State,
          createdAt: typeof container.Created === "number" ? container.Created * 1000 : Date.now(),
          updatedAt: Date.now(),
          lastError: null
        },
        {
          labels: container.Labels ?? null,
          containerState: container.State,
          containerRunning: container.State === "running"
        }
      )
    );
    const liveLeaseIds = new Set(liveLeases.map((lease) => lease.id));
    const pendingLeases = [...pendingPreviewLeases.values()]
      .filter((lease) => (!requestedThreadId || lease.threadId === requestedThreadId) && !liveLeaseIds.has(lease.id))
      .map((lease) =>
        serializeLease(
          {
            ...lease,
            updatedAt: Date.now()
          },
          {
            containerState: "starting",
            containerRunning: false
          }
        )
      );

    const retainedLeases = [...retainedPreviewLeases.values()]
      .filter(({ lease }) => (!requestedThreadId || lease.threadId === requestedThreadId) && !liveLeaseIds.has(lease.id))
      .map(({ lease, runtime }) => ({
        ...serializeLease(lease, {
          containerState: runtime.status === "failed" ? "failed" : lease.status,
          containerRunning: false
        }),
        runtime
      }));

    response.json([...pendingLeases, ...retainedLeases, ...liveLeases].sort((left, right) => right.updatedAt - left.updatedAt));
  } catch (error) {
    response.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

app.get("/leases/:leaseId", async (request, response) => {
  const pendingLease = pendingPreviewLeases.get(request.params.leaseId);
  if (pendingLease) {
    if (!authorizeScopedThread(request, response, pendingLease.threadId)) {
      return;
    }

    response.json({
      ...serializeLease(
        {
          ...pendingLease,
          updatedAt: Date.now()
        },
        {
          containerState: "starting",
          containerRunning: false
        }
      ),
      runtime: {
        running: false,
        status: "starting",
        startedAt: null,
        finishedAt: null,
        error: null
      }
    });
    return;
  }

  const retainedLease = getRetainedPreviewLease(request.params.leaseId);
  if (retainedLease) {
    if (!authorizeScopedThread(request, response, retainedLease.lease.threadId)) {
      return;
    }

    response.json({
      ...serializeLease(retainedLease.lease, {
        containerState: retainedLease.runtime.status === "failed" ? "failed" : retainedLease.lease.status,
        containerRunning: false
      }),
      runtime: retainedLease.runtime
    });
    return;
  }

  const required = await requireContainer(request.params.leaseId, response);
  if (!required) {
    return;
  }
  if (rejectIfLeaseStopping(request.params.leaseId, response)) {
    return;
  }
  const { containerName, container } = required;
  if (!authorizeScopedThread(request, response, container.Config?.Labels?.["manor.thread-id"] || null)) {
    return;
  }

  response.json({
    ...serializeLease(
      {
        id: request.params.leaseId,
        threadId: container.Config?.Labels?.["manor.thread-id"] || null,
        projectId: container.Config?.Labels?.["manor.project-id"] || "unknown",
        projectLabel: container.Config?.Labels?.["manor.project-id"] || "Unknown",
        title: container.Config?.Labels?.["manor.title"] || `Preview ${request.params.leaseId.slice(0, 8)}`,
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
        lastError: container.State?.Error || null
      },
      {
        labels: container.Config?.Labels ?? null,
        containerState: container.State?.Running ? "running" : "stopped",
        containerRunning: Boolean(container.State?.Running)
      }
    ),
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
  if (rejectIfLeaseRetainedFailed(request.params.leaseId, response)) {
    return;
  }
  const required = await requireContainer(request.params.leaseId, response);
  if (!required) {
    return;
  }
  if (rejectIfLeaseUnavailable(required, request.params.leaseId, response)) {
    return;
  }
  if (!authorizeScopedThread(request, response, required.container.Config?.Labels?.["manor.thread-id"] || null)) {
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
  if (rejectIfLeaseRetainedFailed(request.params.leaseId, response)) {
    return;
  }
  const required = await requireContainer(request.params.leaseId, response);
  if (!required) {
    return;
  }
  if (rejectIfLeaseUnavailable(required, request.params.leaseId, response)) {
    return;
  }
  if (!authorizeScopedThread(request, response, required.container.Config?.Labels?.["manor.thread-id"] || null)) {
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
  if (rejectIfLeaseRetainedFailed(request.params.leaseId, response)) {
    return;
  }
  const required = await requireContainer(request.params.leaseId, response);
  if (!required) {
    return;
  }
  if (rejectIfLeaseUnavailable(required, request.params.leaseId, response)) {
    return;
  }
  if (!authorizeScopedThread(request, response, required.container.Config?.Labels?.["manor.thread-id"] || null)) {
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
    const output = await collectExecOutput(required.containerRef, exec);
    response.json({
      leaseId: request.params.leaseId,
      command,
      exitCode: output.exitCode,
      stdout: output.stdout,
      stderr: output.stderr
    });
  } catch (error) {
    response.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

app.post("/leases/:leaseId/verify", async (request, response) => {
  if (!hasBrokerAccess(request)) {
    response.status(403).json({ error: "Forbidden" });
    return;
  }
  if (rejectIfLeaseRetainedFailed(request.params.leaseId, response)) {
    return;
  }
  const required = await requireContainer(request.params.leaseId, response);
  if (!required) {
    return;
  }
  if (rejectIfLeaseUnavailable(required, request.params.leaseId, response)) {
    return;
  }

  try {
    const playwrightContainer = docker.getContainer(playwrightContainerName);
    await playwrightContainer.inspect();
    const targetUrl = `${internalOperatorBaseUrl}${routeBase}/${request.params.leaseId}/`;
    const runId = `${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
    const outputDir = `/artifacts/previews/${request.params.leaseId}/${runId}`;
    const mode = request.body?.mode === "headful" ? "headful" : "headless";
    const options = JSON.stringify({
      runId,
      mode,
      targetUrl,
      outputDir
    });
    const execCommand =
      mode === "headful"
        ? ["xvfb-run", "-a", "node", "/opt/manor/playwright/verify-preview.mjs", options]
        : ["node", "/opt/manor/playwright/verify-preview.mjs", options];
    const exec = await playwrightContainer.exec({
      AttachStdout: true,
      AttachStderr: true,
      Cmd: execCommand,
      WorkingDir: "/opt/manor/playwright",
      Tty: false
    });
    const output = await collectExecOutput(playwrightContainer, exec);
    if (output.exitCode !== 0) {
      throw new Error(output.stderr.trim() || output.stdout.trim() || "Preview verification failed");
    }
    const parsed = JSON.parse(output.stdout.trim());
    response.json(parsed);
  } catch (error) {
    response.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

app.delete("/leases/:leaseId", async (request, response) => {
  if (!hasBrokerAccess(request)) {
    response.status(403).json({ error: "Forbidden" });
    return;
  }
  const containerName = toContainerName(request.params.leaseId);
  setLeaseTransition(request.params.leaseId, "stopping");
  if (pendingPreviewLeases.has(request.params.leaseId)) {
    pendingPreviewLeases.delete(request.params.leaseId);
  }

  try {
    await docker.getContainer(containerName).remove({ force: true });
  } catch {
    // already gone
  }

  await dropPreviewEgressLeasePolicy(request.params.leaseId).catch(() => {});
  clearLeaseTransition(request.params.leaseId);
  clearLeaseBootstrapState(request.params.leaseId);
  clearRetainedPreviewLease(request.params.leaseId);
  response.json({ ok: true, leaseId: request.params.leaseId });
});

app.post("/services", async (request, response) => {
  if (!hasBrokerAccess(request)) {
    response.status(403).json({ error: "Forbidden" });
    return;
  }
  const payload = request.body ?? {};
  if (typeof payload.templateId !== "string" || !payload.templateId) {
    response.status(400).json({ error: "templateId is required" });
    return;
  }

  if (typeof payload.title !== "string" || !payload.title) {
    response.status(400).json({ error: "title is required" });
    return;
  }

  const serviceId = payload.serviceId || crypto.randomUUID();
  const containerName = toServiceContainerName(serviceId);
  const env = typeof payload.env === "object" && payload.env ? payload.env : {};
  const envVars = [];

  for (const [key, value] of Object.entries(env)) {
    if (typeof value === "string") {
      envVars.push(`${key}=${value}`);
    }
  }

  try {
    await ensureImage(payload.image);

    const existing = await inspectContainer(containerName);
    if (existing) {
      await docker.getContainer(containerName).remove({ force: true });
    }

    const containerOptions = {
      Image: payload.image,
      name: containerName,
      Env: envVars,
      Labels: {
        "manor.managed": "true",
        "manor.runtime-kind": "service",
        "manor.service-id": serviceId,
        "manor.thread-id": payload.threadId ?? "",
        "manor.project-id": payload.projectId || "service",
        "manor.template-id": payload.templateId,
        "manor.template-label": payload.templateLabel || payload.templateId,
        "manor.title": payload.title,
        "manor.target-port": String(Number(payload.targetPort || 0)),
        "manor.worktree-path": typeof payload.worktreePath === "string" ? payload.worktreePath : ""
      },
      HostConfig: {
        AutoRemove: true,
        NetworkMode: previewNetwork
      }
    };

    if (typeof payload.worktreePath === "string" && payload.worktreePath) {
      containerOptions.WorkingDir = payload.worktreePath;
    }

    if (typeof payload.command === "string" && payload.command) {
      containerOptions.Cmd = ["bash", "-lc", payload.command];
    }

    const serviceContainer = await docker.createContainer(containerOptions);
    await serviceContainer.start();
    try {
      await docker.getNetwork(sharedWorkNetwork).connect({ Container: serviceContainer.id });
    } catch {
      // already connected or shared network unavailable
    }
    const container = await inspectContainer(containerName);
    if (!container) {
      throw new Error("Service container did not start");
    }

    response.json({
      id: serviceId,
      threadId: payload.threadId ?? null,
      projectId: payload.projectId || "service",
      projectLabel: payload.projectLabel || payload.projectId || "service",
      title: payload.title,
      templateId: payload.templateId,
      templateLabel: payload.templateLabel || payload.templateId,
      runtimeKind: payload.runtimeKind || "container",
      containerName,
      targetHost: containerName,
      targetPort: Number(payload.targetPort || 0),
      worktreePath: typeof payload.worktreePath === "string" ? payload.worktreePath : null,
      image: payload.image,
      status: container?.State?.Running ? "running" : "starting",
      createdAt: new Date(container.Created).getTime(),
      updatedAt: Date.now(),
      lastError: container.State?.Error || null,
      env
    });
  } catch (error) {
    response.status(500).json({
      id: serviceId,
      threadId: payload.threadId ?? null,
      projectId: payload.projectId || "service",
      projectLabel: payload.projectLabel || payload.projectId || "service",
      title: payload.title,
      templateId: payload.templateId,
      templateLabel: payload.templateLabel || payload.templateId,
      runtimeKind: payload.runtimeKind || "container",
      containerName,
      targetHost: containerName,
      targetPort: Number(payload.targetPort || 0),
      worktreePath: typeof payload.worktreePath === "string" ? payload.worktreePath : null,
      image: payload.image,
      status: "failed",
      createdAt: Date.now(),
      updatedAt: Date.now(),
      lastError: error instanceof Error ? error.message : String(error),
      env,
      error: error instanceof Error ? error.message : String(error)
    });
  }
});

app.get("/services", async (request, response) => {
  const requestedThreadId = typeof request.query.threadId === "string" ? request.query.threadId : null;
  if (!authorizeScopedThread(request, response, requestedThreadId)) {
    return;
  }

  try {
    const containers = await listManagedContainers(
      (labels) => labels["manor.runtime-kind"] === "service" && (!requestedThreadId || (labels["manor.thread-id"] || "") === requestedThreadId)
    );

    response.json(
      containers.map((container) => ({
        id: container.Labels?.["manor.service-id"] || "",
        threadId: container.Labels?.["manor.thread-id"] || null,
        projectId: container.Labels?.["manor.project-id"] || "service",
        projectLabel: container.Labels?.["manor.project-id"] || "service",
        title: container.Labels?.["manor.title"] || `Service ${(container.Labels?.["manor.service-id"] || "").slice(0, 8)}`,
        templateId: container.Labels?.["manor.template-id"] || "unknown",
        templateLabel: container.Labels?.["manor.template-label"] || container.Labels?.["manor.template-id"] || "unknown",
        runtimeKind: "container",
        containerName: container.Names?.[0]?.replace(/^\//, "") || "",
        targetHost: container.Names?.[0]?.replace(/^\//, "") || "",
        targetPort: Number(container.Labels?.["manor.target-port"] || "0"),
        worktreePath: null,
        image: container.Image || previewImage,
        status: container.State === "running" ? "running" : "stopped",
        createdAt: typeof container.Created === "number" ? container.Created * 1000 : Date.now(),
        updatedAt: Date.now(),
        lastError: null,
        env: {}
      }))
    );
  } catch (error) {
    response.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

app.get("/services/:serviceId", async (request, response) => {
  const required = await requireServiceContainer(request.params.serviceId, response);
  if (!required) {
    return;
  }
  const { containerName, container } = required;
  if (!authorizeScopedThread(request, response, container.Config?.Labels?.["manor.thread-id"] || null)) {
    return;
  }

  response.json({
    id: request.params.serviceId,
    threadId: container.Config?.Labels?.["manor.thread-id"] || null,
    projectId: container.Config?.Labels?.["manor.project-id"] || "service",
    projectLabel: container.Config?.Labels?.["manor.project-id"] || "service",
    title: container.Config?.Labels?.["manor.title"] || `Service ${request.params.serviceId.slice(0, 8)}`,
    templateId: container.Config?.Labels?.["manor.template-id"] || "unknown",
    templateLabel: container.Config?.Labels?.["manor.template-label"] || container.Config?.Labels?.["manor.template-id"] || "unknown",
    runtimeKind: "container",
    containerName,
    targetHost: containerName,
    targetPort: Number(container.Config?.Labels?.["manor.target-port"] || "0"),
    worktreePath: container.Config?.WorkingDir || null,
    image: container.Config?.Image || previewImage,
    status: container.State?.Running ? "running" : "stopped",
    createdAt: new Date(container.Created).getTime(),
    updatedAt: Date.now(),
    lastError: container.State?.Error || null,
    env: Object.fromEntries((container.Config?.Env ?? []).map((entry) => {
      const [key, ...rest] = entry.split("=");
      return [key, rest.join("=")];
    })),
    runtime: {
      running: Boolean(container.State?.Running),
      status: container.State?.Status || "unknown",
      startedAt: container.State?.StartedAt ? new Date(container.State.StartedAt).getTime() : null,
      finishedAt: container.State?.FinishedAt ? new Date(container.State.FinishedAt).getTime() : null,
      error: container.State?.Error || null
    }
  });
});

app.get("/services/:serviceId/processes", async (request, response) => {
  const required = await requireServiceContainer(request.params.serviceId, response);
  if (!required) {
    return;
  }
  if (!authorizeScopedThread(request, response, required.container.Config?.Labels?.["manor.thread-id"] || null)) {
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

app.get("/services/:serviceId/logs", async (request, response) => {
  const required = await requireServiceContainer(request.params.serviceId, response);
  if (!required) {
    return;
  }
  if (!authorizeScopedThread(request, response, required.container.Config?.Labels?.["manor.thread-id"] || null)) {
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
      leaseId: request.params.serviceId,
      logs
    });
  } catch (error) {
    response.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

app.post("/services/:serviceId/exec", async (request, response) => {
  const required = await requireServiceContainer(request.params.serviceId, response);
  if (!required) {
    return;
  }
  if (!authorizeScopedThread(request, response, required.container.Config?.Labels?.["manor.thread-id"] || null)) {
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
    const output = await collectExecOutput(required.containerRef, exec);
    response.json({
      leaseId: request.params.serviceId,
      command,
      exitCode: output.exitCode,
      stdout: output.stdout,
      stderr: output.stderr
    });
  } catch (error) {
    response.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

app.delete("/services/:serviceId", async (request, response) => {
  if (!hasBrokerAccess(request)) {
    response.status(403).json({ error: "Forbidden" });
    return;
  }
  const containerName = toServiceContainerName(request.params.serviceId);

  try {
    await docker.getContainer(containerName).remove({ force: true });
  } catch {
    // already gone
  }

  response.json({ ok: true, serviceId: request.params.serviceId });
});

app.listen(port, "0.0.0.0", () => {
  console.log(`Runtime broker listening on ${port}`);
});
