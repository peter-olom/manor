import crypto from "node:crypto";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { loadSkillsFromDir, type Skill } from "@earendil-works/pi-coding-agent";
import { archiveButlerSkillCandidate, archiveSkillContentEvidence, archiveSkillDirectory, extractSkillArchive, inspectAgentSkillArchive, MAX_SKILL_ARCHIVE_BYTES } from "./skill-archive.js";
import { assertSealedButlerSkillCandidateUnchanged as assertSealedCandidateUnchanged, replaceExistingSkillArchive, sealButlerSkillCandidate as sealCandidate, snapshotExistingSkill } from "./skill-install-lifecycle.js";
import { migrateLegacySkillRegistry } from "./skill-registry-migration.js";
import type { AgentSkillChangeInput, AgentSkillChangeProposal, AgentSkillChangeResult, SkillCatalogItem, SkillEnvironmentId, SkillEnvironmentView, SkillOrigin, SkillScope } from "./skill-types.js";
export type { AgentSkillChangeInput, AgentSkillChangeProposal, AgentSkillChangeResult, SkillCapabilities, SkillCatalogItem, SkillEnvironmentId, SkillEnvironmentView, SkillOrigin, SkillScope } from "./skill-types.js";

type SkillRecord = SkillCatalogItem & {
  filePath: string;
  baseDir: string;
  inputPath: string;
};

type SkillsServiceOptions = {
  butlerPiAgentDir: string;
  workerPiAgentDir: string;
  sharedSkillsDir?: string;
  butlerScratchRoot?: string;
  workspaceRoot: string;
};

type NormalizedAgentSkillChangeInput =
  | Exclude<AgentSkillChangeInput, { operation: "install" }>
  | {
      operation: "install";
      environment: SkillEnvironmentId;
      name: string;
      content?: string;
      archiveBase64?: string;
      archiveManifest?: Array<{ path: string; sha256: string }>;
      replacement?: { archiveBase64: string; archiveSha256: string };
      candidateEvidence?: string;
      workerVerificationGoal?: string;
      runtimeRequirements?: string[];
      source: string;
      scope: SkillScope;
      cwd: string | null;
    };

type AgentSkillProposalRecord = AgentSkillChangeProposal & {
  owner: string;
  input: NormalizedAgentSkillChangeInput;
  beforeContent: string | null;
  beforeHash: string | null;
  questionMessageId: string | null;
  questionId: string | null;
};

type AgentSkillResultRecord = AgentSkillChangeResult & {
  owner: string;
  environment: SkillEnvironmentId;
  cwd: string | null;
  createdSkillId: string | null;
  previousContent: string | null;
  appliedContentHash: string | null;
  appliedContent: string | null;
  appliedArchiveManifest: Array<{ path: string; sha256: string }> | null;
  previousArchiveBase64: string | null;
  installedArchiveSha256: string | null;
  undoneAt: number | null;
};

const ENVIRONMENTS: SkillEnvironmentView[] = [
  environment("butler-pi", "Butler", "pi", true),
  environment("worker-pi", "Worker", "pi", true)
];
const MAX_SKILL_BYTES = 2 * 1024 * 1024;
const MAX_AGENT_SKILL_BYTES = 32 * 1024;
const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const AGENT_PROPOSAL_TTL_MS = 30 * 60 * 1000;
const MAX_AGENT_ARCHIVE_MANIFEST_EVIDENCE_BYTES = 12 * 1024;
const MAX_PENDING_BUTLER_CANDIDATES_PER_OWNER = 2;
const MAX_PENDING_BUTLER_CANDIDATES_GLOBAL = 8;
const AGENT_APPROVAL_PREFIX = "skill-change";
export const AGENT_SKILL_CONTENT_MARKER = "MANOR_FULL_SKILL_CONTENT_V1_JSON";

function environment(
  id: SkillEnvironmentId,
  label: string,
  harness: "pi",
  mutable: boolean
): SkillEnvironmentView {
  return {
    id,
    label,
    harness,
    capabilities: {
      list: true,
      read: true,
      create: mutable,
      install: mutable,
      edit: mutable,
      delete: mutable,
      import: mutable,
      packageManagement: false
    }
  };
}

