import crypto from "node:crypto";

const PREVIEW_USER_ENV_KEYS = [
  "HOME",
  "TMPDIR",
  "XDG_CACHE_HOME",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_STATE_HOME",
  "XDG_RUNTIME_DIR"
];

function normalizeString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

export function buildPreviewUserEnvironment(leaseId, input = {}) {
  const token = crypto.createHash("sha256").update(String(leaseId)).digest("hex").slice(0, 24);
  const home = `/tmp/manor-preview-users/${token}`;
  const reserved = PREVIEW_USER_ENV_KEYS.filter((key) => Object.hasOwn(input, key));
  if (reserved.length > 0) {
    throw new Error(`Preview environment keys are managed by Manor: ${reserved.join(", ")}`);
  }
  return {
    ...input,
    HOME: home,
    TMPDIR: `${home}/tmp`,
    XDG_CACHE_HOME: `${home}/.cache`,
    XDG_CONFIG_HOME: `${home}/.config`,
    XDG_DATA_HOME: `${home}/.local/share`,
    XDG_STATE_HOME: `${home}/.local/state`,
    XDG_RUNTIME_DIR: `${home}/.run`
  };
}

export function buildPreviewUserDirectoryCommand(environment) {
  const directories = PREVIEW_USER_ENV_KEYS.map((key) => normalizeString(environment[key]));
  if (directories.some((directory) => !directory)) {
    throw new Error("Preview user environment is incomplete.");
  }
  const quoted = [...new Set(directories)].map(shellQuote).join(" ");
  return `umask 077; mkdir -p ${quoted}; chmod 700 ${quoted}`;
}

export function previewImagePreparationKey(baseImageId, setupCommand, egressProfile, egressDomains = []) {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify({ version: 1, baseImageId, setupCommand, egressProfile, egressDomains: [...egressDomains].sort() }))
    .digest("hex");
}

