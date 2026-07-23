import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { PiRpcWorkerClient } from "../../src/server/pi-rpc-worker-client.js";
import { ButlerStateStore } from "../../src/server/state-store.js";

type SessionMetadataClient = {
  initializeSessionStorage: (client: {
    start: () => Promise<void>;
    getState: () => Promise<never>;
  }, sessionDir: string, metadata: {
    threadId: string;
    cwd: string;
    provider: string;
    model: string;
  }, sessionPath?: string) => Promise<void>;
};

const metadata = {
  threadId: "pi-session-startup",
  cwd: "/repos/project",
  provider: "ollama-cloud",
  model: "glm-5.2"
};

function createClient(root: string, manageSessionDirectories: boolean): SessionMetadataClient {
  return new PiRpcWorkerClient({
    store: new ButlerStateStore(path.join(root, "state.json")),
    piAuthPath: path.join(root, "auth.json"),
    sessionRootDir: path.join(root, "sessions"),
    manageSessionDirectories
  }) as unknown as SessionMetadataClient;
}

test("local Pi startup creates its session directory and commits metadata atomically", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "manor-pi-local-session-startup-"));
  try {
    const sessionDir = path.join(root, "sessions", metadata.threadId);
    let stateCalls = 0;
    await createClient(root, true).initializeSessionStorage({
      start: async () => { await access(sessionDir); },
      getState: async () => { stateCalls += 1; return {} as never; }
    }, sessionDir, metadata);

    assert.equal(stateCalls, 0);
    assert.deepEqual(JSON.parse(await readFile(path.join(sessionDir, "manor-session.json"), "utf8")), metadata);
    assert.deepEqual(await readdir(sessionDir), ["manor-session.json"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("fresh remote Pi startup waits for a Worker RPC round trip before committing metadata", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "manor-pi-remote-session-startup-"));
  try {
    const sessionDir = path.join(root, "sessions", metadata.threadId);
    const order: string[] = [];
    await createClient(root, false).initializeSessionStorage({
      start: async () => {
        order.push("start");
        await assert.rejects(() => access(sessionDir), { code: "ENOENT" });
      },
      getState: async () => {
        order.push("ready");
        await mkdir(sessionDir, { recursive: true });
        return {} as never;
      }
    }, sessionDir, metadata);

    assert.deepEqual(order, ["start", "ready"]);
    assert.deepEqual(JSON.parse(await readFile(path.join(sessionDir, "manor-session.json"), "utf8")), metadata);
    assert.deepEqual(await readdir(sessionDir), ["manor-session.json"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("resumed remote Pi startup keeps the existing session-directory lifecycle", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "manor-pi-remote-session-resume-"));
  try {
    const sessionDir = path.join(root, "sessions", metadata.threadId);
    const sessionPath = path.join(sessionDir, "persisted.jsonl");
    await mkdir(sessionDir, { recursive: true });
    await writeFile(sessionPath, "{}\n", "utf8");
    await writeFile(path.join(sessionDir, "manor-session.json"), JSON.stringify({ ...metadata, model: "old-model" }), "utf8");
    let stateCalls = 0;

    await createClient(root, false).initializeSessionStorage({
      start: async () => undefined,
      getState: async () => { stateCalls += 1; return {} as never; }
    }, sessionDir, metadata, sessionPath);

    assert.equal(stateCalls, 0);
    assert.deepEqual(JSON.parse(await readFile(path.join(sessionDir, "manor-session.json"), "utf8")), metadata);
    assert.deepEqual((await readdir(sessionDir)).sort(), ["manor-session.json", "persisted.jsonl"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("failed remote Pi readiness does not commit partial session metadata", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "manor-pi-remote-session-failure-"));
  try {
    const sessionDir = path.join(root, "sessions", metadata.threadId);
    await assert.rejects(() => createClient(root, false).initializeSessionStorage({
      start: async () => undefined,
      getState: async () => {
        await mkdir(sessionDir, { recursive: true });
        throw new Error("remote worker unavailable");
      }
    }, sessionDir, metadata), /remote worker unavailable/);

    assert.deepEqual(await readdir(sessionDir), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
