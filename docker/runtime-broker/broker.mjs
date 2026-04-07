import express from "express";
import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
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
const stackBindingRegistryPath =
  process.env.RUNTIME_STACK_BINDINGS_FILE ?? "/opt/manor/runtime-broker/state/stack-thread-bindings.json";
const internalOperatorBaseUrl = process.env.RUNTIME_OPERATOR_BASE_URL_INTERNAL ?? "http://butler:8080";
const playwrightContainerName = process.env.RUNTIME_PLAYWRIGHT_CONTAINER ?? "manor-playwright";
const runtimeBrokerContainerName = process.env.RUNTIME_BROKER_CONTAINER ?? "manor-runtime-broker";
const previewEgressContainerName = process.env.RUNTIME_PREVIEW_EGRESS_CONTAINER ?? "manor-preview-egress";
const artifactsRootDir = path.resolve(process.env.RUNTIME_ARTIFACTS_DIR ?? "/artifacts");
const playwrightArtifactsScratchDir = process.env.RUNTIME_PLAYWRIGHT_ARTIFACT_ROOT ?? "/tmp/manor-playwright-artifacts";
const stackNetworkPrefix = process.env.RUNTIME_STACK_NETWORK_PREFIX ?? "manor-stack";
const stackVolumePrefix = process.env.RUNTIME_STACK_VOLUME_PREFIX ?? "manor-stack-vol";
const docker = new Docker({ socketPath: "/var/run/docker.sock" });
const leaseTransitions = new Map();
const leaseBootstrapStates = new Map();
const pendingPreviewLeases = new Map();
const retainedPreviewLeases = new Map();
const noHeartbeatReadyDelayMs = Number(process.env.RUNTIME_NO_HEARTBEAT_READY_DELAY_MS ?? "2000");

