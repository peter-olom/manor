import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { promisify } from "node:util";

import { providerCredentialsChanged, readButlerAuthStatus } from "../../src/server/auth-status.js";
import { saveChatGptAuth } from "../../../docker/butler/chatgpt-login.mjs";

const execFileAsync = promisify(execFile);
const authScriptPath = fileURLToPath(new URL("../../../docker/butler/auth.sh", import.meta.url));

function expiredOauthAuth() {
  const access = `header.${Buffer.from(JSON.stringify({
    exp: Math.floor(Date.now() / 1000) - 3600,
    "https://api.openai.com/auth": { chatgpt_account_id: "account-1" }
  })).toString("base64url")}.signature`;

  return {
    "openai-codex": {
      type: "oauth",
      access,
      refresh: "refresh-token",
      expires: Date.now() - 3600_000,
      accountId: "account-1"
    }
  };
}

test("expired ChatGPT credentials stay configured so Pi can refresh them on use", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "manor-auth-status-"));
  const authPath = path.join(root, "auth.json");
  const raw = `${JSON.stringify(expiredOauthAuth(), null, 2)}\n`;
  await writeFile(authPath, raw, "utf8");

  const status = await readButlerAuthStatus(authPath);

  assert.deepEqual({ mode: status.mode, loggedIn: status.loggedIn, validationError: status.validationError }, {
    mode: "chatgpt",
    loggedIn: true,
    validationError: null
  });
  assert.equal(await readFile(authPath, "utf8"), raw);
});

test("auth status preserves provider credential availability when OAuth and API keys coexist", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "manor-auth-mixed-"));
  const authPath = path.join(root, "auth.json");
  await writeFile(authPath, JSON.stringify({
    ...expiredOauthAuth(),
    openai: { type: "api_key", key: "api-key-value" }
  }), "utf8");

  const status = await readButlerAuthStatus(authPath);

  assert.equal(status.mode, "chatgpt");
  assert.deepEqual(status.providerCredentials, { openai: true, openaiCodex: true });
});

test("provider credential changes are detected even when the primary auth mode is unchanged", () => {
  const oauth = { mode: "chatgpt" as const, loggedIn: true, validationError: null, lastValidatedAt: 1, providerCredentials: { openai: false, openaiCodex: true } };
  const oauthAndApi = { ...oauth, providerCredentials: { openai: true, openaiCodex: true } };

  assert.equal(providerCredentialsChanged(oauth, oauthAndApi), true);
  assert.equal(providerCredentialsChanged(oauthAndApi, oauth), true);
  assert.equal(providerCredentialsChanged(oauth, { ...oauth }), false);
});

test("ChatGPT status rejects incomplete stored credentials", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "manor-auth-incomplete-"));
  const authPath = path.join(root, "auth.json");
  await writeFile(authPath, JSON.stringify({ "openai-codex": { type: "oauth", access: "invalid" } }), "utf8");

  const status = await readButlerAuthStatus(authPath);

  assert.equal(status.mode, "chatgpt");
  assert.equal(status.loggedIn, false);
  assert.match(status.validationError ?? "", /incomplete/i);
});

test("butler-auth status reports stored ChatGPT auth without rotating it", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "manor-auth-script-"));
  const authPath = path.join(root, "auth.json");
  const raw = `${JSON.stringify(expiredOauthAuth(), null, 2)}\n`;
  await writeFile(authPath, raw, "utf8");

  const result = await execFileAsync("bash", [authScriptPath, "status"], {
    env: { ...process.env, PI_AGENT_DIR: root }
  });

  assert.match(result.stdout, /Logged in to Butler using ChatGPT/);
  assert.equal(await readFile(authPath, "utf8"), raw);
});

test("ChatGPT re-login writes through Pi auth storage without losing other providers", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "manor-auth-login-"));
  const authPath = path.join(root, "auth.json");
  await writeFile(authPath, JSON.stringify({ openai: { type: "api_key", key: "existing-key" } }), "utf8");
  const next = expiredOauthAuth()["openai-codex"];
  const previousAppDir = process.env.BUTLER_APP_DIR;
  process.env.BUTLER_APP_DIR = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));

  try {
    await saveChatGptAuth(authPath, next);
  } finally {
    if (previousAppDir === undefined) delete process.env.BUTLER_APP_DIR;
    else process.env.BUTLER_APP_DIR = previousAppDir;
  }

  const saved = JSON.parse(await readFile(authPath, "utf8")) as Record<string, { type?: string; refresh?: string }>;
  assert.equal(saved.openai?.type, "api_key");
  assert.equal(saved["openai-codex"]?.refresh, "refresh-token");
});

test("auth status revision changes when stored credentials are replaced", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "manor-auth-revision-"));
  const authPath = path.join(root, "auth.json");
  await writeFile(authPath, JSON.stringify(expiredOauthAuth()), "utf8");
  const before = await readButlerAuthStatus(authPath);

  await writeFile(authPath, JSON.stringify({
    "openai-codex": {
      ...expiredOauthAuth()["openai-codex"],
      refresh: "replacement-refresh-token"
    }
  }), "utf8");
  const after = await readButlerAuthStatus(authPath);

  assert.ok(before.credentialRevision);
  assert.ok(after.credentialRevision);
  assert.notEqual(after.credentialRevision, before.credentialRevision);
});

test("butler-auth device pins the installed app directory from any working directory", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "manor-auth-device-"));
  const binDir = path.join(root, "bin");
  const fakeNode = path.join(binDir, "node");
  await mkdir(binDir);
  await writeFile(fakeNode, "#!/bin/sh\nprintf '%s\\n' \"$BUTLER_APP_DIR\"\n", "utf8");
  await chmod(fakeNode, 0o755);

  const result = await execFileAsync("bash", [authScriptPath, "device"], {
    cwd: root,
    env: { ...process.env, PATH: `${binDir}:${process.env.PATH ?? ""}`, PI_AGENT_DIR: root, BUTLER_APP_DIR: "" }
  });

  assert.equal(result.stdout.trim(), "/opt/manor/butler");
});
