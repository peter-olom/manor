import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import express from "express";
import {
  normalizeRestartDelayMs,
  normalizeRestartWaitTimeoutSeconds,
  safeTokenMatch,
  shouldBuildSourceImages,
  validateRestartPayload
} from "./controller-policy.mjs";

const port = Number(process.env.MANOR_HOST_CONTROLLER_PORT ?? "8092");
const manorDir = path.resolve(process.env.MANOR_HOST_PROJECT_DIR ?? process.cwd());
const stateDir = path.resolve(process.env.MANOR_HOST_CONTROLLER_STATE_DIR ?? "/state");
const statePath = path.join(stateDir, "restart-status.json");
const authToken = process.env.MANOR_HOST_CONTROLLER_TOKEN ?? null;
const defaultDelayMs = normalizeRestartDelayMs(process.env.MANOR_HOST_RESTART_DELAY_MS);
const restartWaitTimeoutSeconds = normalizeRestartWaitTimeoutSeconds(process.env.MANOR_START_WAIT_TIMEOUT);
const butlerHealthUrl = process.env.MANOR_HOST_BUTLER_HEALTH_URL ?? "http://butler:8080/livez";
const composeProjectName = process.env.MANOR_COMPOSE_PROJECT_NAME ?? process.env.COMPOSE_PROJECT_NAME ?? "manor";
const lifecycleLockName = `${composeProjectName}_lifecycle-lock`;
const lifecycleTakeoverRoot = path.join(manorDir, "state", "lifecycle-guards");
const lifecycleTakeoverDir = path.join(lifecycleTakeoverRoot, `${composeProjectName}-takeover`);
const lifecycleHostLeaseDir = path.join(lifecycleTakeoverRoot, `${composeProjectName}-host-lease`);
const lifecycleLockHeartbeatGraceSeconds = 30;
const lifecycleTakeoverHeartbeats = new Map();
const hostUid = Number(process.env.MANOR_HOST_UID);
const hostGid = Number(process.env.MANOR_HOST_GID);
const applianceServices = [
  "egress",
  "preview-egress",
  "worker",
  "runtime-broker",
  "playwright",
  "butler",
  "butler-gateway"
];
const sourceBuildServices = [...applianceServices, "host-controller"];
const githubHttpsFetchConfig = [
  "-c", "http.proxy=http://egress:3128",
  "-c", "url.https://github.com/.insteadOf=git@github.com:",
  "-c", "url.https://github.com/.insteadOf=ssh://git@github.com/"
];

let latestRun = null;
let activeRun = null;

function now() {
  return Date.now();
}

function limitedTail(value, limit = 12_000) {
  if (value.length <= limit) {
    return value;
  }
  return value.slice(value.length - limit);
}

function elapsedMs(startedAt, endedAt) {
  if (!Number.isFinite(startedAt) || !Number.isFinite(endedAt) || endedAt < startedAt) {
    return null;
  }
  return Math.max(0, Math.floor(endedAt - startedAt));
}

function publicRun(run) {
  if (!run) {
    return null;
  }
  const snapshotAt = now();
  return {
    id: run.id,
    status: run.status,
    target: run.target,
    gitRef: run.gitRef,
    includeDesktop: run.includeDesktop,
    hotReload: run.hotReload,
    update: run.update,
    startedAt: run.startedAt,
    completedAt: run.completedAt,
    durationMs: elapsedMs(run.startedAt, run.completedAt ?? snapshotAt),
    error: run.error,
    controllerActivationPending: run.controllerActivationPending === true,
    controllerActivationImage: run.controllerActivationImage ?? null,
    controllerActivationRollbackImage: run.controllerActivationRollbackImage ?? null,
    controllerActivationRollbackProjectDir: run.controllerActivationRollbackProjectDir ?? null,
    controllerActivationPreviousContainerId: run.controllerActivationPreviousContainerId ?? null,
    controllerActivationDeadline: run.controllerActivationDeadline ?? null,
    controllerActivationCleanupDir: run.controllerActivationCleanupDir ?? null,
    controllerActivationRollingBack: run.controllerActivationRollingBack === true,
    steps: run.steps.map((step) => ({
      label: step.label,
      status: step.status,
      startedAt: step.startedAt,
      completedAt: step.completedAt,
      exitCode: step.exitCode,
      stdoutTail: step.stdoutTail,
      stderrTail: step.stderrTail
    }))
  };
}

async function persist() {
  await fs.mkdir(stateDir, { recursive: true });
  const nextStatePath = `${statePath}.${process.pid}.${crypto.randomUUID()}`;
  await fs.writeFile(nextStatePath, JSON.stringify({ latestRun: publicRun(latestRun) }, null, 2), "utf8");
  await fs.rename(nextStatePath, statePath);
}

async function loadState() {
  try {
    const parsed = JSON.parse(await fs.readFile(statePath, "utf8"));
    latestRun = parsed.latestRun && typeof parsed.latestRun === "object" ? parsed.latestRun : null;
    if (latestRun?.status === "running" && latestRun.controllerActivationPending !== true) {
      latestRun.status = "failed";
      latestRun.completedAt = now();
      latestRun.error = "Host controller stopped before the restart run completed.";
    } else if (latestRun?.status === "running" && !Number.isFinite(latestRun.controllerActivationDeadline)) {
      latestRun.controllerActivationDeadline = now() + (restartWaitTimeoutSeconds + 60) * 1000;
    }
  } catch (error) {
    if (error.code !== "ENOENT") {
      const corruptPath = `${statePath}.corrupt-${Date.now()}`;
      await fs.rename(statePath, corruptPath).catch(() => undefined);
      console.error(`Ignored unreadable host controller state at ${statePath}.`);
    }
  }
}

function composeArgs(includeDesktop, hotReload = false) {
  const args = ["compose", "-f", "compose.yml", "-f", "compose.build.yml"];
  if (hotReload) {
    args.push("-f", "compose.dev.yml");
  }
  if (includeDesktop) {
    args.push("--profile", "desktop");
  }
  return args;
}

function commandEnv(run) {
  return {
    ...process.env,
    COMPOSE_PROJECT_NAME: composeProjectName,
    MANOR_PI_AUTO_UPDATE: "0"
  };
}

