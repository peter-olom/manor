import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import net from "node:net";
import test from "node:test";

import { RpcClient } from "@earendil-works/pi-coding-agent";

const bridgePath = new URL("../../../docker/worker/worker-pi-rpc-bridge.mjs", import.meta.url);
const proxyPath = new URL("../../../docker/butler/worker-pi-rpc-proxy.mjs", import.meta.url);

async function waitForSocket(socketPath: string, bridge: ChildProcess, stderr: string[]): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    if (bridge.exitCode !== null) throw new Error(`Bridge exited early: ${stderr.join("")}`);
    try {
      await stat(socketPath);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
  throw new Error(`Timed out waiting for bridge socket: ${stderr.join("")}`);
}

async function waitForPath(targetPath: string): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    try {
      await stat(targetPath);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
  throw new Error(`Timed out waiting for ${targetPath}`);
}

async function stopBridge(bridge: ChildProcess): Promise<void> {
  if (bridge.exitCode !== null) return;
  bridge.kill("SIGTERM");
  await new Promise<void>((resolve) => bridge.once("exit", () => resolve()));
}

async function readBridgeStartError(socketPath: string, frame: Record<string, unknown>): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    let buffer = "";
    socket.on("connect", () => socket.write(`${JSON.stringify(frame)}\n`));
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      const response = JSON.parse(buffer.slice(0, newline)) as { type?: string; message?: string };
      socket.destroy();
      response.type === "error" ? resolve(response.message ?? "") : reject(new Error(`Unexpected bridge frame: ${buffer}`));
    });
    socket.on("error", reject);
  });
}

test("Pi RPC proxy executes the agent behind the Worker bridge", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "manor-worker-pi-bridge-"));
  const reposRoot = path.join(root, "repos");
  const cwd = path.join(reposRoot, "project");
  const sessionRoot = path.join(root, "sessions");
  const extensionRoot = path.join(root, "extensions");
  const socketRoot = await mkdtemp("/tmp/manor-pi-socket-");
  const socketPath = path.join(socketRoot, "bridge.sock");
  const markerPath = path.join(root, "worker-process.txt");
  const workerAgentDir = path.join(root, "agent");
  const fakeCliPath = path.join(root, "fake-pi-cli.mjs");
  await Promise.all([
    mkdir(cwd, { recursive: true }),
    mkdir(sessionRoot, { recursive: true }),
    mkdir(extensionRoot, { recursive: true }),
    mkdir(workerAgentDir, { recursive: true })
  ]);
  await writeFile(fakeCliPath, `
import { appendFileSync } from "node:fs";
appendFileSync(process.env.EXECUTION_MARKER, JSON.stringify({
  pid: process.pid,
  piAgentDir: process.env.PI_CODING_AGENT_DIR,
  nodeUseEnvProxy: process.env.NODE_USE_ENV_PROXY
}) + "\\n");
let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let newline = buffer.indexOf("\\n");
  while (newline >= 0) {
    const line = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 1);
    if (line) {
      const command = JSON.parse(line);
      process.stdout.write(JSON.stringify({ type: "response", id: command.id, success: true, data: { command: command.type } }) + "\\n");
    }
    newline = buffer.indexOf("\\n");
  }
});
`, "utf8");

  const bridgeStderr: string[] = [];
  const bridge = spawn(process.execPath, [bridgePath.pathname], {
    env: {
      ...process.env,
      EXECUTION_MARKER: markerPath,
      NODE_USE_ENV_PROXY: "1",
      PI_CODING_AGENT_DIR: workerAgentDir,
      WORKER_PI_CLI_PATH: fakeCliPath,
      WORKER_PI_EXTENSION_DIR: extensionRoot,
      WORKER_PI_RPC_SOCKET: socketPath,
      WORKER_PI_SESSION_ROOT: sessionRoot,
      WORKER_REPOS_ROOT: reposRoot
    },
    stdio: ["ignore", "ignore", "pipe"]
  });
  bridge.stderr?.on("data", (chunk) => bridgeStderr.push(chunk.toString()));

  try {
    await waitForSocket(socketPath, bridge, bridgeStderr);
    const sessionDir = path.join(sessionRoot, "pi-test");
    const client = new RpcClient({
      cliPath: proxyPath.pathname,
      cwd,
      env: {
        MANOR_THREAD_ID: "pi-test",
        WORKER_PI_RPC_SOCKET: socketPath
      },
      provider: "fake",
      model: "fake",
      args: ["--session-dir", sessionDir]
    });
    await client.start();
    await waitForPath(markerPath);
    const duplicateError = await readBridgeStartError(socketPath, {
      type: "start",
      cwd,
      env: { MANOR_THREAD_ID: "pi-test" },
      args: ["--mode", "rpc", "--provider", "fake", "--model", "fake", "--session-dir", sessionDir]
    });
    assert.match(duplicateError, /thread pi-test is already active/);
    const state = await client.getState() as unknown as { command: string };
    assert.equal(state.command, "get_state");
    await client.setThinkingLevel("high");
    await client.stop();
    const marker = JSON.parse(await readFile(markerPath, "utf8")) as {
      pid: number;
      piAgentDir: string;
      nodeUseEnvProxy: string;
    };
    assert.ok(marker.pid > 0);
    assert.equal(marker.piAgentDir, workerAgentDir);
    assert.equal(marker.nodeUseEnvProxy, "1");
    await stat(sessionDir);
  } finally {
    await stopBridge(bridge);
  }
});

