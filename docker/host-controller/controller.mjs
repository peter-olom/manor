import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import express from "express";
import {
  normalizeRestartDelayMs,
  normalizeString,
  safeTokenMatch,
  validateRestartModeScope,
  validateRestartPayload
} from "./controller-policy.mjs";

const port = Number(process.env.MANOR_HOST_CONTROLLER_PORT ?? "8092");
const manorDir = path.resolve(process.env.MANOR_HOST_PROJECT_DIR ?? process.cwd());
const stateDir = path.resolve(process.env.MANOR_HOST_CONTROLLER_STATE_DIR ?? "/state");
const statePath = path.join(stateDir, "restart-status.json");
const authToken = process.env.MANOR_HOST_CONTROLLER_TOKEN ?? null;
const defaultDelayMs = normalizeRestartDelayMs(process.env.MANOR_HOST_RESTART_DELAY_MS);
const butlerHealthUrl = process.env.MANOR_HOST_BUTLER_HEALTH_URL ?? "http://butler:8080/livez";
const applianceServices = [
  "egress",
  "preview-egress",
  "codex-box",
  "runtime-broker",
  "playwright",
  "butler",
  "butler-gateway"
];

let latestRun = null;
let activeRun = null;

function now() {
  return Date.now();
}

function truthy(value) {
  return ["1", "true", "yes", "on"].includes(String(value ?? "").trim().toLowerCase());
}

function limitedTail(value, limit = 12_000) {
  if (value.length <= limit) {
    return value;
  }
  return value.slice(value.length - limit);
}

function publicRun(run) {
  if (!run) {
    return null;
  }
  return {
    id: run.id,
    status: run.status,
    mode: run.mode,
    target: run.target,
    gitRef: run.gitRef,
    imageTag: run.imageTag,
    includeDesktop: run.includeDesktop,
    update: run.update,
    startedAt: run.startedAt,
    completedAt: run.completedAt,
    error: run.error,
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
  await fs.writeFile(statePath, JSON.stringify({ latestRun: publicRun(latestRun) }, null, 2), "utf8");
}

async function loadState() {
  try {
    const parsed = JSON.parse(await fs.readFile(statePath, "utf8"));
    latestRun = parsed.latestRun && typeof parsed.latestRun === "object" ? parsed.latestRun : null;
    if (latestRun?.status === "running") {
      latestRun.status = "failed";
      latestRun.completedAt = now();
      latestRun.error = "Host controller stopped before the restart run completed.";
    }
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw error;
    }
  }
}

function readEnvValueFromText(text, key) {
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }
    const index = trimmed.indexOf("=");
    if (index < 0 || trimmed.slice(0, index) !== key) {
      continue;
    }
    return trimmed.slice(index + 1).replace(/^"(.*)"$/, "$1").replace(/^'(.*)'$/, "$1");
  }
  return null;
}