export function createPreviewImagePreparer(options) {
  const {
    docker,
    ensureImage,
    collectDockerLogs,
    ensureNetworkConnection,
    disconnectNetworkConnection,
    previewEgressContainerName,
    preparationTimeoutMs = 30 * 60 * 1000,
    cancellationPollMs = 100,
    preparationMemoryBytes = 4 * 1024 * 1024 * 1024,
    preparationNanoCpus = 4_000_000_000,
    preparationPidsLimit = 1024,
    maxPreparedImages = 24,
    preparedImageMaxAgeMs = 7 * 24 * 60 * 60 * 1000,
    brokerInstanceId = crypto.randomUUID(),
    onCleanupError = (error) => console.error("[runtime-broker] preview image cleanup failed:", error)
  } = options;
  const inFlight = new Map();
  let maintenancePromise = null;

  function reportCleanupError(error) {
    try {
      onCleanupError(error);
    } catch {
      // Cleanup reporting must not hide the primary preparation result.
    }
  }

  async function removeResource(resource, description, removeOptions = { force: true }) {
    try {
      await resource.remove(removeOptions);
    } catch (error) {
      reportCleanupError(new Error(`${description}: ${error instanceof Error ? error.message : String(error)}`));
    }
  }

  async function maintainPreparedResources() {
    const now = Date.now();
    const staleBefore = now - preparationTimeoutMs - Math.max(60_000, cancellationPollMs);
    const [containers, networks, images] = await Promise.all([
      docker.listContainers({ all: true }),
      docker.listNetworks(),
      docker.listImages({ all: true })
    ]);
    for (const container of containers) {
      if (container.Labels?.["manor.runtime-kind"] === "preview-image-preparation" && (
        container.Labels?.["manor.broker-instance"] !== brokerInstanceId ||
        Number(container.Created || 0) * 1000 < staleBefore
      )) {
        await removeResource(docker.getContainer(container.Id), `remove stale preparation container ${container.Id}`);
      }
    }
    for (const network of networks) {
      if (network.Labels?.["manor.runtime-kind"] === "preview-image-preparation" && (
        network.Labels?.["manor.broker-instance"] !== brokerInstanceId ||
        Date.parse(network.Created || "") < staleBefore
      )) {
        await disconnectNetworkConnection(network.Name, previewEgressContainerName).catch((error) =>
          reportCleanupError(new Error(`disconnect stale preparation network ${network.Name}: ${error instanceof Error ? error.message : String(error)}`))
        );
        await removeResource(docker.getNetwork(network.Id), `remove stale preparation network ${network.Id}`);
      }
    }
    const preparedImages = images
      .filter((image) => image.Labels?.["manor.runtime-kind"] === "preview-prepared-image")
      .sort((left, right) => Number(right.Created || 0) - Number(left.Created || 0));
    for (const [index, image] of preparedImages.entries()) {
      const expired = Number(image.Created || 0) * 1000 < now - preparedImageMaxAgeMs;
      if (index >= maxPreparedImages || expired) {
        await removeResource(docker.getImage(image.Id), `remove expired prepared image ${image.Id}`, { force: false });
      }
    }
  }

  async function runMaintenance() {
    if (!maintenancePromise) {
      maintenancePromise = maintainPreparedResources()
        .catch(reportCleanupError)
        .finally(() => {
          maintenancePromise = null;
        });
    }
    await maintenancePromise;
  }

  function cancellationPromise(signal) {
    return new Promise((_, reject) => {
      if (signal.aborted) {
        reject(signal.reason ?? new Error("Preview image preparation was cancelled."));
        return;
      }
      signal.addEventListener(
        "abort",
        () => reject(signal.reason ?? new Error("Preview image preparation was cancelled.")),
        { once: true }
      );
    });
  }

  async function prepareOnce(input) {
    const setupCommand = normalizeString(input.setupCommand);
    if (!setupCommand) return input.baseImage;

    await ensureImage(input.baseImage);
    const base = await docker.getImage(input.baseImage).inspect();
    const key = previewImagePreparationKey(base.Id, setupCommand, input.egressProfile, input.egressDomains);
    const tag = `manor-preview-prepared:${key.slice(0, 32)}`;
    try {
      return (await docker.getImage(tag).inspect()).Id;
    } catch {
      // Build the missing immutable image below.
    }

    const suffix = crypto.randomUUID().slice(0, 8);
    const containerName = `manor-preview-prepare-${key.slice(0, 16)}-${suffix}`;
    const networkName = `manor-preview-prepare-${key.slice(0, 12)}-${suffix}`;
    const networkMode = input.egressProfile === "none" ? "none" : networkName;
    let network = null;
    let container = null;
    try {
      if (networkMode !== "none") {
        network = await docker.createNetwork({
          Name: networkName,
          Driver: "bridge",
          Internal: input.egressProfile !== "internet",
          Labels: {
            "manor.managed": "true",
            "manor.runtime-kind": "preview-image-preparation",
            "manor.broker-instance": brokerInstanceId,
            "manor.preparation-key": key
          }
        });
        if (input.proxyEnv.length > 0) {
          await ensureNetworkConnection(networkName, previewEgressContainerName, ["preview-egress"]);
        }
      }

      container = await docker.createContainer({
        Image: base.Id,
        name: containerName,
        User: "0:0",
        Entrypoint: [],
        Cmd: ["sh", "-lc", setupCommand],
        WorkingDir: "/tmp",
        Env: input.proxyEnv,
        Labels: {
          "manor.managed": "true",
          "manor.runtime-kind": "preview-image-preparation",
          "manor.broker-instance": brokerInstanceId,
          "manor.preparation-key": key
        },
        HostConfig: {
          AutoRemove: false,
          NetworkMode: networkMode,
          Mounts: [],
          CapDrop: ["ALL"],
          CapAdd: ["CHOWN", "DAC_OVERRIDE", "FOWNER", "FSETID", "MKNOD", "SETFCAP", "SETGID", "SETUID"],
          Memory: preparationMemoryBytes,
          NanoCpus: preparationNanoCpus,
          PidsLimit: preparationPidsLimit,
          SecurityOpt: ["no-new-privileges:true"]
        }
      });
      input.signal.throwIfAborted();
      await container.start();
      let timeout;
      const result = await Promise.race([
        container.wait(),
        cancellationPromise(input.signal),
        new Promise((_, reject) => {
          timeout = setTimeout(
            () => reject(new Error(`Preview image preparation timed out after ${preparationTimeoutMs}ms.`)),
            preparationTimeoutMs
          );
        })
      ]).finally(() => clearTimeout(timeout));
      if (Number(result?.StatusCode) !== 0) {
        const rawLogs = await container.logs({ stdout: true, stderr: true, tail: 200 });
        const logs = (await collectDockerLogs(rawLogs)).trim().slice(-8_000);
        throw new Error(`Preview image preparation failed with exit ${result?.StatusCode ?? "unknown"}.${logs ? `\n${logs}` : ""}`);
      }
      const committed = await container.commit({
        repo: "manor-preview-prepared",
        tag: key.slice(0, 32),
        changes: [
          "LABEL manor.managed=true",
          "LABEL manor.runtime-kind=preview-prepared-image",
          `LABEL manor.preparation-key=${key}`,
          "USER 1001:1001",
          'CMD ["/bin/sh"]',
          "ENTRYPOINT []",
          "WORKDIR /tmp",
          "ENV HTTP_PROXY= HTTPS_PROXY= ALL_PROXY= http_proxy= https_proxy= all_proxy= NO_PROXY= no_proxy="
        ]
      });
      return committed.Id;
    } finally {
      if (container) await removeResource(container, `remove preparation container ${containerName}`);
      if (input.proxyEnv.length > 0 && networkMode !== "none") {
        await disconnectNetworkConnection(networkName, previewEgressContainerName).catch((error) =>
          reportCleanupError(new Error(`disconnect preparation network ${networkName}: ${error instanceof Error ? error.message : String(error)}`))
        );
      }
      if (network) await removeResource(network, `remove preparation network ${networkName}`);
    }
  }

  async function waitForConsumer(job, isCancelled) {
    job.consumers += 1;
    let interval;
    const cancelled = new Promise((_, reject) => {
      interval = setInterval(() => {
        if (isCancelled?.()) reject(new Error("Preview image preparation was cancelled."));
      }, cancellationPollMs);
    });
    try {
      return await Promise.race([job.promise, cancelled]);
    } finally {
      clearInterval(interval);
      job.consumers -= 1;
      if (job.consumers === 0 && isCancelled?.() && !job.settled) {
        job.controller.abort(new Error("Preview image preparation was cancelled."));
      }
    }
  }

  async function preparePreviewImage(input) {
    const setupCommand = normalizeString(input.setupCommand);
    if (!setupCommand) return input.baseImage;
    await runMaintenance();
    await ensureImage(input.baseImage);
    const base = await docker.getImage(input.baseImage).inspect();
    const key = previewImagePreparationKey(base.Id, setupCommand, input.egressProfile, input.egressDomains);
    let job = inFlight.get(key);
    if (!job) {
      const controller = new AbortController();
      job = { controller, consumers: 0, settled: false, promise: null };
      job.promise = prepareOnce({ ...input, signal: controller.signal }).finally(() => {
        job.settled = true;
        inFlight.delete(key);
      });
      inFlight.set(key, job);
    }
    return waitForConsumer(job, input.isCancelled);
  }
  preparePreviewImage.maintain = runMaintenance;
  return preparePreviewImage;
}