test("idle Worker bridge shutdown emits a transport-close event", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "manor-worker-pi-idle-close-"));
  const reposRoot = path.join(root, "repos");
  const cwd = path.join(reposRoot, "project");
  const sessionRoot = path.join(root, "sessions");
  const extensionRoot = path.join(root, "extensions");
  const socketRoot = await mkdtemp("/tmp/manor-pi-socket-");
  const socketPath = path.join(socketRoot, "bridge.sock");
  const markerPath = path.join(root, "worker-process.txt");
  const fakeCliPath = path.join(root, "fake-pi-cli.mjs");
  await Promise.all([
    mkdir(cwd, { recursive: true }),
    mkdir(sessionRoot, { recursive: true }),
    mkdir(extensionRoot, { recursive: true }),
    writeFile(fakeCliPath, "import { writeFileSync } from 'node:fs'; writeFileSync(process.env.EXECUTION_MARKER, 'ok'); process.stdin.resume();\n", "utf8")
  ]);
  const bridgeStderr: string[] = [];
  const bridge = spawn(process.execPath, [bridgePath.pathname], {
    env: {
      ...process.env,
      EXECUTION_MARKER: markerPath,
      WORKER_PI_CLI_PATH: fakeCliPath,
      WORKER_PI_EXTENSION_DIR: extensionRoot,
      WORKER_PI_RPC_SOCKET: socketPath,
      WORKER_PI_SESSION_ROOT: sessionRoot,
      WORKER_REPOS_ROOT: reposRoot
    },
    stdio: ["ignore", "ignore", "pipe"]
  });
  bridge.stderr?.on("data", (chunk) => bridgeStderr.push(chunk.toString()));
  await waitForSocket(socketPath, bridge, bridgeStderr);
  const client = new RpcClient({
    cliPath: proxyPath.pathname,
    cwd,
    env: { MANOR_THREAD_ID: "pi-idle-close", WORKER_PI_RPC_SOCKET: socketPath },
    provider: "fake",
    model: "fake",
    args: ["--session-dir", path.join(sessionRoot, "pi-idle-close")]
  });
  try {
    await client.start();
    await waitForPath(markerPath);
    const closed = new Promise<{ type: string; reason: string }>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Timed out waiting for transport-close event")), 2_000);
      const unsubscribe = client.onEvent((event) => {
        const value = event as unknown as { type?: string; reason?: string };
        if (value.type !== "manor_transport_closed") return;
        clearTimeout(timer);
        unsubscribe();
        resolve({ type: value.type, reason: value.reason ?? "" });
      });
    });
    await stopBridge(bridge);
    const event = await closed;
    assert.equal(event.type, "manor_transport_closed");
    assert.match(event.reason, /exited|disconnected|closed/i);
  } finally {
    await client.stop();
    await stopBridge(bridge);
  }
});

