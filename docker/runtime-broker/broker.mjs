import express from "express";
import crypto from "node:crypto";
import path from "node:path";
import { Readable } from "node:stream";
import Docker from "dockerode";
import { createBrokerCore } from "./broker-core.mjs";
import { createBrokerRuntime } from "./broker-runtime.mjs";
import { createBrokerStorage } from "./broker-storage.mjs";
const port = Number(process.env.RUNTIME_BROKER_PORT ?? "8090");
const previewNetwork = process.env.RUNTIME_PREVIEW_NETWORK ?? "manor_work";
const previewOutboundNetwork = process.env.RUNTIME_PREVIEW_OUTBOUND_NETWORK ?? "manor_preview_outbound";
const sharedWorkNetwork = process.env.RUNTIME_SERVICE_SHARED_NETWORK ?? "manor_work";
const previewImage = process.env.RUNTIME_PREVIEW_IMAGE ?? "node:22-bookworm";
const routeBase = process.env.RUNTIME_ROUTE_BASE ?? "/preview";
const previewEgressConfigPath = process.env.RUNTIME_PREVIEW_EGRESS_CONFIG ?? "/opt/manor/config/preview-egress-profiles.json";
const previewEgressAdminUrl = process.env.RUNTIME_PREVIEW_EGRESS_ADMIN_URL ?? "http://preview-egress:8091";
const brokerToken = process.env.RUNTIME_BROKER_TOKEN ?? null;
const codexAccessRegistryPath = process.env.RUNTIME_CODEX_ACCESS_FILE ?? "/state/codex-broker-access.json";
const stackBindingRegistryPath = process.env.RUNTIME_STACK_BINDINGS_FILE ?? "/opt/manor/runtime-broker/state/stack-thread-bindings.json";
const internalOperatorBaseUrl = process.env.RUNTIME_OPERATOR_BASE_URL_INTERNAL ?? "http://butler:8080";
const codexWorkspaceContainerName = process.env.RUNTIME_CODEX_WORKSPACE_CONTAINER ?? "manor-codex-box";
const butlerContainerName = process.env.RUNTIME_BUTLER_CONTAINER ?? "manor-butler";
const butlerArtifactsRootDir = path.posix.resolve(process.env.RUNTIME_BUTLER_ARTIFACTS_DIR ?? "/artifacts");
const playwrightContainerName = process.env.RUNTIME_PLAYWRIGHT_CONTAINER ?? "manor-playwright";
const runtimeBrokerContainerName = process.env.RUNTIME_BROKER_CONTAINER ?? "manor-runtime-broker";
const previewEgressContainerName = process.env.RUNTIME_PREVIEW_EGRESS_CONTAINER ?? "manor-preview-egress";
const playwrightArtifactsScratchDir = process.env.RUNTIME_PLAYWRIGHT_ARTIFACT_ROOT ?? "/tmp/manor-playwright-artifacts";
const stackNetworkPrefix = process.env.RUNTIME_STACK_NETWORK_PREFIX ?? "manor-stack";
const stackVolumePrefix = process.env.RUNTIME_STACK_VOLUME_PREFIX ?? "manor-stack-vol";
const stackInfraReconnectIntervalMs = Number(process.env.RUNTIME_STACK_INFRA_RECONNECT_INTERVAL_MS ?? "30000");
const docker = new Docker({ socketPath: "/var/run/docker.sock" });
const leaseTransitions = new Map(), leaseBootstrapStates = new Map(), activeLeaseBootstrapMonitors = new Set();
const pendingPreviewLeases = new Map(), retainedPreviewLeases = new Map();
const noHeartbeatReadyDelayMs = Number(process.env.RUNTIME_NO_HEARTBEAT_READY_DELAY_MS ?? "2000");
const app = express(); app.use(express.json());
const brokerContext = {
  previewNetwork,
  previewOutboundNetwork,
  sharedWorkNetwork,
  previewImage,
  routeBase,
  previewEgressConfigPath,
  previewEgressAdminUrl,
  brokerToken,
  codexAccessRegistryPath,
  stackBindingRegistryPath,
  internalOperatorBaseUrl,
  codexWorkspaceContainerName,
  butlerContainerName,
  butlerArtifactsRootDir,
  playwrightContainerName,
  runtimeBrokerContainerName,
  previewEgressContainerName,
  playwrightArtifactsScratchDir,
  stackNetworkPrefix,
  stackVolumePrefix,
  stackInfraReconnectIntervalMs,
  docker,
  leaseTransitions,
  leaseBootstrapStates,
  activeLeaseBootstrapMonitors,
  pendingPreviewLeases,
  retainedPreviewLeases,
  noHeartbeatReadyDelayMs
};
let runtimeHelpers;
let storageHelpers;
const coreHelpers = createBrokerCore(brokerContext, {
  listStackMemberContainers: (...args) => storageHelpers.listStackMemberContainers(...args),
  listManagedServiceContainersByVolume: (...args) => storageHelpers.listManagedServiceContainersByVolume(...args),
  scheduleLeaseBootstrapMonitor: (...args) => runtimeHelpers.scheduleLeaseBootstrapMonitor(...args),
  serializeLease: (...args) => runtimeHelpers.serializeLease(...args),
  serializeLiveLeaseFromSummary: (...args) => runtimeHelpers.serializeLiveLeaseFromSummary(...args)
});
runtimeHelpers = createBrokerRuntime(brokerContext, {
  ...coreHelpers,
  collectExecOutput: (...args) => storageHelpers.collectExecOutput(...args)
});
storageHelpers = createBrokerStorage(brokerContext, {
  ...coreHelpers,
  ...runtimeHelpers
});
const {
  appendPreviewRoutePath,
  authorizeScopedThread,
  buildLease,
  buildShellCommand,
  buildStack,
  clearLeaseBootstrapState,
  clearLeaseTransition,
  clearRetainedPreviewLease,
  clearStackThreadBinding,
  cloneManagedStackVolume,
  collectExecOutput,
  disconnectNetworkConnection,
  dropPreviewEgressLeasePolicy,
  ensureImage,
  ensureManagedStackVolume,
  ensureNetworkConnection,
  ensurePreviewEgressLeasePolicy,
  ensurePreviewOutboundNetwork,
  ensureStackInfrastructure,
  findStackNetwork,
  getLeaseTransition,
  getRetainedPreviewLease,
  getStackCloneSourceKeyFromLabels,
  getStackPromoteTargetKeyFromLabels,
  getStackScopeKeyFromLabels,
  hasBrokerAccess,
  inspectContainer,
  inspectNetwork,
  isDirectPreviewInternet,
  isPreviewProxyEgress,
  listManagedContainers,
  listManagedNetworks,
  listManagedServiceContainersByVolume,
  listStackInternalHosts,
  listStackMemberContainers,
  listStackVolumesByScopeKey,
  mergeLeaseBootstrapState,
  normalizeBoolean,
  normalizeCookieEntries,
  normalizeExecArgs,
  normalizeHeaderMap,
  normalizeString,
  normalizeStringArray,
  overwriteManagedStackVolume,
  parseAliases,
  persistVerificationArtifacts,
  resolveCodexWorkspaceMounts,
  previewEgressProfiles,
  reconcileManagedRuntimeState,
  rejectIfLeaseRetainedFailed,
  rejectIfLeaseStopping,
  rejectIfLeaseUnavailable,
  requireContainer,
  requireServiceContainer,
  requireStackNetwork,
  resolveAttachedThreadId,
  resolveStackThreadId,
  resolveTargetHost,
  resolveWorktreeProjectInfo,
  retainPreviewLease,
  scheduleLeaseBootstrapMonitor,
  serializeInspectedLease,
  serializeInspectedService,
  serializeLease,
  serializeLiveLeaseFromSummary,
  serializeLiveServiceFromSummary,
  serializeStackFromNetwork,
  setLeaseBootstrapState,
  setLeaseTransition,
  setStackThreadBinding,
  toContainerName,
  toServiceContainerName
} = {
  ...coreHelpers,
  ...runtimeHelpers,
  ...storageHelpers
};

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

    await ensureStackInfrastructure(stack.networkName);

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
    if (["host", "connection", "content-length", "accept-encoding"].includes(key.toLowerCase())) {
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

  headers.set("accept-encoding", "identity");

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
      if (["connection", "content-length", "transfer-encoding", "content-encoding"].includes(key.toLowerCase())) {
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
  const envVars = [`PORT=${lease.targetPort}`, "HOST=0.0.0.0", "NODE_OPTIONS=--use-openssl-ca"];
  const aliases = [...new Set([lease.containerName, ...lease.aliases])];
  let proxyPort = null;
  let dynamicPolicyName = null;

  try {
    if (stack?.Name) {
      await ensureStackInfrastructure(stack.Name, {
        includePreviewEgress: isPreviewProxyEgress(lease.egressProfile, lease.egressDomains)
      });
    }

    if (lease.egressDomains.length > 0) {
      const dynamicPolicy = await ensurePreviewEgressLeasePolicy(lease.id, lease.egressDomains);
      if (!dynamicPolicy) {
        response.status(400).json({ error: "Failed to create preview egress policy" });
        return;
      }
      proxyPort = dynamicPolicy.port;
      dynamicPolicyName = dynamicPolicy.name;
      lease.egressProfile = "custom";
    } else if (isPreviewProxyEgress(lease.egressProfile, lease.egressDomains)) {
      const profile = previewEgressProfiles.get(lease.egressProfile);
      if (!profile || !Number.isFinite(profile.port) || profile.port <= 0) {
        response.status(400).json({ error: `Unknown preview egress profile: ${lease.egressProfile}` });
        return;
      }
      proxyPort = profile.port;
    }

    if (proxyPort !== null) {
      const previewProxy = `http://preview-egress:${proxyPort}`;
      const noProxyEntries = new Set(["localhost", "127.0.0.1", "::1", lease.containerName, ...aliases]);
      if (lease.stackId) {
        for (const host of await listStackInternalHosts(lease.stackId)) {
          noProxyEntries.add(host);
        }
      }
      const noProxyValue = [...noProxyEntries].filter(Boolean).join(",");
      envVars.push(
        `HTTP_PROXY=${previewProxy}`,
        `HTTPS_PROXY=${previewProxy}`,
        `ALL_PROXY=${previewProxy}`,
        `http_proxy=${previewProxy}`,
        `https_proxy=${previewProxy}`,
        `all_proxy=${previewProxy}`,
        `NO_PROXY=${noProxyValue}`,
        `no_proxy=${noProxyValue}`,
        "NODE_OPTIONS=--use-env-proxy --use-openssl-ca"
      );
    }

    envVars.push(`MANOR_EGRESS_PROFILE=${lease.egressProfile}`);

    for (const [key, value] of Object.entries(env)) {
      if (typeof value === "string") {
        envVars.push(`${key}=${value}`);
      }
    }

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

    const networkName = stack?.Name || previewNetwork;
    const workspaceMounts = await resolveCodexWorkspaceMounts();

    const runtimeContainer = await docker.createContainer({
      Image: lease.image,
      name: lease.containerName,
      Cmd: buildShellCommand(lease.command),
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
        NetworkMode: networkName,
        Mounts: workspaceMounts
      },
      NetworkingConfig: {
        EndpointsConfig: {
          [networkName]: {
            Aliases: aliases
          }
        }
      }
    });

    if (isDirectPreviewInternet(lease.egressProfile, lease.egressDomains)) {
      await ensurePreviewOutboundNetwork();
      await ensureNetworkConnection(previewOutboundNetwork, lease.containerName);
    }

    await runtimeContainer.start();
    await ensureNetworkConnection(sharedWorkNetwork, lease.containerName, aliases);
    const container = await inspectContainer(lease.containerName);
    if (!container) {
      throw new Error("Preview container did not start");
    }

    pendingPreviewLeases.delete(lease.id);
    scheduleLeaseBootstrapMonitor(lease);

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
    const statusCode =
      typeof error === "object" &&
      error !== null &&
      "message" in error &&
      typeof error.message === "string" &&
      error.message.toLowerCase().includes("preview egress admin is unavailable")
        ? 502
        : 500;

    response.status(statusCode).json({
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
  const commandArgs = normalizeExecArgs(request.body?.commandArgs);
  const cwd = typeof request.body?.cwd === "string" ? request.body.cwd.trim() : "";
  const stdin = typeof request.body?.stdin === "string" ? request.body.stdin : "";
  const stdinProvided = request.body?.stdinProvided === true;
  if (!command && commandArgs.length === 0) {
    response.status(400).json({ error: "command is required" });
    return;
  }

  try {
    const execCommand = commandArgs.length > 0 ? commandArgs : buildShellCommand(command, cwd);
    const exec = await required.containerRef.exec({
      AttachStdin: stdinProvided,
      AttachStdout: true,
      AttachStderr: true,
      Cmd: execCommand,
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
    const stackId = required.container.Config?.Labels?.["manor.stack-id"] || null;
    const stack = stackId ? await findStackNetwork(stackId) : null;
    if (stack?.Name) {
      await ensureStackInfrastructure(stack.Name, { includePreviewEgress: false, includePlaywright: true });
    }

    const playwrightContainer = docker.getContainer(playwrightContainerName);
    await playwrightContainer.inspect();
    const labels = required.container.Config?.Labels || {};
    const aliases = parseAliases(labels["manor.aliases"]);
    const targetPort =
      Number(required.container.Config?.Env?.find((entry) => entry.startsWith("PORT="))?.slice(5) || "3000");
    const internalTargetHost = stack?.Name ? resolveTargetHost(required.containerName, aliases) : null;
    const baseTargetUrl = internalTargetHost
      ? `http://${internalTargetHost}:${targetPort}/`
      : `${internalOperatorBaseUrl}${routeBase}/${request.params.leaseId}/`;
    const requestedTargetUrl = normalizeString(request.body?.targetUrl);
    const targetUrl = requestedTargetUrl || appendPreviewRoutePath(baseTargetUrl, request.body?.path);
    if (!/^https?:\/\//i.test(targetUrl)) {
      response.status(400).json({ error: "targetUrl must be an absolute http or https URL when provided." });
      return;
    }
    const runId = `${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
    const remoteOutputDir = path.posix.join(playwrightArtifactsScratchDir, request.params.leaseId, runId);
    const mode = request.body?.mode === "headful" ? "headful" : "headless";
    const script = normalizeString(request.body?.script) || undefined;
    const waitForSelector = normalizeString(request.body?.waitForSelector) || undefined;
    const postLoadWaitMs =
      typeof request.body?.postLoadWaitMs === "number" && Number.isFinite(request.body.postLoadWaitMs)
        ? Math.max(0, Math.trunc(request.body.postLoadWaitMs))
        : undefined;
    const headers = normalizeHeaderMap(request.body?.headers);
    const cookies = normalizeCookieEntries(request.body?.cookies);
    const options = JSON.stringify({
      runId,
      mode,
      targetUrl,
      outputDir: remoteOutputDir,
      waitForSelector,
      postLoadWaitMs,
      headers,
      cookies,
      script
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
    const persisted = await persistVerificationArtifacts(playwrightContainer, parsed, remoteOutputDir, {
      leaseId: request.params.leaseId,
      runId
    });
    response.json(persisted);
  } catch (error) {
    response.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

app.post("/browser/verify", async (request, response) => {
  if (!hasBrokerAccess(request)) {
    response.status(403).json({ error: "Forbidden" });
    return;
  }

  const threadId = normalizeString(request.body?.threadId);
  const projectId = normalizeString(request.body?.projectId);
  const projectLabel = normalizeString(request.body?.projectLabel);
  const title = normalizeString(request.body?.title) || "Browser proof";
  const targetUrl = normalizeString(request.body?.targetUrl);
  if (!threadId || !projectId || !projectLabel || !targetUrl) {
    response.status(400).json({ error: "threadId, projectId, projectLabel, and targetUrl are required." });
    return;
  }
  if (!/^https?:\/\//i.test(targetUrl)) {
    response.status(400).json({ error: "targetUrl must be an absolute http or https URL." });
    return;
  }

  try {
    const playwrightContainer = docker.getContainer(playwrightContainerName);
    await playwrightContainer.inspect();
    const runId = `${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
    const remoteOutputDir = path.posix.join(playwrightArtifactsScratchDir, "browser", threadId, runId);
    const mode = request.body?.mode === "headful" ? "headful" : "headless";
    const script = normalizeString(request.body?.script) || undefined;
    const waitForSelector = normalizeString(request.body?.waitForSelector) || undefined;
    const postLoadWaitMs =
      typeof request.body?.postLoadWaitMs === "number" && Number.isFinite(request.body.postLoadWaitMs)
        ? Math.max(0, Math.trunc(request.body.postLoadWaitMs))
        : undefined;
    const headers = normalizeHeaderMap(request.body?.headers);
    const cookies = normalizeCookieEntries(request.body?.cookies);
    const options = JSON.stringify({
      runId,
      mode,
      targetUrl,
      outputDir: remoteOutputDir,
      waitForSelector,
      postLoadWaitMs,
      headers,
      cookies,
      script
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
      throw new Error(output.stderr.trim() || output.stdout.trim() || "Browser verification failed");
    }
    const parsed = JSON.parse(output.stdout.trim());
    const persisted = await persistVerificationArtifacts(playwrightContainer, parsed, remoteOutputDir, {
      kind: "browser",
      threadId,
      runId
    });
    response.json({
      ...persisted,
      browserProof: {
        threadId,
        projectId,
        projectLabel,
        title,
        targetUrl
      }
    });
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
        "manor.working-dir": typeof payload.workingDir === "string" ? payload.workingDir : "",
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

    if (typeof payload.workingDir === "string" && payload.workingDir) {
      containerOptions.WorkingDir = payload.workingDir;
    }

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
    await ensureNetworkConnection(sharedWorkNetwork, serviceContainer.id, serviceAliases);
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
  const commandArgs = normalizeExecArgs(request.body?.commandArgs);
  const cwd = typeof request.body?.cwd === "string" ? request.body.cwd.trim() : "";
  const stdin = typeof request.body?.stdin === "string" ? request.body.stdin : "";
  const stdinProvided = request.body?.stdinProvided === true;
  if (!command && commandArgs.length === 0) {
    response.status(400).json({ error: "command is required" });
    return;
  }

  try {
    const execCommand = commandArgs.length > 0 ? commandArgs : buildShellCommand(command, cwd);
    const exec = await required.containerRef.exec({
      AttachStdin: stdinProvided,
      AttachStdout: true,
      AttachStderr: true,
      Cmd: execCommand,
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
  void reconcileManagedRuntimeState();
  if (stackInfraReconnectIntervalMs > 0) {
    setInterval(() => {
      void reconcileManagedRuntimeState();
    }, stackInfraReconnectIntervalMs);
  }
});
