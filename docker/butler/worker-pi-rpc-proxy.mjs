#!/usr/bin/env node

import net from "node:net";

const socketPath = process.env.WORKER_PI_RPC_SOCKET ?? "/worker-runtime/pi-rpc.sock";
const transportClosedEvent = "manor_transport_closed";
const forwardedEnvKeys = [
  "MANOR_BUTLER_BASE_URL",
  "MANOR_HARNESS_REGISTRY_PATH",
  "MANOR_THREAD_ID",
  "PI_AGENT_DIR",
  "PI_CODING_AGENT_DIR"
];

let buffer = "";
let stdinBuffer = "";
let stdoutBuffer = "";
let connected = false;
let receivedExit = false;
let emittedTransportClosed = false;
let queuedFrameBytes = 0;
const queuedFrames = [];
const pendingRequestIds = new Set();

const socket = net.createConnection(socketPath);
socket.setNoDelay(true);

function writeFrame(frame) {
  if (!socket.destroyed) socket.write(`${JSON.stringify(frame)}\n`);
}

function sendFrame(frame) {
  if (connected) {
    writeFrame(frame);
    return;
  }
  queuedFrameBytes += Buffer.byteLength(JSON.stringify(frame));
  if (queuedFrameBytes > 2 * 1024 * 1024) {
    fail("Worker Pi bridge input exceeded the size limit before connecting.");
    return;
  }
  queuedFrames.push(frame);
}

function forwardedEnv() {
  return Object.fromEntries(
    forwardedEnvKeys.flatMap((key) => process.env[key] ? [[key, process.env[key]]] : [])
  );
}

function rejectPending(message) {
  for (const id of pendingRequestIds) {
    process.stdout.write(`${JSON.stringify({ type: "response", id, success: false, error: message || "Worker Pi bridge failed." })}\n`);
  }
  pendingRequestIds.clear();
}

function emitTransportClosed(message) {
  if (emittedTransportClosed) return;
  emittedTransportClosed = true;
  process.stdout.write(`${JSON.stringify({ type: transportClosedEvent, reason: message || "Worker Pi transport closed." })}\n`);
}

function fail(message) {
  if (message) process.stderr.write(`${message}\n`);
  rejectPending(message);
  emitTransportClosed(message);
  process.exitCode = 1;
  process.stdin.pause();
  socket.destroy();
}

function trackJsonLines(chunk, state, onValue) {
  state.value += chunk.toString("utf8");
  let newline = state.value.indexOf("\n");
  while (newline >= 0) {
    const line = state.value.slice(0, newline);
    state.value = state.value.slice(newline + 1);
    try {
      if (line) onValue(JSON.parse(line));
    } catch { /* Pi owns JSONL validation. */ }
    newline = state.value.indexOf("\n");
  }
}

function handleFrame(line) {
  let frame;
  try {
    frame = JSON.parse(line);
  } catch {
    fail("Worker Pi bridge returned an invalid frame.");
    return;
  }

  if (frame.type === "stdout" && typeof frame.data === "string") {
    const output = Buffer.from(frame.data, "base64");
    const state = { value: stdoutBuffer };
    trackJsonLines(output, state, (value) => {
      if (value?.type === "response" && typeof value.id === "string") pendingRequestIds.delete(value.id);
    });
    stdoutBuffer = state.value;
    process.stdout.write(output);
    return;
  }
  if (frame.type === "stderr" && typeof frame.data === "string") {
    process.stderr.write(Buffer.from(frame.data, "base64"));
    return;
  }
  if (frame.type === "error") {
    fail(typeof frame.message === "string" ? frame.message : "Worker Pi bridge failed.");
    return;
  }
  if (frame.type === "exit") {
    receivedExit = true;
    const message = `Worker Pi process exited${Number.isInteger(frame.code) ? ` with code ${frame.code}` : ""}.`;
    if (pendingRequestIds.size > 0) {
      rejectPending(`Worker Pi process exited before ${pendingRequestIds.size} request(s) completed.`);
    }
    emitTransportClosed(message);
    process.exitCode = Number.isInteger(frame.code) ? frame.code : 1;
    process.stdin.pause();
    socket.end();
  }
}

socket.on("connect", () => {
  connected = true;
  writeFrame({
    type: "start",
    cwd: process.cwd(),
    args: process.argv.slice(2),
    env: forwardedEnv()
  });
  for (const frame of queuedFrames.splice(0)) writeFrame(frame);
  queuedFrameBytes = 0;
});

process.stdin.on("data", (chunk) => {
  const state = { value: stdinBuffer };
  trackJsonLines(chunk, state, (value) => {
    if (typeof value?.id === "string" && value.type !== "extension_ui_response") pendingRequestIds.add(value.id);
  });
  stdinBuffer = state.value;
  sendFrame({ type: "stdin", data: Buffer.from(chunk).toString("base64") });
});
process.stdin.on("end", () => sendFrame({ type: "stdin-end" }));
process.stdin.resume();

socket.on("data", (chunk) => {
  buffer += chunk.toString("utf8");
  if (buffer.length > 2 * 1024 * 1024) {
    fail("Worker Pi bridge frame exceeded the size limit.");
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

socket.on("error", (error) => {
  fail(`Worker Pi bridge is unavailable at ${socketPath}: ${error.message}`);
});

socket.on("close", () => {
  process.stdin.pause();
  if (connected && !receivedExit && process.exitCode !== 1) {
    fail("Worker Pi bridge disconnected before the agent exited.");
  }
});

function forwardSignal(signal) {
  sendFrame({ type: "signal", signal });
  const timer = setTimeout(() => {
    socket.destroy();
    process.exit(0);
  }, 750);
  timer.unref();
}

process.on("SIGTERM", () => forwardSignal("SIGTERM"));
process.on("SIGINT", () => forwardSignal("SIGINT"));