test("Worker bridge rejects Pi sessions outside the shared repository root", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "manor-worker-pi-bridge-reject-"));
  const reposRoot = path.join(root, "repos");
  const outsideCwd = path.join(root, "outside");
  const sessionRoot = path.join(root, "sessions");
  const extensionRoot = path.join(root, "extensions");
  const socketRoot = await mkdtemp("/tmp/manor-pi-socket-");
  const socketPath = path.join(socketRoot, "bridge.sock");
  const fakeCliPath = path.join(root, "fake-pi-cli.mjs");
  await Promise.all([
    mkdir(reposRoot, { recursive: true }),
    mkdir(outsideCwd, { recursive: true }),
    mkdir(sessionRoot, { recursive: true }),
    mkdir(extensionRoot, { recursive: true }),
    writeFile(fakeCliPath, "setInterval(() => undefined, 1000);\n", "utf8")
  ]);
  const bridgeStderr: string[] = [];
  const bridge = spawn(process.execPath, [bridgePath.pathname], {
    env: {
      ...process.env,
      WORKER_PI_CLI_PATH: fakeCliPath,
      WORKER_PI_EXTENSION_DIR: extensionRoot,
      WORKER_PI_RPC_SOCKET: socketPath,
      WORKER_PI_SESSION_ROOT: sessionRoot,
      WORKER_REPOS_ROOT: reposRoot
    },
    stdio: ["ignore", "ignore", "pipe"]
  });
  bridge.stderr?.on("data", (chunk) => bridgeStderr.push(chunk.toString()));
  try {
    await waitForSocket(socketPath, bridge, bridgeStderr);
    const message = await new Promise<string>((resolve, reject) => {
      const socket = net.createConnection(socketPath);
      let buffer = "";
      socket.on("connect", () => socket.write(`${JSON.stringify({
        type: "start",
        cwd: outsideCwd,
        env: { MANOR_THREAD_ID: "pi-rejected" },
        args: ["--mode", "rpc", "--provider", "fake", "--model", "fake", "--session-dir", path.join(sessionRoot, "pi-rejected")]
      })}\n`));
      socket.on("data", (chunk) => {
        buffer += chunk.toString("utf8");
        const newline = buffer.indexOf("\n");
        if (newline < 0) return;
        const frame = JSON.parse(buffer.slice(0, newline)) as { type?: string; message?: string };
        socket.destroy();
        frame.type === "error" ? resolve(frame.message ?? "") : reject(new Error(`Unexpected bridge frame: ${buffer}`));
      });
      socket.on("error", reject);
    });
    assert.match(message, /working directory must be inside \/repos/);
  } finally {
    await stopBridge(bridge);
  }
});

test("Worker bridge validates workspace writes inside the Worker runtime", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "manor-worker-pi-workspace-check-"));
  const reposRoot = path.join(root, "repos");
  const invalidCwd = path.join(reposRoot, "not-a-directory");
  const sessionRoot = path.join(root, "sessions");
  const extensionRoot = path.join(root, "extensions");
  const socketRoot = await mkdtemp("/tmp/manor-pi-socket-");
  const socketPath = path.join(socketRoot, "bridge.sock");
  const fakeCliPath = path.join(root, "fake-pi-cli.mjs");
  await Promise.all([
    mkdir(reposRoot, { recursive: true }),
    mkdir(sessionRoot, { recursive: true }),
    mkdir(extensionRoot, { recursive: true }),
    writeFile(invalidCwd, "not a workspace", "utf8"),
    writeFile(fakeCliPath, "setInterval(() => undefined, 1000);\n", "utf8")
  ]);
  const bridgeStderr: string[] = [];
  const bridge = spawn(process.execPath, [bridgePath.pathname], {
    env: {
      ...process.env,
      WORKER_PI_CLI_PATH: fakeCliPath,
      WORKER_PI_EXTENSION_DIR: extensionRoot,
      WORKER_PI_RPC_SOCKET: socketPath,
      WORKER_PI_SESSION_ROOT: sessionRoot,
      WORKER_REPOS_ROOT: reposRoot
    },
    stdio: ["ignore", "ignore", "pipe"]
  });
  bridge.stderr?.on("data", (chunk) => bridgeStderr.push(chunk.toString()));
  try {
    await waitForSocket(socketPath, bridge, bridgeStderr);
    const message = await readBridgeStartError(socketPath, {
      type: "start",
      cwd: invalidCwd,
      env: { MANOR_THREAD_ID: "pi-workspace-check" },
      args: ["--mode", "rpc", "--provider", "fake", "--model", "fake", "--session-dir", path.join(sessionRoot, "pi-workspace-check")]
    });
    assert.match(message, /not writable inside the Worker runtime/i);
  } finally {
    await stopBridge(bridge);
  }
});

