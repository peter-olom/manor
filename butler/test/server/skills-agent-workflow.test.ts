import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import JSZip from "jszip";

import { SkillsService } from "../../src/server/skills-service.js";
import { buildButlerSkillTools } from "../../src/server/butler-agent-skill-tools.js";
import type { ButlerAgentToolAccess } from "../../src/server/butler-agent-tool-access.js";

async function fixture(t: test.TestContext, fetchImpl?: typeof fetch) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "manor-agent-skills-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const workspace = path.join(root, "repos");
  const cwd = path.join(workspace, "project");
  await fs.mkdir(cwd, { recursive: true });
  const service = new SkillsService({
    butlerPiAgentDir: path.join(root, "butler"),
    workerPiAgentDir: path.join(root, "worker"),
    workerCodexHomeDir: path.join(root, "codex"),
    workspaceRoot: workspace,
    fetchImpl
  });
  return { service, cwd, butlerDir: path.join(root, "butler") };
}

function approve(service: SkillsService, owner: string, proposalId: string, messageId = "message-1", questionId = "question-1") {
  const optionId = service.agentApprovalOptions(proposalId).approve;
  service.bindAgentProposalQuestion(owner, proposalId, messageId, questionId);
  service.validateAgentApprovalOption(owner, { messageId, questionId, optionId });
  service.recordAgentApprovalOption(owner, { messageId, questionId, optionId });
}

test("agent skill changes require the exact bound operator approval and support verified undo", async (t) => {
  const { service, cwd } = await fixture(t);
  const owner = "butler:pair-1";
  const proposal = await service.proposeAgentChange(owner, {
    operation: "create",
    environment: "butler-pi",
    name: "review-ready",
    description: "Review a change before release",
    instructions: "Review the diff and run focused tests.",
    cwd
  });

  assert.equal((await service.list("butler-pi", cwd)).length, 0);
  assert.match(proposal.target, /Butler Pi \(butler-pi\) \/ user scope/);
  assert.match(proposal.footprint, /one managed SKILL\.md/i);
  assert.match(proposal.conflict, /No destination conflict/i);
  await assert.rejects(() => service.applyApprovedAgentChange(owner, proposal.id), /not approved/i);

  const optionId = service.agentApprovalOptions(proposal.id).approve;
  service.bindAgentProposalQuestion(owner, proposal.id, "message-1", "question-1");
  assert.throws(() => service.validateAgentApprovalOption(owner, { messageId: "message-2", questionId: "question-1", optionId }), /does not belong/i);
  assert.throws(() => service.validateAgentApprovalOption("butler:pair-2", { messageId: "message-1", questionId: "question-1", optionId }), /not found/i);
  service.validateAgentApprovalOption(owner, { messageId: "message-1", questionId: "question-1", optionId });
  service.recordAgentApprovalOption(owner, { messageId: "message-1", questionId: "question-1", optionId });

  const result = await service.applyApprovedAgentChange(owner, proposal.id);
  assert.equal(result.verification.catalogVisible, true);
  assert.equal(result.verification.invocation, "/skill:review-ready");
  assert.equal((await service.list("butler-pi", cwd))[0]?.name, "review-ready");

  const undo = await service.proposeAgentChange(owner, { operation: "undo", resultId: result.id });
  approve(service, owner, undo.id, "message-undo", "question-undo");
  const undone = await service.applyApprovedAgentChange(owner, undo.id);
  assert.equal(undone.verification.catalogVisible, false);
  assert.equal((await service.list("butler-pi", cwd)).length, 0);
});

test("agent create and install proposals reject occupied destinations before approval", async (t) => {
  const { service, cwd } = await fixture(t);
  await service.create({
    environment: "butler-pi",
    name: "already-there",
    description: "Existing skill",
    instructions: "Stay installed.",
    cwd
  });

  await assert.rejects(() => service.proposeAgentChange("butler:pair-1", {
    operation: "install",
    environment: "butler-pi",
    name: "already-there",
    source: "https://example.com/already-there/SKILL.md",
    content: "---\nname: already-there\ndescription: Replacement\n---\n\nReplace it.\n",
    cwd
  }), /already exists at the requested destination/i);
});

