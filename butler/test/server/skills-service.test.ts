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
  assert.equal(scriptMode, 0o700);
});

test("makes Worker skill archives readable and preserves executable assets", async (t) => {
  const setup = await fixture(t);
  const zip = new JSZip();
  zip.file("worker-tool/SKILL.md", "---\nname: worker-tool\ndescription: Worker tool\n---\n\nRun bin/worker-tool.\n");
  zip.file("worker-tool/bin/worker-tool", "#!/bin/sh\nexit 0\n", { unixPermissions: 0o100755 });
  const archiveBase64 = (await zip.generateAsync({ type: "nodebuffer", platform: "UNIX" })).toString("base64");

  await setup.service.importArchive({ environment: "worker-pi", archiveBase64, cwd: setup.cwd });

  const skillRoot = path.join(setup.workerPi, "skills", "worker-tool");
  assert.equal((await fs.stat(path.join(setup.workerPi, "skills"))).mode & 0o777, 0o755);
  assert.equal((await fs.stat(skillRoot)).mode & 0o777, 0o755);
  assert.equal((await fs.stat(path.join(skillRoot, "SKILL.md"))).mode & 0o777, 0o644);
  assert.equal((await fs.stat(path.join(skillRoot, "bin", "worker-tool"))).mode & 0o777, 0o755);
});

test("repairs legacy Worker skill permissions on startup", async (t) => {
  const setup = await fixture(t);
  const skillRoot = path.join(setup.workerPi, "skills", "legacy-worker-tool");
  await fs.mkdir(path.join(skillRoot, "bin"), { recursive: true, mode: 0o700 });
  await fs.writeFile(path.join(skillRoot, "SKILL.md"), "---\nname: legacy-worker-tool\ndescription: Legacy tool\n---\n\nUse it.\n", { mode: 0o600 });
  await fs.writeFile(path.join(skillRoot, "bin", "legacy-worker-tool"), "binary", { mode: 0o700 });
  await fs.chmod(path.join(setup.workerPi, "skills"), 0o700);

  await setup.service.repairWorkerUserSkillPermissions();

  assert.equal((await fs.stat(path.join(setup.workerPi, "skills"))).mode & 0o777, 0o755);
  assert.equal((await fs.stat(skillRoot)).mode & 0o777, 0o755);
  assert.equal((await fs.stat(path.join(skillRoot, "SKILL.md"))).mode & 0o777, 0o644);
  assert.equal((await fs.stat(path.join(skillRoot, "bin", "legacy-worker-tool"))).mode & 0o777, 0o755);
  assert.equal((await fs.stat(skillRoot)).uid, process.getuid?.() ?? 0);
  assert.equal((await fs.stat(skillRoot)).gid, process.getgid?.() ?? 0);
});

test("uses one shared user registry for Butler and Worker", async (t) => {
  const setup = await fixture(t);
  const sharedSkills = path.join(setup.root, "shared-skills");
  const service = new SkillsService({
    butlerPiAgentDir: setup.butlerPi,
    workerPiAgentDir: setup.workerPi,
    sharedSkillsDir: sharedSkills,
    workspaceRoot: setup.workspace
  });

  await service.create({
    environment: "butler-pi",
    name: "shared-tool",
    description: "Available to both agents",
    instructions: "Run the shared tool.",
    cwd: setup.cwd
  });

  assert.equal((await service.list("butler-pi", setup.cwd)).some((skill) => skill.name === "shared-tool"), true);
  assert.equal((await service.list("worker-pi", setup.cwd)).some((skill) => skill.name === "shared-tool"), true);
  assert.equal((await fs.stat(path.join(sharedSkills, "shared-tool"))).mode & 0o777, 0o755);
  assert.equal((await fs.stat(path.join(sharedSkills, "shared-tool", "SKILL.md"))).mode & 0o777, 0o644);
  const workerSkill = (await service.list("worker-pi", setup.cwd)).find((skill) => skill.name === "shared-tool")!;
  await service.delete("worker-pi", workerSkill.id, setup.cwd);
  assert.equal((await service.list("butler-pi", setup.cwd)).some((skill) => skill.name === "shared-tool"), false);

  await writeSkill(path.join(setup.cwd, ".pi", "skills"), "repo-tool");
  const repoTool = (await service.list("butler-pi", setup.cwd)).find((skill) => skill.name === "repo-tool")!;
  assert.equal(repoTool.mutable, false);
  await assert.rejects(() => service.create({
    environment: "butler-pi",
    scope: "project",
    name: "blocked-project-tool",
    description: "Must be changed by Worker",
    instructions: "Do nothing.",
    cwd: setup.cwd
  }), /must be changed by Worker/i);
});

