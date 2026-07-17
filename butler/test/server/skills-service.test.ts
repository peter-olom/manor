import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import JSZip from "jszip";

import { SkillsService, type SkillEnvironmentId } from "../../src/server/skills-service.js";

async function writeSkill(root: string, name: string, description = `${name} description`): Promise<string> {
  const directory = path.join(root, name);
  await fs.mkdir(directory, { recursive: true });
  const filePath = path.join(directory, "SKILL.md");
  await fs.writeFile(filePath, `---\nname: ${name}\ndescription: "${description}"\n---\n\nUse ${name}.\n`);
  return filePath;
}

async function fixture(t: test.TestContext) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "manor-skills-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const workspace = path.join(root, "repos");
  const cwd = path.join(workspace, "project");
  const butlerPi = path.join(root, "butler-pi", "agent");
  const workerPi = path.join(root, "worker-pi", "agent");
  await fs.mkdir(cwd, { recursive: true });
  const service = new SkillsService({
    butlerPiAgentDir: butlerPi,
    workerPiAgentDir: workerPi,
    workspaceRoot: workspace
  });
  return { root, workspace, cwd, butlerPi, workerPi, service };
}

test("normalizes Butler and Worker Pi skill catalogs", async (t) => {
  const setup = await fixture(t);
  await writeSkill(path.join(setup.butlerPi, "skills"), "butler-local");
  await writeSkill(path.join(setup.cwd, ".pi", "skills"), "worker-project");
  await writeSkill(path.join(setup.workspace, ".agents", "skills"), "shared-project");
  await writeSkill(path.join(setup.workerPi, "npm", "node_modules", "vendor", "skills"), "worker-package");

  const butler = await setup.service.list("butler-pi", setup.cwd);
  const workerPi = await setup.service.list("worker-pi", setup.cwd);

  assert.deepEqual(butler.map((skill) => skill.name), ["butler-local", "shared-project", "worker-project"]);
  assert.equal(butler[0]?.invocation, "/skill:butler-local");
  assert.deepEqual(workerPi.map((skill) => skill.name), ["shared-project", "worker-package", "worker-project"]);
  assert.equal(workerPi.find((skill) => skill.name === "worker-package")?.mutable, false);
  assert.match(workerPi[0]?.id ?? "", /^skill_[A-Za-z0-9_-]{24}$/);
});

test("creates, reads, edits, resolves, and deletes a local skill by server id", async (t) => {
  const setup = await fixture(t);
  const created = await setup.service.create({
    environment: "worker-pi",
    name: "release-check",
    description: "Run release checks safely",
    instructions: "Run the focused checks and report failures.",
    cwd: setup.cwd
  });

  assert.equal(created.origin, "local");
  assert.equal(created.mutable, true);
  const read = await setup.service.read("worker-pi", created.id, setup.cwd);
  assert.match(read.content, /Run the focused checks/);
  const inputItem = await setup.service.resolveInputItem("worker-pi", created.id, setup.cwd);
  assert.deepEqual(inputItem.type, "skill");
  assert.equal(inputItem.name, "release-check");
  assert.equal(path.basename(inputItem.path), "SKILL.md");

  const edited = await setup.service.edit({
    environment: "worker-pi",
    id: created.id,
    cwd: setup.cwd,
    content: "---\nname: release-check\ndescription: Updated release checks\n---\n\nRun tests first.\n"
  });
  assert.equal(edited.id, created.id);
  assert.match((await setup.service.read("worker-pi", created.id, setup.cwd)).content, /Run tests first/);

  await setup.service.delete("worker-pi", created.id, setup.cwd);
  await assert.rejects(() => setup.service.read("worker-pi", created.id, setup.cwd), /not found/i);
});

test("keeps package skills read-only", async (t) => {
  const setup = await fixture(t);
  await writeSkill(path.join(setup.workerPi, "npm", "node_modules", "example", "skills"), "package-skill");
  const environment: SkillEnvironmentId = "worker-pi";
  const skill = (await setup.service.list(environment, setup.cwd))[0]!;
  assert.equal(skill.mutable, false);
  assert.equal(skill.capabilities.edit, false);
  assert.match((await setup.service.read(environment, skill.id, setup.cwd)).content, /Use/);
  await assert.rejects(() => setup.service.edit({ environment, id: skill.id, cwd: setup.cwd, content: "---\nname: changed\ndescription: changed\n---\n" }), /read-only/i);
  await assert.rejects(() => setup.service.delete(environment, skill.id, setup.cwd), /read-only/i);
});

