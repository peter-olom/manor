import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { SkillsService } from "../../src/server/skills-service.js";
import { buildButlerSkillTools } from "../../src/server/butler-agent-skill-tools.js";
import type { ButlerAgentToolAccess } from "../../src/server/butler-agent-tool-access.js";

async function fixture(t: test.TestContext) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "manor-agent-skills-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const workspace = path.join(root, "repos");
  const cwd = path.join(workspace, "project");
  const scratch = path.join(root, "scratch");
  await fs.mkdir(cwd, { recursive: true });
  await fs.mkdir(scratch, { recursive: true });
  const service = new SkillsService({
    butlerPiAgentDir: path.join(root, "butler"),
    workerPiAgentDir: path.join(root, "worker"),
    workerCodexHomeDir: path.join(root, "codex"),
    butlerScratchRoot: scratch,
    workspaceRoot: workspace
  });
  return { service, cwd, scratch, butlerDir: path.join(root, "butler"), workerDir: path.join(root, "worker") };
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

test("repository-backed installs must be prepared by Butler", async (t) => {
  const { service, cwd } = await fixture(t);
  await assert.rejects(() => service.proposeAgentChange("butler:repo-install", {
    operation: "install",
    environment: "worker-pi",
    name: "remote-skill",
    source: "https://github.com/example/remote-skill",
    cwd
  }), /Butler-led.*Butler scratch/i);
});

