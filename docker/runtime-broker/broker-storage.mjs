import crypto from "node:crypto";
import path from "node:path";

export function createBrokerStorage(context, deps = {}) {
  const { previewNetwork, previewOutboundNetwork, sharedWorkNetwork, previewImage, routeBase, previewEgressConfigPath, previewEgressAdminUrl, brokerToken, codexAccessRegistryPath, stackBindingRegistryPath, internalOperatorBaseUrl, codexWorkspaceContainerName, butlerContainerName, butlerArtifactsRootDir, playwrightContainerName, runtimeBrokerContainerName, previewEgressContainerName, playwrightArtifactsScratchDir, stackNetworkPrefix, stackVolumePrefix, stackInfraReconnectIntervalMs, docker, leaseTransitions, leaseBootstrapStates, activeLeaseBootstrapMonitors, pendingPreviewLeases, retainedPreviewLeases, noHeartbeatReadyDelayMs } = context;
  const {
    ensureImage,
    ensureVolumeIsIdle,
    getStackBaseStorageKeyFromLabels,
    getStackCloneSourceKeyFromLabels,
    getStackPromoteTargetKeyFromLabels,
    getStackScopeKeyFromLabels,
    getStackStorageModeFromLabels,
    inspectVolume,
    listManagedContainers,
    listStackVolumesByScopeKey,
    normalizeString,
    resolveStackThreadId,
    resolveWorktreeProjectInfo,
    toManagedVolumeName
  } = deps;

async function resolveCodexWorkspaceMounts(options = {}) {
  const readOnly = options.readOnly === true;
  const codexContainer = docker.getContainer(codexWorkspaceContainerName);
  const inspection = await codexContainer.inspect();
  const mounts = Array.isArray(inspection.Mounts) ? inspection.Mounts : [];
  const workspaceMounts = mounts
    .filter((mount) => mount?.Destination === "/repos")
    .map((mount) => {
      if (mount.Type === "volume" && mount.Name) {
        return {
          Type: "volume",
          Source: mount.Name,
          Target: mount.Destination,
          ReadOnly: readOnly || mount.RW === false
        };
      }
      if (mount.Source) {
        return {
          Type: mount.Type || "bind",
          Source: mount.Source,
          Target: mount.Destination,
          ReadOnly: readOnly || mount.RW === false
        };
      }
      return null;
    })
    .filter(Boolean);

  if (workspaceMounts.length === 0) {
    throw new Error(`Could not resolve /repos mount from ${codexWorkspaceContainerName}`);
  }

  return workspaceMounts;
}

async function resolveCodexWorkspaceUser() {
  const codexContainer = docker.getContainer(codexWorkspaceContainerName);
  const inspection = await codexContainer.inspect();
  const configuredUser = normalizeString(inspection?.Config?.User || "");
  if (/^\d+:\d+$/.test(configuredUser)) {
    return configuredUser;
  }
  if (/^\d+$/.test(configuredUser)) {
    return `${configuredUser}:${configuredUser}`;
  }

  const exec = await codexContainer.exec({
    AttachStdout: true,
    AttachStderr: true,
    Cmd: ["sh", "-c", "printf '%s:%s' \"$(id -u)\" \"$(id -g)\""],
    Tty: false
  });
  const output = await collectExecOutput(codexContainer, exec);
  if (output.exitCode !== 0) {
    throw new Error(
      output.stderr.trim() ||
        output.stdout.trim() ||
        `Could not resolve workspace user from ${codexWorkspaceContainerName}`
    );
  }
  const user = output.stdout.trim();
  if (!/^\d+:\d+$/.test(user)) {
    throw new Error(`Unexpected workspace user from ${codexWorkspaceContainerName}: ${user || "(empty)"}`);
  }
  return user;
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
  const stdinPayload =
    typeof options.stdin === "string" || Buffer.isBuffer(options.stdin) ? options.stdin : "";
  const stdinProvided = options.stdinProvided === true;
  const stream = await exec.start({ hijack: true, stdin: stdinProvided });
  if (stdinProvided) {
    stream.write(stdinPayload);
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

async function writeContainerFile(containerRef, filePath, contents) {
  const exec = await containerRef.exec({
    AttachStdout: true,
    AttachStderr: true,
    AttachStdin: true,
    Cmd: [
      "bash",
      "-lc",
      `mkdir -p ${JSON.stringify(path.posix.dirname(filePath))} && cat > ${JSON.stringify(filePath)}`
    ],
    Tty: false
  });
  const output = await collectExecOutput(containerRef, exec, { stdin: contents, stdinProvided: true });
  if (output.exitCode !== 0) {
    throw new Error(output.stderr.trim() || output.stdout.trim() || `Could not write container file ${filePath}`);
  }
}

function resolveVerificationArtifactTargetDir(outputLocation) {
  if (outputLocation?.kind === "browser") {
    return path.posix.join(butlerArtifactsRootDir, "browser", outputLocation.threadId, outputLocation.runId);
  }

  return path.posix.join(butlerArtifactsRootDir, "previews", outputLocation.leaseId, outputLocation.runId);
}

async function persistArtifactFiles(containerRef, artifacts, outputLocation) {
  const butlerContainer = docker.getContainer(butlerContainerName);
  await butlerContainer.inspect();
  const targetDir = resolveVerificationArtifactTargetDir(outputLocation);

  const persistedArtifacts = [];
  for (const artifact of Array.isArray(artifacts) ? artifacts : []) {
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
    const localPath = path.posix.join(targetDir, path.posix.basename(remotePath));
    const contents = await readContainerFile(containerRef, remotePath);
    await writeContainerFile(butlerContainer, localPath, contents);
    persistedArtifacts.push({
      ...artifact,
      fileName: path.posix.basename(localPath),
      filePath: localPath,
      sizeBytes: contents.byteLength,
      url: null
    });
  }

  return persistedArtifacts;
}

async function persistVerificationArtifacts(containerRef, verification, remoteOutputDir, outputLocation) {
  const archiveStartedAt = Date.now();
  const butlerContainer = docker.getContainer(butlerContainerName);
  await butlerContainer.inspect();
  const targetDir = resolveVerificationArtifactTargetDir(outputLocation);
  const persistedArtifacts = await persistArtifactFiles(containerRef, verification.artifacts, outputLocation);
  const manifestPath = path.posix.join(targetDir, "manifest.json");
  const manifestArtifact = {
    kind: "manifest",
    label: "Manifest",
    fileName: path.posix.basename(manifestPath),
    filePath: manifestPath,
    contentType: "application/json",
    sizeBytes: 0,
    url: null
  };
  const persistedVerification = {
    ...verification,
    phases: [
      ...(Array.isArray(verification.phases) ? verification.phases : []),
      {
        name: "archive_artifacts",
        label: "Archive artifacts",
        status: "completed",
        startedAt: archiveStartedAt,
        completedAt: Date.now(),
        durationMs: Math.max(0, Date.now() - archiveStartedAt),
        message: "Copied proof artifacts into Manor storage."
      }
    ],
    artifacts: [manifestArtifact, ...persistedArtifacts]
  };
  persistedVerification.summary = {
    ...(persistedVerification.summary && typeof persistedVerification.summary === "object"
      ? persistedVerification.summary
      : {}),
    phaseCount: Array.isArray(persistedVerification.phases) ? persistedVerification.phases.length : 0
  };
  const manifestBuffer = Buffer.from(`${JSON.stringify(persistedVerification, null, 2)}\n`, "utf8");
  manifestArtifact.sizeBytes = manifestBuffer.byteLength;
  await writeContainerFile(butlerContainer, manifestPath, manifestBuffer);

  await removeContainerPath(containerRef, remoteOutputDir);
  return persistedVerification;
}

  return {
    resolveCodexWorkspaceMounts,
    resolveCodexWorkspaceUser,
    listStackMemberContainers,
    listManagedServiceContainersByVolume,
    ensureManagedStackVolume,
    runVolumeCopyJob,
    cloneManagedStackVolume,
    toManagedVolumeBackupName,
    overwriteManagedStackVolume,
    summarizeStackStatus,
    serializeStackFromNetwork,
    collectExecOutput,
    readContainerFile,
    removeContainerPath,
    writeContainerFile,
    persistArtifactFiles,
    persistVerificationArtifacts
  };
}