test("agent fetches, approves, and installs a public GitHub skill archive", async (t) => {
  const zip = new JSZip();
  const wrapper = `Asiri_Remote_Connect_Repository-${"a".repeat(40)}`;
  zip.file(`${wrapper}/SKILL.md`, "---\nname: asiri-remote-connect\ndescription: Connect to mapped remote hosts\n---\n\nRun scripts/remote_connect.py.\n");
  zip.file(`${wrapper}/scripts/remote_connect.py`, "print('ready')\n");
  const archive = await zip.generateAsync({ type: "uint8array" });
  let fetchedUrl = "";
  let fetchCount = 0;
  const fetchImpl = (async (input: string | URL | Request) => {
    fetchCount += 1;
    fetchedUrl = String(input);
    return new Response(archive, { status: 200, headers: { "content-length": String(archive.byteLength) } });
  }) as typeof fetch;
  const { service, cwd, butlerDir } = await fixture(t, fetchImpl);
  const owner = "butler:pair-github";

  const proposal = await service.proposeAgentChange(owner, {
    operation: "install",
    environment: "butler-pi",
    source: "https://github.com/peter-olom/asiri-remote-connect",
    cwd
  });

  assert.equal(fetchedUrl, "https://github.com/peter-olom/asiri-remote-connect/archive/HEAD.zip");
  assert.equal(proposal.sourceVerification, "fetched");
  assert.match(proposal.contentEvidence, /scripts\/remote_connect\.py/);
  assert.match(proposal.footprint, /2 files/);
  approve(service, owner, proposal.id);
  const result = await service.applyApprovedAgentChange(owner, proposal.id);

  assert.equal(result.skill.name, "asiri-remote-connect");
  assert.equal(fetchCount, 1);
  assert.equal(await fs.readFile(path.join(butlerDir, "skills", "asiri-remote-connect", "scripts", "remote_connect.py"), "utf8"), "print('ready')\n");

  const undo = await service.proposeAgentChange(owner, { operation: "undo", resultId: result.id });
  assert.match(undo.footprint, /complete approved archive/i);
  approve(service, owner, undo.id, "message-undo", "question-undo");
  const undone = await service.applyApprovedAgentChange(owner, undo.id);
  assert.equal(undone.undo.preservedLocation, null);
  await assert.rejects(() => fs.access(path.join(butlerDir, "skills", "asiri-remote-connect")));
  assert.equal((await fs.readdir(path.join(butlerDir, "skills"))).some((entry) => entry.startsWith(".manor-preserved-asiri-remote-connect-")), false);
});

test("agent archive proposals cap SKILL.md and retained pending payloads", async (t) => {
  const zip = new JSZip();
  zip.file("repo-main/SKILL.md", `---\nname: bounded-archive\ndescription: Bounded archive\n---\n\n${"x".repeat(33 * 1024)}\n`);
  const oversizedArchive = await zip.generateAsync({ type: "uint8array" });
  let fetchCount = 0;
  const oversizedFetch = (async () => {
    fetchCount += 1;
    return new Response(oversizedArchive, { status: 200 });
  }) as typeof fetch;
  const oversizedFixture = await fixture(t, oversizedFetch);
  await assert.rejects(() => oversizedFixture.service.proposeAgentChange("butler:oversized", {
    operation: "install",
    environment: "butler-pi",
    name: "bounded-archive",
    source: "https://github.com/example/bounded-archive",
    cwd: oversizedFixture.cwd
  }), /32768 bytes/i);
  assert.equal(fetchCount, 1);

  const validZip = new JSZip();
  validZip.file("repo-main/SKILL.md", "---\nname: bounded-archive\ndescription: Bounded archive\n---\n\nUse it.\n");
  const validArchive = await validZip.generateAsync({ type: "uint8array" });
  const validFetch = (async () => {
    fetchCount += 1;
    return new Response(validArchive, { status: 200 });
  }) as typeof fetch;
  const { service, cwd } = await fixture(t, validFetch);
  const owner = "butler:bounded";
  const first = await service.proposeAgentChange(owner, {
    operation: "install", environment: "butler-pi", name: "bounded-archive", source: "https://github.com/example/bounded-archive", cwd
  });
  await service.proposeAgentChange(owner, {
    operation: "install", environment: "worker-pi", name: "bounded-archive", source: "https://github.com/example/bounded-archive", cwd
  });
  await assert.rejects(() => service.proposeAgentChange(owner, {
    operation: "install", environment: "butler-pi", name: "bounded-archive", source: "https://github.com/example/bounded-archive", cwd
  }), /Too many pending archive skill approvals/i);
  const reject = service.agentApprovalOptions(first.id).reject;
  service.bindAgentProposalQuestion(owner, first.id, "message-reject", "question-reject");
  service.recordAgentApprovalOption(owner, { messageId: "message-reject", questionId: "question-reject", optionId: reject });
  await service.proposeAgentChange(owner, {
    operation: "install", environment: "butler-pi", name: "bounded-archive", source: "https://github.com/example/bounded-archive", cwd
  });
});