test("migrates valid legacy user skills without overwriting shared entries", async (t) => {
  const setup = await fixture(t);
  const sharedSkills = path.join(setup.root, "shared-skills");
  const legacyButler = path.join(setup.root, "legacy-butler");
  const legacyWorker = path.join(setup.root, "legacy-worker");
  await writeSkill(legacyButler, "butler-tool", "Legacy Butler tool");
  await fs.mkdir(path.join(legacyButler, "Invalid Legacy Name"), { recursive: true });
  await writeSkill(legacyWorker, "worker-tool", "Legacy Worker tool");
  await writeSkill(sharedSkills, "worker-tool", "Existing shared tool");
  const service = new SkillsService({
    butlerPiAgentDir: setup.butlerPi,
    workerPiAgentDir: setup.workerPi,
    sharedSkillsDir: sharedSkills,
    workspaceRoot: setup.workspace
  });

  const result = await service.migrateLegacyUserSkills([legacyButler, legacyWorker]);

  assert.deepEqual(result, { migrated: 1, skipped: 1, failed: 1 });
  assert.equal((await service.list("butler-pi", setup.cwd)).some((skill) => skill.name === "butler-tool"), true);
  assert.match(await fs.readFile(path.join(sharedSkills, "worker-tool", "SKILL.md"), "utf8"), /Existing shared tool/);
  assert.match(await fs.readFile(path.join(legacyWorker, "worker-tool", "SKILL.md"), "utf8"), /Legacy Worker tool/);

  await fs.rm(path.join(sharedSkills, "butler-tool"), { recursive: true });
  const repeated = await service.migrateLegacyUserSkills([legacyButler, legacyWorker]);
  assert.deepEqual(repeated, { migrated: 0, skipped: 0, failed: 0 });
  await assert.rejects(() => fs.access(path.join(sharedSkills, "butler-tool")));
});

test("uses one readable permission policy for shared project skills", async (t) => {
  const setup = await fixture(t);
  const created = await setup.service.create({
    environment: "butler-pi",
    scope: "project",
    name: "shared-project-tool",
    description: "Shared project tool",
    instructions: "Use it.",
    cwd: setup.cwd
  });
  const filePath = path.join(setup.cwd, ".pi", "skills", "shared-project-tool", "SKILL.md");

  assert.equal((await fs.stat(path.dirname(filePath))).mode & 0o777, 0o755);
  assert.equal((await fs.stat(filePath)).mode & 0o777, 0o644);
  assert.equal((await setup.service.list("worker-pi", setup.cwd)).some((skill) => skill.id !== created.id && skill.name === "shared-project-tool"), true);

  await setup.service.edit({
    environment: "worker-pi",
    id: (await setup.service.list("worker-pi", setup.cwd)).find((skill) => skill.name === "shared-project-tool")!.id,
    content: "---\nname: shared-project-tool\ndescription: Shared project tool\n---\n\nUpdated.\n",
    cwd: setup.cwd
  });
  assert.equal((await fs.stat(filePath)).mode & 0o777, 0o644);
});

test("imports GitHub archives under the skill's declared name", async (t) => {
  const setup = await fixture(t);
  const zip = new JSZip();
  const wrapper = `Asiri_Remote_Connect_Repository-${"a".repeat(40)}`;
  zip.file(`${wrapper}/SKILL.md`, "---\nname: asiri-remote-connect\ndescription: Connect to mapped remote hosts\n---\n\nRun scripts/remote_connect.py.\n");
  zip.file(`${wrapper}/scripts/remote_connect.py`, "print('ready')\n");

  const imported = await setup.service.importArchive({
    environment: "butler-pi",
    archiveBase64: (await zip.generateAsync({ type: "nodebuffer" })).toString("base64"),
    cwd: setup.cwd
  });

  assert.deepEqual(imported.map((skill) => skill.name), ["asiri-remote-connect"]);
  assert.equal(await fs.readFile(path.join(setup.butlerPi, "skills", "asiri-remote-connect", "scripts", "remote_connect.py"), "utf8"), "print('ready')\n");
  await assert.rejects(() => fs.access(path.join(setup.butlerPi, "skills", "asiri-remote-connect-main")));
});

test("rejects archives that declare the same skill name more than once", async (t) => {
  const setup = await fixture(t);
  const zip = new JSZip();
  const content = "---\nname: duplicate-skill\ndescription: Duplicate skill\n---\n\nUse it.\n";
  zip.file("duplicate-skill-main/SKILL.md", content);
  zip.file("duplicate-skill-release/SKILL.md", content);
  const archiveBase64 = (await zip.generateAsync({ type: "nodebuffer" })).toString("base64");

  await assert.rejects(() => setup.service.importArchive({
    environment: "worker-pi",
    archiveBase64,
    cwd: setup.cwd
  }), /declares duplicate-skill more than once/i);
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
