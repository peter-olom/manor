#!/usr/bin/env node

import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const DEFAULT_SOCKET_PATH = "/butler-executor-runtime/executor.sock";
export const DEFAULT_SCRATCH_ROOT = "/scratch";
export const DEFAULT_TIMEOUT_MS = 120_000;
export const MAX_TIMEOUT_MS = 900_000;
export const MAX_SCRIPT_BYTES = 32 * 1024;
export const DEFAULT_OUTPUT_BYTES = 32 * 1024;
export const MAX_OUTPUT_BYTES = 64 * 1024;
export const MAX_REQUEST_BYTES = 48 * 1024;

const SAFE_ENV_KEYS = [
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "all_proxy",
  "no_proxy",
  "NODE_USE_ENV_PROXY",
  "MANOR_HARNESS_SOCKET_PATH",
  "SSL_CERT_DIR",
  "SSL_CERT_FILE"
];

function boundedInteger(value, fallback, minimum, maximum) {
  return Number.isInteger(value) && value >= minimum && value <= maximum ? value : fallback;
}

function validTimezone(value) {
  if (typeof value !== "string" || value.length === 0 || value.length > 128) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format();
    return true;
  } catch {
    return false;
  }
}

export function decodeExecutorRequest(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || value.type !== "exec") {
    throw new Error("Butler executor expected an exec request.");
  }
  if (typeof value.id !== "string" || !/^[a-zA-Z0-9-]{1,128}$/.test(value.id)) {
    throw new Error("Butler executor requires a valid request ID.");
  }
  if (typeof value.threadId !== "string" || !/^[a-zA-Z0-9._:-]{1,128}$/.test(value.threadId)) {
    throw new Error("Butler executor requires a valid thread ID.");
  }
  if (
    !value.carCapability
    || typeof value.carCapability !== "object"
    || value.carCapability.threadId !== value.threadId
    || typeof value.carCapability.token !== "string"
    || !/^[a-f0-9]{32,128}$/i.test(value.carCapability.token)
  ) {
    throw new Error("Butler executor requires a thread-bound CAR capability.");
  }
  if (!value.carPolicy || typeof value.carPolicy !== "object" || !["review", "enforce", "off"].includes(value.carPolicy.mode)) {
    throw new Error("Butler executor requires a valid CAR policy.");
  }
  if (typeof value.script !== "string" || value.script.trim().length === 0 || Buffer.byteLength(value.script) > MAX_SCRIPT_BYTES) {
    throw new Error("Butler executor received an invalid or oversized script.");
  }
  if (value.timeoutMs !== undefined && (!Number.isInteger(value.timeoutMs) || value.timeoutMs < 1_000 || value.timeoutMs > MAX_TIMEOUT_MS)) {
    throw new Error(`Butler executor timeout must be between 1000 and ${MAX_TIMEOUT_MS} milliseconds.`);
  }
  if (value.timezone !== undefined && !validTimezone(value.timezone)) {
    throw new Error("Butler executor received an invalid timezone.");
  }
  return {
    id: value.id,
    threadId: value.threadId,
    carCapability: value.carCapability,
    carPolicy: { mode: value.carPolicy.mode },
    script: value.script,
    timeoutMs: value.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    timezone: value.timezone ?? "UTC"
  };
}

export function buildSanitizedEnvironment(source, scratchRoot, timezone, threadId, carRegistryPath, carPolicyPath) {
  const env = {
    HOME: path.join(scratchRoot, "home"),
    XDG_CACHE_HOME: path.join(scratchRoot, "home/.cache"),
    XDG_CONFIG_HOME: path.join(scratchRoot, "home/.config"),
    XDG_DATA_HOME: path.join(scratchRoot, "home/.local/share"),
    TMPDIR: "/tmp",
    PATH: `/usr/local/bin:${path.join(scratchRoot, "home/.local/bin")}:/opt/manor/npm-global/bin:/usr/bin:/bin`,
    LANG: source.LANG || "C.UTF-8",
    LC_ALL: source.LC_ALL || "C.UTF-8",
    TERM: source.TERM || "xterm-256color",
    TZ: timezone,
    MANOR_THREAD_ID: threadId,
    MANOR_HARNESS_REGISTRY_PATH: carRegistryPath,
    MANOR_CONTENT_ADMISSION_POLICY_PATH: carPolicyPath,
    GIT_TERMINAL_PROMPT: "0"
  };
  for (const key of SAFE_ENV_KEYS) {
    if (typeof source[key] === "string" && source[key]) env[key] = source[key];
  }
  return env;
}