async function runStep(run, label, command, args, options = {}) {
  const step = {
    label,
    command,
    args,
    status: "running",
    startedAt: now(),
    completedAt: null,
    exitCode: null,
    stdoutTail: "",
    stderrTail: ""
  };
  run.steps.push(step);
  await persist();

  return await new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    const child = spawn(command, args, {
      cwd: options.cwd ?? manorDir,
      env: { ...commandEnv(run), ...(options.env ?? {}) },
      stdio: ["ignore", "pipe", "pipe"]
    });
    child.stdout.on("data", (chunk) => {
      stdout = limitedTail(stdout + chunk.toString());
      step.stdoutTail = stdout;
    });
    child.stderr.on("data", (chunk) => {
      stderr = limitedTail(stderr + chunk.toString());
      step.stderrTail = stderr;
    });
    child.on("error", async (error) => {
      step.status = "failed";
      step.completedAt = now();
      step.stderrTail = limitedTail(`${stderr}\n${error.message}`.trim());
      await persist();
      reject(error);
    });
    child.on("close", async (exitCode) => {
      step.exitCode = exitCode;
      step.completedAt = now();
      step.status = exitCode === 0 ? "completed" : "failed";
      await persist();
      if (exitCode === 0) {
        resolve({ stdout, stderr, exitCode });
        return;
      }
      reject(new Error(`${label} failed with exit code ${exitCode}`));
    });
  });
}

async function commandOutput(command, args, outputLimit = 12_000) {
  return await new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    const child = spawn(command, args, {
      cwd: manorDir,
      env: { ...process.env, COMPOSE_PROJECT_NAME: composeProjectName },
      stdio: ["ignore", "pipe", "pipe"]
    });
    child.stdout.on("data", (chunk) => {
      stdout = limitedTail(stdout + chunk.toString(), outputLimit);
    });
    child.stderr.on("data", (chunk) => {
      stderr = limitedTail(stderr + chunk.toString());
    });
    child.on("error", reject);
    child.on("close", (exitCode) => {
      if (exitCode === 0) {
        resolve(stdout);
        return;
      }
      reject(new Error(stderr || `${command} ${args.join(" ")} failed with exit code ${exitCode}`));
    });
  });
}

async function acquireLifecycleLock(run, previousLatestRun = null) {
  const create = async () => {
    await commandOutput("docker", [
      "network",
      "create",
      "--label",
      "com.manor.lifecycle-lock=1",
      "--label",
      `com.manor.lifecycle-run=${run.id}`,
      "--label",
      `com.manor.lifecycle-created=${Math.floor(now() / 1000)}`,
      lifecycleLockName
    ]);
    run.lifecycleLockOwned = true;
  };
  try {
    await create();
  } catch {
    const takeoverToken = `${run.id}-takeover`;
    if (!await acquireLifecycleTakeoverGuard(takeoverToken)) {
      throw new Error("Another Manor lifecycle operation is already running. Wait for it to finish and retry.");
    }
    try {
      try {
        await create();
        return;
      } catch {}
      const details = (await commandOutput("docker", [
        "network",
        "inspect",
        "--format",
        "{{index .Labels \"com.manor.lifecycle-run\"}}|{{index .Labels \"com.manor.lifecycle-created\"}}",
        lifecycleLockName
      ]).catch(() => "")).trim();
      const [owner, createdText] = details.split("|");
      const createdAt = Number(createdText);
      const hostLockIsYoung = Number.isFinite(createdAt) && Math.floor(now() / 1000) - createdAt <= lifecycleLockHeartbeatGraceSeconds;
      const heartbeatStatus = owner?.startsWith("host-") && !hostLockIsYoung
        ? await hostLifecycleHeartbeatStatus(owner)
        : "fresh";
      if (owner?.startsWith("host-") && !hostLockIsYoung && heartbeatStatus === "stale") {
        const verifiedOwner = (await commandOutput("docker", [
          "network",
          "inspect",
          "--format",
          "{{index .Labels \"com.manor.lifecycle-run\"}}",
          lifecycleLockName
        ]).catch(() => "")).trim();
        if (verifiedOwner !== owner) throw new Error("Lifecycle lock ownership changed during takeover.");
        await removeHostLifecycleHeartbeats(owner);
        const finalDetails = (await commandOutput("docker", [
          "network",
          "inspect",
          "--format",
          "{{.Id}}|{{index .Labels \"com.manor.lifecycle-run\"}}",
          lifecycleLockName
        ]).catch(() => "")).trim();
        const [finalNetworkId, finalOwner] = finalDetails.split("|");
        if (finalOwner !== owner) throw new Error("Lifecycle lock ownership changed during takeover.");
        await commandOutput("docker", ["network", "rm", finalNetworkId]);
        await create();
        return;
      }
      if (owner && owner === previousLatestRun?.id && previousLatestRun.status !== "running") {
        await releaseLifecycleLock(previousLatestRun);
        await create();
        return;
      }
    } finally {
      await releaseLifecycleTakeoverGuard(takeoverToken);
    }
    throw new Error("Another Manor lifecycle operation is already running. Wait for it to finish and retry.");
  }
}

async function acquireLifecycleTakeoverGuard(token) {
  try {
    const sharedStateRoot = path.dirname(lifecycleTakeoverRoot);
    await fs.mkdir(sharedStateRoot, { recursive: true, mode: 0o775 });
    if (Number.isInteger(hostUid) && hostUid >= 0 && Number.isInteger(hostGid) && hostGid >= 0) {
      await fs.chown(sharedStateRoot, hostUid, hostGid);
    }
    await fs.chmod(sharedStateRoot, 0o775);
    await fs.mkdir(lifecycleTakeoverRoot, { recursive: true, mode: 0o777 });
    if (Number.isInteger(hostUid) && hostUid >= 0 && Number.isInteger(hostGid) && hostGid >= 0) {
      await fs.chown(lifecycleTakeoverRoot, hostUid, hostGid);
    }
    await fs.chmod(lifecycleTakeoverRoot, 0o777);
    await fs.mkdir(lifecycleTakeoverDir, { mode: 0o777 });
    await fs.chmod(lifecycleTakeoverDir, 0o777);
    await fs.writeFile(path.join(lifecycleTakeoverDir, "owner"), `${token}\n`, { encoding: "utf8", mode: 0o666 });
    await fs.writeFile(path.join(lifecycleTakeoverDir, "heartbeat"), "", { encoding: "utf8", mode: 0o666 });
    await fs.chmod(path.join(lifecycleTakeoverDir, "owner"), 0o666);
    await fs.chmod(path.join(lifecycleTakeoverDir, "heartbeat"), 0o666);
    if (Number.isInteger(hostUid) && hostUid >= 0 && Number.isInteger(hostGid) && hostGid >= 0) {
      await Promise.all([
        fs.chown(lifecycleTakeoverDir, hostUid, hostGid),
        fs.chown(path.join(lifecycleTakeoverDir, "owner"), hostUid, hostGid),
        fs.chown(path.join(lifecycleTakeoverDir, "heartbeat"), hostUid, hostGid)
      ]);
    }
    const heartbeat = setInterval(() => {
      const at = new Date();
      void fs.utimes(path.join(lifecycleTakeoverDir, "heartbeat"), at, at).catch(() => undefined);
    }, 2_000);
    heartbeat.unref();
    lifecycleTakeoverHeartbeats.set(token, heartbeat);
    return true;
  } catch (error) {
    if (error.code !== "EEXIST") return false;
    try {
      const heartbeat = await fs.stat(path.join(lifecycleTakeoverDir, "heartbeat")).catch(() => fs.stat(lifecycleTakeoverDir));
      if (now() - heartbeat.mtimeMs <= lifecycleLockHeartbeatGraceSeconds * 1000) return false;
      const staleDir = `${lifecycleTakeoverDir}.stale.${token}.${crypto.randomUUID()}`;
      await fs.rename(lifecycleTakeoverDir, staleDir);
      await fs.rm(staleDir, { recursive: true, force: true });
      return await acquireLifecycleTakeoverGuard(token);
    } catch {
      return false;
    }
  }
}