test("imports only staged skill files without executing package content", async (t) => {
  const setup = await fixture(t);
  const marker = path.join(setup.root, "executed");
  const zip = new JSZip();
  zip.file("safe-import/SKILL.md", "---\nname: safe-import\ndescription: Safe imported skill\n---\n\nRead references.\n");
  zip.file("safe-import/scripts/install.sh", `#!/bin/sh\ntouch ${marker}\n`, { unixPermissions: 0o100755 });
  zip.file("safe-import/package.json", JSON.stringify({ scripts: { postinstall: `touch ${marker}` } }));
  const archiveBase64 = (await zip.generateAsync({ type: "nodebuffer", platform: "UNIX" })).toString("base64");

  const imported = await setup.service.importArchive({
    environment: "butler-pi",
    archiveBase64,
    cwd: setup.cwd
  });

  assert.deepEqual(imported.map((skill) => skill.name), ["safe-import"]);
  await assert.rejects(() => fs.access(marker));
  const scriptMode = (await fs.stat(path.join(setup.butlerPi, "skills", "safe-import", "scripts", "install.sh"))).mode & 0o777;
  assert.equal(scriptMode, 0o600);
});

test("rejects archive traversal and rolls back the staging directory", async (t) => {
  const setup = await fixture(t);
  const zip = new JSZip();
  zip.file("../escaped/SKILL.md", "---\nname: escaped\ndescription: escaped\n---\n");
  const archiveBase64 = (await zip.generateAsync({ type: "nodebuffer" })).toString("base64");

  await assert.rejects(() => setup.service.importArchive({
    environment: "worker-pi",
    archiveBase64,
    cwd: setup.cwd
  }), /unsafe path/i);
  await assert.rejects(() => fs.access(path.join(setup.workerPi, "skills", "escaped")));
  const entries = await fs.readdir(path.join(setup.workerPi, "skills"));
  assert.deepEqual(entries, []);
});

test("rejects project skill access outside the configured workspace", async (t) => {
  const setup = await fixture(t);
  await assert.rejects(() => setup.service.list("worker-pi", setup.root), /inside the workspace/i);
  await assert.rejects(() => setup.service.create({
    environment: "worker-pi",
    name: "escaped",
    description: "escaped",
    instructions: "escaped",
    scope: "project",
    cwd: setup.root
  }), /inside the workspace/i);
});

test("rejects every project mutation when the skill root resolves outside the workspace", async (t) => {
  const setup = await fixture(t);
  const outsideConfig = path.join(setup.root, "outside-config");
  const escapedFile = await writeSkill(path.join(outsideConfig, "skills"), "escaped-root");
  await fs.symlink(outsideConfig, path.join(setup.cwd, ".pi"), "dir");
  const escaped = (await setup.service.list("worker-pi", setup.cwd)).find((skill) => skill.name === "escaped-root")!;
  const originalContent = await fs.readFile(escapedFile, "utf8");

  await assert.rejects(() => setup.service.create({
    environment: "worker-pi",
    name: "new-project-skill",
    description: "Must stay in the workspace",
    instructions: "Do not escape.",
    scope: "project",
    cwd: setup.cwd
  }), /inside the workspace/i);
  await assert.rejects(() => setup.service.edit({
    environment: "worker-pi",
    id: escaped.id,
    cwd: setup.cwd,
    content: "---\nname: escaped-root\ndescription: changed\n---\n"
  }), /inside the workspace/i);
  await assert.rejects(() => setup.service.delete("worker-pi", escaped.id, setup.cwd), /inside the workspace/i);

  const zip = new JSZip();
  zip.file("imported-project/SKILL.md", "---\nname: imported-project\ndescription: imported\n---\n");
  const archiveBase64 = (await zip.generateAsync({ type: "nodebuffer" })).toString("base64");
  await assert.rejects(() => setup.service.importArchive({
    environment: "worker-pi",
    archiveBase64,
    scope: "project",
    cwd: setup.cwd
  }), /inside the workspace/i);

  assert.equal(await fs.readFile(escapedFile, "utf8"), originalContent);
  await assert.rejects(() => fs.access(path.join(outsideConfig, "skills", "new-project-skill")));
  await assert.rejects(() => fs.access(path.join(outsideConfig, "skills", "imported-project")));
});

test("rejects zip bombs while streaming before an entry can exceed the expanded archive cap", async (t) => {
  const setup = await fixture(t);
  const zip = new JSZip();
  zip.file("stream-limit/SKILL.md", "---\nname: stream-limit\ndescription: streamed size limit\n---\n");
  zip.file("stream-limit/references/bomb.txt", Buffer.alloc(26 * 1024 * 1024, 65));
  const archive = await zip.generateAsync({
    type: "nodebuffer",
    compression: "DEFLATE",
    compressionOptions: { level: 9 }
  });
  assert.ok(archive.length < 10 * 1024 * 1024);

  await assert.rejects(() => setup.service.importArchive({
    environment: "butler-pi",
    archiveBase64: archive.toString("base64"),
    cwd: setup.cwd
  }), /expanded skill archive is too large/i);

  const skillsRoot = path.join(setup.butlerPi, "skills");
  assert.deepEqual(await fs.readdir(skillsRoot), []);
});
