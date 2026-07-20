import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";

import { ButlerExecutorClient } from "../../src/server/butler-executor-client.js";
import { createButlerExecutorAdmissionServer, listenOnButlerExecutorAdmissionSocket } from "../../src/server/butler-executor-admission-server.js";
import { admitContentThroughButler } from "../../src/server/content-admission-client.js";
import {
  buildExecutorArgs,
  buildSanitizedEnvironment,
  createButlerExecutorServer,
  createScopedCarContext,
  decodeExecutorRequest
} from "../../../docker/worker/butler-executor.mjs";

type FakeChild = EventEmitter & {
  stdout: PassThrough;
  stderr: PassThrough;
  exitCode: number | null;
  signalCode: string | null;
  kill: () => void;
};

function fakeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.exitCode = null;
  child.signalCode = null;
  child.kill = () => {};
  return child;
}

async function unixPost(socketPath: string, body: Record<string, unknown>): Promise<{ status: number; payload: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const encoded = JSON.stringify(body);
    const request = http.request({
      socketPath,
      path: "/api/harness/action",
      method: "POST",
      headers: { "content-type": "application/json", "content-length": Buffer.byteLength(encoded) }
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      response.on("end", () => resolve({
        status: response.statusCode ?? 500,
        payload: JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>
      }));
    });
    request.on("error", reject);
    request.end(encoded);
  });
}

function exitChild(child: FakeChild, code = 0): void {
  child.stdout.end();
  child.stderr.end();
  child.exitCode = code;
  child.emit("exit", code, null);
}

const TEST_CAPABILITY = { id: "cap-1", threadId: "butler-1", token: "a".repeat(48), cwd: "/scratch" };

async function writeCarState(root: string): Promise<{ harnessRegistryPath: string; contentAdmissionPolicyPath: string }> {
  const registryPath = path.join(root, "harness-capabilities.json");
  const policyPath = path.join(root, "content-admission-policy.json");
  await writeFile(registryPath, JSON.stringify({ capabilities: [TEST_CAPABILITY] }));
  await writeFile(policyPath, JSON.stringify({ mode: "enforce" }));
  return { harnessRegistryPath: registryPath, contentAdmissionPolicyPath: policyPath };
}

test("executor validates requests and runs a non-interactive shell", () => {
  assert.throws(() => decodeExecutorRequest({ type: "exec", id: "bad id", threadId: "butler-1", carCapability: TEST_CAPABILITY, carPolicy: { mode: "enforce" }, script: "date" }), /request ID/);
  assert.throws(() => decodeExecutorRequest({ type: "exec", id: "ok", threadId: "butler-1", carCapability: TEST_CAPABILITY, carPolicy: { mode: "enforce" }, script: "date", timeoutMs: 900_001 }), /timeout/);
  assert.deepEqual(buildExecutorArgs("git status"), ["--noprofile", "--norc", "-c", "git status"]);
});

test("executor environment excludes provider and control-plane credentials", () => {
  const env = buildSanitizedEnvironment({
    PATH: "/secret/bin",
    OPENAI_API_KEY: "secret",
    RUNTIME_BROKER_TOKEN: "secret",
    MANOR_HOST_CONTROLLER_TOKEN: "secret",
    MANOR_BUTLER_BASE_URL: "http://butler:8080",
    MANOR_HARNESS_SOCKET_PATH: "/butler-executor-runtime/admission.sock",
    MANOR_HARNESS_REGISTRY_PATH: "/harness-state/harness-capabilities.json",
    HTTPS_PROXY: "http://proxy.test"
  }, "/scratch", "Africa/Lagos", "butler-1", "/scratch/car.json", "/scratch/policy.json");
  assert.equal(env.HOME, "/scratch/home");
  assert.equal(env.TZ, "Africa/Lagos");
  assert.equal(env.MANOR_THREAD_ID, "butler-1");
  assert.equal(env.HTTPS_PROXY, "http://proxy.test");
  assert.equal(env.MANOR_BUTLER_BASE_URL, undefined);
  assert.equal(env.MANOR_HARNESS_SOCKET_PATH, "/butler-executor-runtime/admission.sock");
  assert.equal(env.MANOR_HARNESS_REGISTRY_PATH, "/scratch/car.json");
  assert.equal(env.MANOR_CONTENT_ADMISSION_POLICY_PATH, "/scratch/policy.json");
  assert.equal("OPENAI_API_KEY" in env, false);
  assert.equal("RUNTIME_BROKER_TOKEN" in env, false);
  assert.equal("MANOR_HOST_CONTROLLER_TOKEN" in env, false);
  assert.doesNotMatch(env.PATH, /secret/);
});