async function readEnvValue(key) {
  if (Object.prototype.hasOwnProperty.call(process.env, key)) {
    return process.env[key] ?? null;
  }
  try {
    return readEnvValueFromText(await fs.readFile(path.join(manorDir, ".env"), "utf8"), key);
  } catch (error) {
    if (error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

async function detectMode(requestedMode) {
  if (requestedMode === "source" || requestedMode === "image") {
    return requestedMode;
  }
  return truthy(await readEnvValue("MANOR_BUILD_FROM_SOURCE")) ? "source" : "image";
}

function composeArgs(mode, includeDesktop) {
  const args = ["compose", "-f", "compose.yml"];
  if (mode === "source") {
    args.push("-f", "compose.build.yml");
  }
  if (includeDesktop) {
    args.push("--profile", "desktop");
  }
  return args;
}

function commandEnv(run) {
  return {
    ...process.env,
    ...(run.imageTag ? { MANOR_IMAGE_TAG: run.imageTag } : {})
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

async function checkCleanGitWorktree(run) {
  const result = await runStep(run, "Check source worktree", "git", ["status", "--porcelain"]);
  if (result.stdout.trim()) {
    throw new Error("Source update refused because the Manor checkout has uncommitted changes.");
  }
}

async function currentBranch(run) {
  const result = await runStep(run, "Read source branch", "git", ["branch", "--show-current"]);
  return result.stdout.trim();
}

async function updateSource(run) {
  const wantsUpdate = run.update || run.gitRef || run.target === "latest";
  if (!wantsUpdate) {
    return;
  }

  await runStep(run, "Verify source checkout", "git", ["rev-parse", "--is-inside-work-tree"]);
  await checkCleanGitWorktree(run);
  if (run.gitRef) {
    await runStep(run, "Fetch source refs", "git", ["fetch", "--all", "--tags", "--prune"]);
    await runStep(run, "Checkout target ref", "git", ["checkout", run.gitRef]);
    return;
  }

  const branch = await currentBranch(run);
  if (!branch) {
    throw new Error("Source update refused because the Manor checkout is detached. Provide a target ref.");
  }
  await runStep(run, "Fetch source branch", "git", ["fetch", "origin", branch]);
  await runStep(run, "Fast-forward source branch", "git", ["merge", "--ff-only", `origin/${branch}`]);
}

async function updateImage(run) {
  const wantsPull = run.update || run.imageTag || run.target === "latest";
  if (!wantsPull) {
    return;
  }
  await runStep(run, "Pull Manor images", "docker", [...composeArgs("image", run.includeDesktop), "pull", ...applianceServices]);
}

async function buildSourceImages(run) {
  if (run.build === false) {
    return;
  }
  await runStep(run, "Build source images", "docker", [...composeArgs("source", run.includeDesktop), "build", ...applianceServices]);
}

async function restartAppliance(run) {
  const services = [...applianceServices];
  if (run.includeDesktop) {
    services.push("desktop-proof");
  }
  await cleanupStaleReplacementContainers(run, services);
  for (const service of services) {
    await runStep(run, `Remove ${service}`, "docker", [...composeArgs(run.mode, run.includeDesktop), "rm", "--stop", "--force", service]);
    await runStep(run, `Start ${service}`, "docker", [...composeArgs(run.mode, run.includeDesktop), "up", "-d", "--no-deps", "--wait", "--wait-timeout", "90", service]);
  }
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
  const deadline = Date.now() + 90_000;
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

async function executeRun(run) {
  activeRun = run;
  latestRun = run;
  await persist();
  try {
    if (run.delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, run.delayMs));
    }
    if (run.mode === "source") {
      await updateSource(run);
      await buildSourceImages(run);
    } else {
      await updateImage(run);
    }
    await restartAppliance(run);
    await waitForButler(run);
    run.status = "completed";
    run.completedAt = now();
  } catch (error) {
    run.status = "failed";
    run.completedAt = now();
    run.error = error instanceof Error ? error.message : String(error);
  } finally {
    activeRun = null;
    await persist();
  }
}

function createRun(payload) {
  return {
    id: crypto.randomUUID(),
    status: "running",
    mode: payload.mode,
    target: payload.target,
    gitRef: payload.gitRef,
    imageTag: payload.imageTag,
    includeDesktop: payload.includeDesktop === true,
    update: payload.update === true || payload.target === "latest" || Boolean(payload.gitRef || payload.imageTag),
    build: payload.build === false ? false : true,
    delayMs: defaultDelayMs,
    startedAt: now(),
    completedAt: null,
    error: null,
    steps: []
  };
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
await persist();

const app = express();
app.use(express.json({ limit: "16kb" }));

app.get("/health", (_request, response) => {
  response.json({ ok: true, active: Boolean(activeRun), latestRun: publicRun(latestRun) });
});

app.get("/status", authorize, async (_request, response) => {
  response.json({
    ok: true,
    active: publicRun(activeRun),
    latestRun: publicRun(latestRun),
    detectedMode: await detectMode("auto")
  });
});

app.post("/restart", authorize, async (request, response) => {
  const body = request.body && typeof request.body === "object" ? request.body : {};
  if (activeRun) {
    response.status(409).json({ error: "A Manor restart is already running.", active: publicRun(activeRun) });
    return;
  }

  const parsed = validateRestartPayload(body);
  if (!parsed.ok) {
    response.status(400).json({ error: parsed.error });
    return;
  }

  const mode = await detectMode(parsed.value.requestedMode);
  const scoped = validateRestartModeScope(parsed.value, mode);
  if (!scoped.ok) {
    response.status(400).json({ error: scoped.error });
    return;
  }

  const run = createRun(scoped.value);
  latestRun = run;
  await persist();
  void executeRun(run);
  response.status(202).json({ ok: true, run: publicRun(run) });
});

app.listen(port, "0.0.0.0", () => {
  console.log(`Manor host controller listening on ${port}`);
});