test("concurrent archive proposals cannot bypass retained payload limits", async (t) => {
  const zip = new JSZip();
  zip.file("repo-main/SKILL.md", "---\nname: bounded-archive\ndescription: Bounded archive\n---\n\nUse it.\n");
  const archive = await zip.generateAsync({ type: "uint8array" });
  let fetchCount = 0;
  const fetchImpl = (async () => {
    fetchCount += 1;
    return new Response(archive, { status: 200 });
  }) as typeof fetch;
  const { service, cwd } = await fixture(t, fetchImpl);
  const owner = "butler:concurrent-bounded";

  const results = await Promise.allSettled(["butler-pi", "worker-pi", "butler-pi"].map((environment) => service.proposeAgentChange(owner, {
    operation: "install",
    environment: environment as "butler-pi" | "worker-pi",
    name: "bounded-archive",
    source: "https://github.com/example/bounded-archive",
    cwd
  })));

  assert.equal(results.filter((result) => result.status === "fulfilled").length, 2);
  assert.equal(results.filter((result) => result.status === "rejected").length, 1);
  assert.equal(fetchCount, 2);
  assert.match(String((results.find((result) => result.status === "rejected") as PromiseRejectedResult).reason), /Too many pending archive skill approvals/i);
});

test("agent archive installs accept only public GitHub repository URLs", async (t) => {
  const { service, cwd } = await fixture(t);
  await assert.rejects(() => service.proposeAgentChange("butler:pair-1", {
    operation: "install",
    environment: "butler-pi",
    name: "remote-skill",
    source: "https://example.com/remote-skill.zip",
    cwd
  }), /public GitHub repository URL/i);
});

test("agent create, install, and update reject multi-file skill references with Advanced guidance", async (t) => {
  const { service, cwd } = await fixture(t);
  const owner = "butler:pair-1";
  await assert.rejects(() => service.proposeAgentChange(owner, {
    operation: "create",
    environment: "butler-pi",
    name: "create-multifile",
    description: "Needs a script",
    instructions: "Run scripts/check.sh before replying.",
    cwd
  }), /Advanced archive install for multi-file skills/i);
  await assert.rejects(() => service.proposeAgentChange(owner, {
    operation: "install",
    environment: "butler-pi",
    name: "install-multifile",
    source: "agent-reported source",
    content: "---\nname: install-multifile\ndescription: Needs a guide\n---\n\nRead [the guide](guide.md).\n",
    cwd
  }), /Advanced archive install for multi-file skills/i);
  const created = await service.create({ environment: "butler-pi", name: "update-multifile", description: "Single file", instructions: "Stay self-contained.", cwd });
  await assert.rejects(() => service.proposeAgentChange(owner, {
    operation: "update",
    environment: "butler-pi",
    id: created.id,
    reason: "Add an asset",
    content: "---\nname: update-multifile\ndescription: Needs an asset\n---\n\nUse assets/template.txt.\n",
    cwd
  }), /Advanced archive install for multi-file skills/i);
});