async function releaseLifecycleTakeoverGuard(token) {
  const heartbeat = lifecycleTakeoverHeartbeats.get(token);
  if (heartbeat) clearInterval(heartbeat);
  lifecycleTakeoverHeartbeats.delete(token);
  const owner = (await fs.readFile(path.join(lifecycleTakeoverDir, "owner"), "utf8").catch(() => "")).trim();
  if (owner !== token) return;
  const releasedDir = `${lifecycleTakeoverDir}.released.${token}.${crypto.randomUUID()}`;
  try {
    await fs.rename(lifecycleTakeoverDir, releasedDir);
    await fs.rm(releasedDir, { recursive: true, force: true });
  } catch {}
}

async function hostLifecycleHeartbeatStatus(owner) {
  try {
    const heartbeatOwner = (await fs.readFile(path.join(lifecycleHostLeaseDir, "owner"), "utf8")).trim();
    if (heartbeatOwner !== owner) return "stale";
    const heartbeat = await fs.stat(path.join(lifecycleHostLeaseDir, "heartbeat"));
    return now() - heartbeat.mtimeMs <= lifecycleLockHeartbeatGraceSeconds * 1000 ? "fresh" : "stale";
  } catch (error) {
    if (error.code === "ENOENT") return "stale";
    return "unknown";
  }
}

async function removeHostLifecycleHeartbeats(owner) {
  const leaseOwner = (await fs.readFile(path.join(lifecycleHostLeaseDir, "owner"), "utf8").catch(() => "")).trim();
  if (leaseOwner === owner) {
    const removedDir = `${lifecycleHostLeaseDir}.removed.${owner}.${crypto.randomUUID()}`;
    try {
      await fs.rename(lifecycleHostLeaseDir, removedDir);
      await fs.rm(removedDir, { recursive: true, force: true });
    } catch {}
  }
  for (const suffix of ["heartbeat-a", "heartbeat-b"]) {
    const name = `${lifecycleLockName}-${suffix}`;
    const details = (await commandOutput("docker", [
      "network",
      "inspect",
      "--format",
      "{{.Id}}|{{index .Labels \"com.manor.lifecycle-run\"}}",
      name
    ]).catch(() => "")).trim();
    const [networkId, heartbeatOwner] = details.split("|");
    if (heartbeatOwner === owner) await commandOutput("docker", ["network", "rm", networkId]).catch(() => undefined);
  }
}

async function releaseLifecycleLock(run) {
  if (!run?.id) return;
  const details = (await commandOutput("docker", [
    "network",
    "inspect",
    "--format",
    "{{.Id}}|{{index .Labels \"com.manor.lifecycle-run\"}}",
    lifecycleLockName
  ]).catch(() => "")).trim();
  const [networkId, owner] = details.split("|");
  if (owner === run.id) {
    await commandOutput("docker", ["network", "rm", networkId]).catch(() => undefined);
  }
  run.lifecycleLockOwned = false;
}

async function reconcileOrphanLifecycleLock() {
  let owner;
  try {
    owner = (await commandOutput("docker", [
      "network",
      "inspect",
      "--format",
      "{{index .Labels \"com.manor.lifecycle-run\"}}",
      lifecycleLockName
    ])).trim();
  } catch {
    return;
  }
  if (!owner || owner.startsWith("host-") || (latestRun?.id === owner && latestRun.status === "running")) return;

  let helpers;
  try {
    helpers = (await commandOutput("docker", [
      "ps",
      "--filter",
      `label=com.manor.restart-run=${owner}`,
      "--quiet"
    ])).trim();
  } catch {
    return;
  }
  if (helpers) return;
  const verifiedDetails = (await commandOutput("docker", [
    "network",
    "inspect",
    "--format",
    "{{.Id}}|{{index .Labels \"com.manor.lifecycle-run\"}}",
    lifecycleLockName
  ]).catch(() => "")).trim();
  const [networkId, verifiedOwner] = verifiedDetails.split("|");
  if (verifiedOwner === owner) await commandOutput("docker", ["network", "rm", networkId]).catch(() => undefined);
}

async function detectRunningButlerHotReload() {
  const listed = await commandOutput("docker", [
    "ps",
    "--filter",
    `label=com.docker.compose.project=${composeProjectName}`,
    "--filter",
    "label=com.docker.compose.service=butler",
    "--quiet"
  ]).catch(() => "");
  const containerId = listed.split(/\r?\n/).map((line) => line.trim()).find(Boolean);
  if (!containerId) {
    return false;
  }
  const env = await commandOutput("docker", ["inspect", "--format", "{{range .Config.Env}}{{println .}}{{end}}", containerId]).catch(() => "");
  if (env.split(/\r?\n/).includes("BUTLER_HOT_RELOAD=1")) {
    return true;
  }
  const configFiles = await commandOutput("docker", ["inspect", "--format", "{{index .Config.Labels \"com.docker.compose.project.config_files\"}}", containerId]).catch(() => "");
  return configFiles.includes("compose.dev.yml");
}

async function currentBranch(run) {
  const result = await runStep(run, "Read source branch", "git", ["branch", "--show-current"]);
  return result.stdout.trim();
}

