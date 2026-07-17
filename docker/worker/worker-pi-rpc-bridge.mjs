#!/usr/bin/env node

import { spawn } from "node:child_process";
import { chmodSync, mkdirSync, realpathSync, rmSync } from "node:fs";
import net from "node:net";
import path from "node:path";

const socketPath = process.env.WORKER_PI_RPC_SOCKET ?? "/worker-runtime/pi-rpc.sock";
const cliPath = process.env.WORKER_PI_CLI_PATH ?? "/opt/manor/worker/node_modules/@earendil-works/pi-coding-agent/dist/cli.js";
const reposRoot = realpathSync(process.env.WORKER_REPOS_ROOT ?? "/repos");
const sessionRoot = path.resolve(process.env.WORKER_PI_SESSION_ROOT ?? "/worker-pi/sessions");
const extensionRoot = path.resolve(process.env.WORKER_PI_EXTENSION_DIR ?? "/opt/manor/worker/dist/server");
const allowedExtensions = new Set(["pi-manor-tools-extension.js", "pi-ollama-web-tools-extension.js", "pi-opencode-web-tools-extension.js"]);
const allowedSignals = new Set(["SIGINT", "SIGKILL", "SIGTERM"]);
const children = new Set();
const activeThreads = new Map();

mkdirSync(path.dirname(socketPath), { recursive: true });
mkdirSync(sessionRoot, { recursive: true });
rmSync(socketPath, { force: true });

