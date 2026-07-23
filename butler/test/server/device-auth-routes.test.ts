import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import test from "node:test";

import express from "express";

import { authProcessIdentityForPiAgentDir, registerDeviceAuthRoutes } from "../../src/server/device-auth-routes.js";

function jwt(payload: Record<string, unknown>): string {
  return `header.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.signature`;
}

async function waitForFile(filePath: string): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      await stat(filePath);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  throw new Error(`Timed out waiting for ${filePath}`);
}

test("Worker device auth replaces existing credentials in only the Worker Pi auth store", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "manor-device-auth-"));
  const butlerPiAgentDir = path.join(root, "butler");
  const workerPiAgentDir = path.join(root, "worker");
  const loginScript = path.join(root, "login.mjs");
  const access = jwt({
    exp: Math.floor(Date.now() / 1000) + 3600,
    "https://api.openai.com/auth": { chatgpt_account_id: "account-1" }
  });
  await mkdir(workerPiAgentDir, { recursive: true });
  await writeFile(path.join(workerPiAgentDir, "auth.json"), JSON.stringify({
    "openai-codex": { type: "oauth", access: "old-access", refresh: "old-refresh" }
  }), "utf8");
  await writeFile(loginScript, `
    import { mkdir, writeFile } from "node:fs/promises";
    import path from "node:path";
    const agentDir = process.env.PI_AGENT_DIR;
    await mkdir(agentDir, { recursive: true });
    await writeFile(path.join(agentDir, "auth.json"), JSON.stringify({
      "openai-codex": {
        type: "oauth",
        access: ${JSON.stringify(access)},
        refresh: "worker-refresh-token",
        expires: Date.now() + 3600000,
        accountId: "account-1"
      }
    }));
    console.log("https://auth.openai.com/oauth/authorize?state=worker-test");
  `, "utf8");

  const changed: string[] = [];
  const app = express();
  registerDeviceAuthRoutes(app, {
    butlerPiAgentDir,
    workerPiAgentDir,
    authCommand: process.execPath,
    authCommandArgs: [loginScript],
    onAuthChanged: (target) => { changed.push(target); }
  });
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  t.after(() => new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  }));
  const port = (server.address() as AddressInfo).port;

  const loginResponse = await fetch(`http://127.0.0.1:${port}/api/auth/worker/device`, { method: "POST" });
  const login = await loginResponse.json() as { authUrl: string };
  assert.equal(loginResponse.status, 200);
  assert.equal(login.authUrl, "https://auth.openai.com/oauth/authorize?state=worker-test");

  const workerAuthPath = path.join(workerPiAgentDir, "auth.json");
  await waitForFile(workerAuthPath);
  assert.match(await readFile(workerAuthPath, "utf8"), /worker-refresh-token/);
  assert.doesNotMatch(await readFile(workerAuthPath, "utf8"), /old-refresh/);
  await assert.rejects(readFile(path.join(butlerPiAgentDir, "auth.json"), "utf8"), { code: "ENOENT" });

  const statusResponse = await fetch(`http://127.0.0.1:${port}/api/auth/worker/status`);
  const status = await statusResponse.json() as { mode: string; loggedIn: boolean };
  assert.deepEqual({ mode: status.mode, loggedIn: status.loggedIn }, { mode: "chatgpt", loggedIn: true });
  assert.equal((await fetch(`http://127.0.0.1:${port}/api/auth/codex/device`, { method: "POST" })).status, 404);

  for (let attempt = 0; attempt < 50 && changed.length === 0; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.deepEqual(changed, ["worker"]);
});

test("auth process identity follows the Pi agent directory owner when privileged", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "manor-auth-owner-"));
  const agentDir = path.join(root, "agent");
  const identity = await authProcessIdentityForPiAgentDir(agentDir);
  const owner = await stat(agentDir);
  if (typeof process.getuid === "function" && process.getuid() === 0) {
    assert.deepEqual(identity, { uid: owner.uid, gid: owner.gid });
  } else {
    assert.deepEqual(identity, {});
  }
});

test("Butler and Worker device auth cannot compete for the shared callback port", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "manor-device-auth-lock-"));
  const loginScript = path.join(root, "login.mjs");
  await writeFile(loginScript, `
    console.log("https://auth.openai.com/oauth/authorize?state=shared-port-test");
    setTimeout(() => process.exit(0), 500);
  `, "utf8");
  const app = express();
  registerDeviceAuthRoutes(app, {
    butlerPiAgentDir: path.join(root, "butler"),
    workerPiAgentDir: path.join(root, "worker"),
    authCommand: process.execPath,
    authCommandArgs: [loginScript]
  });
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  t.after(() => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  const port = (server.address() as AddressInfo).port;

  assert.equal((await fetch(`http://127.0.0.1:${port}/api/auth/butler/device`, { method: "POST" })).status, 200);
  const workerResponse = await fetch(`http://127.0.0.1:${port}/api/auth/worker/device`, { method: "POST" });
  assert.equal(workerResponse.status, 409);
  assert.match((await workerResponse.json() as { error: string }).error, /active Butler sign-in/);
});