async function localGitRefExists(gitRef) {
  return await new Promise((resolve) => {
    const child = spawn("git", ["rev-parse", "--verify", "--quiet", `${gitRef}^{commit}`], {
      cwd: manorDir,
      env: process.env,
      stdio: ["ignore", "ignore", "ignore"]
    });
    child.on("error", () => resolve(false));
    child.on("close", (exitCode) => resolve(exitCode === 0));
  });
}

async function updateSource(run) {
  const wantsUpdate = run.update || run.gitRef || run.target === "latest";
  if (!wantsUpdate) {
    return;
  }

  if (run.gitRef) {
    if (await localGitRefExists(run.gitRef)) {
      await runStep(run, "Checkout local target ref", "git", ["checkout", run.gitRef]);
      return;
    }
    await runStep(run, "Fetch source refs", "git", [...githubHttpsFetchConfig, "fetch", "--all", "--tags", "--prune"]);
    await runStep(run, "Checkout target ref", "git", ["checkout", run.gitRef]);
    return;
  }

  const branch = await currentBranch(run);
  if (!branch) {
    throw new Error("Source update refused because the Manor checkout is detached. Provide a target ref.");
  }
  await runStep(run, "Fetch source branch", "git", [...githubHttpsFetchConfig, "fetch", "origin", branch]);
  await runStep(run, "Fast-forward source branch", "git", ["merge", "--ff-only", `origin/${branch}`]);
}

async function buildSourceImages(run) {
  if (run.build === false) {
    return;
  }
  await runStep(run, "Build source images", "docker", [
    ...composeArgs(run.includeDesktop),
    "build",
    ...sourceBuildServices,
    ...(run.includeDesktop ? ["desktop-proof"] : [])
  ]);
}

async function activeEnvFileArgs() {
  const envPath = path.join(manorDir, ".env");
  try {
    await fs.access(envPath);
    return ["--env-file", envPath];
  } catch (error) {
    if (error.code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

async function recordCleanHeadRetry(run, error) {
  const recordedAt = now();
  run.steps.push({
    label: "Retry source restart from clean HEAD",
    command: "internal",
    args: [],
    status: "completed",
    startedAt: recordedAt,
    completedAt: recordedAt,
    exitCode: 0,
    stdoutTail: `Working-tree restart failed: ${error instanceof Error ? error.message : String(error)}`,
    stderrTail: ""
  });
  await persist();
}

async function prepareCleanHeadSource(run) {
  const fallbackParent = path.join(manorDir, "state", "host-controller");
  await fs.mkdir(fallbackParent, { recursive: true });
  const cleanDir = await fs.mkdtemp(path.join(fallbackParent, "head-"));
  const archivePath = `${cleanDir}.tar`;
  try {
    await runStep(run, "Export clean HEAD source", "git", ["archive", "--format=tar", `--output=${archivePath}`, "HEAD"]);
    await runStep(run, "Extract clean HEAD source", "tar", ["-xf", archivePath, "-C", cleanDir]);
    const compose = [
      "compose",
      ...await activeEnvFileArgs(),
      "--project-directory",
      cleanDir,
      "-f",
      path.join(cleanDir, "compose.yml"),
      "-f",
      path.join(cleanDir, "compose.build.yml")
    ];
    if (run.includeDesktop) {
      compose.push("--profile", "desktop");
    }
    await fs.rm(archivePath, { force: true });
    return { cleanDir, compose };
  } catch (error) {
    await fs.rm(archivePath, { force: true });
    await fs.rm(cleanDir, { recursive: true, force: true });
    throw error;
  }
}

function composeDurationFromNanoseconds(value) {
  return Number.isFinite(value) && value > 0 ? `${value}ns` : undefined;
}

function escapeComposeValues(value) {
  if (typeof value === "string") return value.split("$").join("$$");
  if (Array.isArray(value)) return value.map(escapeComposeValues);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, escapeComposeValues(entry)]));
  }
  return value;
}

async function prepareControllerRollbackSource(run) {
  const rollbackSource = await prepareCleanHeadSource(run);
  try {
    const inspected = JSON.parse(await commandOutput("docker", ["inspect", "manor-host-controller"], 1_000_000));
    const container = Array.isArray(inspected) ? inspected[0] : null;
    if (!container?.Config || !container?.HostConfig || !Array.isArray(container.Mounts)) {
      throw new Error("Could not capture the running host controller configuration for rollback.");
    }

    const environment = {};
    for (const entry of container.Config.Env ?? []) {
      const separator = entry.indexOf("=");
      if (separator > 0) {
        const key = entry.slice(0, separator);
        environment[key] = `\${${key}}`;
      }
    }

    const networks = {};
    const serviceNetworks = {};
    let networkIndex = 0;
    for (const [networkName, network] of Object.entries(container.NetworkSettings?.Networks ?? {})) {
      const projectPrefix = `${composeProjectName}_`;
      const logicalName = networkName.startsWith(projectPrefix)
        ? networkName.slice(projectPrefix.length)
        : `rollback_network_${networkIndex}`;
      networkIndex += 1;
      networks[logicalName] = networkName.startsWith(projectPrefix)
        ? {}
        : { name: networkName, external: true };
      const aliases = [...new Set((network.Aliases ?? []).filter((alias) =>
        typeof alias === "string" && alias && alias !== container.Id && !/^[0-9a-f]{64}$/.test(alias)
      ))];
      serviceNetworks[logicalName] = aliases.length > 0 ? { aliases } : {};
    }

    const volumes = {};
    const serviceVolumes = [];
    let volumeIndex = 0;
    for (const mount of container.Mounts) {
      if (mount.Type !== "bind" && mount.Type !== "volume") continue;
      let source = mount.Source;
      if (mount.Type === "volume") {
        const logicalName = `rollback_volume_${volumeIndex}`;
        volumeIndex += 1;
        volumes[logicalName] = { name: mount.Name, external: true };
        source = logicalName;
      }
      serviceVolumes.push({
        type: mount.Type,
        source,
        target: mount.Destination,
        read_only: mount.RW === false
      });
    }

    const health = container.Config.Healthcheck;
    const healthcheck = health ? {
      test: health.Test,
      interval: composeDurationFromNanoseconds(health.Interval),
      timeout: composeDurationFromNanoseconds(health.Timeout),
      retries: health.Retries,
      start_period: composeDurationFromNanoseconds(health.StartPeriod),
      start_interval: composeDurationFromNanoseconds(health.StartInterval)
    } : undefined;
    if (healthcheck) {
      for (const key of Object.keys(healthcheck)) {
        if (healthcheck[key] === undefined) delete healthcheck[key];
      }
    }

    const restartPolicy = container.HostConfig.RestartPolicy ?? {};
    const restart = restartPolicy.Name === "on-failure" && restartPolicy.MaximumRetryCount > 0
      ? `on-failure:${restartPolicy.MaximumRetryCount}`
      : restartPolicy.Name || "no";
    const service = {
      image: "manor-host-controller:local",
      hostname: container.Config.Hostname || "manor-host-controller",
      environment,
      volumes: serviceVolumes,
      networks: serviceNetworks,
      restart,
      working_dir: container.Config.WorkingDir || manorDir,
      user: container.Config.User || undefined,
      entrypoint: container.Config.Entrypoint ?? undefined,
      command: container.Config.Cmd ?? undefined,
      healthcheck,
      read_only: container.HostConfig.ReadonlyRootfs === true,
      privileged: container.HostConfig.Privileged === true
    };
    for (const key of Object.keys(service)) {
      if (service[key] === undefined) delete service[key];
    }

    const overridePath = path.join(rollbackSource.cleanDir, "controller-rollback.override.json");
    const override = escapeComposeValues({
      services: { "host-controller": service },
      networks,
      volumes
    });
    override.services["host-controller"].environment = environment;
    await fs.writeFile(overridePath, JSON.stringify(override, null, 2), { encoding: "utf8", mode: 0o600 });
    rollbackSource.compose.push("-f", overridePath);
    return rollbackSource;
  } catch (error) {
    await cleanupCleanHeadSource(rollbackSource);
    throw error;
  }
}