function isWithinRoot(candidate, root) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function sendFrame(socket, frame) {
  if (!socket.destroyed) socket.write(`${JSON.stringify(frame)}\n`);
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

function decodeStart(frame) {
  if (!frame || frame.type !== "start") throw new Error("Worker Pi bridge expected a start frame.");
  if (!Array.isArray(frame.args) || frame.args.some((arg) => typeof arg !== "string") || frame.args.length > 128) {
    throw new Error("Worker Pi bridge received invalid CLI arguments.");
  }
  if (frame.args[0] !== "--mode" || frame.args[1] !== "rpc") {
    throw new Error("Worker Pi bridge only accepts Pi RPC mode.");
  }
  if (typeof frame.cwd !== "string") throw new Error("Worker Pi bridge requires a working directory.");
  const cwd = realpathSync(frame.cwd);
  if (!isWithinRoot(cwd, reposRoot)) throw new Error("Worker Pi bridge working directory must be inside /repos.");
  const sessionDirIndex = frame.args.indexOf("--session-dir");
  const sessionDir = sessionDirIndex >= 0 ? path.resolve(frame.args[sessionDirIndex + 1] ?? "") : null;
  if (!sessionDir || !isWithinRoot(sessionDir, sessionRoot)) {
    throw new Error("Worker Pi bridge session directory must be inside the Worker session root.");
  }
  mkdirSync(sessionDir, { recursive: true });
  const resumeIndex = frame.args.indexOf("--session");
  if (resumeIndex >= 0) {
    const sessionPath = path.resolve(frame.args[resumeIndex + 1] ?? "");
    if (!isWithinRoot(sessionPath, sessionRoot)) throw new Error("Worker Pi bridge session path must be inside the Worker session root.");
  }
  for (let index = 0; index < frame.args.length; index += 1) {
    if (frame.args[index] !== "--extension") continue;
    const extension = path.resolve(frame.args[index + 1] ?? "");
    if (!isWithinRoot(extension, extensionRoot) || !allowedExtensions.has(path.basename(extension))) {
      throw new Error("Worker Pi bridge received an unsupported extension.");
    }
  }
  const threadId = frame.env && typeof frame.env === "object" && !Array.isArray(frame.env)
    ? frame.env.MANOR_THREAD_ID
    : null;
  if (typeof threadId !== "string" || !/^pi-[a-zA-Z0-9-]+$/.test(threadId)) {
    throw new Error("Worker Pi bridge requires a valid Pi Worker thread ID.");
  }
  const piAgentDir = process.env.PI_CODING_AGENT_DIR ?? process.env.PI_AGENT_DIR ?? "/worker-pi/agent";
  return {
    args: frame.args,
    cwd,
    threadId,
    env: {
      MANOR_THREAD_ID: threadId,
      PI_AGENT_DIR: piAgentDir,
      PI_CODING_AGENT_DIR: piAgentDir
    }
  };
}

const server = net.createServer((socket) => {
  socket.setNoDelay(true);
  let buffer = "";
  let child = null;
  let sentExit = false;
  let killTimer = null;

  function stopChild(signal = "SIGTERM") {
    signalProcessGroup(child, signal);
    if (signal !== "SIGKILL" && child && !killTimer) {
      killTimer = setTimeout(() => signalProcessGroup(child, "SIGKILL"), 1000);
      killTimer.unref();
    }
  }

  function startChild(frame) {
    const request = decodeStart(frame);
    if (activeThreads.has(request.threadId)) {
      throw new Error(`Worker Pi thread ${request.threadId} is already active.`);
    }
    child = spawn(process.execPath, [cliPath, ...request.args], {
      cwd: request.cwd,
      detached: process.platform !== "win32",
      env: { ...process.env, ...request.env },
      stdio: ["pipe", "pipe", "pipe"]
    });
    children.add(child);
    activeThreads.set(request.threadId, child);
    const releaseChild = () => {
      children.delete(child);
      if (activeThreads.get(request.threadId) === child) activeThreads.delete(request.threadId);
    };
    child.stdout.on("data", (chunk) => sendFrame(socket, { type: "stdout", data: Buffer.from(chunk).toString("base64") }));
    child.stderr.on("data", (chunk) => sendFrame(socket, { type: "stderr", data: Buffer.from(chunk).toString("base64") }));
    child.on("error", (error) => {
      releaseChild();
      sendFrame(socket, { type: "error", message: error.message });
      socket.end();
    });
    child.on("exit", (code, signal) => {
      if (killTimer) clearTimeout(killTimer);
      releaseChild();
      if (!sentExit) {
        sentExit = true;
        sendFrame(socket, { type: "exit", code: code ?? (signal ? 1 : 0), signal });
      }
      socket.end();
    });
  }

  function handleFrame(line) {
    let frame;
    try {
      frame = JSON.parse(line);
      if (!child) {
        startChild(frame);
        return;
      }
      if (frame.type === "stdin" && typeof frame.data === "string") {
        child.stdin.write(Buffer.from(frame.data, "base64"));
      } else if (frame.type === "stdin-end") {
        child.stdin.end();
      } else if (frame.type === "signal" && allowedSignals.has(frame.signal)) {
        stopChild(frame.signal);
      }
    } catch (error) {
      sendFrame(socket, { type: "error", message: error instanceof Error ? error.message : String(error) });
      stopChild();
      socket.end();
    }
  }

  socket.on("data", (chunk) => {
    buffer += chunk.toString("utf8");
    if (buffer.length > 2 * 1024 * 1024) {
      sendFrame(socket, { type: "error", message: "Worker Pi bridge frame exceeded the size limit." });
      stopChild();
      socket.destroy();
      return;
    }
    let newline = buffer.indexOf("\n");
    while (newline >= 0) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (line) handleFrame(line);
      newline = buffer.indexOf("\n");
    }
  });
  socket.on("error", () => stopChild());
  socket.on("close", () => stopChild());
});

server.listen(socketPath, () => {
  chmodSync(socketPath, 0o660);
});

function shutdown() {
  for (const child of children) signalProcessGroup(child, "SIGTERM");
  server.close(() => {
    rmSync(socketPath, { force: true });
    process.exit(0);
  });
  const timer = setTimeout(() => {
    for (const child of children) signalProcessGroup(child, "SIGKILL");
    process.exit(1);
  }, 1000);
  timer.unref();
}

server.on("error", (error) => {
  process.stderr.write(`Worker Pi bridge failed: ${error.message}\n`);
  process.exit(1);
});
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