function loadStackBindingRegistry() {
  try {
    const raw = fs.readFileSync(stackBindingRegistryPath, "utf8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed.stackThreadBindings === "object" && parsed.stackThreadBindings
      ? parsed.stackThreadBindings
      : {};
  } catch {
    return {};
  }
}

function saveStackBindingRegistry(bindings) {
  fs.mkdirSync(path.dirname(stackBindingRegistryPath), { recursive: true });
  fs.writeFileSync(
    stackBindingRegistryPath,
    `${JSON.stringify({ stackThreadBindings: bindings }, null, 2)}\n`,
    "utf8"
  );
}

function getStackThreadBinding(stackId) {
  const normalizedStackId = normalizeString(stackId);
  if (!normalizedStackId) {
    return null;
  }

  const bindings = loadStackBindingRegistry();
  const threadId = normalizeString(bindings[normalizedStackId]);
  return threadId || null;
}

function setStackThreadBinding(stackId, threadId) {
  const normalizedStackId = normalizeString(stackId);
  const normalizedThreadId = normalizeString(threadId);
  if (!normalizedStackId || !normalizedThreadId) {
    return;
  }

  const bindings = loadStackBindingRegistry();
  bindings[normalizedStackId] = normalizedThreadId;
  saveStackBindingRegistry(bindings);
}

function clearStackThreadBinding(stackId) {
  const normalizedStackId = normalizeString(stackId);
  if (!normalizedStackId) {
    return;
  }

  const bindings = loadStackBindingRegistry();
  if (!(normalizedStackId in bindings)) {
    return;
  }
  delete bindings[normalizedStackId];
  saveStackBindingRegistry(bindings);
}

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

function toStackNetworkName(stackId) {
  return `${stackNetworkPrefix}-${stackId.replace(/[^a-zA-Z0-9_.-]/g, "").slice(0, 32)}`;
}

function toManagedVolumeName(scopeKey, templateId, volumeKey) {
  const digest = crypto
    .createHash("sha256")
    .update(`${scopeKey}|${templateId}|${volumeKey}`)
    .digest("hex")
    .slice(0, 12);
  const safeScope = scopeKey.replace(/[^a-zA-Z0-9_.-]/g, "").slice(0, 20) || "stack";
  const safeTemplate = templateId.replace(/[^a-zA-Z0-9_.-]/g, "").slice(0, 20) || "service";
  const safeVolumeKey = volumeKey.replace(/[^a-zA-Z0-9_.-]/g, "").slice(0, 20) || "data";
  return `${stackVolumePrefix}-${safeScope}-${safeTemplate}-${safeVolumeKey}-${digest}`;
}

function normalizeString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeStackStorageMode(value) {
  const normalized = normalizeString(value).toLowerCase();
  if (normalized === "ephemeral" || normalized === "job" || normalized === "base" || normalized === "custom") {
    return normalized;
  }
  return "";
}

function sanitizeStorageToken(value, fallback) {
  const normalized = normalizeString(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return (normalized || fallback).slice(0, 32);
}

function deriveWorktreeToken(worktreePath) {
  const normalized = normalizeString(worktreePath).replace(/\\/g, "/").replace(/\/+$/, "");
  if (!normalized) {
    return "";
  }

  const segments = normalized.split("/").filter(Boolean);
  return segments.at(-1) || "";
}

function resolveWorktreeProjectInfo(worktreePath, fallbackId = "unknown", fallbackLabel = "Unknown") {
  const normalized = normalizeString(worktreePath).replace(/\\/g, "/").replace(/\/+$/, "");
  if (normalized.startsWith("/repos/.manor-worktrees/")) {
    const relative = normalized.slice("/repos/.manor-worktrees/".length);
    const [repoName] = relative.split("/").filter(Boolean);
    if (repoName) {
      return { id: repoName, label: repoName };
    }
  }

  if (normalized.startsWith("/repos/")) {
    const relative = normalized.slice("/repos/".length);
    const [repoName] = relative.split("/").filter(Boolean);
    if (repoName) {
      return { id: repoName, label: repoName };
    }
  }

  const normalizedFallbackId = normalizeString(fallbackId) || "unknown";
  const normalizedFallbackLabel = normalizeString(fallbackLabel) || normalizedFallbackId || "Unknown";
  return {
    id: normalizedFallbackId,
    label: normalizedFallbackLabel
  };
}

function deriveProjectStorageKey(payload) {
  const projectToken = sanitizeStorageToken(
    payload.projectId || payload.projectLabel || deriveWorktreeToken(payload.worktreePath) || "stack",
    "stack"
  );
  return `project-${projectToken}-base`;
}

function deriveJobStorageKey(payload, stackId) {
  const projectToken = sanitizeStorageToken(
    payload.projectId || payload.projectLabel || deriveWorktreeToken(payload.worktreePath) || "stack",
    "stack"
  );
  const jobToken = sanitizeStorageToken(payload.threadId || payload.title || stackId || "job", "job");
  return `project-${projectToken}-job-${jobToken}`;
}

function normalizeStringArray(value) {
  if (!Array.isArray(value)) {
    return [];
  }

  return [...new Set(value.map((entry) => normalizeString(entry)).filter(Boolean))];
}

function normalizeBoolean(value) {
  return value === true || value === "true" || value === "1" || value === 1;
}

function parseAliases(rawValue) {
  return [...new Set(String(rawValue ?? "").split(",").map((value) => value.trim()).filter(Boolean))];
}

function resolveTargetHost(containerName, aliases = []) {
  return aliases[0] || containerName;
}

async function inspectNetwork(networkName) {
  try {
    return await docker.getNetwork(networkName).inspect();
  } catch {
    return null;
  }
}

async function listManagedNetworks(filter) {
  const networks = await docker.listNetworks();
  return networks.filter((network) => filter(network.Labels || {}, network));
}

async function inspectVolume(volumeName) {
  try {
    return await docker.getVolume(volumeName).inspect();
  } catch {
    return null;
  }
}

async function listManagedVolumes(filter) {
  const volumes = await docker.listVolumes();
  const entries = Array.isArray(volumes?.Volumes) ? volumes.Volumes : [];
  return entries.filter((volume) => filter(volume.Labels || {}, volume));
}

async function ensureNetworkConnection(networkName, containerName, aliases = []) {
  const networkRef = docker.getNetwork(networkName);
  try {
    await networkRef.connect({
      Container: containerName,
      EndpointConfig: aliases.length > 0 ? { Aliases: aliases } : undefined
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.includes("already exists") && !message.includes("already connected")) {
      throw error;
    }
  }
}

async function disconnectNetworkConnection(networkName, containerName) {
  try {
    await docker.getNetwork(networkName).disconnect({
      Container: containerName,
      Force: true
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.includes("is not connected") && !message.includes("No such container")) {
      throw error;
    }
  }
}

async function findStackNetwork(stackId) {
  const normalizedStackId = normalizeString(stackId);
  if (!normalizedStackId) {
    return null;
  }

  const matches = await listManagedNetworks(
    (labels) => labels["manor.runtime-kind"] === "stack" && labels["manor.stack-id"] === normalizedStackId
  );
  return matches[0] ?? null;
}

async function resolveStackThreadId(stackId, fallbackThreadId = null) {
  const normalizedFallback = normalizeString(fallbackThreadId) || null;
  const normalizedStackId = normalizeString(stackId);
  if (!normalizedStackId) {
    return normalizedFallback;
  }

  const binding = getStackThreadBinding(normalizedStackId);
  if (binding) {
    return binding;
  }

  const stack = await findStackNetwork(normalizedStackId);
  if (!stack) {
    return normalizedFallback;
  }

  return normalizeString(stack.Labels?.["manor.thread-id"]) || normalizedFallback;
}

async function resolveAttachedThreadId(rawThreadId, stackId) {
  const explicitThreadId = normalizeString(rawThreadId);
  if (explicitThreadId) {
    return explicitThreadId;
  }

  return resolveStackThreadId(stackId, null);
}

function getStackScopeKeyFromLabels(labels) {
  return normalizeString(labels?.["manor.stack-scope-key"]);
}

function getStackCloneSourceKeyFromLabels(labels) {
  return normalizeString(labels?.["manor.clone-from-storage-key"]);
}

function getStackStorageModeFromLabels(labels) {
  return normalizeStackStorageMode(labels?.["manor.storage-mode"]) || "ephemeral";
}

function getStackBaseStorageKeyFromLabels(labels) {
  return normalizeString(labels?.["manor.base-storage-key"]);
}

function getStackPromoteTargetKeyFromLabels(labels) {
  return normalizeString(labels?.["manor.promote-target-storage-key"]);
}

async function listStackVolumesByScopeKey(scopeKey) {
  const normalizedScopeKey = normalizeString(scopeKey);
  if (!normalizedScopeKey) {
    return [];
  }
  return listManagedVolumes(
    (labels) => labels["manor.runtime-kind"] === "stack-volume" && labels["manor.stack-scope-key"] === normalizedScopeKey
  );
}

async function ensureVolumeIsIdle(volumeName, purpose) {
  const activeUsers = await listManagedServiceContainersByVolume(volumeName);
  if (activeUsers.length === 0) {
    return;
  }

  const existingTitle = activeUsers[0].Labels?.["manor.title"] || activeUsers[0].Labels?.["manor.service-id"] || "service";
  throw new Error(`${purpose} requires ${volumeName} to be idle. Stop ${existingTitle} first.`);
}

async function requireStackNetwork(stackId, response) {
  const stack = await findStackNetwork(stackId);
  if (!stack) {
    response.status(404).json({ error: "Stack not found" });
    return null;
  }

  return stack;
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
  const stackId = normalizeString(payload.stackId) || null;

  return {
    id,
    threadId: payload.threadId ?? null,
    projectId: payload.projectId || "unknown",
    projectLabel: payload.projectLabel || payload.projectId || "Unknown",
    title: payload.title || `Preview ${id.slice(0, 8)}`,
    stackId,
    aliases: normalizeStringArray(payload.aliases),
    worktreePath: payload.worktreePath,
    branchName: payload.branchName ?? null,
    containerName,
    targetHost: resolveTargetHost(containerName, normalizeStringArray(payload.aliases)),
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

function buildStack(payload) {
  const id = payload.stackId || crypto.randomUUID();
  const now = Date.now();
  const explicitStorageKey = normalizeString(payload.storageKey);
  const explicitCloneFromStorageKey = normalizeString(payload.cloneFromStorageKey);
  const requestedStorageMode = normalizeStackStorageMode(payload.storageMode);
  const storageMode =
    requestedStorageMode ||
    (normalizeBoolean(payload.retainsVolumes) || explicitStorageKey || explicitCloneFromStorageKey ? "custom" : "ephemeral");
  const derivedBaseStorageKey = deriveProjectStorageKey(payload);
  let retainsVolumes = false;
  let baseStorageKey = derivedBaseStorageKey;
  let storageKey = "";
  let cloneFromStorageKey = "";
  let defaultPromoteTargetStorageKey = "";

  if (storageMode === "job") {
    retainsVolumes = true;
    baseStorageKey = explicitCloneFromStorageKey || derivedBaseStorageKey;
    storageKey = explicitStorageKey || deriveJobStorageKey(payload, id);
    cloneFromStorageKey = baseStorageKey && baseStorageKey !== storageKey ? baseStorageKey : "";
    defaultPromoteTargetStorageKey = cloneFromStorageKey;
  } else if (storageMode === "base") {
    retainsVolumes = true;
    baseStorageKey = explicitStorageKey || derivedBaseStorageKey;
    storageKey = baseStorageKey;
    cloneFromStorageKey =
      explicitCloneFromStorageKey && explicitCloneFromStorageKey !== storageKey ? explicitCloneFromStorageKey : "";
  } else if (storageMode === "custom") {
    retainsVolumes = normalizeBoolean(payload.retainsVolumes) || Boolean(explicitStorageKey || explicitCloneFromStorageKey);
    storageKey = retainsVolumes ? explicitStorageKey || normalizeString(payload.threadId) || id : "";
    cloneFromStorageKey =
      retainsVolumes && explicitCloneFromStorageKey && explicitCloneFromStorageKey !== storageKey ? explicitCloneFromStorageKey : "";
    baseStorageKey = cloneFromStorageKey || (storageKey ? storageKey : derivedBaseStorageKey);
    defaultPromoteTargetStorageKey = cloneFromStorageKey;
  } else {
    baseStorageKey = derivedBaseStorageKey;
  }

  return {
    id,
    threadId: payload.threadId ?? null,
    projectId: payload.projectId || "unknown",
    projectLabel: payload.projectLabel || payload.projectId || "Unknown",
    title: payload.title || `Stack ${id.slice(0, 8)}`,
    worktreePath: normalizeString(payload.worktreePath) || null,
    networkName: toStackNetworkName(id),
    status: "running",
    storageMode,
    retainsVolumes,
    baseStorageKey,
    storageKey,
    cloneFromStorageKey,
    defaultPromoteTargetStorageKey,
    volumeNames: [],
    createdAt: now,
    updatedAt: now,
    lastError: null,
    previewIds: [],
    serviceIds: []
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

async function serializeLiveLeaseFromSummary(containerSummary) {
  const labels = containerSummary.Labels || {};
  const stackId = labels["manor.stack-id"] || null;
  const effectiveThreadId = await resolveAttachedThreadId(labels["manor.thread-id"] || null, stackId);
  const worktreePath = labels["manor.worktree-path"] || containerSummary.Names?.[0]?.replace(/^\//, "") || "/repos";
  const project = resolveWorktreeProjectInfo(
    worktreePath,
    labels["manor.project-id"] || "unknown",
    labels["manor.project-label"] || labels["manor.project-id"] || "Unknown"
  );
  const aliases = parseAliases(labels["manor.aliases"]);
  const containerName = containerSummary.Names?.[0]?.replace(/^\//, "") || "";
  return serializeLease(
    {
      id: labels["manor.lease-id"] || "",
      threadId: effectiveThreadId,
      projectId: project.id,
      projectLabel: project.label,
      title: labels["manor.title"] || `Preview ${(labels["manor.lease-id"] || "").slice(0, 8)}`,
      stackId,
      aliases,
      worktreePath,
      branchName: null,
      containerName,
      targetHost: resolveTargetHost(containerName, aliases),
      targetPort: Number(labels["manor.target-port"] || labels["manor.port"] || "3000"),
      routePrefix: `${routeBase}/${labels["manor.lease-id"] || ""}/`,
      operatorUrl: `${routeBase}/${labels["manor.lease-id"] || ""}/`,
      command: Array.isArray(containerSummary.Command) ? containerSummary.Command.join(" ") : containerSummary.Command || "",
      image: containerSummary.Image || previewImage,
      egressProfile: labels["manor.egress-profile"] || "none",
      egressDomains:
        labels["manor.egress-domains"]
          ?.split(",")
          .map((value) => value.trim())
          .filter(Boolean) || [],
      status: containerSummary.State,
      createdAt: typeof containerSummary.Created === "number" ? containerSummary.Created * 1000 : Date.now(),
      updatedAt: Date.now(),
      lastError: null
    },
    {
      labels,
      containerState: containerSummary.State,
      containerRunning: containerSummary.State === "running"
    }
  );
}

async function serializeInspectedLease(containerName, container) {
  const labels = container.Config?.Labels || {};
  const stackId = labels["manor.stack-id"] || null;
  const effectiveThreadId = await resolveAttachedThreadId(labels["manor.thread-id"] || null, stackId);
  const worktreePath = container.Config?.WorkingDir || "/repos";
  const project = resolveWorktreeProjectInfo(
    worktreePath,
    labels["manor.project-id"] || "unknown",
    labels["manor.project-label"] || labels["manor.project-id"] || "Unknown"
  );
  const aliases = parseAliases(labels["manor.aliases"]);
  return {
    ...serializeLease(
      {
        id: labels["manor.lease-id"] || "",
        threadId: effectiveThreadId,
        projectId: project.id,
        projectLabel: project.label,
        title: labels["manor.title"] || `Preview ${(labels["manor.lease-id"] || "").slice(0, 8)}`,
        stackId,
        aliases,
        worktreePath,
        branchName: null,
        containerName,
        targetHost: resolveTargetHost(containerName, aliases),
        targetPort: Number(container.Config?.Env?.find((entry) => entry.startsWith("PORT="))?.slice(5) || "3000"),
        routePrefix: `${routeBase}/${labels["manor.lease-id"] || ""}/`,
        operatorUrl: `${routeBase}/${labels["manor.lease-id"] || ""}/`,
        command: Array.isArray(container.Config?.Cmd) ? container.Config.Cmd.join(" ") : "",
        image: container.Config?.Image || previewImage,
        egressProfile:
          container.Config?.Env?.find((entry) => entry.startsWith("MANOR_EGRESS_PROFILE="))?.slice("MANOR_EGRESS_PROFILE=".length) ||
          "none",
        egressDomains:
          labels["manor.egress-domains"]
            ?.split(",")
            .map((value) => value.trim())
            .filter(Boolean) || [],
        status: container.State?.Running ? "running" : "stopped",
        createdAt: new Date(container.Created).getTime(),
        updatedAt: Date.now(),
        lastError: container.State?.Error || null
      },
      {
        labels,
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
  };
}

async function serializeLiveServiceFromSummary(containerSummary) {
  const labels = containerSummary.Labels || {};
  const stackId = labels["manor.stack-id"] || null;
  const effectiveThreadId = await resolveAttachedThreadId(labels["manor.thread-id"] || null, stackId);
  const worktreePath = labels["manor.worktree-path"] || null;
  const project = resolveWorktreeProjectInfo(
    worktreePath,
    labels["manor.project-id"] || "service",
    labels["manor.project-label"] || labels["manor.project-id"] || "service"
  );
  const aliases = parseAliases(labels["manor.aliases"]);
  const containerName = containerSummary.Names?.[0]?.replace(/^\//, "") || "";
  return {
    id: labels["manor.service-id"] || "",
    threadId: effectiveThreadId,
    projectId: project.id,
    projectLabel: project.label,
    title: labels["manor.title"] || `Service ${(labels["manor.service-id"] || "").slice(0, 8)}`,
    stackId,
    aliases,
    templateId: labels["manor.template-id"] || "unknown",
    templateLabel: labels["manor.template-label"] || labels["manor.template-id"] || "unknown",
    runtimeKind: "container",
    containerName,
    targetHost: resolveTargetHost(containerName, aliases),
    targetPort: Number(labels["manor.target-port"] || "0"),
    worktreePath,
    image: containerSummary.Image || previewImage,
    status: containerSummary.State === "running" ? "running" : "stopped",
    storageKind:
      labels["manor.storage-kind"] === "volume" || labels["manor.storage-kind"] === "worktree"
        ? labels["manor.storage-kind"]
        : "ephemeral",
    sticky: labels["manor.storage-kind"] === "volume",
    volumeName: labels["manor.volume-name"] || null,
    volumeMountPath: labels["manor.volume-mount-path"] || null,
    createdAt: typeof containerSummary.Created === "number" ? containerSummary.Created * 1000 : Date.now(),
    updatedAt: Date.now(),
    lastError: null,
    env: {}
  };
}

async function serializeInspectedService(containerName, container) {
  const labels = container.Config?.Labels || {};
  const stackId = labels["manor.stack-id"] || null;
  const effectiveThreadId = await resolveAttachedThreadId(labels["manor.thread-id"] || null, stackId);
  const worktreePath = container.Config?.WorkingDir || null;
  const project = resolveWorktreeProjectInfo(
    worktreePath,
    labels["manor.project-id"] || "service",
    labels["manor.project-label"] || labels["manor.project-id"] || "service"
  );
  const aliases = parseAliases(labels["manor.aliases"]);
  return {
    id: labels["manor.service-id"] || "",
    threadId: effectiveThreadId,
    projectId: project.id,
    projectLabel: project.label,
    title: labels["manor.title"] || `Service ${(labels["manor.service-id"] || "").slice(0, 8)}`,
    stackId,
    aliases,
    templateId: labels["manor.template-id"] || "unknown",
    templateLabel: labels["manor.template-label"] || labels["manor.template-id"] || "unknown",
    runtimeKind: "container",
    containerName,
    targetHost: resolveTargetHost(containerName, aliases),
    targetPort: Number(labels["manor.target-port"] || "0"),
    worktreePath,
    image: container.Config?.Image || previewImage,
    status: container.State?.Running ? "running" : "stopped",
    storageKind:
      labels["manor.storage-kind"] === "volume" || labels["manor.storage-kind"] === "worktree"
        ? labels["manor.storage-kind"]
        : "ephemeral",
    sticky: labels["manor.storage-kind"] === "volume",
    volumeName: labels["manor.volume-name"] || null,
    volumeMountPath: labels["manor.volume-mount-path"] || null,
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
  };
}

async function listStackMemberContainers(stackId) {
  return listManagedContainers((labels) => labels["manor.stack-id"] === stackId);
}

async function listManagedServiceContainersByVolume(volumeName, exceptServiceId = "") {
  return listManagedContainers(
    (labels) =>
      labels["manor.runtime-kind"] === "service" &&
      labels["manor.volume-name"] === volumeName &&
      labels["manor.service-id"] !== exceptServiceId
  );
}

async function ensureManagedStackVolume({
  scopeKey,
  templateId,
  templateLabel,
  volumeKey,
  mountPath,
  threadId,
  projectId,
  projectLabel
}) {
  const volumeName = toManagedVolumeName(scopeKey, templateId, volumeKey);
  const existing = await inspectVolume(volumeName);
  if (existing) {
    return { volumeName, volume: existing, created: false };
  }

  await docker.createVolume({
    Name: volumeName,
    Labels: {
      "manor.managed": "true",
      "manor.runtime-kind": "stack-volume",
      "manor.stack-scope-key": scopeKey,
      "manor.thread-id": threadId ?? "",
      "manor.project-id": projectId || "service",
      "manor.project-label": projectLabel || projectId || "service",
      "manor.template-id": templateId,
      "manor.template-label": templateLabel || templateId,
      "manor.volume-key": volumeKey,
      "manor.mount-path": mountPath,
      "manor.created-at": String(Date.now())
    }
  });

  const created = await inspectVolume(volumeName);
  if (!created) {
    throw new Error(`Volume ${volumeName} was created but could not be inspected`);
  }
  return { volumeName, volume: created, created: true };
}

async function runVolumeCopyJob({
  sourceVolumeName,
  targetVolumeName,
  clearTarget = false
}) {
  await ensureImage(previewImage);
  const helperName = `manor-volume-copy-${crypto.randomUUID().replace(/[^a-zA-Z0-9_.-]/g, "").slice(0, 20)}`;
  const copyContainer = await docker.createContainer({
    Image: previewImage,
    name: helperName,
    Cmd: [
      "sh",
      "-lc",
      [
        "set -eu",
        "mkdir -p /from /to",
        clearTarget ? "find /to -mindepth 1 -maxdepth 1 -exec rm -rf {} +" : "true",
        "if [ -z \"$(find /from -mindepth 1 -maxdepth 1 -print -quit)\" ]; then exit 0; fi",
        "cd /from",
        "tar cf - . | (cd /to && tar xpf -)"
      ].join("; ")
    ],
    Labels: {
      "manor.runtime-kind": "volume-copy"
    },
    HostConfig: {
      AutoRemove: true,
      NetworkMode: "none",
      Mounts: [
        {
          Type: "volume",
          Source: sourceVolumeName,
          Target: "/from",
          ReadOnly: true
        },
        {
          Type: "volume",
          Source: targetVolumeName,
          Target: "/to"
        }
      ]
    }
  });

  try {
    await copyContainer.start();
    const result = await copyContainer.wait();
    const statusCode = Number(result?.StatusCode ?? 1);
    if (statusCode !== 0) {
      throw new Error(`Volume copy failed with status ${statusCode}`);
    }
  } finally {
    await copyContainer.remove({ force: true }).catch(() => {});
  }
}

async function cloneManagedStackVolume({
  sourceScopeKey,
  targetScopeKey,
  templateId,
  templateLabel,
  volumeKey,
  mountPath,
  threadId,
  projectId,
  projectLabel
}) {
  const sourceVolumeName = toManagedVolumeName(sourceScopeKey, templateId, volumeKey);
  const sourceVolume = await inspectVolume(sourceVolumeName);
  const target = await ensureManagedStackVolume({
    scopeKey: targetScopeKey,
    templateId,
    templateLabel,
    volumeKey,
    mountPath,
    threadId,
    projectId,
    projectLabel
  });

  if (!sourceVolume || !target.created) {
    return {
      sourceVolumeName,
      sourceExists: Boolean(sourceVolume),
      volumeName: target.volumeName,
      cloned: false
    };
  }

  try {
    await ensureVolumeIsIdle(sourceVolumeName, "Volume fork");
    await runVolumeCopyJob({
      sourceVolumeName,
      targetVolumeName: target.volumeName,
      clearTarget: true
    });
    return {
      sourceVolumeName,
      sourceExists: true,
      volumeName: target.volumeName,
      cloned: true
    };
  } catch (error) {
    await docker.getVolume(target.volumeName).remove().catch(() => {});
    throw error;
  }
}

function toManagedVolumeBackupName(volumeName) {
  const suffix = crypto.randomUUID().replace(/[^a-zA-Z0-9_.-]/g, "").slice(0, 8);
  return `${volumeName}-backup-${suffix}`.slice(0, 120);
}

async function overwriteManagedStackVolume({
  sourceVolumeName,
  targetScopeKey,
  templateId,
  templateLabel,
  volumeKey,
  mountPath,
  threadId,
  projectId,
  projectLabel
}) {
  await ensureVolumeIsIdle(sourceVolumeName, "Volume promotion");

  const targetVolumeName = toManagedVolumeName(targetScopeKey, templateId, volumeKey);
  const targetVolume = await inspectVolume(targetVolumeName);
  let createdTarget = false;
  if (targetVolume) {
    await ensureVolumeIsIdle(targetVolumeName, "Volume promotion");
  }

  let backupVolumeName = null;
  if (targetVolume) {
    backupVolumeName = toManagedVolumeBackupName(targetVolumeName);
    await docker.createVolume({
      Name: backupVolumeName,
      Labels: {
        "manor.managed": "true",
        "manor.runtime-kind": "stack-volume-backup",
        "manor.source-volume-name": targetVolumeName
      }
    });
    await runVolumeCopyJob({
      sourceVolumeName: targetVolumeName,
      targetVolumeName: backupVolumeName,
      clearTarget: true
    });
  } else {
    const ensuredTarget = await ensureManagedStackVolume({
      scopeKey: targetScopeKey,
      templateId,
      templateLabel,
      volumeKey,
      mountPath,
      threadId,
      projectId,
      projectLabel
    });
    createdTarget = ensuredTarget.created;
  }

  try {
    await runVolumeCopyJob({
      sourceVolumeName,
      targetVolumeName,
      clearTarget: true
    });
    if (backupVolumeName) {
      await docker.getVolume(backupVolumeName).remove().catch(() => {});
    }
    return targetVolumeName;
  } catch (error) {
    if (backupVolumeName) {
      await runVolumeCopyJob({
        sourceVolumeName: backupVolumeName,
        targetVolumeName,
        clearTarget: true
      }).catch(() => {});
      await docker.getVolume(backupVolumeName).remove().catch(() => {});
    } else if (createdTarget) {
      await docker.getVolume(targetVolumeName).remove().catch(() => {});
    }
    throw error;
  }
}

function summarizeStackStatus(containers) {
  if (containers.some((container) => container.State && container.State !== "running")) {
    return "degraded";
  }

  return "running";
}

async function serializeStackFromNetwork(networkSummary) {
  const labels = networkSummary.Labels || {};
  const stackId = labels["manor.stack-id"] || "";
  const effectiveThreadId = (await resolveStackThreadId(stackId, labels["manor.thread-id"] || null)) || null;
  const worktreePath = labels["manor.worktree-path"] || null;
  const project = resolveWorktreeProjectInfo(
    worktreePath,
    labels["manor.project-id"] || "unknown",
    labels["manor.project-label"] || labels["manor.project-id"] || "Unknown"
  );
  const storageMode = getStackStorageModeFromLabels(labels);
  const retainsVolumes = labels["manor.retains-volumes"] === "true";
  const stackScopeKey = getStackScopeKeyFromLabels(labels);
  const cloneFromStorageKey = getStackCloneSourceKeyFromLabels(labels);
  const baseStorageKey =
    getStackBaseStorageKeyFromLabels(labels) ||
    (storageMode === "base"
      ? stackScopeKey
      : getStackPromoteTargetKeyFromLabels(labels) || cloneFromStorageKey || stackScopeKey);
  const defaultPromoteTargetStorageKey = getStackPromoteTargetKeyFromLabels(labels) || cloneFromStorageKey;
  const containers = await listStackMemberContainers(stackId);
  const volumes = retainsVolumes ? await listStackVolumesByScopeKey(stackScopeKey) : [];
  const previewIds = containers
    .filter((container) => container.Labels?.["manor.runtime-kind"] !== "service")
    .map((container) => container.Labels?.["manor.lease-id"] || "")
    .filter(Boolean);
  const serviceIds = containers
    .filter((container) => container.Labels?.["manor.runtime-kind"] === "service")
    .map((container) => container.Labels?.["manor.service-id"] || "")
    .filter(Boolean);
  const createdAtRaw = typeof labels["manor.created-at"] === "string" ? Number(labels["manor.created-at"]) : Date.now();
  const createdAt = Number.isFinite(createdAtRaw) && createdAtRaw > 0 ? createdAtRaw : Date.now();
  const memberUpdatedAt = containers.reduce((max, container) => {
    const created = typeof container.Created === "number" ? container.Created * 1000 : createdAt;
    return Math.max(max, created);
  }, createdAt);

  return {
    id: stackId,
    threadId: effectiveThreadId,
    projectId: project.id,
    projectLabel: project.label,
    title: labels["manor.title"] || `Stack ${stackId.slice(0, 8)}`,
    worktreePath,
    networkName: networkSummary.Name,
    status: summarizeStackStatus(containers),
    storageMode,
    retainsVolumes,
    baseStorageKey: baseStorageKey || null,
    storageKey: stackScopeKey || null,
    cloneFromStorageKey: cloneFromStorageKey || null,
    defaultPromoteTargetStorageKey: defaultPromoteTargetStorageKey || null,
    volumeNames: volumes.map((volume) => volume.Name).filter(Boolean).sort(),
    createdAt,
    updatedAt: memberUpdatedAt,
    lastError: null,
    previewIds,
    serviceIds
  };
}

async function collectExecOutput(containerRef, exec, options = {}) {
  const stdinText = typeof options.stdin === "string" ? options.stdin : "";
  const stdinProvided = options.stdinProvided === true;
  const stream = await exec.start({ hijack: true, stdin: stdinProvided });
  if (stdinProvided) {
    stream.write(stdinText);
    stream.end();
  }
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

async function readContainerFile(containerRef, filePath) {
  const exec = await containerRef.exec({
    AttachStdout: true,
    AttachStderr: true,
    Cmd: [
      "bash",
      "-lc",
      `test -f ${JSON.stringify(filePath)} && base64 -w0 ${JSON.stringify(filePath)}`
    ],
    Tty: false
  });
  const output = await collectExecOutput(containerRef, exec);
  if (output.exitCode !== 0) {
    throw new Error(output.stderr.trim() || output.stdout.trim() || `Could not read container file ${filePath}`);
  }
  return Buffer.from(output.stdout.trim(), "base64");
}

async function removeContainerPath(containerRef, targetPath) {
  const exec = await containerRef.exec({
    AttachStdout: true,
    AttachStderr: true,
    Cmd: ["bash", "-lc", `rm -rf ${JSON.stringify(targetPath)}`],
    Tty: false
  });
  await collectExecOutput(containerRef, exec).catch(() => null);
}

async function persistVerificationArtifacts(containerRef, verification, remoteOutputDir, localOutputDir) {
  fs.mkdirSync(localOutputDir, { recursive: true });

  const persistedArtifacts = [];
  for (const artifact of Array.isArray(verification.artifacts) ? verification.artifacts : []) {
    if (!artifact || typeof artifact !== "object") {
      continue;
    }
    if (artifact.kind === "manifest") {
      continue;
    }
    const remotePath = normalizeString(artifact.filePath);
    if (!remotePath) {
      continue;
    }
    const localPath = path.join(localOutputDir, path.basename(remotePath));
    const contents = await readContainerFile(containerRef, remotePath);
    fs.writeFileSync(localPath, contents);
    const stats = fs.statSync(localPath);
    persistedArtifacts.push({
      ...artifact,
      fileName: path.basename(localPath),
      filePath: localPath,
      sizeBytes: stats.size,
      url: null
    });
  }

  const manifestPath = path.join(localOutputDir, "manifest.json");
  const manifestArtifact = {
    kind: "manifest",
    label: "Manifest",
    fileName: path.basename(manifestPath),
    filePath: manifestPath,
    contentType: "application/json",
    sizeBytes: 0,
    url: null
  };
  const persistedVerification = {
    ...verification,
    artifacts: [manifestArtifact, ...persistedArtifacts]
  };
  fs.writeFileSync(manifestPath, `${JSON.stringify(persistedVerification, null, 2)}\n`, "utf8");
  manifestArtifact.sizeBytes = fs.statSync(manifestPath).size;
  fs.writeFileSync(manifestPath, `${JSON.stringify(persistedVerification, null, 2)}\n`, "utf8");

  await removeContainerPath(containerRef, remoteOutputDir);
  return persistedVerification;
}

app.get("/health", async (_request, response) => {
  try {
    await docker.ping();
    response.json({ ok: true });
  } catch (error) {
    response.status(500).json({ ok: false, error: error instanceof Error ? error.message : String(error) });
  }
});

app.post("/stacks", async (request, response) => {
  if (!hasBrokerAccess(request)) {
    response.status(403).json({ error: "Forbidden" });
    return;
  }

  const payload = request.body ?? {};
  const title = normalizeString(payload.title);
  if (!title) {
    response.status(400).json({ error: "title is required" });
    return;
  }

  const stack = buildStack(payload);

  try {
    const existing = await inspectNetwork(stack.networkName);
    if (existing) {
      response.status(409).json({ error: `Stack ${stack.id} already exists` });
      return;
    }

    await docker.createNetwork({
      Name: stack.networkName,
      CheckDuplicate: true,
      Internal: true,
      Labels: {
        "manor.managed": "true",
        "manor.runtime-kind": "stack",
        "manor.stack-id": stack.id,
        "manor.thread-id": stack.threadId ?? "",
        "manor.project-id": stack.projectId,
        "manor.project-label": stack.projectLabel,
        "manor.title": stack.title,
        "manor.worktree-path": stack.worktreePath ?? "",
        "manor.storage-mode": stack.storageMode,
        "manor.retains-volumes": stack.retainsVolumes ? "true" : "false",
        "manor.base-storage-key": stack.baseStorageKey || "",
        "manor.stack-scope-key": stack.storageKey || "",
        "manor.clone-from-storage-key": stack.cloneFromStorageKey || "",
        "manor.promote-target-storage-key": stack.defaultPromoteTargetStorageKey || "",
        "manor.created-at": String(stack.createdAt)
      }
    });

    await ensureNetworkConnection(stack.networkName, runtimeBrokerContainerName, ["runtime-broker"]).catch(() => {});
    await ensureNetworkConnection(stack.networkName, previewEgressContainerName, ["preview-egress"]).catch(() => {});
    await ensureNetworkConnection(stack.networkName, playwrightContainerName, ["playwright"]).catch(() => {});

    const created = await inspectNetwork(stack.networkName);
    if (!created) {
      throw new Error("Stack network was created but could not be inspected");
    }
    response.json(await serializeStackFromNetwork(created));
  } catch (error) {
    response.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

app.get("/stacks", async (request, response) => {
  const requestedThreadId = typeof request.query.threadId === "string" ? request.query.threadId : null;
  if (!authorizeScopedThread(request, response, requestedThreadId)) {
    return;
  }

  try {
    const networks = await listManagedNetworks((labels) => labels["manor.runtime-kind"] === "stack");
    const stacks = await Promise.all(networks.map((network) => serializeStackFromNetwork(network)));
    response.json(
      stacks
        .filter((stack) => !requestedThreadId || stack.threadId === requestedThreadId)
        .sort((left, right) => right.updatedAt - left.updatedAt)
    );
  } catch (error) {
    response.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

app.get("/stacks/:stackId", async (request, response) => {
  const stack = await requireStackNetwork(request.params.stackId, response);
  if (!stack) {
    return;
  }
  const effectiveThreadId = await resolveStackThreadId(request.params.stackId, stack.Labels?.["manor.thread-id"] || null);
  if (!authorizeScopedThread(request, response, effectiveThreadId)) {
    return;
  }

  try {
    response.json(await serializeStackFromNetwork(stack));
  } catch (error) {
    response.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

app.post("/stacks/:stackId/adopt", async (request, response) => {
  if (!hasBrokerAccess(request)) {
    response.status(403).json({ error: "Forbidden" });
    return;
  }

  const stack = await requireStackNetwork(request.params.stackId, response);
  if (!stack) {
    return;
  }

  const threadId = normalizeString(request.body?.threadId);
  if (!threadId) {
    response.status(400).json({ error: "threadId is required" });
    return;
  }

  try {
    const currentThreadId = await resolveStackThreadId(request.params.stackId, stack.Labels?.["manor.thread-id"] || null);
    if (currentThreadId && currentThreadId !== threadId) {
      response.status(409).json({ error: `Stack ${request.params.stackId} is already attached to a different job` });
      return;
    }

    const members = await listStackMemberContainers(request.params.stackId);
    const conflictingMember = members.find((container) => {
      const memberThreadId = normalizeString(container.Labels?.["manor.thread-id"]);
      return memberThreadId && memberThreadId !== threadId;
    });
    if (conflictingMember) {
      response.status(409).json({
        error: `Stack ${request.params.stackId} has member runtime already attached to a different job`
      });
      return;
    }

    setStackThreadBinding(request.params.stackId, threadId);
    response.json(await serializeStackFromNetwork(stack));
  } catch (error) {
    response.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

app.post("/stacks/:stackId/promote", async (request, response) => {
  if (!hasBrokerAccess(request)) {
    response.status(403).json({ error: "Forbidden" });
    return;
  }

  const stack = await requireStackNetwork(request.params.stackId, response);
  if (!stack) {
    return;
  }

  const retainsVolumes = stack.Labels?.["manor.retains-volumes"] === "true";
  const sourceStorageKey = getStackScopeKeyFromLabels(stack.Labels);
  const defaultTargetStorageKey = getStackPromoteTargetKeyFromLabels(stack.Labels) || getStackCloneSourceKeyFromLabels(stack.Labels);
  const targetStorageKey = normalizeString(request.body?.targetStorageKey) || defaultTargetStorageKey;
  if (!retainsVolumes || !sourceStorageKey) {
    response.status(400).json({ error: "Stack does not retain volumes" });
    return;
  }
  if (!targetStorageKey) {
    response.status(400).json({ error: "targetStorageKey is required" });
    return;
  }
  if (targetStorageKey === sourceStorageKey) {
    response.status(400).json({ error: "targetStorageKey must differ from the stack storage key" });
    return;
  }

  try {
    const sourceVolumes = await listStackVolumesByScopeKey(sourceStorageKey);
    const promotedVolumes = [];

    for (const volume of sourceVolumes) {
      const templateId = normalizeString(volume.Labels?.["manor.template-id"]);
      const templateLabel = normalizeString(volume.Labels?.["manor.template-label"]) || templateId;
      const volumeKey = normalizeString(volume.Labels?.["manor.volume-key"]);
      const mountPath = normalizeString(volume.Labels?.["manor.mount-path"]);
      if (!templateId || !volumeKey || !mountPath || !volume.Name) {
        continue;
      }

      const targetVolumeName = await overwriteManagedStackVolume({
        sourceVolumeName: volume.Name,
        targetScopeKey: targetStorageKey,
        templateId,
        templateLabel,
        volumeKey,
        mountPath,
        threadId: stack.Labels?.["manor.thread-id"] || null,
        projectId: stack.Labels?.["manor.project-id"] || "service",
        projectLabel: stack.Labels?.["manor.project-label"] || stack.Labels?.["manor.project-id"] || "service"
      });
      promotedVolumes.push(targetVolumeName);
    }

    response.json({
      ok: true,
      stackId: request.params.stackId,
      sourceStorageKey,
      targetStorageKey,
      promotedVolumes: promotedVolumes.sort()
    });
  } catch (error) {
    response.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

app.delete("/stacks/:stackId", async (request, response) => {
  if (!hasBrokerAccess(request)) {
    response.status(403).json({ error: "Forbidden" });
    return;
  }

  const stack = await requireStackNetwork(request.params.stackId, response);
  if (!stack) {
    return;
  }
  const dropVolumes = normalizeBoolean(request.query.dropVolumes);
  const retainsVolumes = stack.Labels?.["manor.retains-volumes"] === "true";
  const stackScopeKey = getStackScopeKeyFromLabels(stack.Labels);

  try {
    const members = await listStackMemberContainers(request.params.stackId);
    for (const container of members) {
      const isService = container.Labels?.["manor.runtime-kind"] === "service";
      const containerName = container.Names?.[0]?.replace(/^\//, "") || "";
      if (!containerName) {
        continue;
      }
      if (!isService) {
        const leaseId = container.Labels?.["manor.lease-id"] || "";
        if (leaseId) {
          clearLeaseBootstrapState(leaseId);
          clearRetainedPreviewLease(leaseId);
          await dropPreviewEgressLeasePolicy(leaseId).catch(() => {});
        }
      }
      await docker.getContainer(containerName).remove({ force: true }).catch(() => {});
    }

    await disconnectNetworkConnection(stack.Name, playwrightContainerName).catch(() => {});
    await disconnectNetworkConnection(stack.Name, previewEgressContainerName).catch(() => {});
    await disconnectNetworkConnection(stack.Name, runtimeBrokerContainerName).catch(() => {});
    await docker.getNetwork(stack.Name).remove().catch(() => {});

    if (retainsVolumes && dropVolumes) {
      const volumes = await listStackVolumesByScopeKey(stackScopeKey);
      for (const volume of volumes) {
        await docker.getVolume(volume.Name).remove().catch(() => {});
      }
    }

    clearStackThreadBinding(request.params.stackId);

    response.json({ ok: true, stackId: request.params.stackId });
  } catch (error) {
    response.status(500).json({ error: error instanceof Error ? error.message : String(error) });
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
  const stack = lease.stackId ? await findStackNetwork(lease.stackId) : null;
  if (lease.stackId && !stack) {
    response.status(400).json({ error: `Unknown stack: ${lease.stackId}` });
    return;
  }
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

    const aliases = [...new Set([lease.containerName, ...lease.aliases])];
    const networkName = stack?.Name || previewNetwork;

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
        "manor.project-label": lease.projectLabel,
        "manor.title": lease.title,
        "manor.stack-id": lease.stackId ?? "",
        "manor.aliases": lease.aliases.join(","),
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
        NetworkMode: networkName
      },
      NetworkingConfig: {
        EndpointsConfig: {
          [networkName]: {
            Aliases: aliases
          }
        }
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
    const containers = await listManagedContainers((labels) => labels["manor.runtime-kind"] !== "service");
    const liveLeases = (await Promise.all(containers.map((container) => serializeLiveLeaseFromSummary(container)))).filter(
      (lease) => !requestedThreadId || lease.threadId === requestedThreadId
    );
    const liveLeaseIds = new Set(liveLeases.map((lease) => lease.id));
    const pendingLeases = (
      await Promise.all(
        [...pendingPreviewLeases.values()].map(async (lease) => {
          const effectiveThreadId = await resolveAttachedThreadId(lease.threadId, lease.stackId);
          const project = resolveWorktreeProjectInfo(
            lease.worktreePath,
            lease.projectId,
            lease.projectLabel
          );
          return {
            threadId: effectiveThreadId,
            lease: serializeLease(
              {
                ...lease,
                threadId: effectiveThreadId,
                projectId: project.id,
                projectLabel: project.label,
                updatedAt: Date.now()
              },
              {
                containerState: "starting",
                containerRunning: false
              }
            )
          };
        })
      )
    )
      .filter(({ threadId, lease }) => (!requestedThreadId || threadId === requestedThreadId) && !liveLeaseIds.has(lease.id))
      .map(({ lease }) => lease);

    const retainedLeases = (
      await Promise.all(
        [...retainedPreviewLeases.values()].map(async ({ lease, runtime }) => {
          const effectiveThreadId = await resolveAttachedThreadId(lease.threadId, lease.stackId);
          const project = resolveWorktreeProjectInfo(
            lease.worktreePath,
            lease.projectId,
            lease.projectLabel
          );
          return {
            threadId: effectiveThreadId,
            lease: {
              ...serializeLease(
                {
                  ...lease,
                  threadId: effectiveThreadId,
                  projectId: project.id,
                  projectLabel: project.label
                },
                {
                  containerState: runtime.status === "failed" ? "failed" : lease.status,
                  containerRunning: false
                }
              ),
              runtime
            }
          };
        })
      )
    )
      .filter(({ threadId, lease }) => (!requestedThreadId || threadId === requestedThreadId) && !liveLeaseIds.has(lease.id))
      .map(({ lease }) => lease);

    response.json([...pendingLeases, ...retainedLeases, ...liveLeases].sort((left, right) => right.updatedAt - left.updatedAt));
  } catch (error) {
    response.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

app.get("/leases/:leaseId", async (request, response) => {
  const pendingLease = pendingPreviewLeases.get(request.params.leaseId);
  if (pendingLease) {
    const effectiveThreadId = await resolveAttachedThreadId(pendingLease.threadId, pendingLease.stackId);
    if (!authorizeScopedThread(request, response, effectiveThreadId)) {
      return;
    }
    const project = resolveWorktreeProjectInfo(
      pendingLease.worktreePath,
      pendingLease.projectId,
      pendingLease.projectLabel
    );

    response.json({
      ...serializeLease(
        {
          ...pendingLease,
          threadId: effectiveThreadId,
          projectId: project.id,
          projectLabel: project.label,
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
    const effectiveThreadId = await resolveAttachedThreadId(retainedLease.lease.threadId, retainedLease.lease.stackId);
    if (!authorizeScopedThread(request, response, effectiveThreadId)) {
      return;
    }
    const project = resolveWorktreeProjectInfo(
      retainedLease.lease.worktreePath,
      retainedLease.lease.projectId,
      retainedLease.lease.projectLabel
    );

    response.json({
      ...serializeLease(
        {
          ...retainedLease.lease,
          threadId: effectiveThreadId,
          projectId: project.id,
          projectLabel: project.label
        },
        {
          containerState: retainedLease.runtime.status === "failed" ? "failed" : retainedLease.lease.status,
          containerRunning: false
        }
      ),
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
  const effectiveThreadId = await resolveAttachedThreadId(
    container.Config?.Labels?.["manor.thread-id"] || null,
    container.Config?.Labels?.["manor.stack-id"] || null
  );
  if (!authorizeScopedThread(request, response, effectiveThreadId)) {
    return;
  }
  response.json(await serializeInspectedLease(containerName, container));
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
  const effectiveThreadId = await resolveAttachedThreadId(
    required.container.Config?.Labels?.["manor.thread-id"] || null,
    required.container.Config?.Labels?.["manor.stack-id"] || null
  );
  if (!authorizeScopedThread(request, response, effectiveThreadId)) {
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
  const effectiveThreadId = await resolveAttachedThreadId(
    required.container.Config?.Labels?.["manor.thread-id"] || null,
    required.container.Config?.Labels?.["manor.stack-id"] || null
  );
  if (!authorizeScopedThread(request, response, effectiveThreadId)) {
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
  const effectiveThreadId = await resolveAttachedThreadId(
    required.container.Config?.Labels?.["manor.thread-id"] || null,
    required.container.Config?.Labels?.["manor.stack-id"] || null
  );
  if (!authorizeScopedThread(request, response, effectiveThreadId)) {
    return;
  }

  const command = typeof request.body?.command === "string" ? request.body.command.trim() : "";
  const cwd = typeof request.body?.cwd === "string" ? request.body.cwd.trim() : "";
  const stdin = typeof request.body?.stdin === "string" ? request.body.stdin : "";
  const stdinProvided = request.body?.stdinProvided === true;
  if (!command) {
    response.status(400).json({ error: "command is required" });
    return;
  }

  try {
    const exec = await required.containerRef.exec({
      AttachStdin: stdinProvided,
      AttachStdout: true,
      AttachStderr: true,
      Cmd: ["bash", "-lc", cwd ? `cd ${JSON.stringify(cwd)} && ${command}` : command],
      WorkingDir: cwd || undefined,
      Tty: false
    });
    const output = await collectExecOutput(required.containerRef, exec, { stdin, stdinProvided });
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
    const remoteOutputDir = path.posix.join(playwrightArtifactsScratchDir, request.params.leaseId, runId);
    const localOutputDir = path.join(artifactsRootDir, "previews", request.params.leaseId, runId);
    const mode = request.body?.mode === "headful" ? "headful" : "headless";
    const options = JSON.stringify({
      runId,
      mode,
      targetUrl,
      outputDir: remoteOutputDir
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
    const persisted = await persistVerificationArtifacts(playwrightContainer, parsed, remoteOutputDir, localOutputDir);
    response.json(persisted);
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
  const stackId = normalizeString(payload.stackId) || null;
  const stack = stackId ? await findStackNetwork(stackId) : null;
  if (stackId && !stack) {
    response.status(400).json({ error: `Unknown stack: ${stackId}` });
    return;
  }
  const retainsVolumes = stack?.Labels?.["manor.retains-volumes"] === "true";
  const stackScopeKey = getStackScopeKeyFromLabels(stack?.Labels);
  const stackCloneSourceKey = getStackCloneSourceKeyFromLabels(stack?.Labels);
  const aliases = normalizeStringArray(payload.aliases);
  const stackVolumePath = normalizeString(payload.stackVolumePath) || null;
  const env = typeof payload.env === "object" && payload.env ? payload.env : {};
  const envVars = [];
  const storage = {
    kind: "ephemeral",
    sticky: false,
    volumeName: null,
    volumeMountPath: null
  };

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

    const networkName = stack?.Name || previewNetwork;
    const serviceAliases = [...new Set([containerName, ...aliases])];
    const targetHost = resolveTargetHost(containerName, aliases);

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
        "manor.project-label": payload.projectLabel || payload.projectId || "service",
        "manor.stack-id": stackId ?? "",
        "manor.aliases": aliases.join(","),
        "manor.template-id": payload.templateId,
        "manor.template-label": payload.templateLabel || payload.templateId,
        "manor.title": payload.title,
        "manor.target-port": String(Number(payload.targetPort || 0)),
        "manor.worktree-path": typeof payload.worktreePath === "string" ? payload.worktreePath : "",
        "manor.storage-kind": "ephemeral",
        "manor.volume-name": "",
        "manor.volume-mount-path": ""
      },
      HostConfig: {
        AutoRemove: true,
        NetworkMode: networkName
      },
      NetworkingConfig: {
        EndpointsConfig: {
          [networkName]: {
            Aliases: serviceAliases
          }
        }
      }
    };

    if (typeof payload.command === "string" && payload.command) {
      containerOptions.Entrypoint = ["sh", "-lc"];
      containerOptions.Cmd = [payload.command];
    }

    if (retainsVolumes && stackScopeKey && stackVolumePath) {
      const volumeKey = aliases[0] || payload.templateId;
      const volumeTemplateLabel = payload.templateLabel || payload.templateId;
      const { volumeName } =
        stackCloneSourceKey && stackCloneSourceKey !== stackScopeKey
          ? await cloneManagedStackVolume({
              sourceScopeKey: stackCloneSourceKey,
              targetScopeKey: stackScopeKey,
              templateId: payload.templateId,
              templateLabel: volumeTemplateLabel,
              volumeKey,
              mountPath: stackVolumePath,
              threadId: payload.threadId ?? null,
              projectId: payload.projectId || "service",
              projectLabel: payload.projectLabel || payload.projectId || "service"
            })
          : await ensureManagedStackVolume({
              scopeKey: stackScopeKey,
              templateId: payload.templateId,
              templateLabel: volumeTemplateLabel,
              volumeKey,
              mountPath: stackVolumePath,
              threadId: payload.threadId ?? null,
              projectId: payload.projectId || "service",
              projectLabel: payload.projectLabel || payload.projectId || "service"
            });
      const activeUsers = await listManagedServiceContainersByVolume(volumeName, serviceId);
      if (activeUsers.length > 0) {
        const existingTitle = activeUsers[0].Labels?.["manor.title"] || activeUsers[0].Labels?.["manor.service-id"] || "service";
        throw new Error(
          `Persistent volume ${volumeName} is already attached to ${existingTitle}. Use a distinct alias or stop the existing service first.`
        );
      }

      containerOptions.HostConfig.Mounts = [
        {
          Type: "volume",
          Source: volumeName,
          Target: stackVolumePath
        }
      ];
      containerOptions.Labels["manor.storage-kind"] = "volume";
      containerOptions.Labels["manor.volume-name"] = volumeName;
      containerOptions.Labels["manor.volume-mount-path"] = stackVolumePath;
      storage.kind = "volume";
      storage.sticky = true;
      storage.volumeName = volumeName;
      storage.volumeMountPath = stackVolumePath;
    }

    const serviceContainer = await docker.createContainer(containerOptions);
    await serviceContainer.start();
    if (!stackId) {
      try {
        await docker.getNetwork(sharedWorkNetwork).connect({ Container: serviceContainer.id });
      } catch {
        // already connected or shared network unavailable
      }
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
      stackId,
      aliases,
      templateId: payload.templateId,
      templateLabel: payload.templateLabel || payload.templateId,
      runtimeKind: payload.runtimeKind || "container",
      containerName,
      targetHost,
      targetPort: Number(payload.targetPort || 0),
      worktreePath: typeof payload.worktreePath === "string" ? payload.worktreePath : null,
      image: payload.image,
      status: container?.State?.Running ? "running" : "starting",
      storageKind: storage.kind,
      sticky: storage.sticky,
      volumeName: storage.volumeName,
      volumeMountPath: storage.volumeMountPath,
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
      stackId,
      aliases,
      templateId: payload.templateId,
      templateLabel: payload.templateLabel || payload.templateId,
      runtimeKind: payload.runtimeKind || "container",
      containerName,
      targetHost,
      targetPort: Number(payload.targetPort || 0),
      worktreePath: typeof payload.worktreePath === "string" ? payload.worktreePath : null,
      image: payload.image,
      status: "failed",
      storageKind: storage.kind,
      sticky: storage.sticky,
      volumeName: storage.volumeName,
      volumeMountPath: storage.volumeMountPath,
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
    const containers = await listManagedContainers((labels) => labels["manor.runtime-kind"] === "service");
    const services = (await Promise.all(containers.map((container) => serializeLiveServiceFromSummary(container)))).filter(
      (service) => !requestedThreadId || service.threadId === requestedThreadId
    );

    response.json(services);
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
  const effectiveThreadId = await resolveAttachedThreadId(
    container.Config?.Labels?.["manor.thread-id"] || null,
    container.Config?.Labels?.["manor.stack-id"] || null
  );
  if (!authorizeScopedThread(request, response, effectiveThreadId)) {
    return;
  }

  response.json(await serializeInspectedService(containerName, container));
});

app.get("/services/:serviceId/processes", async (request, response) => {
  const required = await requireServiceContainer(request.params.serviceId, response);
  if (!required) {
    return;
  }
  const effectiveThreadId = await resolveAttachedThreadId(
    required.container.Config?.Labels?.["manor.thread-id"] || null,
    required.container.Config?.Labels?.["manor.stack-id"] || null
  );
  if (!authorizeScopedThread(request, response, effectiveThreadId)) {
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
  const effectiveThreadId = await resolveAttachedThreadId(
    required.container.Config?.Labels?.["manor.thread-id"] || null,
    required.container.Config?.Labels?.["manor.stack-id"] || null
  );
  if (!authorizeScopedThread(request, response, effectiveThreadId)) {
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
  const effectiveThreadId = await resolveAttachedThreadId(
    required.container.Config?.Labels?.["manor.thread-id"] || null,
    required.container.Config?.Labels?.["manor.stack-id"] || null
  );
  if (!authorizeScopedThread(request, response, effectiveThreadId)) {
    return;
  }

  const command = typeof request.body?.command === "string" ? request.body.command.trim() : "";
  const cwd = typeof request.body?.cwd === "string" ? request.body.cwd.trim() : "";
  const stdin = typeof request.body?.stdin === "string" ? request.body.stdin : "";
  const stdinProvided = request.body?.stdinProvided === true;
  if (!command) {
    response.status(400).json({ error: "command is required" });
    return;
  }

  try {
    const exec = await required.containerRef.exec({
      AttachStdin: stdinProvided,
      AttachStdout: true,
      AttachStderr: true,
      Cmd: ["sh", "-lc", cwd ? `cd ${JSON.stringify(cwd)} && ${command}` : command],
      WorkingDir: cwd || undefined,
      Tty: false
    });
    const output = await collectExecOutput(required.containerRef, exec, { stdin, stdinProvided });
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