async function cleanupCleanHeadSource(cleanHead) {
  await fs.rm(cleanHead.cleanDir, { recursive: true, force: true });
}

async function cleanupOtherCleanHeadSources(protectedCleanDirs = []) {
  const fallbackParent = path.join(manorDir, "state", "host-controller");
  const protectedPaths = new Set(Array.isArray(protectedCleanDirs) ? protectedCleanDirs : [protectedCleanDirs]);
  let entries = [];
  try {
    entries = await fs.readdir(fallbackParent, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }
  await Promise.all(entries
    .filter((entry) => entry.isDirectory() && entry.name.startsWith("head-"))
    .map((entry) => path.join(fallbackParent, entry.name))
    .filter((entryPath) => !protectedPaths.has(entryPath))
    .map((entryPath) => fs.rm(entryPath, { recursive: true, force: true })));
}

async function buildCleanHeadSourceImages(run, cleanHead) {
  await runStep(
    run,
    "Build clean HEAD source images",
    "docker",
    [...cleanHead.compose, "build", ...sourceBuildServices, ...(run.includeDesktop ? ["desktop-proof"] : [])],
    { cwd: cleanHead.cleanDir }
  );
}

async function restartAppliance(run, compose = composeArgs(run.includeDesktop, run.hotReload), cwd = manorDir) {
  const services = [...applianceServices];
  if (run.includeDesktop) {
    services.push("desktop-proof");
  }
  await cleanupStaleReplacementContainers(run, services);
  for (const service of services) {
    await runStep(run, `Restart ${service}`, "docker", [
      ...compose,
      "up",
      "-d",
      "--force-recreate",
      "--no-deps",
      "--no-build",
      "--pull",
      "never",
      "--wait",
      "--wait-timeout",
      String(restartWaitTimeoutSeconds),
      service
    ], { cwd });
  }
}

async function cleanupStoppedActivationHelpers() {
  const listed = await commandOutput("docker", [
    "ps",
    "--all",
    "--filter",
    "label=com.manor.host-controller-restart=1",
    "--filter",
    "status=exited",
    "--quiet"
  ]).catch(() => "");
  const containerIds = listed.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (containerIds.length > 0) {
    await commandOutput("docker", ["rm", "--force", ...containerIds]);
  }
}

async function scheduleHostControllerActivation(run, rollbackSource) {
  await cleanupStoppedActivationHelpers();
  const helperName = `${composeProjectName}-host-controller-restart-${run.id.slice(0, 12)}`;
  const previousContainerId = (await commandOutput("docker", ["inspect", "--format", "{{.Id}}", "manor-host-controller"])).trim();
  const rollbackImage = (await commandOutput("docker", ["inspect", "--format", "{{.Image}}", "manor-host-controller"])).trim();
  const desiredImage = (await commandOutput("docker", ["image", "inspect", "--format", "{{.Id}}", "manor-host-controller:local"])).trim();
  const stateVolume = (await commandOutput("docker", [
    "inspect",
    "--format",
    "{{range .Mounts}}{{if eq .Destination \"/state\"}}{{.Name}}{{end}}{{end}}",
    "manor-host-controller"
  ])).trim();
  const networkNames = JSON.parse((await commandOutput("docker", [
    "inspect",
    "--format",
    "{{json .NetworkSettings.Networks}}",
    "manor-host-controller"
  ])).trim());
  const controlNetwork = Object.keys(networkNames).find((name) => name === `${composeProjectName}_control`)
    ?? Object.keys(networkNames).find((name) => name.endsWith("_control"));
  if (!previousContainerId || !rollbackImage || !desiredImage || !stateVolume || !controlNetwork) {
    throw new Error("Could not resolve the running host controller image for rollback.");
  }
  const activationArgs = [
    ...composeArgs(run.includeDesktop, run.hotReload),
    "up",
    "-d",
    "--force-recreate",
    "--no-deps",
    "--no-build",
    "--pull",
    "never",
    "--wait",
    "--wait-timeout",
    String(restartWaitTimeoutSeconds),
    "host-controller"
  ];
  const rollbackArgs = [
    ...rollbackSource.compose,
    "up",
    "-d",
    "--force-recreate",
    "--no-deps",
    "--no-build",
    "--pull",
    "never",
    "--wait",
    "--wait-timeout",
    String(restartWaitTimeoutSeconds),
    "host-controller"
  ];
  const forwardedEnvironment = Object.keys(commandEnv(run))
    .sort()
    .flatMap((key) => ["--env", key]);

  run.controllerActivationPending = true;
  run.controllerActivationImage = desiredImage;
  run.controllerActivationRollbackImage = rollbackImage;
  run.controllerActivationRollbackProjectDir = rollbackSource.cleanDir;
  run.controllerActivationPreviousContainerId = previousContainerId;
  run.controllerActivationDeadline = now() + (restartWaitTimeoutSeconds + 60) * 1000;
  run.controllerActivationCleanupDir = rollbackSource.cleanDir;
  run.controllerActivationRollingBack = false;
  await persist();

  await runStep(run, "Schedule host controller activation", "docker", [
    "run",
    "--detach",
    "--name",
    helperName,
    "--restart",
    "unless-stopped",
    "--label",
    "com.manor.host-controller-restart=1",
    "--label",
    `com.manor.restart-run=${run.id}`,
    "--network",
    controlNetwork,
    "--volume",
    "/var/run/docker.sock:/var/run/docker.sock",
    "--volume",
    `${manorDir}:${manorDir}`,
    "--volume",
    `${stateVolume}:/state`,
    "--workdir",
    manorDir,
    ...forwardedEnvironment,
    "--entrypoint",
    "node",
    rollbackImage,
    "/opt/manor/host-controller/controller-activation.mjs",
    run.id,
    helperName,
    lifecycleLockName,
    rollbackImage,
    rollbackSource.cleanDir,
    JSON.stringify(activationArgs),
    JSON.stringify(rollbackArgs)
  ]);

}

async function cleanupStaleReplacementContainers(run, services) {
  const listed = await runStep(run, "List stale Compose containers", "docker", ["ps", "-a", "--format", "{{.Names}}"]);
  const servicePattern = services.map((service) => service.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
  const stalePattern = new RegExp(`^[0-9a-f]{12}_manor-(${servicePattern})$`);
  const staleNames = listed.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((name) => stalePattern.test(name));
  if (staleNames.length === 0) {
    return;
  }
  await runStep(run, "Remove stale Compose containers", "docker", ["rm", "--force", ...staleNames]);
}

async function waitForButler(run) {
  const step = {
    label: "Wait for Butler health",
    command: "fetch",
    args: [butlerHealthUrl],
    status: "running",
    startedAt: now(),
    completedAt: null,
    exitCode: null,
    stdoutTail: "",
    stderrTail: ""
  };
  run.steps.push(step);
  await persist();
  const deadline = Date.now() + restartWaitTimeoutSeconds * 1000;
  let lastError = "";
  while (Date.now() < deadline) {
    try {
      const response = await fetch(butlerHealthUrl);
      if (response.ok) {
        step.status = "completed";
        step.exitCode = 0;
        step.completedAt = now();
        step.stdoutTail = `Healthy: ${butlerHealthUrl}`;
        await persist();
        return;
      }
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    step.stderrTail = lastError;
    await persist();
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  step.status = "failed";
  step.exitCode = 1;
  step.completedAt = now();
  step.stderrTail = lastError || "Timed out waiting for Butler health.";
  await persist();
  throw new Error("Timed out waiting for Butler health.");
}

async function restartSourceAppliance(run, controllerRollbackDir = null) {
  try {
    await buildSourceImages(run);
    await restartAppliance(run);
    await waitForButler(run);
    await cleanupOtherCleanHeadSources(controllerRollbackDir ? [controllerRollbackDir] : []).catch(() => undefined);
    return run.build !== false;
  } catch (primaryError) {
    await recordCleanHeadRetry(run, primaryError);
    let cleanHead = null;
    let fallbackRunning = false;
    try {
      cleanHead = await prepareCleanHeadSource(run);
      await buildCleanHeadSourceImages(run, cleanHead);
      run.hotReload = false;
      await restartAppliance(run, cleanHead.compose, cleanHead.cleanDir);
      await waitForButler(run);
      fallbackRunning = true;
      await cleanupOtherCleanHeadSources([cleanHead.cleanDir, controllerRollbackDir].filter(Boolean)).catch(() => undefined);
      return false;
    } catch (fallbackError) {
      const primaryMessage = primaryError instanceof Error ? primaryError.message : String(primaryError);
      const fallbackMessage = fallbackError instanceof Error ? fallbackError.message : String(fallbackError);
      throw new Error(`Source restart failed from the working tree (${primaryMessage}); retry from clean HEAD also failed (${fallbackMessage}).`);
    } finally {
      if (cleanHead && !fallbackRunning) {
        await cleanupCleanHeadSource(cleanHead);
      }
    }
  }
}

async function executeRun(run) {
  activeRun = run;
  latestRun = run;
  let activateHostController = false;
  let activationRollbackSource = null;
  let activationScheduled = false;
  try {
    await persist();
    if (run.delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, run.delayMs));
    }
    await runStep(run, "Verify source checkout", "git", ["rev-parse", "--is-inside-work-tree"]);
    if (run.build !== false) {
      activationRollbackSource = await prepareControllerRollbackSource(run);
    }
    await updateSource(run);
    activateHostController = await restartSourceAppliance(run, activationRollbackSource?.cleanDir ?? null);
    if (activateHostController) {
      await scheduleHostControllerActivation(run, activationRollbackSource);
      activationScheduled = true;
    } else {
      run.status = "completed";
      run.completedAt = now();
      await persist();
    }
  } catch (error) {
    run.status = "failed";
    run.completedAt = now();
    run.error = error instanceof Error ? error.message : String(error);
    run.controllerActivationPending = false;
  } finally {
    if (activationRollbackSource && !activationScheduled) {
      await cleanupCleanHeadSource(activationRollbackSource);
    }
    activeRun = null;
    if (!activationScheduled) {
      await releaseLifecycleLock(run);
    }
    await persist().catch((error) => {
      console.error(`Could not persist final Manor restart state: ${error instanceof Error ? error.message : String(error)}`);
    });
  }
}

function createRun(payload) {
  return {
    id: crypto.randomUUID(),
    status: "running",
    target: payload.target,
    gitRef: payload.gitRef,
    includeDesktop: payload.includeDesktop === true,
    hotReload: payload.hotReload === true,
    update: payload.update === true || payload.target === "latest" || Boolean(payload.gitRef),
    build: shouldBuildSourceImages(payload),
    delayMs: defaultDelayMs,
    startedAt: now(),
    completedAt: null,
    error: null,
    controllerActivationPending: false,
    controllerActivationImage: null,
    controllerActivationRollbackImage: null,
    controllerActivationRollbackProjectDir: null,
    controllerActivationPreviousContainerId: null,
    controllerActivationDeadline: null,
    controllerActivationCleanupDir: null,
    controllerActivationRollingBack: false,
    lifecycleLockOwned: false,
    steps: []
  };
}

let activationMutation = Promise.resolve();
let restartAdmission = Promise.resolve();

async function withRestartAdmission(operation) {
  const current = restartAdmission.then(operation, operation);
  restartAdmission = current.then(() => undefined, () => undefined);
  return await current;
}

async function withActivationMutation(operation) {
  const current = activationMutation.then(operation, operation);
  activationMutation = current.then(() => undefined, () => undefined);
  return await current;
}

async function inspectRunningController() {
  const [containerId, image, health, projectDir] = await Promise.all([
    commandOutput("docker", ["inspect", "--format", "{{.Id}}", "manor-host-controller"]),
    commandOutput("docker", ["inspect", "--format", "{{.Image}}", "manor-host-controller"]),
    commandOutput("docker", [
      "inspect",
      "--format",
      "{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}",
      "manor-host-controller"
    ]),
    commandOutput("docker", [
      "inspect",
      "--format",
      "{{index .Config.Labels \"com.docker.compose.project.working_dir\"}}",
      "manor-host-controller"
    ])
  ]);
  return { containerId: containerId.trim(), image: image.trim(), health: health.trim(), projectDir: projectDir.trim() };
}

async function cleanupActivationSource(run) {
  const cleanupDir = run.controllerActivationCleanupDir;
  if (typeof cleanupDir === "string" && cleanupDir) {
    await fs.rm(cleanupDir, { recursive: true, force: true }).catch(() => undefined);
  }
  run.controllerActivationCleanupDir = null;
}

async function completePendingActivation(run) {
  if (run.controllerActivationRollingBack === true) {
    return { ok: false, error: "Host controller rollback has already started." };
  }
  const running = await inspectRunningController().catch(() => ({ containerId: "", image: "", health: "", projectDir: "" }));
  if (!running.containerId || running.containerId === run.controllerActivationPreviousContainerId) {
    return { ok: false, error: "The rebuilt host controller has not replaced the previous container yet." };
  }
  if (!running.image || running.image !== run.controllerActivationImage) {
    return { ok: false, error: "The running host controller does not match the expected rebuilt image." };
  }
  if (running.projectDir !== manorDir) {
    return { ok: false, error: "The rebuilt host controller is not using the active source manifests." };
  }
  if (running.health !== "healthy") {
    return { ok: false, error: "The rebuilt host controller is not healthy yet." };
  }
  if (latestRun?.id !== run.id) {
    return { ok: false, error: "The restart run is no longer current." };
  }
  if (latestRun.status === "completed" && latestRun.controllerActivationPending !== true) {
    return { ok: true };
  }
  if (latestRun.status !== "running" || latestRun.controllerActivationPending !== true) {
    return { ok: false, error: "No matching host controller activation is pending." };
  }
  if (latestRun.controllerActivationRollingBack === true) {
    return { ok: false, error: "Host controller rollback has already started." };
  }

  try {
    const persisted = JSON.parse(await fs.readFile(statePath, "utf8"));
    if (persisted.latestRun?.id === run.id && persisted.latestRun.status === "failed") {
      latestRun = persisted.latestRun;
      return { ok: false, error: persisted.latestRun.error || "Host controller activation failed." };
    }
    if (persisted.latestRun?.id === run.id && persisted.latestRun.controllerActivationRollingBack === true) {
      latestRun = persisted.latestRun;
      return { ok: false, error: "Host controller rollback has already started." };
    }
  } catch {}

  const completedAt = now();
  if (!latestRun.steps.some((step) => step.label === "Activate host controller" && step.status === "completed")) {
    latestRun.steps.push({
      label: "Activate host controller",
      command: "internal",
      args: [],
      status: "completed",
      startedAt: completedAt,
      completedAt,
      exitCode: 0,
      stdoutTail: "The rebuilt host controller is healthy.",
      stderrTail: ""
    });
  }
  latestRun.status = "completed";
  latestRun.completedAt = completedAt;
  latestRun.error = null;
  latestRun.controllerActivationPending = false;
  latestRun.controllerActivationRollingBack = false;
  await cleanupActivationSource(latestRun);
  await persist();
  return { ok: true };
}

async function markActivationRollbackStarting(run, message) {
  if (latestRun?.id !== run.id || latestRun.status !== "running" || latestRun.controllerActivationPending !== true) {
    return { ok: false, error: "No matching host controller activation is pending." };
  }
  if (latestRun.controllerActivationRollingBack === true) {
    return { ok: true };
  }
  latestRun.controllerActivationRollingBack = true;
  latestRun.error = message;
  latestRun.controllerActivationDeadline = now() + (restartWaitTimeoutSeconds + 60) * 1000;
  await persist();
  return { ok: true };
}

async function failPendingActivation(run, message, cleanupSource = false) {
  if (latestRun?.id !== run.id) {
    return { ok: false, error: "No matching host controller activation is pending." };
  }
  const failedAt = now();
  if (latestRun.status === "failed" && latestRun.controllerActivationPending !== true) {
    latestRun.error = message;
    latestRun.completedAt = failedAt;
    latestRun.steps.push({
      label: "Activate host controller",
      command: "internal",
      args: [],
      status: "failed",
      startedAt: failedAt,
      completedAt: failedAt,
      exitCode: 1,
      stdoutTail: "",
      stderrTail: message
    });
    await persist();
    return { ok: true };
  }
  if (latestRun.status !== "running" || latestRun.controllerActivationPending !== true) {
    return { ok: false, error: "No matching host controller activation is pending." };
  }
  latestRun.steps.push({
    label: "Activate host controller",
    command: "internal",
    args: [],
    status: "failed",
    startedAt: failedAt,
    completedAt: failedAt,
    exitCode: 1,
    stdoutTail: "",
    stderrTail: message
  });
  latestRun.status = "failed";
  latestRun.completedAt = failedAt;
  latestRun.error = message;
  latestRun.controllerActivationPending = false;
  latestRun.controllerActivationRollingBack = false;
  if (cleanupSource) {
    await cleanupActivationSource(latestRun);
  }
  await persist();
  return { ok: true };
}

async function failExpiredActivation(run) {
  await failPendingActivation(
    run,
    "Host controller activation did not complete before its recovery deadline.",
    false
  );
}

async function reconcilePendingActivation() {
  await withActivationMutation(async () => {
    let run = latestRun;
    if (!run || run.status !== "running" || run.controllerActivationPending !== true) return;

    try {
      const persisted = JSON.parse(await fs.readFile(statePath, "utf8"));
      if (persisted.latestRun?.id === run.id && persisted.latestRun.status === "failed") {
        latestRun = persisted.latestRun;
        return;
      }
      if (persisted.latestRun?.id === run.id && persisted.latestRun.controllerActivationRollingBack === true) {
        latestRun = persisted.latestRun;
        run = latestRun;
      }
    } catch {}

    let helperList = null;
    try {
      helperList = await commandOutput("docker", [
        "ps",
        "--filter",
        `label=com.manor.restart-run=${run.id}`,
        "--quiet"
      ]);
    } catch {
      return;
    }
    const helperIds = helperList.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    if (helperIds.length > 0) {
      if (Number.isFinite(run.controllerActivationDeadline) && now() >= run.controllerActivationDeadline) {
        await commandOutput("docker", ["update", "--restart=no", ...helperIds]).catch(() => undefined);
        await commandOutput("docker", ["rm", "--force", ...helperIds]).catch(() => undefined);
        run.controllerActivationDeadline = now() + 10_000;
        await persist();
      }
      return;
    }

    if (run.controllerActivationRollingBack !== true) {
      const completed = await completePendingActivation(run);
      if (completed.ok) {
        await releaseLifecycleLock(run);
        return;
      }
    } else {
      const running = await inspectRunningController().catch(() => ({ containerId: "", image: "", health: "", projectDir: "" }));
      if (running.projectDir === run.controllerActivationRollbackProjectDir && running.health === "healthy") {
        await failPendingActivation(run, run.error || "The previous host controller image was restored.", true);
        await releaseLifecycleLock(run);
        return;
      }
    }
    if (Number.isFinite(run.controllerActivationDeadline) && now() >= run.controllerActivationDeadline) {
      await failExpiredActivation(run);
      await releaseLifecycleLock(run);
    }
  });
}

function authorize(request, response, next) {
  if (!authToken) {
    response.status(503).json({ error: "Host controller token is not configured." });
    return;
  }
  if (safeTokenMatch(authToken, request.header("x-manor-host-controller-token"))) {
    next();
    return;
  }
  response.status(403).json({ error: "Forbidden" });
}

await loadState();
if (latestRun && latestRun.status !== "running") {
  await releaseLifecycleLock(latestRun);
}
await reconcileOrphanLifecycleLock();
await persist();

const app = express();
app.use(express.json({ limit: "16kb" }));

app.get("/health", (_request, response) => {
  response.json({ ok: true, active: Boolean(activeRun || latestRun?.status === "running"), latestRun: publicRun(latestRun) });
});

app.get("/status", authorize, async (_request, response) => {
  response.json({
    ok: true,
    active: publicRun(activeRun ?? (latestRun?.status === "running" ? latestRun : null)),
    latestRun: publicRun(latestRun),
  });
});

app.post("/restart", authorize, async (request, response) => {
  await withRestartAdmission(async () => {
    const body = request.body && typeof request.body === "object" ? request.body : {};
    const running = activeRun ?? (latestRun?.status === "running" ? latestRun : null);
    if (running) {
      response.status(409).json({ error: "A Manor restart is already running.", active: publicRun(running) });
      return;
    }

    const parsed = validateRestartPayload(body);
    if (!parsed.ok) {
      response.status(400).json({ error: parsed.error });
      return;
    }

    const hotReload = parsed.value.hotReload === true
      ? true
      : parsed.value.hotReload === false
        ? false
        : await detectRunningButlerHotReload();
    const run = createRun(parsed.value);
    run.hotReload = hotReload;
    const previousLatestRun = latestRun;
    latestRun = run;
    try {
      await persist();
    } catch (error) {
      latestRun = previousLatestRun;
      response.status(500).json({ error: "Could not initialize the Manor restart state." });
      return;
    }
    try {
      await acquireLifecycleLock(run, previousLatestRun);
    } catch (error) {
      if (latestRun?.id === run.id) {
        latestRun = previousLatestRun;
        await persist().catch((persistError) => {
          console.error(`Could not restore the previous Manor restart state: ${persistError instanceof Error ? persistError.message : String(persistError)}`);
        });
      }
      response.status(409).json({ error: error instanceof Error ? error.message : String(error) });
      return;
    }
    void executeRun(run);
    response.status(202).json({ ok: true, run: publicRun(run) });
  });
});

app.post("/activation/complete", authorize, async (request, response) => {
  const runId = typeof request.body?.runId === "string" ? request.body.runId : "";
  if (!runId || latestRun?.id !== runId) {
    response.status(409).json({ error: "No matching host controller activation is pending." });
    return;
  }

  const requestedRun = latestRun;
  const result = await withActivationMutation(() => completePendingActivation(requestedRun));
  if (!result.ok) {
    response.status(409).json({ error: result.error });
    return;
  }
  response.json({ ok: true, run: publicRun(latestRun) });
});

app.post("/activation/fail", authorize, async (request, response) => {
  const runId = typeof request.body?.runId === "string" ? request.body.runId : "";
  const message = typeof request.body?.error === "string" && request.body.error.trim()
    ? request.body.error.trim().slice(0, 1000)
    : "Host controller activation failed.";
  if (!runId || latestRun?.id !== runId) {
    response.status(409).json({ error: "No matching host controller activation is pending." });
    return;
  }

  const requestedRun = latestRun;
  const result = await withActivationMutation(() => failPendingActivation(requestedRun, message));
  if (!result.ok) {
    response.status(409).json({ error: result.error });
    return;
  }
  response.json({ ok: true, run: publicRun(latestRun) });
});

app.post("/activation/rollback", authorize, async (request, response) => {
  const runId = typeof request.body?.runId === "string" ? request.body.runId : "";
  const message = typeof request.body?.error === "string" && request.body.error.trim()
    ? request.body.error.trim().slice(0, 1000)
    : "The rebuilt host controller did not become healthy; rollback is running.";
  if (!runId || latestRun?.id !== runId) {
    response.status(409).json({ error: "No matching host controller activation is pending." });
    return;
  }

  const requestedRun = latestRun;
  const result = await withActivationMutation(() => markActivationRollbackStarting(requestedRun, message));
  if (!result.ok) {
    response.status(409).json({ error: result.error });
    return;
  }
  response.json({ ok: true, run: publicRun(latestRun) });
});

app.listen(port, "0.0.0.0", () => {
  console.log(`Manor host controller listening on ${port}`);
});

const activationReconciler = setInterval(() => {
  void reconcilePendingActivation();
}, 2000);
activationReconciler.unref();
void reconcilePendingActivation();
