
import net from "node:net";

export function createBrokerRuntime(context, deps = {}) {
  const { previewNetwork, previewOutboundNetwork, sharedWorkNetwork, previewImage, routeBase, previewEgressConfigPath, previewEgressAdminUrl, brokerToken, harnessAccessRegistryPath, stackBindingRegistryPath, internalOperatorBaseUrl, playwrightContainerName, runtimeBrokerContainerName, previewEgressContainerName, artifactsRootDir, playwrightArtifactsScratchDir, stackNetworkPrefix, stackVolumePrefix, stackInfraReconnectIntervalMs, docker, leaseTransitions, leaseBootstrapStates, activeLeaseBootstrapMonitors, pendingPreviewLeases, retainedPreviewLeases, noHeartbeatReadyDelayMs } = context;
  const {
    buildShellCommand,
    clearLeaseTransitionIfIdle,
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
    serializeContainerRuntimeState,
    formatPreviewRuntimeFailure,
    retainFailedLease,
    retainPreviewLease,
    serializeBootstrapState
  } = deps;

function isLeaseStopping(leaseId) {
  return getLeaseTransition(leaseId)?.state === "stopping";
}

async function retainFailedLeaseWithCurrentRuntime(lease, message) {
  const container = await inspectContainer(lease.containerName);
  if (isLeaseStopping(lease.id)) {
    return;
  }
  retainFailedLease(lease, message, container ? serializeContainerRuntimeState(container.State) : {});
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
      if (isLeaseStopping(lease.id)) {
        return;
      }

      const container = await inspectContainer(lease.containerName);
      if (!container) {
        if (isLeaseStopping(lease.id)) return;
        const state = mergeLeaseBootstrapState(lease.id, {
          phase: "failed",
          lastHeartbeatError: "Preview container disappeared during bootstrap."
        });
        retainFailedLease(lease, state?.lastHeartbeatError);
        return;
      }

      if (!container.State?.Running) {
        if (isLeaseStopping(lease.id)) return;
        const runtime = serializeContainerRuntimeState(container.State);
        const failure = formatPreviewRuntimeFailure(lease.id, runtime);
        const state = mergeLeaseBootstrapState(lease.id, {
          phase: "failed",
          lastHeartbeatError: failure
        });
        retainFailedLease(lease, state?.lastHeartbeatError, runtime);
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

    if (isLeaseStopping(lease.id)) return;
    mergeLeaseBootstrapState(lease.id, {
      phase: "failed",
      lastHeartbeatError: `Bootstrap timed out after ${bootstrap.waitSeconds}s. Preview port was not reachable on the shared network (bind to 0.0.0.0).`
    });
    await retainFailedLeaseWithCurrentRuntime(
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
    if (isLeaseStopping(lease.id)) {
      return;
    }

    const container = await inspectContainer(lease.containerName);
    if (!container) {
      if (isLeaseStopping(lease.id)) return;
      const state = mergeLeaseBootstrapState(lease.id, {
        phase: "failed",
        lastHeartbeatError: "Preview container disappeared during bootstrap."
      });
      retainFailedLease(lease, state?.lastHeartbeatError);
      return;
    }

    if (!container.State?.Running) {
      if (isLeaseStopping(lease.id)) return;
      const runtime = serializeContainerRuntimeState(container.State);
      const failure = formatPreviewRuntimeFailure(lease.id, runtime);
      const state = mergeLeaseBootstrapState(lease.id, {
        phase: "failed",
        lastHeartbeatError: failure
      });
      retainFailedLease(lease, state?.lastHeartbeatError, runtime);
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

  if (isLeaseStopping(lease.id)) return;
  const state = mergeLeaseBootstrapState(lease.id, {
    phase: "failed",
    lastHeartbeatError: `Bootstrap heartbeat timed out after ${bootstrap.waitSeconds}s.`
  });
  await retainFailedLeaseWithCurrentRuntime(lease, state?.lastHeartbeatError);
}

function scheduleLeaseBootstrapMonitor(lease) {
  if (!lease?.id || activeLeaseBootstrapMonitors.has(lease.id)) {
    return;
  }

  activeLeaseBootstrapMonitors.add(lease.id);
  void monitorLeaseBootstrap(lease)
    .catch((error) => {
      if (isLeaseStopping(lease.id)) return;
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
      if (isLeaseStopping(lease.id)) clearLeaseTransitionIfIdle(lease.id);
    });
}

function serializeLease(lease, options = {}) {
  const targetPort = Number(options.targetPort ?? lease.targetPort ?? 3000);
  const labels = options.labels ?? {};
  const status = resolveLeaseStatus(options.containerState ?? lease.status ?? "stopped", lease.id);
  const bootstrap = getLeaseBootstrapState(
    lease.id,
    labels,
    targetPort,
    status,
    Boolean(options.containerRunning)
  );

  return {
    ...lease,
    targetPort,
    publicPort: null,
    publicUrl: null,
    tailnetUrl: null,
    operatorUrl: lease.operatorUrl,
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
  if (containerSummary.State !== "running" && containerName) {
    const inspected = await inspectContainer(containerName);
    if (inspected) {
      return serializeInspectedLease(containerName, inspected);
    }
  }

  const leaseId = labels["manor.lease-id"] || "";
  const transitionState = getLeaseTransition(leaseId)?.state ?? null;
  const terminal = containerSummary.State !== "running" && transitionState !== "starting" && transitionState !== "stopping";
  const exitCodeMatch = typeof containerSummary.Status === "string" ? containerSummary.Status.match(/Exited \((-?\d+)\)/i) : null;
  const runtime = terminal
    ? {
        running: false,
        status: containerSummary.State || "unknown",
        startedAt: null,
        finishedAt: null,
        exitCode: exitCodeMatch ? Number(exitCodeMatch[1]) : null,
        oomKilled: false,
        error: null
      }
    : null;
  const lease = serializeLease(
    {
      id: leaseId,
      threadId: effectiveThreadId,
      projectId: project.id,
      projectLabel: project.label,
      title: labels["manor.title"] || `Preview ${(labels["manor.lease-id"] || "").slice(0, 8)}`,
      stackId,
      aliases,
      worktreePath,
      branchName: labels["manor.branch-name"] || null,
      containerName,
      targetHost: resolveTargetHost(containerName, aliases),
      targetPort: Number(labels["manor.target-port"] || labels["manor.port"] || "3000"),
      publicPort: null,
      publicUrl: null,
      tailnetUrl: null,
      routePrefix: `${routeBase}/${labels["manor.lease-id"] || ""}/`,
      operatorUrl: labels["manor.operator-url"] || `${routeBase}/${labels["manor.lease-id"] || ""}/`,
      command: Array.isArray(containerSummary.Command) ? containerSummary.Command.join(" ") : containerSummary.Command || "",
      workspaceMode: "snapshot",
      image: containerSummary.Image || previewImage,
      egressProfile: labels["manor.egress-profile"] || "internet",
      egressDomains:
        labels["manor.egress-domains"]
          ?.split(",")
          .map((value) => value.trim())
          .filter(Boolean) || [],
      status: terminal ? "failed" : containerSummary.State,
      createdAt: typeof containerSummary.Created === "number" ? containerSummary.Created * 1000 : Date.now(),
      updatedAt: Date.now(),
      lastError: runtime ? formatPreviewRuntimeFailure(leaseId, runtime) : null
    },
    {
      labels,
      containerState: terminal ? "failed" : containerSummary.State,
      containerRunning: containerSummary.State === "running"
    }
  );
  return runtime ? { ...lease, runtime } : lease;
}

async function serializeInspectedLease(containerName, container) {
  const labels = container.Config?.Labels || {};
  const leaseId = labels["manor.lease-id"] || "";
  const stackId = labels["manor.stack-id"] || null;
  const effectiveThreadId = await resolveAttachedThreadId(labels["manor.thread-id"] || null, stackId);
  const worktreePath = labels["manor.worktree-path"] || container.Config?.WorkingDir || "/repos";
  const project = resolveWorktreeProjectInfo(
    worktreePath,
    labels["manor.project-id"] || "unknown",
    labels["manor.project-label"] || labels["manor.project-id"] || "Unknown"
  );
  const aliases = parseAliases(labels["manor.aliases"]);
  const runtime = serializeContainerRuntimeState(container.State);
  const transitionState = getLeaseTransition(leaseId)?.state ?? null;
  const terminal = !runtime.running && transitionState !== "starting" && transitionState !== "stopping";
  const runtimeError = terminal ? formatPreviewRuntimeFailure(leaseId, runtime) : runtime.error;
  return {
    ...serializeLease(
      {
        id: leaseId,
        threadId: effectiveThreadId,
        projectId: project.id,
        projectLabel: project.label,
        title: labels["manor.title"] || `Preview ${(labels["manor.lease-id"] || "").slice(0, 8)}`,
        stackId,
        aliases,
        worktreePath,
        branchName: labels["manor.branch-name"] || null,
        containerName,
        targetHost: resolveTargetHost(containerName, aliases),
        targetPort: Number(container.Config?.Env?.find((entry) => entry.startsWith("PORT="))?.slice(5) || "3000"),
        publicPort: null,
        publicUrl: null,
        tailnetUrl: null,
        routePrefix: `${routeBase}/${labels["manor.lease-id"] || ""}/`,
        operatorUrl: labels["manor.operator-url"] || `${routeBase}/${labels["manor.lease-id"] || ""}/`,
        command: Array.isArray(container.Config?.Cmd) ? container.Config.Cmd.join(" ") : "",
        workspaceMode: "snapshot",
        image: container.Config?.Image || previewImage,
        egressProfile:
          container.Config?.Env?.find((entry) => entry.startsWith("MANOR_EGRESS_PROFILE="))?.slice("MANOR_EGRESS_PROFILE=".length) ||
          "internet",
        egressDomains:
          labels["manor.egress-domains"]
            ?.split(",")
            .map((value) => value.trim())
            .filter(Boolean) || [],
        status: terminal ? "failed" : runtime.running ? "running" : transitionState || "stopped",
        createdAt: new Date(container.Created).getTime(),
        updatedAt: Date.now(),
        lastError: runtimeError
      },
      {
        labels,
        containerState: terminal ? "failed" : runtime.running ? "running" : transitionState || "stopped",
        containerRunning: runtime.running
      }
    ),
    runtime
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