test("Worker bridge rejects a workspace whose Git object store is not writable", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "manor-worker-pi-git-check-"));
  const reposRoot = path.join(root, "repos");
  const cwd = path.join(reposRoot, "project");
  const sessionRoot = path.join(root, "sessions");
  const extensionRoot = path.join(root, "extensions");
  const binRoot = path.join(root, "bin");
  const socketRoot = await mkdtemp("/tmp/manor-pi-socket-");
  const socketPath = path.join(socketRoot, "bridge.sock");
  const fakeCliPath = path.join(root, "fake-pi-cli.mjs");
  const fakeGitPath = path.join(binRoot, "git");
  const fakeIndexPath = path.join(root, "git-index");
  await Promise.all([mkdir(cwd, { recursive: true }), mkdir(sessionRoot, { recursive: true }), mkdir(extensionRoot, { recursive: true }), mkdir(binRoot, { recursive: true })]);
  await writeFile(fakeCliPath, "setInterval(() => undefined, 1000);\n", "utf8");
  await writeFile(fakeGitPath, `#!/bin/sh
case "$*" in
  *"rev-parse --show-toplevel"*) printf '%s\\n' "${cwd}" ;;
  *"rev-parse --path-format=absolute --git-path index"*) printf '%s\\n' "${fakeIndexPath}" ;;
  *"hash-object -w"*) echo 'object store denied' >&2; exit 1 ;;
  *"status --short"*) exit 0 ;;
  *) exit 1 ;;
esac
`, { mode: 0o755 });
  const bridgeStderr: string[] = [];
  const bridge = spawn(process.execPath, [bridgePath.pathname], {
    env: { ...process.env, PATH: `${binRoot}:${process.env.PATH ?? ""}`, WORKER_PI_CLI_PATH: fakeCliPath, WORKER_PI_EXTENSION_DIR: extensionRoot, WORKER_PI_RPC_SOCKET: socketPath, WORKER_PI_SESSION_ROOT: sessionRoot, WORKER_REPOS_ROOT: reposRoot },
    stdio: ["ignore", "ignore", "pipe"]
  });
  bridge.stderr?.on("data", (chunk) => bridgeStderr.push(chunk.toString()));
  try {
    await waitForSocket(socketPath, bridge, bridgeStderr);
    const message = await readBridgeStartError(socketPath, { type: "start", cwd, env: { MANOR_THREAD_ID: "pi-git-check" }, args: ["--mode", "rpc", "--provider", "fake", "--model", "fake", "--session-dir", path.join(sessionRoot, "pi-git-check")] });
    assert.match(message, /object store denied/i);
  } finally {
    await stopBridge(bridge);
  }
});

test("bridge disconnect rejects pending Pi RPC requests without waiting for the client timeout", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "manor-worker-pi-disconnect-"));
  const reposRoot = path.join(root, "repos");
  const cwd = path.join(reposRoot, "project");
  const sessionRoot = path.join(root, "sessions");
  const extensionRoot = path.join(root, "extensions");
  const socketRoot = await mkdtemp("/tmp/manor-pi-socket-");
  const socketPath = path.join(socketRoot, "bridge.sock");
  const markerPath = path.join(root, "worker-process.txt");
  const fakeCliPath = path.join(root, "fake-pi-cli.mjs");
  await Promise.all([
    mkdir(cwd, { recursive: true }),
    mkdir(sessionRoot, { recursive: true }),
    mkdir(extensionRoot, { recursive: true }),
    writeFile(fakeCliPath, "import { writeFileSync } from 'node:fs'; writeFileSync(process.env.EXECUTION_MARKER, 'ok'); process.stdin.resume();\n", "utf8")
  ]);
  const bridgeStderr: string[] = [];
  const bridge = spawn(process.execPath, [bridgePath.pathname], {
    env: {
      ...process.env,
      EXECUTION_MARKER: markerPath,
      WORKER_PI_CLI_PATH: fakeCliPath,
      WORKER_PI_EXTENSION_DIR: extensionRoot,
      WORKER_PI_RPC_SOCKET: socketPath,
      WORKER_PI_SESSION_ROOT: sessionRoot,
      WORKER_REPOS_ROOT: reposRoot
    },
    stdio: ["ignore", "ignore", "pipe"]
  });
  bridge.stderr?.on("data", (chunk) => bridgeStderr.push(chunk.toString()));
  await waitForSocket(socketPath, bridge, bridgeStderr);
  const client = new RpcClient({
    cliPath: proxyPath.pathname,
    cwd,
    env: { MANOR_THREAD_ID: "pi-disconnect", WORKER_PI_RPC_SOCKET: socketPath },
    provider: "fake",
    model: "fake",
    args: ["--session-dir", path.join(sessionRoot, "pi-disconnect")]
  });
  try {
    await client.start();
    await waitForPath(markerPath);
    const pending = assert.rejects(client.getState(), /bridge disconnected|bridge failed|process exited/i);
    await new Promise((resolve) => setTimeout(resolve, 30));
    await stopBridge(bridge);
    await pending;
  } finally {
    await client.stop();
    await stopBridge(bridge);
  }
});