test("agent skill changes reject plain companion files and conventional resource directories", async (t) => {
  const { service, cwd } = await fixture(t);
  for (const instructions of [
    "Run helper.py before replying.",
    "Read guide.md for the workflow.",
    "Use helper.py before replying.",
    "Follow guide.md for the workflow.",
    "Run tools/helper.py before replying.",
    "Run custom/helper.py before replying.",
    "Refer to guide.md for details.",
    "Use templates/report.html for the result.",
    "python ./helper.py",
    "./helper.sh",
    "$ python helper.py"
  ]) {
    await assert.rejects(() => service.proposeAgentChange("butler:pair-1", {
      operation: "create",
      environment: "butler-pi",
      name: `companion-${instructions.length}`,
      description: "Needs another file",
      instructions,
      cwd
    }), /one self-contained SKILL\.md only.*Advanced archive install/i);
  }
});

test("agent proposals cap SKILL.md at 32 KiB and include complete marked approval evidence", async (t) => {
  const { service, cwd } = await fixture(t);
  const owner = "butler:pair-1";
  const body = `${"x".repeat(20_000)}TAIL_TOKEN`;
  const content = `---\nname: complete-evidence\ndescription: Complete evidence\n---\n\n${body}\n`;
  const proposal = await service.proposeAgentChange(owner, {
    operation: "install",
    environment: "butler-pi",
    name: "complete-evidence",
    source: "agent-reported source",
    content,
    cwd
  });
  assert.match(proposal.contentEvidence, /MANOR_FULL_SKILL_CONTENT_V1_JSON/);
  assert.match(proposal.contentEvidence, /TAIL_TOKEN/);
  assert.equal(proposal.contentSha256.length, 64);

  await assert.rejects(() => service.proposeAgentChange(owner, {
    operation: "install",
    environment: "butler-pi",
    name: "too-large-agent-skill",
    source: "agent-reported source",
    content: `---\nname: too-large-agent-skill\ndescription: Too large\n---\n\n${"x".repeat(33 * 1024)}\n`,
    cwd
  }), /32.*KiB|32768 bytes/i);
});

test("agent update approval fails closed when the skill changes before apply", async (t) => {
  const { service, cwd } = await fixture(t);
  const owner = "butler:pair-1";
  const created = await service.create({
    environment: "butler-pi",
    name: "stale-update",
    description: "Original",
    instructions: "Original instructions.",
    cwd
  });
  const proposal = await service.proposeAgentChange(owner, {
    operation: "update",
    environment: "butler-pi",
    id: created.id,
    reason: "Improve the workflow",
    content: "---\nname: stale-update\ndescription: Proposed\n---\n\nProposed instructions.\n",
    cwd
  });
  approve(service, owner, proposal.id);
  await service.edit({
    environment: "butler-pi",
    id: created.id,
    content: "---\nname: stale-update\ndescription: Concurrent\n---\n\nConcurrent instructions.\n",
    cwd
  });

  await assert.rejects(() => service.applyApprovedAgentChange(owner, proposal.id), /changed after approval/i);
  await assert.rejects(() => service.applyApprovedAgentChange(owner, proposal.id), /not approved/i);
  assert.match((await service.read("butler-pi", created.id, cwd)).content, /Concurrent instructions/);
});

test("rejecting a skill proposal never permits apply", async (t) => {
  const { service, cwd } = await fixture(t);
  const owner = "butler:pair-1";
  const proposal = await service.proposeAgentChange(owner, {
    operation: "create",
    environment: "butler-pi",
    name: "cancelled-skill",
    description: "Cancelled",
    instructions: "Never install this.",
    cwd
  });
  const optionId = service.agentApprovalOptions(proposal.id).reject;
  service.bindAgentProposalQuestion(owner, proposal.id, "message-1", "question-1");
  service.recordAgentApprovalOption(owner, { messageId: "message-1", questionId: "question-1", optionId });

  await assert.rejects(() => service.applyApprovedAgentChange(owner, proposal.id), /not approved/i);
  assert.equal((await service.list("butler-pi", cwd)).length, 0);
});