test("executor admission socket exposes only content admission", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "manor-admission-socket-"));
  const socketPath = path.join(root, "admission.sock");
  const calls: string[] = [];
  const server = createButlerExecutorAdmissionServer({
    handleAction: async (input) => {
      calls.push(input.action);
      return { text: "allowed", data: { admission: { content: "", review: null, admitted: true, cached: false, notified: false, unavailable: false } } };
    }
  });
  await listenOnButlerExecutorAdmissionSocket(server, socketPath);
  t.after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  });

  const admitted = await unixPost(socketPath, { token: "token", action: "content.admit", params: { source: "repository" } });
  assert.equal(admitted.status, 200);
  assert.deepEqual(calls, ["content.admit"]);

  const registryPath = path.join(root, "capabilities.json");
  await writeFile(registryPath, JSON.stringify({ capabilities: [{ threadId: "butler-1", token: "token", cwd: root }] }));
  const priorEnv = { registry: process.env.MANOR_HARNESS_REGISTRY_PATH, thread: process.env.MANOR_THREAD_ID, socket: process.env.MANOR_HARNESS_SOCKET_PATH, base: process.env.MANOR_BUTLER_BASE_URL };
  Object.assign(process.env, { MANOR_HARNESS_REGISTRY_PATH: registryPath, MANOR_THREAD_ID: "butler-1", MANOR_HARNESS_SOCKET_PATH: socketPath });
  delete process.env.MANOR_BUTLER_BASE_URL;
  t.after(() => {
    for (const [key, value] of Object.entries({ MANOR_HARNESS_REGISTRY_PATH: priorEnv.registry, MANOR_THREAD_ID: priorEnv.thread, MANOR_HARNESS_SOCKET_PATH: priorEnv.socket, MANOR_BUTLER_BASE_URL: priorEnv.base })) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });
  assert.equal((await admitContentThroughButler("repository", "safe", "test")).admitted, true);
  assert.deepEqual(calls, ["content.admit", "content.admit"]);

  const rejected = await unixPost(socketPath, { token: "token", action: "artifact.list", params: {} });
  assert.equal(rejected.status, 400);
  assert.deepEqual(calls, ["content.admit", "content.admit"]);
});

test("executor exposes only the current thread CAR capability", async (t) => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "manor-butler-car-"));
  t.after(() => rm(temporaryRoot, { recursive: true, force: true }));
  const scoped = createScopedCarContext(TEST_CAPABILITY, { mode: "enforce" }, temporaryRoot, "butler-1");
  const payload = JSON.parse(await readFile(scoped.registryPath, "utf8")) as { capabilities: Array<{ threadId: string; token: string }> };
  assert.deepEqual(payload.capabilities, [TEST_CAPABILITY]);
  assert.doesNotMatch(await readFile(scoped.registryPath, "utf8"), /another-thread/);
  assert.deepEqual(JSON.parse(await readFile(scoped.policyPath, "utf8")), { mode: "enforce" });
  scoped.cleanup();
});

test("socket client receives bounded executor results", async (t) => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "manor-butler-executor-"));
  const scratchRoot = path.join(temporaryRoot, "scratch");
  const socketPath = path.join(temporaryRoot, "executor.sock");
  const carState = await writeCarState(temporaryRoot);
  await mkdir(scratchRoot);
  const resolvedScratchRoot = await realpath(scratchRoot);
  t.after(() => rm(temporaryRoot, { recursive: true, force: true }));

  let spawnOptions: { cwd?: string; env?: NodeJS.ProcessEnv } | null = null;
  const server = createButlerExecutorServer({
    scratchRoot,
    spawnProcess: (_command: string, _args: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv }) => {
      spawnOptions = options;
      const child = fakeChild();
      queueMicrotask(() => {
        child.stdout.write("ready\n");
        exitChild(child);
      });
      return child;
    }
  });
  t.after(() => server.close());
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });

  const result = await new ButlerExecutorClient({ socketPath, ...carState }).execute({ script: "date", threadId: "butler-1", timezone: "UTC", timeoutMs: 2_000 });
  assert.equal(result.stdout, "ready\n");
  assert.equal(result.exitCode, 0);
  assert.equal(spawnOptions?.cwd, resolvedScratchRoot);
  assert.equal(spawnOptions?.env?.HOME, path.join(resolvedScratchRoot, "home"));
});

test("busy requests cannot release another command's serial slot", async (t) => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "manor-butler-serial-"));
  const scratchRoot = path.join(temporaryRoot, "scratch");
  const socketPath = path.join(temporaryRoot, "executor.sock");
  const carState = await writeCarState(temporaryRoot);
  await mkdir(scratchRoot);
  t.after(() => rm(temporaryRoot, { recursive: true, force: true }));
  const children: FakeChild[] = [];
  let notifyStarted: (() => void) | null = null;
  const started = new Promise<void>((resolve) => { notifyStarted = resolve; });
  const server = createButlerExecutorServer({
    scratchRoot,
    spawnProcess: () => {
      const child = fakeChild();
      children.push(child);
      notifyStarted?.();
      if (children.length > 1) queueMicrotask(() => exitChild(child));
      return child;
    }
  });
  t.after(() => server.close());
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  const client = new ButlerExecutorClient({ socketPath, ...carState });
  const first = client.execute({ script: "first", threadId: "butler-1", timeoutMs: 2_000 });
  await started;
  await assert.rejects(() => client.execute({ script: "second", threadId: "butler-1" }), /busy/);
  await assert.rejects(() => client.execute({ script: "third", threadId: "butler-1" }), /busy/);
  assert.equal(children.length, 1);
  exitChild(children[0]);
  await first;
  await client.execute({ script: "fourth", threadId: "butler-1" });
  assert.equal(children.length, 2);
});

test("client rejects an executor error frame", async (t) => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "manor-butler-client-"));
  const socketPath = path.join(temporaryRoot, "executor.sock");
  const carState = await writeCarState(temporaryRoot);
  t.after(() => rm(temporaryRoot, { recursive: true, force: true }));
  const server = net.createServer((socket) => {
    socket.once("data", () => socket.end(`${JSON.stringify({ type: "error", message: "busy" })}\n`));
  });
  t.after(() => server.close());
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  await assert.rejects(() => new ButlerExecutorClient({ socketPath, ...carState }).execute({ script: "date", threadId: "butler-1" }), /busy/);
});