test("publishes the exact Butler-prepared skill candidate after approval", async (t) => {
  const { service, scratch, butlerDir } = await fixture(t);
  const candidate = path.join(scratch, "asiri-remote-connect");
  await fs.mkdir(path.join(candidate, "bin"), { recursive: true });
  await fs.writeFile(path.join(candidate, "SKILL.md"), "---\nname: asiri-remote-connect\ndescription: Connect to mapped remote hosts\n---\n\nRun bin/remote-connect.\n");
  await fs.writeFile(path.join(candidate, "bin", "remote-connect"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  const owner = "butler:prepared-candidate";

  const proposal = await service.proposeButlerPreparedInstall(owner, {
    name: "asiri-remote-connect",
    source: "https://github.com/peter-olom/asiri-remote-connect @ abcdef1234567890",
    candidatePath: candidate,
    evidence: "Butler verification results:\n- doctor exited successfully"
  });

  assert.equal(proposal.sourceVerification, "butler-prepared");
  assert.match(proposal.footprint, /Butler-prepared candidate containing 2 files/i);
  assert.match(proposal.contentEvidence, /doctor exited successfully/);
  approve(service, owner, proposal.id);
  const result = await service.applyApprovedAgentChange(owner, proposal.id);
  const binary = path.join(butlerDir, "skills", "asiri-remote-connect", "bin", "remote-connect");
  assert.equal((await fs.stat(binary)).mode & 0o777, 0o700);
  assert.equal(result.verification.operability, "verification-pending");

  const undo = await service.proposeAgentChange(owner, { operation: "undo", resultId: result.id });
  approve(service, owner, undo.id, "message-undo", "question-undo");
  await service.applyApprovedAgentChange(owner, undo.id);
  await assert.rejects(() => fs.access(path.join(butlerDir, "skills", "asiri-remote-connect")));
});

test("atomically replaces and can restore an existing broken repository skill", async (t) => {
  const { service, scratch, butlerDir } = await fixture(t);
  const installed = path.join(butlerDir, "skills", "asiri-remote-connect");
  await fs.mkdir(installed, { recursive: true });
  await fs.writeFile(path.join(installed, "SKILL.md"), "---\nname: asiri-remote-connect\ndescription: Old source-only install\n---\n\nThe binary is missing.\n");
  const candidate = path.join(scratch, "asiri-remote-connect");
  await fs.mkdir(path.join(candidate, "bin"), { recursive: true });
  await fs.writeFile(path.join(candidate, "SKILL.md"), "---\nname: asiri-remote-connect\ndescription: Operational install\n---\n\nRun bin/remote-connect.\n");
  await fs.writeFile(path.join(candidate, "bin", "remote-connect"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  const owner = "butler:repair-existing";

  const proposal = await service.proposeButlerPreparedInstall(owner, {
    name: "asiri-remote-connect",
    source: "https://github.com/example/asiri-remote-connect",
    candidatePath: candidate,
    evidence: "sealed doctor exited 0"
  });
  assert.match(proposal.conflict, /atomically replaced/i);
  approve(service, owner, proposal.id);
  const result = await service.applyApprovedAgentChange(owner, proposal.id);
  assert.equal(await fs.readFile(path.join(installed, "bin", "remote-connect"), "utf8"), "#!/bin/sh\nexit 0\n");

  const undo = await service.proposeAgentChange(owner, { operation: "undo", resultId: result.id });
  assert.match(undo.footprint, /restores the complete previous installation/i);
  approve(service, owner, undo.id, "message-undo-repair", "question-undo-repair");
  await service.applyApprovedAgentChange(owner, undo.id);
  assert.match(await fs.readFile(path.join(installed, "SKILL.md"), "utf8"), /Old source-only install/);
  await assert.rejects(() => fs.access(path.join(installed, "bin", "remote-connect")));
});

test("sealed Butler candidates fail when verification changes their bytes", async (t) => {
  const { service, scratch } = await fixture(t);
  const candidate = path.join(scratch, "sealed-skill");
  await fs.mkdir(candidate, { recursive: true });
  await fs.writeFile(path.join(candidate, "SKILL.md"), "---\nname: sealed-skill\ndescription: Sealed candidate\n---\n\nRun it.\n");
  const sealed = await service.sealButlerSkillCandidate("sealed-skill", candidate);
  t.after(sealed.cleanup);

  await fs.writeFile(path.join(sealed.verificationPath, "SKILL.md"), "---\nname: sealed-skill\ndescription: Changed candidate\n---\n\nChanged.\n");
  await assert.rejects(
    () => service.assertSealedButlerSkillCandidateUnchanged("sealed-skill", sealed.verificationPath, sealed.archiveBase64),
    /changed during final verification/i
  );
});

test("rejects Butler candidates outside scratch and through scratch symlinks", async (t) => {
  const { service, scratch } = await fixture(t);
  const outside = path.join(path.dirname(scratch), "outside-candidate");
  await fs.mkdir(outside, { recursive: true });
  await fs.writeFile(path.join(outside, "SKILL.md"), "---\nname: escaped-skill\ndescription: Escaped skill\n---\n\nDo nothing.\n");

  await assert.rejects(() => service.proposeButlerPreparedInstall("butler:escape", {
    name: "escaped-skill",
    source: "https://example.com/escaped-skill",
    candidatePath: outside,
    evidence: "verification passed"
  }), /inside Butler scratch/i);

  const linked = path.join(scratch, "escaped-skill");
  await fs.symlink(outside, linked, "dir");
  await assert.rejects(() => service.proposeButlerPreparedInstall("butler:escape", {
    name: "escaped-skill",
    source: "https://example.com/escaped-skill",
    candidatePath: linked,
    evidence: "verification passed"
  }), /inside Butler scratch/i);
});

test("bounds pending Butler candidate packages per session", async (t) => {
  const { service, scratch } = await fixture(t);
  const candidate = path.join(scratch, "bounded-candidate");
  await fs.mkdir(candidate);
  await fs.writeFile(path.join(candidate, "SKILL.md"), "---\nname: bounded-candidate\ndescription: Bounded candidate\n---\n\nUse it.\n");
  const input = {
    name: "bounded-candidate",
    source: "https://github.com/example/bounded-candidate @ abcdef1",
    candidatePath: candidate,
    evidence: "Verified by Butler."
  };
  await service.proposeButlerPreparedInstall("butler:bounded-candidate", input);
  await service.proposeButlerPreparedInstall("butler:bounded-candidate", input);
  await assert.rejects(
    () => service.proposeButlerPreparedInstall("butler:bounded-candidate", input),
    /Too many pending Butler skill candidates/i
  );
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
  assert.equal(options[0]?.label, "Publish skill");

  const proposal = proposed.details?.proposal as { id: string };
  const optionId = service.agentApprovalOptions(proposal.id).approve;
  service.recordAgentApprovalOption(owner, { messageId: "message-1", questionId: "question-1", optionId });
  await tools.find((tool) => tool.name === "apply_skill_change")!.execute("call-2", { proposalId: proposal.id });
  assert.equal(reloads, 1);
  assert.equal((await service.list("butler-pi", cwd))[0]?.name, "agent-installed");
});

test("Butler verifies and packages a scratch candidate before Worker confirmation", async (t) => {
  const { service, cwd, scratch } = await fixture(t);
  const candidatePath = path.join(scratch, "prepared-skill");
  await fs.mkdir(path.join(candidatePath, "bin"), { recursive: true });
  await fs.writeFile(path.join(candidatePath, "SKILL.md"), "---\nname: prepared-skill\ndescription: Prepared by Butler\n---\n\nRun bin/prepared.\n");
  await fs.writeFile(path.join(candidatePath, "bin", "prepared"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  const owner = "butler:pair-candidate";
  const threadId = "pi-worker-install";
  const butlerSessionId = "butler-session-candidate";
  const source = "https://github.com/example/prepared-skill";
  const setupCommand = "./scripts/install.sh";
  const verificationCommand = "./bin/prepared doctor";
  const verificationThreadId = "pi-worker-verify";
  const verificationReport = {
    threadId: verificationThreadId,
    turnId: "turn-verify",
    status: "completed",
    summary: "Loaded /skill:prepared-skill and verified the installed capability.",
    details: "The managed installation is operational.",
    evidence: [{
      summary: "Installed doctor passed.",
      details: null,
      command: "/worker-pi/agent/skills/prepared-skill/bin/prepared doctor",
      exitCode: 0,
      proofRunId: null,
      artifactId: null
    }],
    createdAt: 400,
    updatedAt: 450
  };
  let posted: Record<string, unknown> | null = null;
  let verificationInstruction = "";
  let operatorReply = "";
  let verificationStartedAt = 0;
  let executedScript = "";
  const tools = buildButlerSkillTools({
    runtimeThreadId: owner,
    skillsService: service,
    butlerExecutorClient: {
      execute: async (input: { script: string; threadId: string }) => {
        executedScript = input.script;
        assert.equal(input.threadId, owner);
        return { stdout: "doctor ok", stderr: "", exitCode: 0, signal: null, timedOut: false, truncated: false };
      }
    },
    store: {
      getWorkerReport: (id: string) => id === verificationThreadId ? verificationReport : null,
      getThreadJobPayload: (id: string) => id === verificationThreadId
        ? { protocol: { butlerThreadId: butlerSessionId, workerThreadId: id } }
        : null,
      getThread: (id: string) => id === verificationThreadId ? { turns: [{ id: "turn-verify", startedAt: verificationStartedAt }] } : null
    },
    getButlerSessionId: () => butlerSessionId,
    getWorkerDefaults: () => ({ runtime: "pi-rpc", threadId, harness: "pi", model: "worker-model", effort: "high", cwd }),
    createOrUpdateJobPayload: async (input) => {
      verificationInstruction = input.instruction;
      return {} as never;
    },
    handoffWorker: async (input) => {
      assert.equal(input.sourceThreadId, threadId);
      return { threadId: verificationThreadId };
    },
    getToolUiEffects: () => [],
    defineButlerTool: (definition) => definition,
    scheduleButlerSkillReload: () => {},
    postOperatorQuestion: async (input) => {
      posted = input as Record<string, unknown>;
      return {
        id: "message-candidate",
        question: {
          id: "question-candidate",
          questions: [{ id: "question-candidate" }]
        }
      } as never;
    },
    postOperatorJobReply: async (_threadId, text) => { operatorReply = text; }
  } as unknown as ButlerAgentToolAccess) as Array<{ name: string; execute: (id: string, params: Record<string, unknown>) => Promise<{ details?: Record<string, unknown> }> }>;

  const candidateTool = tools.find((tool) => tool.name === "propose_repository_skill_install")!;
  await assert.rejects(() => candidateTool.execute("call-unresolved-dependency", {
    name: "prepared-skill",
    source,
    candidatePath,
    verificationCommand,
    setupCommands: [setupCommand],
    dependencies: ["missing runtime binary"]
  }), /unresolved runtime dependencies/i);

  const proposed = await candidateTool.execute("call-candidate", {
    name: "prepared-skill",
    source,
    candidatePath,
    verificationCommand,
    setupCommands: [setupCommand],
    dependencies: []
  });

  const proposal = proposed.details?.proposal as { id: string; sourceVerification: string; environment: string };
  assert.equal(proposal.sourceVerification, "butler-prepared");
  assert.equal(proposal.environment, "butler-pi");
  assert.match(executedScript, /prepared-skill/);
  const context = (posted?.questions as Array<{ context: string }>)[0]!.context;
  assert.match(context, /prepared and exercised by Butler/i);
  assert.match(context, /doctor ok/);

  const optionId = service.agentApprovalOptions(proposal.id).approve;
  service.validateAgentApprovalOption(owner, { messageId: "message-candidate", questionId: "question-candidate", optionId });
  service.recordAgentApprovalOption(owner, { messageId: "message-candidate", questionId: "question-candidate", optionId });
  const applied = await tools.find((tool) => tool.name === "apply_skill_change")!.execute("call-apply", { proposalId: proposal.id });
  const result = applied.details?.result as { id: string; appliedAt: number; verification: { operability: string; verificationThreadId: string } };
  verificationStartedAt = result.appliedAt + 1;
  assert.equal(result.verification.operability, "verification-pending");
  assert.equal(result.verification.verificationThreadId, verificationThreadId);
  assert.match(verificationInstruction, /Load \/skill:prepared-skill/);

  const confirmed = await tools.find((tool) => tool.name === "confirm_worker_skill_operability")!.execute("call-confirm", {
    resultId: result.id,
    threadId: verificationThreadId
  });
  assert.equal((confirmed.details?.result as { verification: { operability: string } }).verification.operability, "ready");
  assert.match(operatorReply, /is ready/);
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