test("remote device auth accepts the final localhost callback through the API", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "manor-device-auth-complete-"));
  const butlerPiAgentDir = path.join(root, "butler");
  const loginScript = path.join(root, "login.mjs");
  const receivedPath = path.join(root, "received.txt");
  await writeFile(loginScript, `
    import { writeFile } from "node:fs/promises";
    import { createInterface } from "node:readline/promises";
    console.log("https://auth.openai.com/oauth/authorize?state=remote-test");
    const input = createInterface({ input: process.stdin, output: process.stdout });
    const callback = await input.question("> ");
    input.close();
    await writeFile(${JSON.stringify(receivedPath)}, callback, "utf8");
  `, "utf8");

  const changed: string[] = [];
  const app = express();
  app.use(express.json());
  registerDeviceAuthRoutes(app, {
    butlerPiAgentDir,
    workerPiAgentDir: path.join(root, "worker"),
    authCommand: process.execPath,
    authCommandArgs: [loginScript],
    authCompletionTimeoutMs: 500,
    onAuthChanged: async (target) => {
      changed.push(target);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  });
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  t.after(() => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  const port = (server.address() as AddressInfo).port;

  const startResponse = await fetch(`http://127.0.0.1:${port}/api/auth/butler/device`, { method: "POST" });
  assert.equal(startResponse.status, 200);
  const callbackUrl = "http://localhost:1455/auth/callback?code=remote-code&state=remote-test";
  const completionResponse = await fetch(`http://127.0.0.1:${port}/api/auth/butler/device/complete`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ authorizationInput: callbackUrl })
  });
  assert.equal(completionResponse.status, 200);
  assert.equal(await readFile(receivedPath, "utf8"), callbackUrl);
  assert.deepEqual(changed, ["butler"]);
});

test("a device auth URL timeout terminates and clears the login process", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "manor-device-auth-timeout-"));
  const loginScript = path.join(root, "login.mjs");
  await writeFile(loginScript, `setInterval(() => {}, 1000);`, "utf8");
  const app = express();
  registerDeviceAuthRoutes(app, {
    butlerPiAgentDir: path.join(root, "butler"),
    workerPiAgentDir: path.join(root, "worker"),
    authCommand: process.execPath,
    authCommandArgs: [loginScript],
    authLoginTimeoutMs: 50
  });
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  t.after(() => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  const port = (server.address() as AddressInfo).port;

  assert.equal((await fetch(`http://127.0.0.1:${port}/api/auth/butler/device`, { method: "POST" })).status, 500);
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal((await fetch(`http://127.0.0.1:${port}/api/auth/worker/device`, { method: "POST" })).status, 500);
});

test("a remote auth completion timeout clears the process so sign-in can restart", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "manor-device-auth-completion-timeout-"));
  const loginScript = path.join(root, "login.mjs");
  await writeFile(loginScript, `
    import { createInterface } from "node:readline/promises";
    console.log("https://auth.openai.com/oauth/authorize?state=timeout-test");
    const input = createInterface({ input: process.stdin, output: process.stdout });
    await input.question("> ");
    await new Promise(() => {});
  `, "utf8");
  const app = express();
  app.use(express.json());
  registerDeviceAuthRoutes(app, {
    butlerPiAgentDir: path.join(root, "butler"),
    workerPiAgentDir: path.join(root, "worker"),
    authCommand: process.execPath,
    authCommandArgs: [loginScript],
    authCompletionTimeoutMs: 25
  });
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  t.after(() => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  const port = (server.address() as AddressInfo).port;

  assert.equal((await fetch(`http://127.0.0.1:${port}/api/auth/butler/device`, { method: "POST" })).status, 200);
  const completion = await fetch(`http://127.0.0.1:${port}/api/auth/butler/device/complete`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ authorizationInput: "http://localhost:1455/auth/callback?code=timeout" })
  });
  assert.equal(completion.status, 500);
  assert.match((await completion.json() as { error: string }).error, /Timed out completing sign-in/);
  assert.equal((await fetch(`http://127.0.0.1:${port}/api/auth/butler/device`, { method: "POST" })).status, 200);
  await fetch(`http://127.0.0.1:${port}/api/auth/butler/device/complete`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ authorizationInput: "cleanup" })
  });
});