function isWithin(root: string, target: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function skillId(environmentId: SkillEnvironmentId, filePath: string): string {
  return `skill_${crypto.createHash("sha256").update(`${environmentId}\0${path.resolve(filePath)}`).digest("base64url").slice(0, 24)}`;
}

function safeName(value: unknown): string {
  const name = typeof value === "string" ? value.trim() : "";
  if (!SKILL_NAME.test(name) || name.length > 64) {
    throw new Error("Skill name must be 1-64 lowercase letters, numbers, or single hyphens.");
  }
  return name;
}

function skillMarkdown(name: string, description: string, instructions: string): string {
  const cleanDescription = description.trim();
  if (!cleanDescription || cleanDescription.length > 1024 || /[\r\n]/.test(cleanDescription)) {
    throw new Error("Skill description must be a single line between 1 and 1024 characters.");
  }
  const escaped = cleanDescription.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  return `---\nname: ${name}\ndescription: "${escaped}"\n---\n\n${instructions.trim()}\n`;
}

export class SkillsService {
  private readonly agentProposals = new Map<string, AgentSkillProposalRecord>();
  private readonly agentResults = new Map<string, AgentSkillResultRecord>();
  private agentCandidateProposalTail: Promise<void> = Promise.resolve();
  private mutationTail: Promise<void> = Promise.resolve();

  constructor(private readonly options: SkillsServiceOptions) {}

  async repairSharedSkillRegistryPermissions(): Promise<void> {
    const root = this.sharedSkillsRoot("worker-pi");
    await this.ensureMutableRoot(root, "butler-pi", "user");
    await this.setInstalledPermissions(root, "butler-pi", "user");
  }

  async migrateLegacyUserSkills(legacyRoots: string[]): Promise<{ migrated: number; skipped: number; failed: number }> {
    if (!this.options.sharedSkillsDir) return { migrated: 0, skipped: 0, failed: 0 };
    return this.runMutation(async () => {
      const sharedRoot = this.sharedSkillsRoot("butler-pi");
      await this.ensureMutableRoot(sharedRoot, "butler-pi", "user");
      return migrateLegacySkillRegistry({
        sharedRoot,
        legacyRoots,
        validateName: safeName,
        importArchive: async (archiveBase64) => { await this.importArchiveUnlocked({ environment: "butler-pi", archiveBase64, scope: "user" }); },
        ownMarker: (markerPath) => this.setManagedOwnership(markerPath, "butler-pi", "user")
      });
    });
  }

  async repairWorkerUserSkillPermissions(): Promise<void> {
    const root = this.sharedSkillsRoot("worker-pi");
    await this.ensureMutableRoot(root, "worker-pi", "user");
    await this.setInstalledPermissions(root, "worker-pi", "user");
  }

  async proposeButlerPreparedInstall(owner: string, input: {
    name: string;
    source: string;
    candidatePath: string;
    candidateArchiveBase64?: string;
    evidence: string;
    workerVerificationGoal?: string;
    runtimeRequirements?: string[];
  }): Promise<AgentSkillChangeProposal> {
    const name = safeName(input.name);
    const archive = input.candidateArchiveBase64
      ? Buffer.from(input.candidateArchiveBase64, "base64")
      : await archiveButlerSkillCandidate(name, input.candidatePath, this.options.butlerScratchRoot ?? "/scratch");
    return this.proposeAgentChange(owner, {
      operation: "install",
      environment: "butler-pi",
      name,
      source: input.source,
      scope: "user",
      candidateArchiveBase64: archive.toString("base64"),
      candidateEvidence: input.evidence,
      workerVerificationGoal: input.workerVerificationGoal,
      runtimeRequirements: input.runtimeRequirements
    });
  }

  async sealButlerSkillCandidate(nameInput: string, candidatePath: string): Promise<{ archiveBase64: string; verificationPath: string; cleanup: () => Promise<void> }> {
    return sealCandidate({
      name: safeName(nameInput),
      candidatePath,
      scratchRoot: this.options.butlerScratchRoot ?? "/scratch",
      normalizePermissions: (skillPath) => this.setInstalledPermissions(skillPath, "butler-pi", "user")
    });
  }

  async assertSealedButlerSkillCandidateUnchanged(nameInput: string, verificationPath: string, archiveBase64: string): Promise<void> {
    return assertSealedCandidateUnchanged({ name: safeName(nameInput), verificationPath, archiveBase64, scratchRoot: this.options.butlerScratchRoot ?? "/scratch" });
  }

  async proposeAgentChange(owner: string, rawInput: AgentSkillChangeInput): Promise<AgentSkillChangeProposal> {
    if (rawInput.operation === "install" && rawInput.candidateArchiveBase64) {
      return this.runAgentCandidateProposal(() => this.proposeAgentChangeUnlocked(owner, rawInput));
    }
    return this.proposeAgentChangeUnlocked(owner, rawInput);
  }

  private async proposeAgentChangeUnlocked(owner: string, rawInput: AgentSkillChangeInput): Promise<AgentSkillChangeProposal> {
    const normalizedOwner = this.agentOwner(owner);
    const now = Date.now();
    this.pruneAgentProposals(now);
    if (rawInput.operation === "install" && rawInput.candidateArchiveBase64) this.assertAgentCandidateProposalCapacity(normalizedOwner, now);
    const input = await this.normalizeAgentChange(rawInput, normalizedOwner);
    if (input.operation === "install" && input.archiveBase64) this.assertAgentCandidateProposalCapacity(normalizedOwner, Date.now());
    let environment: SkillEnvironmentId;
    let skillName: string;
    let skillScope: SkillScope;
    let source: string | null = null;
    let sourceVerification: AgentSkillChangeProposal["sourceVerification"] = "agent-reported";
    let beforeContent: string | null = null;
    let beforeHash: string | null = null;
    let summary: string;
    let description: string;
    let conflict = "No destination conflict found.";
    let approvedContent: string | Buffer;
    let contentEvidence: string;
    let footprint: string;
    let workerVerificationGoal: string | null = null;
    let runtimeRequirements: string[] = [];

    if (input.operation === "undo") {
      const result = this.requireAgentResult(normalizedOwner, input.resultId);
      if (!result.undo.available || result.undoneAt) throw new Error("This skill change can no longer be undone.");
      environment = result.environment;
      skillName = result.skill.name;
      skillScope = result.skill.scope;
      source = `change ${result.id}`;
      description = `Restore the state before the approved ${result.operation} change.`;
      if (result.previousArchiveBase64) {
        const previousArchive = Buffer.from(result.previousArchiveBase64, "base64");
        const inspected = await inspectAgentSkillArchive(skillName, previousArchive, MAX_SKILL_BYTES);
        approvedContent = previousArchive;
        contentEvidence = `${archiveSkillContentEvidence(inspected.files, MAX_AGENT_ARCHIVE_MANIFEST_EVIDENCE_BYTES)}\n${AGENT_SKILL_CONTENT_MARKER}\n${JSON.stringify(inspected.skillContent)}`;
        footprint = "Atomically restores the complete previous installation if the current replacement is unchanged.";
      } else {
        approvedContent = result.operation === "update" ? result.previousContent ?? "" : result.appliedContent ?? "";
        contentEvidence = result.operation === "update"
          ? this.fullContentEvidence(approvedContent, this.boundedContentDiff(result.appliedContent ?? "", approvedContent))
          : this.fullContentEvidence(approvedContent, "The complete SKILL.md below is approved for removal.");
        footprint = result.operation === "update"
          ? "Restores one managed SKILL.md. No hooks, scripts, or skill instructions are executed."
          : result.appliedArchiveManifest
            ? "Removes the complete approved Butler candidate when every installed file is unchanged. If files changed later, Manor removes SKILL.md and preserves the residual directory."
            : "Removes only the approved SKILL.md. If later files exist, Manor moves the residual directory to a unique hidden preserved location under the same skills root so the original name is reusable.";
      }
      summary = `Undo ${result.operation} of ${skillName} in ${this.agentTarget(environment, skillScope)}.`;
    } else {
      environment = input.environment;
      skillScope = input.operation === "update" ? "user" : input.scope ?? "user";
      if (input.operation === "update") {
        const current = await this.read(input.environment, input.id, input.cwd);
        if (!current.mutable) throw new Error("Package and system skills are read-only.");
        const validated = await this.validateSkillDocument(current.name, input.content);
        skillName = current.name;
        description = this.agentLine(validated.description, "Skill description", 1024);
        skillScope = current.scope;
        beforeContent = current.content;
        beforeHash = this.contentHash(current.content);
        approvedContent = input.content;
        contentEvidence = this.fullContentEvidence(input.content, this.boundedContentDiff(current.content, input.content));
        footprint = "Replaces one managed SKILL.md. Agent-managed changes do not add companion files and execute no hooks, scripts, or skill instructions.";
        source = input.reason;
        summary = `Update ${skillName} in ${this.agentTarget(environment, skillScope)}. Reason: ${input.reason}`;
      } else if (input.operation === "install") {
        skillName = input.name;
        workerVerificationGoal = input.workerVerificationGoal ?? `Load /skill:${skillName} and prove the capability works in the Worker environment.`;
        runtimeRequirements = [...(input.runtimeRequirements ?? [])];
        if (input.archiveBase64) {
          const archive = Buffer.from(input.archiveBase64, "base64");
          const inspected = await inspectAgentSkillArchive(skillName, archive, MAX_AGENT_SKILL_BYTES);
          input.archiveManifest = inspected.manifest;
          description = this.agentLine(inspected.description, "Skill description", 1024);
          approvedContent = archive;
          contentEvidence = `${archiveSkillContentEvidence(inspected.files, MAX_AGENT_ARCHIVE_MANIFEST_EVIDENCE_BYTES)}\n${AGENT_SKILL_CONTENT_MARKER}\n${JSON.stringify(inspected.skillContent)}${input.candidateEvidence ? `\n\nButler preparation evidence:\n${input.candidateEvidence}` : ""}`;
          footprint = `Publishes one Butler-prepared candidate containing ${inspected.files.length} files into the shared skill registry.`;
          sourceVerification = "butler-prepared";
          const replacement = await snapshotExistingSkill(await this.mutableRoot(environment, skillScope, input.cwd), skillName);
          if (replacement) {
            input.replacement = replacement;
            conflict = `An existing ${skillName} installation will be atomically replaced after a stale-state check.`;
            footprint = `Atomically replaces the existing skill with one Butler-prepared candidate containing ${inspected.files.length} files. The previous installation is retained for approved undo.`;
          } else {
            conflict = await this.assertAgentDestinationAvailable(environment, skillName, skillScope, input.cwd);
          }
        } else {
          const content = input.content ?? "";
          const validated = await this.validateSkillDocument(skillName, content);
          description = this.agentLine(validated.description, "Skill description", 1024);
          approvedContent = content;
          contentEvidence = this.fullContentEvidence(content, "Complete proposed single-document SKILL.md.");
          footprint = "Writes one managed SKILL.md. Agent-managed installs do not add companion files and execute no hooks, scripts, or skill instructions.";
          conflict = await this.assertAgentDestinationAvailable(environment, skillName, skillScope, input.cwd);
        }
        source = input.source;
        summary = `${input.replacement ? "Replace" : "Install"} ${skillName} in ${this.agentTarget(environment, skillScope)} from ${input.source}.`;
      } else {
        skillName = input.name;
        await this.validateSkillDocument(skillName, skillMarkdown(skillName, input.description, input.instructions));
        description = input.description;
        approvedContent = skillMarkdown(skillName, input.description, input.instructions);
        contentEvidence = this.fullContentEvidence(approvedContent, "Complete proposed single-document SKILL.md.");
        footprint = "Writes one managed SKILL.md. Agent-managed creation does not add companion files and executes no hooks, scripts, or skill instructions.";
        conflict = await this.assertAgentDestinationAvailable(environment, skillName, skillScope, input.cwd);
        summary = `Create ${skillName} in ${this.agentTarget(environment, skillScope)}.`;
      }
    }

    const id = `skill_change_${crypto.randomUUID()}`;
    const proposal: AgentSkillProposalRecord = {
      id,
      owner: normalizedOwner,
      input,
      operation: input.operation,
      summary,
      environment,
      skillName,
      scope: skillScope,
      source,
      sourceVerification,
      description,
      target: this.agentTarget(environment, skillScope),
      footprint,
      conflict,
      verificationPlan: sourceVerification === "butler-prepared"
        ? `Publish the exact validated candidate, reload Butler, then let a fresh Worker pursue this operational goal before declaring it ready: ${workerVerificationGoal}`
        : this.options.sharedSkillsDir && input.operation === "install"
          ? "Publish the approved skill document to the shared registry, reload Butler, then start a fresh Worker session and invoke it before declaring it ready."
        : environment === "butler-pi"
          ? "Reload the active Butler resources and confirm the resulting catalog entry and invocation."
          : "Confirm the resulting catalog entry and invocation. New Worker sessions load the change; an existing Worker session may need replacement.",
      workerVerificationGoal,
      runtimeRequirements,
      contentSha256: this.contentHash(approvedContent),
      contentEvidence,
      createdAt: now,
      expiresAt: now + AGENT_PROPOSAL_TTL_MS,
      status: "pending",
      resultId: null,
      error: null,
      beforeContent,
      beforeHash,
      questionMessageId: null,
      questionId: null
    };
    this.agentProposals.set(id, proposal);
    return this.publicAgentProposal(proposal);
  }

  agentApprovalOptions(proposalId: string): { approve: string; reject: string } {
    return {
      approve: `${AGENT_APPROVAL_PREFIX}:${proposalId}:approve`,
      reject: `${AGENT_APPROVAL_PREFIX}:${proposalId}:reject`
    };
  }

  bindAgentProposalQuestion(owner: string, proposalId: string, messageId: string, questionId: string): void {
    const proposal = this.requireAgentProposal(this.agentOwner(owner), proposalId);
    if (proposal.status !== "pending" || proposal.questionMessageId || proposal.questionId) {
      throw new Error("This skill change proposal cannot be attached to another approval question.");
    }
    proposal.questionMessageId = this.agentText(messageId, "Approval message id", 300);
    proposal.questionId = this.agentText(questionId, "Approval question id", 300);
  }

  validateAgentApprovalOption(owner: string, input: { messageId: string; questionId: string; optionId?: string }): void {
    const parsed = this.parseAgentApprovalOption(input.optionId);
    if (!parsed) return;
    const proposal = this.requireAgentProposal(this.agentOwner(owner), parsed.proposalId);
    this.assertAgentApprovalQuestion(proposal, input.messageId, input.questionId);
    if (proposal.status !== "pending" && !this.agentDecisionMatchesStatus(proposal, parsed.decision)) throw new Error("This skill change proposal is no longer awaiting approval.");
    if (proposal.expiresAt <= Date.now()) {
      this.clearAgentArchivePayload(proposal);
      throw new Error("This skill change proposal expired. Ask Butler to propose it again.");
    }
  }

  recordAgentApprovalOption(owner: string, input: { messageId: string; questionId: string; optionId?: string }): AgentSkillChangeProposal | null {
    const parsed = this.parseAgentApprovalOption(input.optionId);
    if (!parsed) return null;
    const proposal = this.requireAgentProposal(this.agentOwner(owner), parsed.proposalId);
    this.assertAgentApprovalQuestion(proposal, input.messageId, input.questionId);
    if (proposal.status !== "pending") {
      if (!this.agentDecisionMatchesStatus(proposal, parsed.decision)) throw new Error("This skill change proposal is no longer awaiting approval.");
      return this.publicAgentProposal(proposal);
    }
    if (proposal.expiresAt <= Date.now()) {
      this.clearAgentArchivePayload(proposal);
      throw new Error("This skill change proposal expired. Ask Butler to propose it again.");
    }
    proposal.status = parsed.decision === "approve" ? "approved" : "rejected";
    if (proposal.status === "rejected") this.clearAgentArchivePayload(proposal);
    return this.publicAgentProposal(proposal);
  }

  getAgentProposal(owner: string, proposalId: string): AgentSkillChangeProposal {
    this.pruneAgentProposals(Date.now());
    return this.publicAgentProposal(this.requireAgentProposal(this.agentOwner(owner), proposalId));
  }

  getAgentResult(owner: string, resultId: string): AgentSkillChangeResult {
    return this.publicAgentResult(this.requireAgentResult(this.agentOwner(owner), resultId));
  }

  async applyApprovedAgentChange(owner: string, proposalId: string): Promise<AgentSkillChangeResult> {
    return this.runMutation(() => this.applyApprovedAgentChangeUnlocked(owner, proposalId));
  }

  bindAgentResultVerification(owner: string, resultId: string, verificationThreadId: string): AgentSkillChangeResult {
    const result = this.requireAgentResult(this.agentOwner(owner), resultId);
    if (result.verification.operability !== "verification-pending") throw new Error("This skill change does not require Worker operability verification.");
    if (result.verification.verificationThreadId && result.verification.verificationThreadId !== verificationThreadId) {
      throw new Error("This skill change is already bound to another verification Worker.");
    }
    result.verification.verificationThreadId = verificationThreadId;
    return this.publicAgentResult(result);
  }

  confirmAgentResultVerification(owner: string, resultId: string, verificationThreadId: string): AgentSkillChangeResult {
    const result = this.requireAgentResult(this.agentOwner(owner), resultId);
    if (result.verification.operability !== "verification-pending") throw new Error("This skill change is not awaiting Worker operability verification.");
    if (result.verification.verificationThreadId !== verificationThreadId) throw new Error("The operability report came from the wrong Worker.");
    result.verification.operability = "ready";
    return this.publicAgentResult(result);
  }

  private async applyApprovedAgentChangeUnlocked(owner: string, proposalId: string): Promise<AgentSkillChangeResult> {
    const normalizedOwner = this.agentOwner(owner);
    const proposal = this.requireAgentProposal(normalizedOwner, proposalId);
    if (proposal.status === "applied" && proposal.resultId) return this.publicAgentResult(this.requireAgentResult(normalizedOwner, proposal.resultId));
    if (proposal.status !== "approved") throw new Error("The operator has not approved this skill change.");
    if (proposal.expiresAt <= Date.now()) {
      this.clearAgentArchivePayload(proposal);
      throw new Error("This skill change proposal expired. Ask Butler to propose it again.");
    }
    proposal.status = "applying";
    proposal.error = null;
    try {
      const applied = await this.applyAgentProposal(proposal);
      proposal.status = "applied";
      proposal.resultId = applied.id;
      this.agentResults.set(applied.id, applied);
      this.clearAgentArchivePayload(proposal);
      return this.publicAgentResult(applied);
    } catch (error) {
      proposal.status = "failed";
      proposal.error = error instanceof Error ? error.message : String(error);
      this.clearAgentArchivePayload(proposal);
      throw error;
    }
  }

  listEnvironments(): SkillEnvironmentView[] {
    return ENVIRONMENTS.map((entry) => ({ ...entry, capabilities: { ...entry.capabilities } }));
  }

  async list(environmentId: SkillEnvironmentId, cwd?: string | null): Promise<SkillCatalogItem[]> {
    return (await this.records(environmentId, cwd)).map((record) => this.publicItem(record));
  }

  async read(environmentId: SkillEnvironmentId, id: string, cwd?: string | null): Promise<SkillCatalogItem & { content: string }> {
    const record = await this.findRecord(environmentId, id, cwd);
    if ((await fs.stat(record.filePath)).size > MAX_SKILL_BYTES) throw new Error("Skill content is too large.");
    const content = await fs.readFile(record.filePath, "utf8");
    return { ...this.publicItem(record), content };
  }

  async resolveInputItem(environmentId: SkillEnvironmentId, id: string, cwd?: string | null): Promise<{
    type: "skill";
    name: string;
    path: string;
  }> {
    const record = await this.findRecord(environmentId, id, cwd);
    return { type: "skill", name: record.name, path: record.inputPath };
  }

  async create(input: {
    environment: SkillEnvironmentId;
    name: string;
    description: string;
    instructions: string;
    scope?: SkillScope;
    cwd?: string | null;
  }): Promise<SkillCatalogItem> {
    return this.runMutation(() => this.createUnlocked(input));
  }

  private async createUnlocked(input: {
    environment: SkillEnvironmentId;
    name: string;
    description: string;
    instructions: string;
    scope?: SkillScope;
    cwd?: string | null;
  }): Promise<SkillCatalogItem> {
    const name = safeName(input.name);
    const scope = input.scope ?? "user";
    const root = await this.mutableRoot(input.environment, scope, input.cwd);
    const targetDir = path.join(root, name);
    if (!isWithin(root, targetDir)) throw new Error("Invalid skill destination.");
    await this.ensureMutableRoot(root, input.environment, scope);
    if (await exists(targetDir)) throw new Error(`A skill named ${name} already exists.`);
    const staged = await fs.mkdtemp(path.join(root, ".manor-create-"));
    try {
      const content = skillMarkdown(name, input.description, input.instructions);
      if (Buffer.byteLength(content, "utf8") > MAX_SKILL_BYTES) throw new Error("Skill content is too large.");
      await fs.writeFile(path.join(staged, "SKILL.md"), content, { encoding: "utf8", mode: 0o600 });
      this.assertValidSkillDir(staged, name);
      await this.setInstalledPermissions(staged, input.environment, scope);
      await fs.rename(staged, targetDir);
    } catch (error) {
      await fs.rm(staged, { recursive: true, force: true });
      throw error;
    }
    return this.findByPath(await this.records(input.environment, input.cwd), path.join(targetDir, "SKILL.md"));
  }

  async edit(input: {
    environment: SkillEnvironmentId;
    id: string;
    content: string;
    cwd?: string | null;
  }): Promise<SkillCatalogItem> {
    return this.runMutation(() => this.editUnlocked(input));
  }

  private async editUnlocked(input: {
    environment: SkillEnvironmentId;
    id: string;
    content: string;
    cwd?: string | null;
  }): Promise<SkillCatalogItem> {
    if (Buffer.byteLength(input.content, "utf8") > MAX_SKILL_BYTES) throw new Error("Skill content is too large.");
    const record = await this.findMutableRecord(input.environment, input.id, input.cwd);
    const staged = await fs.mkdtemp(path.join(path.dirname(record.baseDir), ".manor-edit-"));
    try {
      await fs.writeFile(path.join(staged, "SKILL.md"), input.content, { encoding: "utf8", mode: 0o600 });
      this.assertValidSkillDir(staged, record.name);
      const tempFile = path.join(record.baseDir, `.SKILL.md.${crypto.randomUUID()}.tmp`);
      await fs.copyFile(path.join(staged, "SKILL.md"), tempFile);
      await fs.chmod(tempFile, this.fileMode(input.environment, false, record.scope));
      await this.setManagedOwnership(tempFile, input.environment, record.scope);
      await fs.rename(tempFile, record.filePath);
    } finally {
      await fs.rm(staged, { recursive: true, force: true });
    }
    return this.publicItem(await this.findRecord(input.environment, input.id, input.cwd));
  }

  async delete(environmentId: SkillEnvironmentId, id: string, cwd?: string | null): Promise<void> {
    return this.runMutation(() => this.deleteUnlocked(environmentId, id, cwd));
  }

  private async deleteUnlocked(environmentId: SkillEnvironmentId, id: string, cwd?: string | null): Promise<void> {
    const record = await this.findMutableRecord(environmentId, id, cwd);
    const root = await this.mutableRecordRoot(environmentId, record, cwd);
    const target = path.basename(record.filePath) === "SKILL.md" ? record.baseDir : record.filePath;
    if (path.resolve(target) === path.resolve(root) || !isWithin(root, target)) throw new Error("Invalid skill destination.");
    await fs.rm(target, { recursive: true, force: false });
  }

  async importArchive(input: {
    environment: SkillEnvironmentId;
    archiveBase64: string;
    scope?: SkillScope;
    cwd?: string | null;
  }): Promise<SkillCatalogItem[]> {
    return this.runMutation(() => this.importArchiveUnlocked(input));
  }

  private async importArchiveUnlocked(input: {
    environment: SkillEnvironmentId;
    archiveBase64: string;
    scope?: SkillScope;
    cwd?: string | null;
  }): Promise<SkillCatalogItem[]> {
    const archive = Buffer.from(input.archiveBase64, "base64");
    if (archive.length === 0 || archive.length > MAX_SKILL_ARCHIVE_BYTES) throw new Error("Skill archive is empty or too large.");
    const scope = input.scope ?? "user";
    const root = await this.mutableRoot(input.environment, scope, input.cwd);
    await this.ensureMutableRoot(root, input.environment, scope);
    const staged = await fs.mkdtemp(path.join(root, ".manor-import-"));
    const installedPaths: string[] = [];
    try {
      const extracted = await extractSkillArchive(archive, staged);
      for (const entry of extracted.entries) {
        if (await exists(path.join(root, entry.name))) throw new Error(`A skill named ${entry.name} already exists.`);
      }
      for (const entry of extracted.entries) {
        const destination = path.join(root, entry.name);
        const stagedSkill = path.join(staged, entry.archiveRoot);
        await this.setInstalledPermissions(stagedSkill, input.environment, scope);
        await fs.rename(stagedSkill, destination);
        installedPaths.push(path.join(destination, "SKILL.md"));
      }
    } catch (error) {
      for (const installed of installedPaths) await fs.rm(path.dirname(installed), { recursive: true, force: true });
      throw error;
    } finally {
      await fs.rm(staged, { recursive: true, force: true });
    }
    const records = await this.records(input.environment, input.cwd);
    return Promise.all(installedPaths.map(async (filePath) => this.publicItem(await this.findByPath(records, filePath))));
  }

  private async installAgentDocument(input: {
    environment: SkillEnvironmentId;
    name: string;
    content: string;
    scope: SkillScope;
    cwd?: string | null;
  }): Promise<SkillCatalogItem> {
    const name = safeName(input.name);
    if (Buffer.byteLength(input.content, "utf8") > MAX_SKILL_BYTES) throw new Error("Skill content is too large.");
    await this.validateSkillDocument(name, input.content);
    const root = await this.mutableRoot(input.environment, input.scope, input.cwd);
    const targetDir = path.join(root, name);
    if (!isWithin(root, targetDir)) throw new Error("Invalid skill destination.");
    await this.ensureMutableRoot(root, input.environment, input.scope);
    if (await exists(targetDir)) throw new Error(`A skill named ${name} already exists.`);
    const staged = await fs.mkdtemp(path.join(root, ".manor-install-"));
    try {
      await fs.writeFile(path.join(staged, "SKILL.md"), input.content, { encoding: "utf8", mode: 0o600 });
      this.assertValidSkillDir(staged, name);
      await this.setInstalledPermissions(staged, input.environment, input.scope);
      await fs.rename(staged, targetDir);
    } catch (error) {
      await fs.rm(staged, { recursive: true, force: true });
      throw error;
    }
    return this.findByPath(await this.records(input.environment, input.cwd), path.join(targetDir, "SKILL.md"));
  }

  private async applyAgentProposal(proposal: AgentSkillProposalRecord): Promise<AgentSkillResultRecord> {
    const input = proposal.input;
    if (input.operation === "undo") return this.applyAgentUndo(proposal, input.resultId);
    let skill: SkillCatalogItem;
    let appliedContent: string;
    let createdSkillId: string | null = null;
    let previousContent: string | null = null;
    let appliedArchiveManifest: Array<{ path: string; sha256: string }> | null = null;
    let previousArchiveBase64: string | null = null;
    let installedArchiveSha256: string | null = null;
    const cwd = input.cwd?.trim() || null;
    if (input.operation === "update") {
      const current = await this.read(input.environment, input.id, input.cwd);
      if (this.contentHash(current.content) !== proposal.beforeHash) {
        throw new Error("The skill changed after approval was requested. Review and approve a fresh proposal.");
      }
      previousContent = proposal.beforeContent;
      skill = await this.editUnlocked({ environment: input.environment, id: input.id, content: input.content, cwd: input.cwd });
      appliedContent = input.content;
    } else if (input.operation === "install") {
      if (input.archiveBase64) {
        const archive = Buffer.from(input.archiveBase64, "base64");
        if (this.contentHash(archive) !== proposal.contentSha256) {
          throw new Error("The Butler-prepared skill candidate changed after approval was requested. Prepare a fresh candidate.");
        }
        const imported = input.replacement
          ? [await this.replaceAgentArchiveUnlocked({
              environment: input.environment,
              name: input.name,
              archiveBase64: input.archiveBase64,
              expectedCurrentSha256: input.replacement.archiveSha256,
              scope: input.scope ?? "user",
              cwd: input.cwd
            })]
          : await this.importArchiveUnlocked({
              environment: input.environment,
              archiveBase64: input.archiveBase64,
              scope: input.scope ?? "user",
              cwd: input.cwd
            });
        if (imported.length !== 1 || imported[0]?.name !== input.name) throw new Error("The approved Butler candidate did not install the expected skill.");
        skill = imported[0];
        appliedContent = (await this.read(skill.environment, skill.id, input.cwd)).content;
        appliedArchiveManifest = input.archiveManifest?.map((entry) => ({ ...entry })) ?? null;
        previousArchiveBase64 = input.replacement?.archiveBase64 ?? null;
        const installedRecord = await this.findRecord(skill.environment, skill.id, input.cwd);
        const installedArchive = await archiveSkillDirectory(input.name, await fs.realpath(installedRecord.baseDir));
        installedArchiveSha256 = this.contentHash(installedArchive);
      } else {
        const content = input.content ?? "";
        skill = await this.installAgentDocument({
          environment: input.environment,
          name: input.name,
          content,
          scope: input.scope ?? "user",
          cwd: input.cwd
        });
        appliedContent = content;
      }
      createdSkillId = input.operation === "install" && input.archiveBase64 && input.replacement ? null : skill.id;
    } else {
      skill = await this.createUnlocked(input);
      createdSkillId = skill.id;
      appliedContent = skillMarkdown(input.name, input.description, input.instructions);
    }
    const id = `skill_result_${crypto.randomUUID()}`;
    return {
      id,
      owner: proposal.owner,
      proposalId: proposal.id,
      operation: proposal.operation,
      skill,
      environment: skill.environment,
      cwd,
      createdSkillId,
      previousContent,
      appliedContentHash: this.contentHash(appliedContent),
      appliedContent,
      appliedArchiveManifest,
      previousArchiveBase64,
      installedArchiveSha256,
      appliedAt: Date.now(),
      undoneAt: null,
      verification: {
        catalogVisible: true,
        invocation: skill.invocation,
        resourceReload: this.options.sharedSkillsDir || skill.environment === "butler-pi" ? "scheduled" : "next-session",
        operability: input.operation === "install" && (Boolean(input.archiveBase64) || Boolean(this.options.sharedSkillsDir)) ? "verification-pending" : "ready",
        verificationThreadId: null,
        goal: proposal.workerVerificationGoal,
        runtimeRequirements: [...proposal.runtimeRequirements]
      },
      undo: {
        available: true,
        resultId: id,
        instruction: `Use propose_skill_change with operation undo and resultId ${id}, then wait for operator approval.`,
        preservedLocation: null
      }
    };
  }

  private async applyAgentUndo(proposal: AgentSkillProposalRecord, resultId: string): Promise<AgentSkillResultRecord> {
    const original = this.requireAgentResult(proposal.owner, resultId);
    if (!original.undo.available || original.undoneAt) throw new Error("This skill change can no longer be undone.");
    const current = await this.read(original.environment, original.skill.id, original.cwd);
    if (!original.appliedContentHash || this.contentHash(current.content) !== original.appliedContentHash) {
      throw new Error("The skill changed after this result was created. Review and approve a new change instead of undoing it.");
    }
    let skill: SkillCatalogItem;
    let preservedLocation: string | null = null;
    if (original.operation === "update") {
      if (original.previousContent === null) throw new Error("The previous skill content is unavailable.");
      skill = await this.editUnlocked({
        environment: original.environment,
        id: original.skill.id,
        content: original.previousContent,
        cwd: original.cwd
      });
    } else if (original.previousArchiveBase64) {
      if (!original.installedArchiveSha256) throw new Error("The installed skill archive state is unavailable.");
      skill = await this.replaceAgentArchiveUnlocked({
        environment: original.environment,
        name: original.skill.name,
        archiveBase64: original.previousArchiveBase64,
        expectedCurrentSha256: original.installedArchiveSha256,
        scope: original.skill.scope,
        cwd: original.cwd
      });
    } else {
      if (!original.createdSkillId) throw new Error("The installed skill record is unavailable.");
      if (!original.appliedContent) throw new Error("The approved skill content is unavailable.");
      const removedArchive = original.appliedArchiveManifest
        ? await this.removeAgentArchiveIfUnchanged(original.environment, original.createdSkillId, original.appliedArchiveManifest, original.cwd)
        : false;
      if (!removedArchive) {
        preservedLocation = await this.removeAgentSkillDocument(original.environment, original.createdSkillId, original.appliedContent, original.cwd);
      }
      skill = original.skill;
    }
    original.undoneAt = Date.now();
    original.undo.available = false;
    const id = `skill_result_${crypto.randomUUID()}`;
    return {
      id,
      owner: proposal.owner,
      proposalId: proposal.id,
      operation: "undo",
      skill,
      environment: original.environment,
      cwd: original.cwd,
      createdSkillId: null,
      previousContent: null,
      appliedContentHash: original.operation === "update" && original.previousContent ? this.contentHash(original.previousContent) : null,
      appliedContent: original.operation === "update" ? original.previousContent : null,
      appliedArchiveManifest: null,
      previousArchiveBase64: null,
      installedArchiveSha256: null,
      appliedAt: Date.now(),
      undoneAt: null,
      verification: {
        catalogVisible: original.operation === "update",
        invocation: skill.invocation,
        resourceReload: this.options.sharedSkillsDir || original.environment === "butler-pi" ? "scheduled" : "next-session",
        operability: "ready",
        verificationThreadId: null,
        goal: null,
        runtimeRequirements: []
      },
      undo: {
        available: false,
        resultId: id,
        instruction: preservedLocation
          ? `This undo cannot be undone automatically. Later files were preserved at ${preservedLocation}.`
          : "This undo cannot be undone automatically.",
        preservedLocation
      }
    };
  }

  private async normalizeAgentChange(input: AgentSkillChangeInput, owner: string): Promise<NormalizedAgentSkillChangeInput> {
    if (!input || typeof input !== "object") throw new Error("Skill change input is required.");
    if (input.operation === "undo") {
      const resultId = typeof input.resultId === "string" ? input.resultId.trim() : "";
      this.requireAgentResult(owner, resultId);
      return { operation: "undo", resultId };
    }
    if (!ENVIRONMENTS.some((entry) => entry.id === input.environment)) throw new Error("Unknown skill environment.");
    const cwd = input.cwd?.trim() || null;
    if (input.operation === "update") {
      const id = typeof input.id === "string" ? input.id.trim() : "";
      const reason = this.agentLine(input.reason, "Update reason", 1000);
      const content = input.content ?? "";
      this.assertAgentSingleDocument(content);
      return { operation: "update", environment: input.environment, id, content, reason, cwd };
    }
    const changeScope = input.scope === "project" ? "project" : "user";
    if (input.operation === "install") {
      const source = this.agentLine(input.source, "Skill source", 2048);
      const content = input.content ?? "";
      const requestedName = typeof input.name === "string" ? input.name.trim() : "";
      const name = safeName(requestedName);
      if (input.candidateArchiveBase64) {
        if (input.environment !== "butler-pi" || changeScope !== "user") throw new Error("Butler-prepared repository skills publish only to the shared skill registry.");
        const evidence = this.agentText(input.candidateEvidence, "Butler preparation evidence", 12_000);
        const archive = Buffer.from(input.candidateArchiveBase64, "base64");
        if (archive.length === 0 || archive.length > MAX_SKILL_ARCHIVE_BYTES) throw new Error("Butler skill candidate is empty or too large.");
        return {
          operation: "install",
          environment: input.environment,
          name,
          archiveBase64: archive.toString("base64"),
          candidateEvidence: evidence,
          workerVerificationGoal: this.agentText(input.workerVerificationGoal ?? `Load /skill:${name} and prove the capability works in the Worker environment.`, "Worker verification goal", 2_000),
          runtimeRequirements: this.agentTextList(input.runtimeRequirements, "Runtime requirements", 20, 1_000),
          source,
          scope: changeScope,
          cwd
        };
      }
      if (content.trim()) {
        this.assertAgentSingleDocument(content);
        return { operation: "install", environment: input.environment, name, content, source, scope: changeScope, cwd };
      }
      throw new Error("Repository-backed skill installation is Butler-led. Prepare it in Butler scratch, verify it, then propose the prepared candidate.");
    }
    const name = safeName(input.name);
    const created: AgentSkillChangeInput = {
      operation: "create",
      environment: input.environment,
      name,
      description: this.agentText(input.description, "Skill description", 1024),
      instructions: this.agentText(input.instructions, "Skill instructions", MAX_AGENT_SKILL_BYTES),
      scope: changeScope,
      cwd
    };
    this.assertAgentSingleDocument(skillMarkdown(created.name, created.description, created.instructions));
    return created;
  }

  private assertAgentSingleDocument(content: string): void {
    if (Buffer.byteLength(content, "utf8") > MAX_AGENT_SKILL_BYTES) {
      throw new Error(`Agent-managed SKILL.md content must be ${MAX_AGENT_SKILL_BYTES} bytes or fewer. Use Settings → Skills → Advanced for larger or archive-based installs.`);
    }
    const companionPath = /(?:^|[\s`'"(])(?:\.\.\/|\.\/)?(?:scripts|tools?|assets|references|templates|examples|docs|bin|lib|src|config|data|prompts)\/[A-Za-z0-9._~!$&'()*+,;=:@%\/-]+/im.test(content);
    const actionFileReference = /\b(?:run|execute|load|import|source|consult|see|copy|render|read|open|use|follow|check|review|refer(?:\s+to)?)\s+(?:the\s+)?[`'"]?(?:\.\.\/|\.\/)?(?:[A-Za-z0-9._@%+,-]+\/)*[A-Za-z0-9._@%+,-]+\.(?:py|js|mjs|cjs|ts|tsx|sh|bash|zsh|rb|pl|php|md|txt|json|ya?ml|toml|csv|html|css|sql|wasm|png|jpe?g|svg|pdf|docx|xlsx|pptx)\b/im.test(content);
    const commandFileReference = /^\s*(?:\$\s*)?(?:python\d*|node|deno|bun|bash|sh|zsh|ruby|perl|php)\s+(?:\.\.\/|\.\/)?\S+\.(?:py|js|mjs|cjs|ts|tsx|sh|bash|zsh|rb|pl|php)\b/im.test(content);
    const directExecutableReference = /^\s*(?:\$\s*)?(?:\.\.\/|\.\/)\S+\.(?:py|js|mjs|cjs|ts|tsx|sh|bash|zsh|rb|pl|php)\b/im.test(content);
    const inlineRelativeLink = [...content.matchAll(/!?\[[^\]]*\]\(([^)]+)\)/g)].some((match) => {
      const destination = (match[1] ?? "").trim().replace(/^<|>$/g, "").split(/\s+/)[0] ?? "";
      return Boolean(destination) && !/^(?:https?:|mailto:|data:|#|\/)/i.test(destination);
    });
    const referenceRelativeLink = /^\s*\[[^\]]+\]:\s*(?!https?:|mailto:|data:|#|\/)(?:<)?\S+/im.test(content);
    if (companionPath || actionFileReference || commandFileReference || directExecutableReference || inlineRelativeLink || referenceRelativeLink) {
      throw new Error("Agent-managed skill changes support one self-contained SKILL.md only. The conservative guard rejects ambiguous file-like instructions that may refer to companion files, conventional resource directories, or relative Markdown links. Use explicit https:// URLs, clearly qualify runtime-generated paths, or use Settings → Skills → Advanced archive install for multi-file skills.");
    }
  }

  private agentText(value: unknown, label: string, maxLength: number): string {
    const text = typeof value === "string" ? value.trim() : "";
    if (!text || text.length > maxLength) throw new Error(`${label} must be between 1 and ${maxLength} characters.`);
    return text;
  }

  private agentTextList(value: unknown, label: string, maxItems: number, maxLength: number): string[] {
    if (value === undefined) return [];
    if (!Array.isArray(value) || value.length > maxItems) throw new Error(`${label} must contain ${maxItems} items or fewer.`);
    return value.map((entry) => this.agentText(entry, label, maxLength));
  }

  private agentLine(value: unknown, label: string, maxLength: number): string {
    const text = this.agentText(value, label, maxLength);
    if (/[\r\n]/.test(text)) throw new Error(`${label} must be a single line.`);
    return text;
  }

  private agentOwner(owner: string): string {
    const normalized = typeof owner === "string" ? owner.trim() : "";
    if (!normalized || normalized.length > 200) throw new Error("Skill change owner is invalid.");
    return normalized;
  }

  private parseAgentApprovalOption(optionId?: string): { proposalId: string; decision: "approve" | "reject" } | null {
    if (typeof optionId !== "string" || !optionId.startsWith(`${AGENT_APPROVAL_PREFIX}:`)) return null;
    const match = optionId.match(/^skill-change:(skill_change_[0-9a-f-]+):(approve|reject)$/);
    if (!match) throw new Error("Skill change approval is invalid.");
    return { proposalId: match[1]!, decision: match[2] as "approve" | "reject" };
  }

  private requireAgentProposal(owner: string, id: string): AgentSkillProposalRecord {
    const proposal = this.agentProposals.get(id);
    if (!proposal || proposal.owner !== owner) throw new Error("Skill change proposal was not found.");
    return proposal;
  }

  private pruneAgentProposals(now: number): void {
    for (const proposal of this.agentProposals.values()) {
      if (proposal.expiresAt <= now) this.clearAgentArchivePayload(proposal);
    }
  }

  private clearAgentArchivePayload(proposal: AgentSkillProposalRecord): void {
    if (proposal.input.operation !== "install") return;
    proposal.input.archiveBase64 = undefined;
    proposal.input.archiveManifest = undefined;
  }

  private assertAgentCandidateProposalCapacity(owner: string, now: number): void {
    this.pruneAgentProposals(now);
    const active = [...this.agentProposals.values()].filter((proposal) =>
      proposal.expiresAt > now && proposal.input.operation === "install" && Boolean(proposal.input.archiveBase64)
    );
    if (active.filter((proposal) => proposal.owner === owner).length >= MAX_PENDING_BUTLER_CANDIDATES_PER_OWNER) {
      throw new Error("Too many pending Butler skill candidates for this session. Approve, reject, or wait for an existing proposal to expire.");
    }
    if (active.length >= MAX_PENDING_BUTLER_CANDIDATES_GLOBAL) {
      throw new Error("Too many pending Butler skill candidates. Approve, reject, or wait for an existing proposal to expire.");
    }
  }

  private requireAgentResult(owner: string, id: string): AgentSkillResultRecord {
    const result = this.agentResults.get(id);
    if (!result || result.owner !== owner) throw new Error("Skill change result was not found.");
    return result;
  }

  private async removeAgentSkillDocument(environmentId: SkillEnvironmentId, id: string, approvedContent: string, cwd?: string | null): Promise<string | null> {
    const record = await this.findMutableRecord(environmentId, id, cwd);
    const root = await this.mutableRecordRoot(environmentId, record, cwd);
    if (path.basename(record.filePath) !== "SKILL.md" || path.resolve(record.baseDir) === path.resolve(root) || !isWithin(root, record.filePath)) {
      throw new Error("Invalid agent-managed skill destination.");
    }
    await fs.unlink(record.filePath);
    try {
      await fs.rmdir(record.baseDir);
      return null;
    } catch (error) {
      if (!["ENOTEMPTY", "EEXIST"].includes((error as NodeJS.ErrnoException).code ?? "")) {
        return await this.restoreRemovedAgentDocument(record.filePath, approvedContent, error);
      }
    }
    const preserved = path.join(root, `.manor-preserved-${record.name}-${crypto.randomUUID()}`);
    if (!isWithin(root, preserved)) throw new Error("Invalid preserved skill destination.");
    try {
      await fs.rename(record.baseDir, preserved);
      return preserved;
    } catch (error) {
      return await this.restoreRemovedAgentDocument(record.filePath, approvedContent, error);
    }
  }

  private async removeAgentArchiveIfUnchanged(
    environmentId: SkillEnvironmentId,
    id: string,
    approvedManifest: Array<{ path: string; sha256: string }>,
    cwd?: string | null
  ): Promise<boolean> {
    const record = await this.findMutableRecord(environmentId, id, cwd);
    const root = await this.mutableRecordRoot(environmentId, record, cwd);
    if (path.basename(record.filePath) !== "SKILL.md" || path.resolve(record.baseDir) === path.resolve(root) || !isWithin(root, record.baseDir)) {
      throw new Error("Invalid agent-managed skill destination.");
    }
    const currentManifest = await this.agentArchiveDirectoryManifest(record.baseDir);
    const expected = approvedManifest.slice().sort((left, right) => left.path.localeCompare(right.path));
    if (currentManifest.length !== expected.length || currentManifest.some((entry, index) => entry.path !== expected[index]?.path || entry.sha256 !== expected[index]?.sha256)) {
      return false;
    }
    await fs.rm(record.baseDir, { recursive: true, force: false });
    return true;
  }

  private async agentArchiveDirectoryManifest(baseDir: string): Promise<Array<{ path: string; sha256: string }>> {
    const manifest: Array<{ path: string; sha256: string }> = [];
    const visit = async (directory: string): Promise<void> => {
      for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
        const fullPath = path.join(directory, entry.name);
        if (!isWithin(baseDir, fullPath) || entry.isSymbolicLink()) throw new Error("The installed skill contains an unsafe file.");
        if (entry.isDirectory()) {
          await visit(fullPath);
        } else if (entry.isFile()) {
          manifest.push({
            path: path.relative(baseDir, fullPath).split(path.sep).join("/"),
            sha256: this.contentHash(await fs.readFile(fullPath))
          });
        } else {
          throw new Error("The installed skill contains an unsupported file type.");
        }
      }
    };
    await visit(baseDir);
    return manifest.sort((left, right) => left.path.localeCompare(right.path));
  }

  private async restoreRemovedAgentDocument(filePath: string, content: string, originalError: unknown): Promise<never> {
    try {
      await fs.writeFile(filePath, content, { encoding: "utf8", mode: 0o600, flag: "wx" });
    } catch (restoreError) {
      throw new Error(`Skill undo failed and SKILL.md could not be restored: ${restoreError instanceof Error ? restoreError.message : String(restoreError)}`, { cause: originalError });
    }
    throw originalError;
  }

  private runMutation<T>(work: () => Promise<T>): Promise<T> {
    const run = this.mutationTail.then(work, work);
    this.mutationTail = run.then(() => undefined, () => undefined);
    return run;
  }

  private runAgentCandidateProposal<T>(work: () => Promise<T>): Promise<T> {
    const run = this.agentCandidateProposalTail.then(work, work);
    this.agentCandidateProposalTail = run.then(() => undefined, () => undefined);
    return run;
  }

  private assertAgentApprovalQuestion(proposal: AgentSkillProposalRecord, messageId: string, questionId: string): void {
    if (!proposal.questionMessageId || !proposal.questionId || proposal.questionMessageId !== messageId || proposal.questionId !== questionId) {
      throw new Error("This approval does not belong to the skill change proposal.");
    }
  }

  private agentDecisionMatchesStatus(proposal: AgentSkillProposalRecord, decision: "approve" | "reject"): boolean {
    return (decision === "approve" && ["approved", "applying", "applied", "failed"].includes(proposal.status)) ||
      (decision === "reject" && proposal.status === "rejected");
  }

  private publicAgentProposal(proposal: AgentSkillProposalRecord): AgentSkillChangeProposal {
    const { owner: _owner, input: _input, beforeContent: _beforeContent, beforeHash: _beforeHash, questionMessageId: _questionMessageId, questionId: _questionId, ...view } = proposal;
    return { ...view, runtimeRequirements: [...view.runtimeRequirements] };
  }

  private publicAgentResult(result: AgentSkillResultRecord): AgentSkillChangeResult {
    const { owner: _owner, environment: _environment, cwd: _cwd, createdSkillId: _createdSkillId, previousContent: _previousContent, appliedContentHash: _appliedContentHash, appliedContent: _appliedContent, appliedArchiveManifest: _appliedArchiveManifest, previousArchiveBase64: _previousArchiveBase64, installedArchiveSha256: _installedArchiveSha256, undoneAt: _undoneAt, ...view } = result;
    return { ...view, verification: { ...view.verification, runtimeRequirements: [...view.verification.runtimeRequirements] }, undo: { ...view.undo }, skill: { ...view.skill, capabilities: { ...view.skill.capabilities } } };
  }

  private contentHash(content: string | Buffer): string {
    return crypto.createHash("sha256").update(content).digest("hex");
  }

  private environmentLabel(environmentId: SkillEnvironmentId): string {
    if (environmentId === "butler-pi") return "Butler Pi (butler-pi)";
    return "Worker Pi (worker-pi)";
  }

  private agentTarget(environmentId: SkillEnvironmentId, scope: SkillScope): string {
    return this.options.sharedSkillsDir && scope === "user"
      ? "shared Butler and Worker registry / user scope"
      : `${this.environmentLabel(environmentId)} / ${scope} scope`;
  }

  private fullContentEvidence(content: string, heading: string): string {
    return `${heading}\n${AGENT_SKILL_CONTENT_MARKER}\n${JSON.stringify(content)}`;
  }

  private boundedContentDiff(before: string, after: string): string {
    const beforeLines = before.split("\n");
    const afterLines = after.split("\n");
    const changes: string[] = [];
    let size = 0;
    for (let index = 0; index < Math.max(beforeLines.length, afterLines.length); index += 1) {
      if (beforeLines[index] === afterLines[index]) continue;
      const oldLine = beforeLines[index] === undefined ? null : beforeLines[index]!.slice(0, 500);
      const newLine = afterLines[index] === undefined ? null : afterLines[index]!.slice(0, 500);
      const entry = `line ${index + 1}: -${JSON.stringify(oldLine)} +${JSON.stringify(newLine)}`;
      if (size + entry.length > 2000) {
        changes.push("[diff truncated; SHA-256 identifies the complete approved content]");
        break;
      }
      changes.push(entry);
      size += entry.length;
    }
    return `bounded JSON-escaped line diff: ${changes.join("\n") || "no content changes"}`;
  }

  private async replaceAgentArchiveUnlocked(input: {
    environment: SkillEnvironmentId;
    name: string;
    archiveBase64: string;
    expectedCurrentSha256: string;
    scope: SkillScope;
    cwd?: string | null;
  }): Promise<SkillCatalogItem> {
    const name = safeName(input.name);
    const root = await this.mutableRoot(input.environment, input.scope, input.cwd);
    await this.ensureMutableRoot(root, input.environment, input.scope);
    return replaceExistingSkillArchive({
      root,
      name,
      archiveBase64: input.archiveBase64,
      expectedCurrentSha256: input.expectedCurrentSha256,
      validateArchive: async (archive) => {
        const inspected = await inspectAgentSkillArchive(name, archive, MAX_SKILL_BYTES);
        if (inspected.files.length === 0) throw new Error("Replacement skill archive is empty.");
      },
      importArchive: async () => {
        const imported = await this.importArchiveUnlocked({
          environment: input.environment,
          archiveBase64: input.archiveBase64,
          scope: input.scope,
          cwd: input.cwd
        });
        if (imported.length !== 1 || imported[0]?.name !== name) throw new Error("Replacement did not install the expected skill.");
        return imported[0];
      }
    });
  }

  private async assertAgentDestinationAvailable(environmentId: SkillEnvironmentId, name: string, skillScope: SkillScope, cwd?: string | null): Promise<string> {
    const resolvedCwd = await this.resolveCwd(cwd);
    const roots = this.roots(environmentId, resolvedCwd);
    const root = skillScope === "project" ? roots.project : roots.user;
    if (await exists(path.join(root, name))) throw new Error(`A skill named ${name} already exists at the requested destination.`);
    const sameNamed = (await this.list(environmentId, cwd)).filter((skill) => skill.name === name);
    return sameNamed.length === 0
      ? "No destination conflict found."
      : `Destination is clear; ${sameNamed.length} same-named skill${sameNamed.length === 1 ? " exists" : "s exist"} elsewhere in the catalog and may be shadowed.`;
  }

  private sharedSkillsRoot(environmentId: SkillEnvironmentId): string {
    if (this.options.sharedSkillsDir) return path.resolve(this.options.sharedSkillsDir);
    const agentDir = environmentId === "butler-pi" ? this.options.butlerPiAgentDir : this.options.workerPiAgentDir;
    return path.resolve(agentDir, "skills");
  }

  private async validateSkillDocument(name: string, content: string): Promise<Skill> {
    if (Buffer.byteLength(content, "utf8") > MAX_SKILL_BYTES) throw new Error("Skill content is too large.");
    const root = await fs.mkdtemp(path.join(tmpdir(), "manor-skill-validate-"));
    try {
      await fs.writeFile(path.join(root, "SKILL.md"), content, { encoding: "utf8", mode: 0o600 });
      this.assertValidSkillDir(root, name);
      return loadSkillsFromDir({ dir: root, source: "staged" }).skills[0]!;
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  }

  private async records(environmentId: SkillEnvironmentId, cwd?: string | null): Promise<SkillRecord[]> {
    const environmentView = ENVIRONMENTS.find((entry) => entry.id === environmentId);
    if (!environmentView) throw new Error("Unknown skill environment.");
    const resolvedCwd = await this.resolveCwd(cwd);
    const roots = this.roots(environmentId, resolvedCwd);
    const collected: Array<{ skill: Skill; originHint?: SkillOrigin; inputPath?: string }> = [];
    collected.push(...loadSkillsFromDir({ dir: roots.user, source: "user" }).skills.map((skill) => ({ skill, originHint: "local" as const })));
    for (const projectRoot of roots.projectLocal) {
      collected.push(...loadSkillsFromDir({ dir: projectRoot, source: "project" }).skills.map((skill) => ({ skill, originHint: "local" as const })));
    }
    if (roots.system) collected.push(...loadSkillsFromDir({ dir: roots.system, source: "system" }).skills.map((skill) => ({ skill, originHint: "system" as const })));
    for (const packageRoot of roots.packages) {
      collected.push(...loadSkillsFromDir({ dir: packageRoot, source: "package" }).skills.map((skill) => ({ skill, originHint: "package" as const })));
    }
    const byPath = new Map<string, SkillRecord>();
    for (const entry of collected) {
      const filePath = path.resolve(entry.skill.filePath);
      if (byPath.has(filePath)) continue;
      const origin = entry.originHint ?? this.classifyOrigin(filePath, roots);
      const projectLocal = roots.projectLocal.some((root) => isWithin(root, filePath));
      const scope: SkillScope = projectLocal ? "project" : "user";
      const mutable = origin === "local" && (isWithin(roots.user, filePath) || (!this.options.sharedSkillsDir && projectLocal));
      byPath.set(filePath, {
        id: skillId(environmentId, filePath),
        environment: environmentId,
        name: entry.skill.name,
        description: entry.skill.description,
        scope,
        origin,
        mutable,
        invocation: `/skill:${entry.skill.name}`,
        capabilities: { read: true, edit: mutable, delete: mutable },
        filePath,
        baseDir: path.resolve(entry.skill.baseDir || path.dirname(filePath)),
        inputPath: entry.inputPath ?? this.transportPath(environmentId, filePath)
      });
    }
    return [...byPath.values()].sort((left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id));
  }

  private roots(environmentId: SkillEnvironmentId, cwd: string) {
    const agentDir = environmentId === "butler-pi" ? this.options.butlerPiAgentDir : this.options.workerPiAgentDir;
    const project = path.resolve(cwd, ".pi", "skills");
    return {
      user: this.sharedSkillsRoot(environmentId),
      project,
      projectLocal: [project, ...this.ancestorAgentSkillRoots(cwd)],
      system: null,
      packages: [path.resolve(agentDir, "npm", "node_modules"), path.resolve(agentDir, "git")]
    };
  }

  private classifyOrigin(filePath: string, roots: ReturnType<SkillsService["roots"]>): SkillOrigin {
    if (roots.system && isWithin(roots.system, filePath)) return "system";
    if (roots.packages.some((root) => isWithin(root, filePath))) return "package";
    if (isWithin(roots.user, filePath) || roots.projectLocal.some((root) => isWithin(root, filePath))) return "local";
    return "package";
  }

  private async resolveCwd(cwd?: string | null): Promise<string> {
    const candidate = path.resolve(cwd?.trim() || this.options.workspaceRoot);
    if (!isWithin(this.options.workspaceRoot, candidate)) throw new Error("Working directory must be inside the workspace.");
    const [canonicalWorkspace, canonicalCandidate] = await Promise.all([
      fs.realpath(path.resolve(this.options.workspaceRoot)),
      fs.realpath(candidate)
    ]);
    if (!isWithin(canonicalWorkspace, canonicalCandidate)) throw new Error("Working directory must be inside the workspace.");
    return candidate;
  }

  private async mutableRoot(environmentId: SkillEnvironmentId, scope: SkillScope, cwd?: string | null): Promise<string> {
    if (!ENVIRONMENTS.some((entry) => entry.id === environmentId && entry.capabilities.create)) {
      throw new Error("This environment does not support skill changes.");
    }
    if (this.options.sharedSkillsDir && scope === "project") {
      throw new Error("Project skills are repository files and must be changed by Worker.");
    }
    const resolvedCwd = await this.resolveCwd(cwd);
    const roots = this.roots(environmentId, resolvedCwd);
    return scope === "project" ? this.ensureProjectRoot(roots.project, resolvedCwd, this.directoryMode(environmentId, scope)) : roots.user;
  }

  private directoryMode(environmentId: SkillEnvironmentId, scope: SkillScope = "user"): number {
    if (this.options.sharedSkillsDir && scope === "user") return 0o755;
    return environmentId === "worker-pi" || scope === "project" ? 0o755 : 0o700;
  }

  private fileMode(environmentId: SkillEnvironmentId, executable: boolean, scope: SkillScope = "user"): number {
    if (this.options.sharedSkillsDir && scope === "user") return executable ? 0o755 : 0o644;
    if (environmentId === "worker-pi" || scope === "project") return executable ? 0o755 : 0o644;
    return executable ? 0o700 : 0o600;
  }

  private async ensureMutableRoot(root: string, environmentId: SkillEnvironmentId, scope: SkillScope = "user"): Promise<void> {
    const mode = this.directoryMode(environmentId, scope);
    await fs.mkdir(root, { recursive: true, mode });
    await fs.chmod(root, mode);
    await this.setManagedOwnership(root, environmentId, scope);
  }

  private async setInstalledPermissions(root: string, environmentId: SkillEnvironmentId, scope: SkillScope = "user"): Promise<void> {
    const visit = async (target: string): Promise<void> => {
      const stats = await fs.lstat(target);
      if (stats.isDirectory()) {
        await fs.chmod(target, this.directoryMode(environmentId, scope));
        await this.setManagedOwnership(target, environmentId, scope);
        const entries = await fs.readdir(target);
        for (const entry of entries) await visit(path.join(target, entry));
        return;
      }
      if (!stats.isFile()) throw new Error("Installed skill contains an unsupported file type.");
      await fs.chmod(target, this.fileMode(environmentId, (stats.mode & 0o111) !== 0, scope));
      await this.setManagedOwnership(target, environmentId, scope);
    };
    await visit(root);
  }

  private async setManagedOwnership(target: string, environmentId: SkillEnvironmentId, scope: SkillScope): Promise<void> {
    void target;
    void environmentId;
    void scope;
  }

  private async findRecord(environmentId: SkillEnvironmentId, id: string, cwd?: string | null): Promise<SkillRecord> {
    const record = (await this.records(environmentId, cwd)).find((entry) => entry.id === id);
    if (!record) throw new Error("Skill not found.");
    return record;
  }

  private async findMutableRecord(environmentId: SkillEnvironmentId, id: string, cwd?: string | null): Promise<SkillRecord> {
    const record = await this.findRecord(environmentId, id, cwd);
    if (!record.mutable) throw new Error("Package and system skills are read-only.");
    const root = await this.mutableRecordRoot(environmentId, record, cwd);
    const canonicalRoot = await fs.realpath(root);
    const canonicalFile = await fs.realpath(record.filePath);
    if (!isWithin(canonicalRoot, canonicalFile)) throw new Error("Skill path escapes its managed root.");
    return record;
  }

  private async mutableRecordRoot(environmentId: SkillEnvironmentId, record: SkillRecord, cwd?: string | null): Promise<string> {
    const resolvedCwd = await this.resolveCwd(cwd);
    const roots = this.roots(environmentId, resolvedCwd);
    const root = [roots.user, ...roots.projectLocal].find((candidate) => isWithin(candidate, record.filePath));
    if (!root) throw new Error("Skill path escapes its managed root.");
    if (root !== roots.user) await this.assertProjectPath(await fs.realpath(root));
    return root;
  }

  private async ensureProjectRoot(root: string, cwd: string, mode = 0o755): Promise<string> {
    let current = await fs.realpath(cwd);
    const relative = path.relative(path.resolve(cwd), path.resolve(root));
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("Invalid project skill root.");
    for (const segment of relative.split(path.sep)) {
      const candidate = path.join(current, segment);
      try {
        const stats = await fs.lstat(candidate);
        if (!stats.isDirectory() && !stats.isSymbolicLink()) throw new Error("Project skill root must be a directory.");
        current = await fs.realpath(candidate);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        await fs.mkdir(candidate, { mode });
        current = await fs.realpath(candidate);
      }
      await fs.chmod(current, mode);
      await this.assertProjectPath(current);
    }
    return current;
  }

  private async assertProjectPath(target: string): Promise<void> {
    const workspace = await fs.realpath(path.resolve(this.options.workspaceRoot));
    if (!isWithin(workspace, target)) throw new Error("Project skill root must stay inside the workspace.");
  }

  private ancestorAgentSkillRoots(cwd: string): string[] {
    const workspaceRoot = path.resolve(this.options.workspaceRoot);
    const roots: string[] = [];
    let current = path.resolve(cwd);
    while (isWithin(workspaceRoot, current)) {
      roots.push(path.join(current, ".agents", "skills"));
      if (current === workspaceRoot) break;
      current = path.dirname(current);
    }
    return roots;
  }

  private publicItem(record: SkillRecord): SkillCatalogItem {
    const { filePath: _filePath, baseDir: _baseDir, inputPath: _inputPath, ...item } = record;
    return item;
  }

  private transportPath(environmentId: SkillEnvironmentId, filePath: string): string {
    return filePath;
  }

  private async findByPath(records: SkillRecord[], filePath: string): Promise<SkillRecord> {
    const resolvedTarget = path.resolve(filePath);
    const target = await fs.realpath(resolvedTarget).catch(() => resolvedTarget);
    for (const record of records) {
      const resolvedRecord = path.resolve(record.filePath);
      const candidate = await fs.realpath(resolvedRecord).catch(() => resolvedRecord);
      if (candidate === target) return record;
    }
    throw new Error("Installed skill was not discovered.");
  }

  private assertValidSkillDir(directory: string, expectedName: string): void {
    const result = loadSkillsFromDir({ dir: directory, source: "staged" });
    if (result.skills.length !== 1 || result.skills[0]?.name !== expectedName) {
      const message = result.diagnostics[0]?.message ?? "SKILL.md must contain a valid matching name and description.";
      throw new Error(message);
    }
  }

}

async function exists(target: string): Promise<boolean> {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}
