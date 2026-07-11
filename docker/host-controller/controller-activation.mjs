#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";

const [runId, helperName, lifecycleLockName, rollbackImage, cleanupDir, desiredJson, rollbackJson] = process.argv.slice(2);
const statePath = "/state/restart-status.json";
const controllerToken = process.env.MANOR_HOST_CONTROLLER_TOKEN ?? "";
const configuredWaitSeconds = Number(process.env.MANOR_START_WAIT_TIMEOUT ?? "300");
const rollbackWaitSeconds = Number.isFinite(configuredWaitSeconds) && configuredWaitSeconds > 0 ? configuredWaitSeconds : 300;

function docker(args) {
  return spawnSync("docker", args, { env: process.env, stdio: "inherit" }).status ?? 1;
}

function dockerOutput(args) {
  const result = spawnSync("docker", args, { env: process.env, encoding: "utf8" });
  return result.status === 0 ? result.stdout.trim() : "";
}

async function updateFailure(message) {
  try {
    const state = JSON.parse(await fs.readFile(statePath, "utf8"));
    if (state.latestRun?.id !== runId || state.latestRun.status === "completed") return;
    const now = Date.now();
    state.latestRun.status = "failed";
    state.latestRun.completedAt = now;
    state.latestRun.error = message;
    state.latestRun.controllerActivationPending = false;
    state.latestRun.controllerActivationRollingBack = false;
    state.latestRun.steps = [...(state.latestRun.steps ?? []), {
      label: "Activate host controller",
      status: "failed",
      startedAt: now,
      completedAt: now,
      exitCode: 1,
      stdoutTail: "",
      stderrTail: message
    }];
    const nextStatePath = `${statePath}.activation-${process.pid}`;
    await fs.writeFile(nextStatePath, JSON.stringify(state, null, 2), "utf8");
    await fs.rename(nextStatePath, statePath);
  } catch {}
}

async function updateRollbackStarting(message) {
  try {
    const state = JSON.parse(await fs.readFile(statePath, "utf8"));
    if (state.latestRun?.id !== runId || state.latestRun.status !== "running") return false;
    state.latestRun.controllerActivationRollingBack = true;
    state.latestRun.error = message;
    state.latestRun.controllerActivationDeadline = Date.now() + (rollbackWaitSeconds + 60) * 1000;
    const nextStatePath = `${statePath}.rollback-${process.pid}`;
    await fs.writeFile(nextStatePath, JSON.stringify(state, null, 2), "utf8");
    await fs.rename(nextStatePath, statePath);
    return true;
  } catch {
    return false;
  }
}

async function readRunState() {
  try {
    const state = JSON.parse(await fs.readFile(statePath, "utf8"));
    return state.latestRun ?? null;
  } catch {
    return null;
  }
}

async function confirmActivation() {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch("http://host-controller:8092/activation/complete", {
        method: "POST",
        signal: AbortSignal.timeout(2000),
        headers: {
          "content-type": "application/json",
          "x-manor-host-controller-token": controllerToken
        },
        body: JSON.stringify({ runId })
      });
      if (response.ok) return true;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  return false;
}

async function activationNoLongerNeedsRollback() {
  const run = await readRunState();
  return Boolean(run && run.id === runId && run.status === "completed");
}

async function reportRollbackStarting(message) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch("http://host-controller:8092/activation/rollback", {
        method: "POST",
        signal: AbortSignal.timeout(2000),
        headers: {
          "content-type": "application/json",
          "x-manor-host-controller-token": controllerToken
        },
        body: JSON.stringify({ runId, error: message })
      });
      if (response.ok) return true;
    } catch {}
    if (await activationNoLongerNeedsRollback()) return false;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return await updateRollbackStarting(message);
}

async function reportFailure(message) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch("http://host-controller:8092/activation/fail", {
        method: "POST",
        signal: AbortSignal.timeout(2000),
        headers: {
          "content-type": "application/json",
          "x-manor-host-controller-token": controllerToken
        },
        body: JSON.stringify({ runId, error: message })
      });
      if (response.ok) return true;
    } catch {}
    if (await activationNoLongerNeedsRollback()) return false;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  await updateFailure(message);
  return !(await activationNoLongerNeedsRollback());
}

async function cleanup() {
  if (cleanupDir) await fs.rm(cleanupDir, { recursive: true, force: true }).catch(() => undefined);
}

function disableRestart() {
  if (helperName) docker(["update", "--restart=no", helperName]);
}

function releaseLifecycleLock() {
  if (!lifecycleLockName) return;
  const details = dockerOutput([
    "network",
    "inspect",
    "--format",
    "{{.Id}}|{{index .Labels \"com.manor.lifecycle-run\"}}",
    lifecycleLockName
  ]);
  const [networkId, owner] = details.split("|");
  if (owner === runId) docker(["network", "rm", networkId]);
}

async function finish(exitCode = 0) {
  disableRestart();
  await cleanup();
  releaseLifecycleLock();
  return exitCode;
}

async function performRollback(rollbackArgs) {
  let message = "The rebuilt host controller did not become healthy; the previous controller image was restored.";
  if (docker(["tag", rollbackImage, "manor-host-controller:local"]) !== 0 || docker(rollbackArgs) !== 0) {
    message = "The rebuilt host controller failed and clean-manifest rollback also failed.";
  }
  await reportFailure(message);
  return await finish(0);
}

async function main() {
  if (!runId || !helperName || !lifecycleLockName || !rollbackImage || !desiredJson || !rollbackJson) {
    throw new Error("Host controller activation helper received incomplete arguments.");
  }

  const desiredArgs = JSON.parse(desiredJson);
  const rollbackArgs = JSON.parse(rollbackJson);
  const initialState = await readRunState();
  if (initialState?.id === runId && initialState.status === "completed") {
    return await finish(0);
  }
  if (!initialState || initialState.id !== runId || initialState.status === "failed" || initialState.controllerActivationRollingBack === true) {
    return await performRollback(rollbackArgs);
  }
  await new Promise((resolve) => setTimeout(resolve, 2000));

  if (docker(desiredArgs) === 0) {
    if (await confirmActivation() || await activationNoLongerNeedsRollback()) {
      return await finish(0);
    }
  }
  if (await activationNoLongerNeedsRollback()) {
    return await finish(0);
  }

  const rollbackMessage = "The rebuilt host controller did not become healthy; rollback to the previous controller is running.";
  if (!await reportRollbackStarting(rollbackMessage) && await activationNoLongerNeedsRollback()) {
    return await finish(0);
  }
  return await performRollback(rollbackArgs);
}

let exitCode = 1;
try {
  exitCode = await main();
} catch (error) {
  try {
    exitCode = await performRollback(JSON.parse(rollbackJson));
  } catch {
    await updateFailure(error instanceof Error ? error.message : String(error));
    exitCode = await finish(1);
  }
}
process.exit(exitCode);
