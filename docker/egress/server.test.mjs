import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createAdminServer, createEgressPolicy, normalizeDomain } from "./server.mjs";

function fixture(t, reload = async () => {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "manor-runtime-egress-"));
  const builtInsPath = path.join(root, "built-ins.txt");
  const statePath = path.join(root, "operator.json");
  const aclPath = path.join(root, "operator.txt");
  const modeAclPath = path.join(root, "content-access.conf");
  fs.writeFileSync(builtInsPath, "github.com\n.github.com\n", "utf8");
  t.after(() => fs.rmSync(root, { force: true, recursive: true }));
  return {
    aclPath,
    statePath, modeAclPath,
    policy: createEgressPolicy({ aclPath, builtInsPath, modeAclPath, reload, statePath })
  };
}

test("normalizes exact and apex-plus-subdomain rules", () => {
  assert.equal(normalizeDomain(" API.Asiri.Dev "), "api.asiri.dev");
  assert.equal(normalizeDomain(".Asiri.Dev"), ".asiri.dev");
});

test("rejects non-hostname and internal runtime targets", () => {
  for (const domain of [
    "https://asiri.dev",
    "asiri.dev/path",
    "asiri.dev:443",
    "*.asiri.dev",
    "127.0.0.1",
    "::1",
    "localhost",
    "butler",
    "host.docker.internal",
    "bad_label.asiri.dev",
    "-bad.asiri.dev"
  ]) {
    assert.throws(() => normalizeDomain(domain), undefined, domain);
  }
});

test("persists operator domains while built-ins remain immutable", async (t) => {
  let reloads = 0;
  const files = fixture(t, async () => { reloads += 1; });

  const added = await files.policy.add(".asiri.dev");
  assert.equal(added.created, true);
  assert.equal(reloads, 1);
  assert.match(fs.readFileSync(files.aclPath, "utf8"), /^\.asiri\.dev\n$/);
  assert.match(fs.readFileSync(files.modeAclPath, "utf8"), /allow all/);
  assert.deepEqual(JSON.parse(fs.readFileSync(files.statePath, "utf8")).domains, [".asiri.dev"]);
  assert.equal((await files.policy.add(".asiri.dev")).created, false);
  assert.equal(reloads, 1);
  await assert.rejects(files.policy.remove("github.com"), /cannot be removed/i);

  const restarted = createEgressPolicy({
    aclPath: files.aclPath,
    builtInsPath: path.join(path.dirname(files.statePath), "built-ins.txt"),
    reload: async () => {},
    statePath: files.statePath
  });
  assert.equal(restarted.list().some((entry) => entry.domain === ".asiri.dev" && entry.source === "operator"), true);
  await restarted.remove(".asiri.dev");
  assert.equal(fs.readFileSync(files.aclPath, "utf8"), "");
});

test("internet is the default and restricted mode removes the allow-all rule", async (t) => {
  const files = fixture(t);
  assert.equal(files.policy.view().mode, "internet");
  await files.policy.setMode("restricted");
  assert.equal(files.policy.view().mode, "restricted");
  assert.doesNotMatch(fs.readFileSync(files.modeAclPath, "utf8"), /allow all/);
  assert.equal(JSON.parse(fs.readFileSync(files.statePath, "utf8")).mode, "restricted");
});

test("migrates the previous allowlist state without opening Internet access", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "manor-runtime-egress-v1-"));
  const builtInsPath = path.join(root, "built-ins.txt");
  const statePath = path.join(root, "operator.json");
  const aclPath = path.join(root, "operator.txt");
  const modeAclPath = path.join(root, "content-access.conf");
  fs.writeFileSync(builtInsPath, "github.com\n", "utf8");
  fs.writeFileSync(statePath, JSON.stringify({ version: 1, domains: ["example.com"] }), "utf8");
  t.after(() => fs.rmSync(root, { force: true, recursive: true }));
  const policy = createEgressPolicy({ aclPath, builtInsPath, modeAclPath, reload: async () => {}, statePath });
  assert.equal(policy.view().mode, "restricted");
  assert.doesNotMatch(fs.readFileSync(modeAclPath, "utf8"), /allow all/);
  assert.deepEqual(JSON.parse(fs.readFileSync(statePath, "utf8")), { version: 2, mode: "restricted", domains: ["example.com"] });
});

test("restores the previous persisted policy when Squid reload fails", async (t) => {
  const files = fixture(t, async () => { throw new Error("reload failed"); });
  await assert.rejects(files.policy.add("asiri.dev"), /reload failed/);
  assert.deepEqual(JSON.parse(fs.readFileSync(files.statePath, "utf8")).domains, []);
  assert.equal(fs.readFileSync(files.aclPath, "utf8"), "");
  assert.equal(files.policy.list().some((entry) => entry.domain === "asiri.dev"), false);
});

test("admin API requires its bearer token and returns the updated list", async (t) => {
  const { policy } = fixture(t);
  const server = createAdminServer({ policy, token: "secret" });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;

  assert.equal((await fetch(`${baseUrl}/domains`)).status, 401);
  const headers = { authorization: "Bearer secret", "content-type": "application/json" };
  const restricted = await fetch(`${baseUrl}/mode`, { method: "PUT", headers, body: JSON.stringify({ mode: "restricted" }) });
  assert.equal((await restricted.json()).mode, "restricted");
  const added = await fetch(`${baseUrl}/domains`, { method: "POST", headers, body: JSON.stringify({ domain: "asiri.dev" }) });
  assert.equal(added.status, 201);
  assert.equal((await added.json()).domains.some((entry) => entry.domain === "asiri.dev"), true);

  const removed = await fetch(`${baseUrl}/domains/${encodeURIComponent("asiri.dev")}`, { method: "DELETE", headers });
  assert.equal(removed.status, 200);
  assert.equal((await removed.json()).domains.some((entry) => entry.domain === "asiri.dev"), false);
});
