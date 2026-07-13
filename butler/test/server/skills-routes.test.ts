import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import express from "express";

import { registerSkillsRoutes } from "../../src/server/skills-routes.js";
import { SkillsService } from "../../src/server/skills-service.js";

test("skills routes expose capabilities and id-based local mutations", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "manor-skill-routes-"));
  const workspace = path.join(root, "repos");
  const cwd = path.join(workspace, "project");
  await fs.mkdir(cwd, { recursive: true });
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  const service = new SkillsService({
    butlerPiAgentDir: path.join(root, "butler"),
    workerPiAgentDir: path.join(root, "worker"),
    workerCodexHomeDir: path.join(root, "codex"),
    workspaceRoot: workspace
  });
  const app = express();
  app.use(express.json());
  const mutations: string[] = [];
  registerSkillsRoutes(app, service, { onMutation: (environment) => mutations.push(environment) });
  const server = app.listen(0);
  t.after(() => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  const address = server.address() as AddressInfo;
  const url = `http://127.0.0.1:${address.port}`;

  const environmentsResponse = await fetch(`${url}/api/skills/environments`);
  const environments = await environmentsResponse.json() as { environments: Array<{ id: string; capabilities: { packageManagement: boolean } }> };
  assert.deepEqual(environments.environments.map((entry) => entry.id), ["butler-pi", "worker-pi", "worker-codex"]);
  assert.ok(environments.environments.every((entry) => entry.capabilities.packageManagement === false));

  const createResponse = await fetch(`${url}/api/skills`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      environment: "worker-codex",
      cwd,
      name: "route-skill",
      description: "Created through the route",
      instructions: "Follow the route."
    })
  });
  assert.equal(createResponse.status, 201);
  const created = await createResponse.json() as { skill: { id: string; name: string } };

  const listResponse = await fetch(`${url}/api/skills/worker-codex?cwd=${encodeURIComponent(cwd)}`);
  const listed = await listResponse.json() as { skills: Array<Record<string, unknown>> };
  assert.equal(listResponse.status, 200);
  assert.equal(listed.skills[0]?.id, created.skill.id);
  assert.equal("path" in (listed.skills[0] ?? {}), false);

  const readResponse = await fetch(`${url}/api/skills/worker-codex/${created.skill.id}?cwd=${encodeURIComponent(cwd)}`);
  assert.equal(readResponse.status, 200);
  const read = await readResponse.json() as { skill: { content: string } };
  assert.match(read.skill.content, /Follow the route/);

  const deleteResponse = await fetch(`${url}/api/skills/worker-codex/${created.skill.id}`, {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ cwd })
  });
  assert.equal(deleteResponse.status, 204);
  assert.deepEqual(mutations, ["worker-codex", "worker-codex"]);
});

test("every Butler skill mutation schedules a resource reload", async (t) => {
  const mutations: string[] = [];
  const service = {
    create: async () => ({ id: "created" }),
    edit: async () => ({ id: "edited" }),
    delete: async () => undefined,
    importArchive: async () => [{ id: "imported" }]
  };
  const app = express();
  app.use(express.json());
  registerSkillsRoutes(app, service as never, { onMutation: (environment) => mutations.push(environment) });
  const server = app.listen(0);
  t.after(() => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  const address = server.address() as AddressInfo;
  const url = `http://127.0.0.1:${address.port}`;
  const json = { "Content-Type": "application/json" };

  assert.equal((await fetch(`${url}/api/skills`, {
    method: "POST", headers: json, body: JSON.stringify({ environment: "butler-pi", name: "new-skill", description: "New", instructions: "Use it." })
  })).status, 201);
  assert.equal((await fetch(`${url}/api/skills/butler-pi/created`, {
    method: "PUT", headers: json, body: JSON.stringify({ content: "updated" })
  })).status, 200);
  assert.equal((await fetch(`${url}/api/skills/import`, {
    method: "POST", headers: json, body: JSON.stringify({ environment: "butler-pi", archiveBase64: "archive" })
  })).status, 201);
  assert.equal((await fetch(`${url}/api/skills/butler-pi/created`, {
    method: "DELETE", headers: json, body: "{}"
  })).status, 204);

  assert.deepEqual(mutations, ["butler-pi", "butler-pi", "butler-pi", "butler-pi"]);
});