test("undo removes only the approved SKILL.md and preserves later files", async (t) => {
  const { service, cwd, butlerDir } = await fixture(t);
  const owner = "butler:pair-1";
  const proposal = await service.proposeAgentChange(owner, {
    operation: "install",
    environment: "butler-pi",
    name: "preserve-resources",
    source: "agent-reported source",
    content: "---\nname: preserve-resources\ndescription: Preserve later resources\n---\n\nStay single-document.\n",
    cwd
  });
  approve(service, owner, proposal.id);
  const result = await service.applyApprovedAgentChange(owner, proposal.id);
  const skillDir = path.join(butlerDir, "skills", "preserve-resources");
  await fs.writeFile(path.join(skillDir, "notes.txt"), "keep me");

  const undo = await service.proposeAgentChange(owner, { operation: "undo", resultId: result.id });
  approve(service, owner, undo.id, "message-undo", "question-undo");
  const undone = await service.applyApprovedAgentChange(owner, undo.id);

  assert.equal(undone.verification.catalogVisible, false);
  assert.match(undone.undo.preservedLocation ?? "", /\.manor-preserved-preserve-resources-/);
  assert.equal(await fs.readFile(path.join(undone.undo.preservedLocation!, "notes.txt"), "utf8"), "keep me");
  await assert.rejects(() => fs.access(skillDir));
  const reinstalled = await service.create({
    environment: "butler-pi",
    name: "preserve-resources",
    description: "Reinstalled cleanly",
    instructions: "Use the name again.",
    cwd
  });
  assert.equal(reinstalled.name, "preserve-resources");
});

test("undo rejects a SKILL.md changed after the approved result", async (t) => {
  const { service, cwd } = await fixture(t);
  const owner = "butler:pair-1";
  const proposal = await service.proposeAgentChange(owner, {
    operation: "create",
    environment: "butler-pi",
    name: "changed-before-undo",
    description: "Original content",
    instructions: "Original instructions.",
    cwd
  });
  approve(service, owner, proposal.id);
  const result = await service.applyApprovedAgentChange(owner, proposal.id);
  await service.edit({
    environment: "butler-pi",
    id: result.skill.id,
    cwd,
    content: "---\nname: changed-before-undo\ndescription: Later edit\n---\n\nKeep this later edit.\n"
  });
  const undo = await service.proposeAgentChange(owner, { operation: "undo", resultId: result.id });
  approve(service, owner, undo.id, "message-undo", "question-undo");

  await assert.rejects(() => service.applyApprovedAgentChange(owner, undo.id), /changed after this result/i);
  assert.match((await service.read("butler-pi", result.skill.id, cwd)).content, /Keep this later edit/);
});

test("update undo stale-checks the content produced by the approved update", async (t) => {
  const { service, cwd } = await fixture(t);
  const owner = "butler:pair-1";
  const created = await service.create({ environment: "butler-pi", name: "update-undo", description: "Original", instructions: "Original.", cwd });
  const update = await service.proposeAgentChange(owner, {
    operation: "update",
    environment: "butler-pi",
    id: created.id,
    reason: "Approved improvement",
    content: "---\nname: update-undo\ndescription: Approved update\n---\n\nApproved update.\n",
    cwd
  });
  approve(service, owner, update.id);
  const result = await service.applyApprovedAgentChange(owner, update.id);
  const undo = await service.proposeAgentChange(owner, { operation: "undo", resultId: result.id });
  approve(service, owner, undo.id, "message-undo", "question-undo");
  await service.edit({
    environment: "butler-pi",
    id: created.id,
    content: "---\nname: update-undo\ndescription: Later change\n---\n\nDo not overwrite.\n",
    cwd
  });

  await assert.rejects(() => service.applyApprovedAgentChange(owner, undo.id), /changed after this result/i);
  assert.match((await service.read("butler-pi", created.id, cwd)).content, /Do not overwrite/);
});

test("serialized manual edits win before an approved stale apply", async (t) => {
  const { service, cwd } = await fixture(t);
  const owner = "butler:pair-1";
  const created = await service.create({
    environment: "butler-pi",
    name: "serialized-update",
    description: "Original",
    instructions: "Original.",
    cwd
  });
  const proposal = await service.proposeAgentChange(owner, {
    operation: "update",
    environment: "butler-pi",
    id: created.id,
    reason: "Approved update",
    content: "---\nname: serialized-update\ndescription: Approved\n---\n\nApproved content.\n",
    cwd
  });
  approve(service, owner, proposal.id);
  const manual = service.edit({
    environment: "butler-pi",
    id: created.id,
    content: "---\nname: serialized-update\ndescription: Manual\n---\n\nManual content.\n",
    cwd
  });
  const apply = service.applyApprovedAgentChange(owner, proposal.id);

  await assert.rejects(() => Promise.all([manual, apply]), /changed after approval/i);
  assert.match((await service.read("butler-pi", created.id, cwd)).content, /Manual content/);
});

