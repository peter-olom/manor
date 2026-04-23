import crypto from "node:crypto";

export function registerBrokerServiceRoutes(options) {
  const {
    app,
    docker,
    previewNetwork,
    sharedWorkNetwork,
    hasBrokerAccess,
    authorizeScopedThread,
    requireServiceContainer,
    resolveAttachedThreadId,
    findStackNetwork,
    normalizeString,
    normalizeStringArray,
    normalizeEnv,
    normalizeExecArgs,
    buildShellCommand,
    collectExecOutput,
    ensureImage,
    inspectContainer,
    cloneManagedStackVolume,
    ensureManagedStackVolume,
    listManagedServiceContainersByVolume,
    ensureNetworkConnection,
    listManagedContainers,
    serializeLiveServiceFromSummary,
    serializeInspectedService,
    toServiceContainerName,
    resolveTargetHost
  } = options;

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
    const stackScopeKey = normalizeString(stack?.Labels?.["manor.stack-scope-key"]) || null;
    const stackCloneSourceKey = normalizeString(stack?.Labels?.["manor.clone-from-storage-key"]) || null;
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

    const targetHost = resolveTargetHost(containerName, aliases);

    try {
      await ensureImage(payload.image);

      const existing = await inspectContainer(containerName);
      if (existing) {
        await docker.getContainer(containerName).remove({ force: true });
      }

      const networkName = stack?.Name || previewNetwork;
      const serviceAliases = [...new Set([containerName, ...aliases])];
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
        const templateLabel = payload.templateLabel || payload.templateId;
        const volumeResult =
          stackCloneSourceKey && stackCloneSourceKey !== stackScopeKey
            ? await cloneManagedStackVolume({
                sourceScopeKey: stackCloneSourceKey,
                targetScopeKey: stackScopeKey,
                templateId: payload.templateId,
                templateLabel,
                volumeKey,
                mountPath: stackVolumePath,
                threadId: payload.threadId ?? null,
                projectId: payload.projectId || "service",
                projectLabel: payload.projectLabel || payload.projectId || "service"
              })
            : await ensureManagedStackVolume({
                scopeKey: stackScopeKey,
                templateId: payload.templateId,
                templateLabel,
                volumeKey,
                mountPath: stackVolumePath,
                threadId: payload.threadId ?? null,
                projectId: payload.projectId || "service",
                projectLabel: payload.projectLabel || payload.projectId || "service"
              });
        const activeUsers = await listManagedServiceContainersByVolume(volumeResult.volumeName, serviceId);
        if (activeUsers.length > 0) {
          const existingTitle = activeUsers[0].Labels?.["manor.title"] || activeUsers[0].Labels?.["manor.service-id"] || "service";
          throw new Error(
            `Persistent volume ${volumeResult.volumeName} is already attached to ${existingTitle}. Use a distinct alias or stop the existing service first.`
          );
        }

        containerOptions.HostConfig.Mounts = [
          {
            Type: "volume",
            Source: volumeResult.volumeName,
            Target: stackVolumePath
          }
        ];
        containerOptions.Labels["manor.storage-kind"] = "volume";
        containerOptions.Labels["manor.volume-name"] = volumeResult.volumeName;
        containerOptions.Labels["manor.volume-mount-path"] = stackVolumePath;
        storage.kind = "volume";
        storage.sticky = true;
        storage.volumeName = volumeResult.volumeName;
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
}
