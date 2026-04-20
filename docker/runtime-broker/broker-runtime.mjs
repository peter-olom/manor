
import net from "node:net";

export function createBrokerRuntime(context, deps = {}) {
  const { previewNetwork, previewOutboundNetwork, sharedWorkNetwork, previewImage, routeBase, previewEgressConfigPath, previewEgressAdminUrl, brokerToken, codexAccessRegistryPath, stackBindingRegistryPath, internalOperatorBaseUrl, playwrightContainerName, runtimeBrokerContainerName, previewEgressContainerName, artifactsRootDir, playwrightArtifactsScratchDir, stackNetworkPrefix, stackVolumePrefix, stackInfraReconnectIntervalMs, docker, leaseTransitions, leaseBootstrapStates, activeLeaseBootstrapMonitors, pendingPreviewLeases, retainedPreviewLeases, noHeartbeatReadyDelayMs } = context;
  const {
    buildShellCommand,
    collectExecOutput,
    getLeaseBootstrapState,
    getLeaseTransition,
    inspectContainer,
    mergeLeaseBootstrapState,
    parseAliases,
    resolveAttachedThreadId,
    resolveLeaseStatus,
    resolveTargetHost,
    resolveWorktreeProjectInfo,
    retainFailedLease,
    retainPreviewLease,
    serializeBootstrapState
  } = deps;

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
      Cmd: buildShellCommand(command),
      Tty: false
    });
    const output = await collectExecOutput(containerRef, exec);
    if (output.exitCode !== 0) {
      throw new Error(output.stderr.trim() || output.stdout.trim() || `Command heartbeat exited ${output.exitCode}`);
    }
  }
}

async function runPreviewNetworkReachabilityCheck(lease) {
  await new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: lease.containerName, port: lease.targetPort });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error("Preview network probe timed out"));
    }, 2_500);
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
        try {
          await runPreviewNetworkReachabilityCheck(lease);
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
      }

      await sleep(500);
    }

    mergeLeaseBootstrapState(lease.id, {
      phase: "failed",
      lastHeartbeatError: `Bootstrap timed out after ${bootstrap.waitSeconds}s. Preview port was not reachable on the shared network (bind to 0.0.0.0).`
    });
    retainFailedLease(
      lease,
      `Bootstrap timed out after ${bootstrap.waitSeconds}s. Preview port was not reachable on the shared network (bind to 0.0.0.0).`
    );
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

function scheduleLeaseBootstrapMonitor(lease) {
  if (!lease?.id || activeLeaseBootstrapMonitors.has(lease.id)) {
    return;
  }

  activeLeaseBootstrapMonitors.add(lease.id);
  void monitorLeaseBootstrap(lease)
    .catch((error) => {
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
    })
    .finally(() => {
      activeLeaseBootstrapMonitors.delete(lease.id);
    });
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
      workspaceMode: labels["manor.workspace-mode"] === "snapshot" ? "snapshot" : "shared",
      image: containerSummary.Image || previewImage,
      egressProfile: labels["manor.egress-profile"] || "internet",
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
        workspaceMode: labels["manor.workspace-mode"] === "snapshot" ? "snapshot" : "shared",
        image: container.Config?.Image || previewImage,
        egressProfile:
          container.Config?.Env?.find((entry) => entry.startsWith("MANOR_EGRESS_PROFILE="))?.slice("MANOR_EGRESS_PROFILE=".length) ||
          "internet",
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
  const worktreePath = labels["manor.worktree-path"] || null;
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


  return {
    ensureImage,
    sleep,
    runHeartbeatCheck,
    monitorLeaseBootstrap,
    scheduleLeaseBootstrapMonitor,
    serializeLease,
    serializeLiveLeaseFromSummary,
    serializeInspectedLease,
    serializeLiveServiceFromSummary,
    serializeInspectedService
  };
}