test("Butler skill proposal tool posts a decision-complete approval card and reloads after apply", async (t) => {
  const { service, cwd } = await fixture(t);
  const owner = "butler:pair-1";
  let reloads = 0;
  let posted: Record<string, unknown> | null = null;
  const tools = buildButlerSkillTools({
    runtimeThreadId: owner,
    skillsService: service,
    getToolUiEffects: () => [],
    defineButlerTool: (definition) => definition,
    scheduleButlerSkillReload: () => { reloads += 1; },
    postOperatorQuestion: async (input) => {
      posted = input as Record<string, unknown>;
      return {
        id: "message-1",
        role: "assistant",
        text: "approval",
        at: Date.now(),
        question: {
          id: "question-1",
          prompt: "approval",
          context: null,
          options: [],
          allowFreeform: false,
          selectedOptionId: null,
          freeformAnswer: null,
          answeredAt: null,
          questions: [{ id: "question-1", prompt: "approval", context: null, options: [], allowFreeform: false, selectedOptionId: null, freeformAnswer: null, answeredAt: null }]
        }
      } as never;
    }
  } as unknown as ButlerAgentToolAccess) as Array<{ name: string; description: string; promptSnippet: string; execute: (id: string, params: Record<string, unknown>) => Promise<{ details?: Record<string, unknown> }> }>;

  for (const tool of tools) {
    assert.match(`${tool.description} ${tool.promptSnippet}`, /butler-pi/);
    assert.match(`${tool.description} ${tool.promptSnippet}`, /worker-pi/);
    assert.doesNotMatch(`${tool.description} ${tool.promptSnippet}`, /worker-codex/);
  }

  const proposed = await tools.find((tool) => tool.name === "propose_skill_change")!.execute("call-1", {
    operation: "install",
    environment: "butler-pi",
    name: "agent-installed",
    content: "---\nname: agent-installed\ndescription: Install through Butler\n---\n\nRun the checked workflow.\n",
    source: "https://example.com/agent-installed/SKILL.md",
    cwd
  });
  const question = (posted?.questions as Array<{ context: string }>)[0]!;
  assert.match(question.context, /Purpose: Install through Butler/);
  assert.match(question.context, /Source: https:\/\/example\.com.*agent-reported; Manor did not fetch or verify/i);
  assert.match(question.context, /Target: Butler Pi \(butler-pi\) \/ user scope/);
  assert.match(question.context, /one managed SKILL\.md/);
  assert.match(question.context, /No destination conflict/);
  assert.match(question.context, /Reload the active Butler resources/);
  assert.match(question.context, /Approved content SHA-256: [a-f0-9]{64}/);
  assert.match(question.context, /Approved content evidence: Complete proposed single-document SKILL\.md\./);
  assert.match(question.context, /MANOR_FULL_SKILL_CONTENT_V1_JSON/);
  const options = ((posted?.questions as Array<{ options: Array<{ label: string }> }>)[0]?.options ?? []);
  assert.equal(options[0]?.label, "Install and verify");

  const proposal = proposed.details?.proposal as { id: string };
  const optionId = service.agentApprovalOptions(proposal.id).approve;
  service.recordAgentApprovalOption(owner, { messageId: "message-1", questionId: "question-1", optionId });
  await tools.find((tool) => tool.name === "apply_skill_change")!.execute("call-2", { proposalId: proposal.id });
  assert.equal(reloads, 1);
  assert.equal((await service.list("butler-pi", cwd))[0]?.name, "agent-installed");
});

test("approval targets identify the single Worker Pi environment", async (t) => {
  const { service, cwd } = await fixture(t);
  const workerPi = await service.proposeAgentChange("butler:pair-1", {
    operation: "create",
    environment: "worker-pi",
    name: "worker-pi-target",
    description: "Worker Pi target",
    instructions: "Use Worker Pi.",
    cwd
  });
  assert.match(workerPi.target, /Worker Pi \(worker-pi\)/);
  assert.doesNotMatch(workerPi.target, /Codex/);
});
