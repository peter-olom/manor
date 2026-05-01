import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export function createBrokerCore(context, deps = {}) {
  const { previewNetwork, previewOutboundNetwork, sharedWorkNetwork, previewImage, routeBase, previewEgressConfigPath, previewEgressAdminUrl, brokerToken, codexAccessRegistryPath, stackBindingRegistryPath, internalOperatorBaseUrl, playwrightContainerName, runtimeBrokerContainerName, previewEgressContainerName, artifactsRootDir, playwrightArtifactsScratchDir, stackNetworkPrefix, stackVolumePrefix, stackInfraReconnectIntervalMs, docker, leaseTransitions, leaseBootstrapStates, activeLeaseBootstrapMonitors, pendingPreviewLeases, retainedPreviewLeases, noHeartbeatReadyDelayMs } = context;
  const {
    listStackMemberContainers,
    listManagedServiceContainersByVolume,
    scheduleLeaseBootstrapMonitor,
    serializeLease,
    serializeLiveLeaseFromSummary
  } = deps;

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

function normalizeHeaderMap(value) {
  if (!value || typeof value !== "object") {
    return {};
  }

  return Object.fromEntries(
    Object.entries(value)
      .filter((entry) => typeof entry[0] === "string" && typeof entry[1] === "string")
      .map(([key, headerValue]) => [key.trim(), headerValue.trim()])
      .filter(([key, headerValue]) => key.length > 0 && headerValue.length > 0)
  );
}

function normalizeCookieEntries(value) {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .filter((entry) => entry && typeof entry === "object")
    .map((entry) => ({
      name: normalizeString(entry.name),
      value: typeof entry.value === "string" ? entry.value : ""
    }))
    .filter((entry) => entry.name.length > 0);
}

function appendPreviewRoutePath(baseUrl, routePath) {
  const normalizedBase = normalizeString(baseUrl);
  const normalizedRoute = normalizeString(routePath).replace(/^\/+/, "");
  if (!normalizedRoute) {
    return normalizedBase;
  }

  if (!normalizedBase.endsWith("/")) {
    return `${normalizedBase}/${normalizedRoute}`;
  }

  return `${normalizedBase}${normalizedRoute}`;
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

function normalizeWorkspaceMode(value) {
  const normalized = normalizeString(value).toLowerCase();
  if (normalized === "shared" || normalized === "snapshot") {
    return normalized;
  }
  return "";
}

function parseAliases(rawValue) {
  return [...new Set(String(rawValue ?? "").split(",").map((value) => value.trim()).filter(Boolean))];
}

function normalizeExecArgs(value) {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
    .filter(Boolean);
}

function resolveTargetHost(containerName, aliases = []) {
  return aliases[0] || containerName;
}

function shellQuote(value) {
  return JSON.stringify(String(value));
}

function buildShellSnippet(command, cwd = "") {
  const normalizedCommand = normalizeString(command);
  const normalizedCwd = normalizeString(cwd);
  if (!normalizedCommand) {
    return "";
  }
  return normalizedCwd ? `cd ${shellQuote(normalizedCwd)} && ${normalizedCommand}` : normalizedCommand;
}

function buildShellCommand(command, cwd = "") {
  const snippet = buildShellSnippet(command, cwd);
  return ["sh", "-lc", snippet];
}

async function inspectNetwork(networkName) {
  try {
    return await docker.getNetwork(networkName).inspect();
  } catch {
    return null;
  }
}

async function ensureBrokerManagedNetwork(networkName, labels = {}, options = {}) {
  const existing = await inspectNetwork(networkName);
  if (existing) {
    return existing;
  }

  await docker.createNetwork({
    Name: networkName,
    CheckDuplicate: true,
    Internal: options.internal === true,
    Labels: {
      "manor.managed": "true",
      ...labels
    }
  });

  const created = await inspectNetwork(networkName);
  if (!created) {
    throw new Error(`Network ${networkName} was created but could not be inspected`);
  }
  return created;
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

async function listStackInternalHosts(stackId) {
  const normalizedStackId = normalizeString(stackId);
  if (!normalizedStackId) {
    return [];
  }

  const members = await listStackMemberContainers(normalizedStackId);
  const hosts = new Set(["localhost", "127.0.0.1", "::1"]);
  for (const member of members) {
    const labels = member.Labels || {};
    const aliases = parseAliases(labels["manor.aliases"]);
    const containerName = member.Names?.[0]?.replace(/^\//, "") || "";
    const targetHost = normalizeString(labels["manor.target-host"]);
    if (containerName) {
      hosts.add(containerName);
    }
    if (targetHost) {
      hosts.add(targetHost);
    }
    for (const alias of aliases) {
      hosts.add(alias);
    }
  }

  return [...hosts];
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

async function ensureStackInfrastructure(networkName, options = {}) {
  const includePreviewEgress = options.includePreviewEgress !== false;
  const includePlaywright = options.includePlaywright !== false;

  await ensureNetworkConnection(networkName, runtimeBrokerContainerName, ["runtime-broker"]);
  if (includePreviewEgress) {
    await ensureNetworkConnection(networkName, previewEgressContainerName, ["preview-egress"]);
  }
  if (includePlaywright) {
    await ensureNetworkConnection(networkName, playwrightContainerName, ["playwright"]);
  }
}

function isDirectPreviewInternet(egressProfile, egressDomains = []) {
  return (!egressProfile || egressProfile === "internet") && egressDomains.length === 0;
}

function isPreviewProxyEgress(egressProfile, egressDomains = []) {
  return egressDomains.length > 0 || (egressProfile && egressProfile !== "none" && egressProfile !== "internet");
}

async function ensurePreviewOutboundNetwork() {
  return ensureBrokerManagedNetwork(
    previewOutboundNetwork,
    {
      "manor.runtime-kind": "preview-outbound",
      "manor.title": "Preview outbound"
    },
    { internal: false }
  );
}

async function reconcileManagedStackInfrastructure() {
  const stackNetworks = await listManagedNetworks((labels) => labels?.["manor.runtime-kind"] === "stack");
  for (const network of stackNetworks) {
    if (!network?.Name) {
      continue;
    }
    try {
      await ensureStackInfrastructure(network.Name);
    } catch (error) {
      console.warn(
        `Failed to reconcile stack infrastructure for ${network.Name}:`,
        error instanceof Error ? error.message : String(error)
      );
    }
  }
}

async function reconcileManagedPreviewBootstraps() {
  const containers = await listManagedContainers((labels) => labels["manor.runtime-kind"] !== "service");
  for (const containerSummary of containers) {
    if (containerSummary.State !== "running") {
      continue;
    }

    const lease = await serializeLiveLeaseFromSummary(containerSummary);
    if (!lease?.id) {
      continue;
    }

    const bootstrap = lease.bootstrap;
    if (!bootstrap || bootstrap.phase === "ready" || bootstrap.phase === "failed") {
      continue;
    }

    setLeaseBootstrapState(lease.id, bootstrap);
    scheduleLeaseBootstrapMonitor(lease);
  }
}

async function reconcileManagedRuntimeState() {
  await reconcileManagedStackInfrastructure();
  await reconcileManagedPreviewBootstraps();
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
  let response;
  try {
    response = await fetch(new URL(pathname, previewEgressAdminUrl), {
      ...init,
      headers: {
        "content-type": "application/json",
        ...(init?.headers ?? {})
      }
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`Preview egress admin is unavailable: ${reason}`);
  }
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
  const workspaceMode = normalizeWorkspaceMode(payload.workspaceMode) || "shared";

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
    publicPort: null,
    publicUrl: null,
    tailnetUrl: null,
    routePrefix: `${routeBase}/${id}/`,
    operatorUrl: `${routeBase}/${id}/`,
    command: payload.command,
    workspaceMode,
    image: payload.image || previewImage,
    egressProfile: payload.egressProfile || "internet",
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


  return {
    loadStackBindingRegistry,
    saveStackBindingRegistry,
    getStackThreadBinding,
    setStackThreadBinding,
    clearStackThreadBinding,
    hasBrokerAccess,
    loadCodexAccessRegistry,
    getCodexGrant,
    authorizeScopedThread,
    toContainerName,
    toServiceContainerName,
    toStackNetworkName,
    toManagedVolumeName,
    normalizeString,
    normalizeHeaderMap,
    normalizeCookieEntries,
    appendPreviewRoutePath,
    normalizeStackStorageMode,
    sanitizeStorageToken,
    deriveWorktreeToken,
    resolveWorktreeProjectInfo,
    deriveProjectStorageKey,
    deriveJobStorageKey,
    normalizeStringArray,
    normalizeBoolean,
    parseAliases,
    normalizeExecArgs,
    resolveTargetHost,
    shellQuote,
    buildShellSnippet,
    buildShellCommand,
    inspectNetwork,
    ensureBrokerManagedNetwork,
    listManagedNetworks,
    inspectVolume,
    listManagedVolumes,
    listStackInternalHosts,
    ensureNetworkConnection,
    disconnectNetworkConnection,
    ensureStackInfrastructure,
    isDirectPreviewInternet,
    isPreviewProxyEgress,
    ensurePreviewOutboundNetwork,
    reconcileManagedStackInfrastructure,
    reconcileManagedPreviewBootstraps,
    reconcileManagedRuntimeState,
    findStackNetwork,
    resolveStackThreadId,
    resolveAttachedThreadId,
    getStackScopeKeyFromLabels,
    getStackCloneSourceKeyFromLabels,
    getStackStorageModeFromLabels,
    getStackBaseStorageKeyFromLabels,
    getStackPromoteTargetKeyFromLabels,
    listStackVolumesByScopeKey,
    ensureVolumeIsIdle,
    requireStackNetwork,
    loadPreviewEgressProfiles,
    previewEgressProfiles,
    requestPreviewEgress,
    ensurePreviewEgressLeasePolicy,
    dropPreviewEgressLeasePolicy,
    buildLease,
    buildStack,
    normalizeBootstrapHeartbeatKind,
    normalizePositiveInteger,
    normalizeBootstrapTarget,
    buildBootstrapConfig,
    bootstrapConfigFromLabels,
    buildBootstrapFallback,
    getLeaseBootstrapState,
    serializeBootstrapState,
    setLeaseBootstrapState,
    mergeLeaseBootstrapState,
    clearLeaseBootstrapState,
    retainPreviewLease,
    getRetainedPreviewLease,
    clearRetainedPreviewLease,
    retainFailedLease,
    inspectContainer,
    requireContainer,
    getLeaseTransition,
    setLeaseTransition,
    clearLeaseTransition,
    resolveLeaseStatus,
    rejectIfLeaseStopping,
    rejectIfLeaseUnavailable,
    rejectIfLeaseRetainedFailed,
    requireServiceContainer,
    listManagedContainers
  };
}