export function createScopedCarContext(capability, policy, scratchRoot, threadId) {
  if (!capability || capability.threadId !== threadId) throw new Error(`Butler executor CAR capability is unavailable for ${threadId}.`);
  const registryRoot = path.join(scratchRoot, ".manor-car");
  mkdirSync(registryRoot, { recursive: true, mode: 0o700 });
  const requestRoot = mkdtempSync(path.join(registryRoot, "request-"));
  const registryPath = path.join(requestRoot, "harness-capabilities.json");
  const policyPath = path.join(requestRoot, "content-admission-policy.json");
  writeFileSync(registryPath, `${JSON.stringify({ capabilities: [capability] })}\n`, { mode: 0o600 });
  writeFileSync(policyPath, `${JSON.stringify({ mode: policy.mode })}\n`, { mode: 0o600 });
  return {
    registryPath,
    policyPath,
    cleanup: () => {
      try {
        rmSync(requestRoot, { recursive: true, force: true });
      } catch {
        // Best-effort cleanup; the next request uses a fresh random directory.
      }
    }
  };
}

export function buildExecutorArgs(script) {
  return ["--noprofile", "--norc", "-c", script];
}

export function assertReadOnlyDirectory(directory) {
  if (!existsSync(directory)) throw new Error(`Required read-only directory is unavailable: ${directory}`);
  const probe = path.join(directory, `.manor-butler-executor-write-check-${process.pid}-${Date.now()}`);
  try {
    writeFileSync(probe, "boundary-check", { flag: "wx", mode: 0o600 });
    rmSync(probe, { force: true });
  } catch (error) {
    if (error && typeof error === "object" && ["EACCES", "EPERM", "EROFS"].includes(error.code)) return;
    throw error;
  }
  throw new Error(`Butler executor requires ${directory} to be mounted read-only.`);
}

function signalProcessGroup(child, signal) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  try {
    if (process.platform !== "win32" && child.pid) process.kill(-child.pid, signal);
    else child.kill(signal);
  } catch {
    child.kill(signal);
  }
}

function killRemainingProcessGroup(child) {
  if (process.platform === "win32" || !child?.pid) return;
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    // The group is already gone.
  }
}

function sendFrame(socket, frame) {
  if (!socket.destroyed) socket.write(`${JSON.stringify(frame)}\n`);
}

export function createButlerExecutorServer(options = {}) {
  const scratchRoot = realpathSync(options.scratchRoot ?? DEFAULT_SCRATCH_ROOT);
  const outputLimit = boundedInteger(options.maxOutputBytes, DEFAULT_OUTPUT_BYTES, 1_024, MAX_OUTPUT_BYTES);
  const spawnProcess = options.spawnProcess ?? spawn;
  const prepareCarContext = options.createCarContext ?? createScopedCarContext;
  let active = false;

  return net.createServer((socket) => {
    socket.setNoDelay(true);
    let buffer = "";
    let child = null;
    let finished = false;
    let ownsActiveSlot = false;
    let timeout = null;
    let killTimer = null;
    let carContext = null;

    const stop = (signal = "SIGTERM") => {
      signalProcessGroup(child, signal);
      if (signal !== "SIGKILL" && child && !killTimer) {
        killTimer = setTimeout(() => signalProcessGroup(child, "SIGKILL"), 750);
        killTimer.unref();
      }
    };

    const fail = (message) => {
      if (finished) return;
      finished = true;
      if (timeout) clearTimeout(timeout);
      if (killTimer) clearTimeout(killTimer);
      carContext?.cleanup();
      carContext = null;
      if (ownsActiveSlot) active = false;
      sendFrame(socket, { type: "error", message });
      socket.end();
    };

    const execute = (rawRequest) => {
      if (active) throw new Error("Butler executor is busy.");
      const request = decodeExecutorRequest(rawRequest);
      active = true;
      ownsActiveSlot = true;
      let usedBytes = 0;
      const stdoutChunks = [];
      const stderrChunks = [];
      let truncated = false;
      let timedOut = false;

      const capture = (stream, chunk) => {
        const bytes = Buffer.from(chunk);
        const remaining = Math.max(0, outputLimit - usedBytes);
        const accepted = bytes.subarray(0, remaining);
        usedBytes += accepted.length;
        if (accepted.length < bytes.length) truncated = true;
        if (stream === "stdout") stdoutChunks.push(accepted);
        else stderrChunks.push(accepted);
      };

      carContext = prepareCarContext(request.carCapability, request.carPolicy, scratchRoot, request.threadId);
      child = spawnProcess("/bin/bash", buildExecutorArgs(request.script), {
        cwd: scratchRoot,
        detached: process.platform !== "win32",
        env: buildSanitizedEnvironment(process.env, scratchRoot, request.timezone, request.threadId, carContext.registryPath, carContext.policyPath),
        stdio: ["ignore", "pipe", "pipe"]
      });
      child.stdout.on("data", (chunk) => capture("stdout", chunk));
      child.stderr.on("data", (chunk) => capture("stderr", chunk));
      child.once("error", (error) => fail(error.message));
      child.once("exit", (code, signal) => {
        if (finished) return;
        finished = true;
        if (timeout) clearTimeout(timeout);
        if (killTimer) clearTimeout(killTimer);
        killRemainingProcessGroup(child);
        carContext?.cleanup();
        carContext = null;
        if (ownsActiveSlot) active = false;
        sendFrame(socket, {
          type: "result",
          id: request.id,
          stdout: Buffer.concat(stdoutChunks).toString("utf8"),
          stderr: Buffer.concat(stderrChunks).toString("utf8"),
          exitCode: code ?? (signal ? 1 : 0),
          signal,
          timedOut,
          truncated
        });
        socket.end();
      });
      timeout = setTimeout(() => {
        timedOut = true;
        stop();
      }, request.timeoutMs);
      timeout.unref();
    };

    socket.on("data", (chunk) => {
      if (finished || child) return;
      buffer += chunk.toString("utf8");
      if (Buffer.byteLength(buffer) > MAX_REQUEST_BYTES) {
        fail("Butler executor request exceeded the size limit.");
        return;
      }
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      const line = buffer.slice(0, newline);
      buffer = "";
      try {
        execute(JSON.parse(line));
      } catch (error) {
        fail(error instanceof Error ? error.message : String(error));
      }
    });
    socket.on("error", () => stop());
    socket.on("close", () => {
      if (!finished) stop();
    });
  });
}

async function main() {
  if (process.getuid?.() === 0) throw new Error("Butler executor must run as a non-root user.");
  const socketPath = process.env.MANOR_BUTLER_EXECUTOR_SOCKET ?? DEFAULT_SOCKET_PATH;
  const scratchRoot = process.env.BUTLER_EXECUTOR_SCRATCH_ROOT ?? DEFAULT_SCRATCH_ROOT;
  mkdirSync(path.join(scratchRoot, "home"), { recursive: true });
  const scratchProbe = path.join(scratchRoot, `.write-check-${process.pid}`);
  writeFileSync(scratchProbe, "ok", { flag: "wx", mode: 0o600 });
  rmSync(scratchProbe, { force: true });
  assertReadOnlyDirectory("/repos");
  assertReadOnlyDirectory("/skills");
  mkdirSync(path.dirname(socketPath), { recursive: true });
  rmSync(socketPath, { force: true });

  const server = createButlerExecutorServer({
    scratchRoot,
    maxOutputBytes: Number.parseInt(process.env.BUTLER_EXECUTOR_MAX_OUTPUT_BYTES ?? "", 10)
  });
  server.listen(socketPath, () => chmodSync(socketPath, 0o660));

  const shutdown = () => {
    server.close(() => {
      rmSync(socketPath, { force: true });
      process.exit(0);
    });
  };
  server.on("error", (error) => {
    process.stderr.write(`Butler executor failed: ${error.message}\n`);
    process.exit(1);
  });
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main().catch((error) => {
    process.stderr.write(`Butler executor failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}
