import crypto from "node:crypto";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import { pipeline } from "node:stream/promises";

import { loadSkillsFromDir, type Skill } from "@earendil-works/pi-coding-agent";
import JSZip from "jszip";

export type SkillEnvironmentId = "butler-pi" | "worker-pi";
export type SkillScope = "user" | "project";
export type SkillOrigin = "local" | "package" | "system";

export type SkillCapabilities = {
  read: boolean;
  edit: boolean;
  delete: boolean;
};

export type SkillCatalogItem = {
  id: string;
  environment: SkillEnvironmentId;
  name: string;
  description: string;
  scope: SkillScope;
  origin: SkillOrigin;
  mutable: boolean;
  invocation: string;
  capabilities: SkillCapabilities;
};

export type SkillEnvironmentView = {
  id: SkillEnvironmentId;
  label: string;
  harness: "pi";
  capabilities: {
    list: true;
    read: true;
    create: boolean;
    install: boolean;
    edit: boolean;
    delete: boolean;
    import: boolean;
    packageManagement: false;
  };
};

export type AgentSkillChangeInput =
  | {
      operation: "create";
      environment: SkillEnvironmentId;
      name: string;
      description: string;
      instructions: string;
      scope?: SkillScope;
      cwd?: string | null;
    }
  | {
      operation: "install";
      environment: SkillEnvironmentId;
      name?: string;
      content?: string;
      source: string;
      scope?: SkillScope;
      cwd?: string | null;
    }
  | {
      operation: "update";
      environment: SkillEnvironmentId;
      id: string;
      content: string;
      reason: string;
      cwd?: string | null;
    }
  | {
      operation: "undo";
      resultId: string;
    };

export type AgentSkillChangeProposal = {
  id: string;
  operation: AgentSkillChangeInput["operation"];
  summary: string;
  environment: SkillEnvironmentId;
  skillName: string;
  scope: SkillScope;
  source: string | null;
  sourceVerification: "agent-reported" | "fetched";
  description: string;
  target: string;
  footprint: string;
  conflict: string;
  verificationPlan: string;
  contentSha256: string;
  contentEvidence: string;
  createdAt: number;
  expiresAt: number;
  status: "pending" | "approved" | "rejected" | "applying" | "applied" | "failed";
  resultId: string | null;
  error: string | null;
};

export type AgentSkillChangeResult = {
  id: string;
  proposalId: string;
  operation: AgentSkillChangeInput["operation"];
  skill: SkillCatalogItem;
  appliedAt: number;
  verification: {
    catalogVisible: boolean;
    invocation: string;
    resourceReload: "scheduled" | "next-session";
  };
  undo: {
    available: boolean;
    resultId: string;
    instruction: string;
    preservedLocation: string | null;
  };
};

type SkillRecord = SkillCatalogItem & {
  filePath: string;
  baseDir: string;
  inputPath: string;
};

type SkillsServiceOptions = {
  butlerPiAgentDir: string;
  workerPiAgentDir: string;
  workspaceRoot: string;
  fetchImpl?: typeof fetch;
};

type ExtractedSkillArchive = {
  entries: Array<{ archiveRoot: string; name: string; description: string }>;
  files: string[];
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
  undoneAt: number | null;
};

const ENVIRONMENTS: SkillEnvironmentView[] = [
  environment("butler-pi", "Butler", "pi", true),
  environment("worker-pi", "Worker", "pi", true)
];
const MAX_SKILL_BYTES = 2 * 1024 * 1024;
const MAX_AGENT_SKILL_BYTES = 32 * 1024;
const MAX_ARCHIVE_BYTES = 10 * 1024 * 1024;
const MAX_ARCHIVE_EXPANDED_BYTES = 25 * 1024 * 1024;
const MAX_ARCHIVE_FILES = 200;
const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const AGENT_PROPOSAL_TTL_MS = 30 * 60 * 1000;
const MAX_PENDING_AGENT_ARCHIVES_PER_OWNER = 2;
const MAX_PENDING_AGENT_ARCHIVES_GLOBAL = 8;
const MAX_AGENT_ARCHIVE_MANIFEST_EVIDENCE_BYTES = 12 * 1024;
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

function validateArchivePath(rawName: string): string {
  if (!rawName || rawName.length > 1024 || rawName.includes("\\") || rawName.includes("\0") || path.posix.isAbsolute(rawName)) {
    throw new Error("Archive contains an unsafe path.");
  }
  const normalized = path.posix.normalize(rawName).replace(/\/$/, "");
  if (!normalized || normalized === "." || normalized === ".." || normalized.startsWith("../")) {
    throw new Error("Archive contains an unsafe path.");
  }
  const segments = normalized.split("/");
  if (segments.some((segment) => !segment || segment.length > 255 || segment === "." || segment === ".." || segment === ".git" || segment === "node_modules")) {
    throw new Error("Archive contains a forbidden path.");
  }
  return normalized;
}

export class SkillsService {
  private readonly agentProposals = new Map<string, AgentSkillProposalRecord>();
  private readonly agentResults = new Map<string, AgentSkillResultRecord>();
  private agentArchiveProposalTail: Promise<void> = Promise.resolve();
  private mutationTail: Promise<void> = Promise.resolve();

  constructor(private readonly options: SkillsServiceOptions) {}

  async proposeAgentChange(owner: string, rawInput: AgentSkillChangeInput): Promise<AgentSkillChangeProposal> {
    if (rawInput.operation === "install" && !rawInput.content?.trim()) {
      return this.runAgentArchiveProposal(() => this.proposeAgentChangeUnlocked(owner, rawInput));
    }
    return this.proposeAgentChangeUnlocked(owner, rawInput);
  }

  private async proposeAgentChangeUnlocked(owner: string, rawInput: AgentSkillChangeInput): Promise<AgentSkillChangeProposal> {
    const normalizedOwner = this.agentOwner(owner);
    const now = Date.now();
    this.pruneAgentProposals(now);
    if (rawInput.operation === "install" && !rawInput.content?.trim()) this.assertAgentArchiveProposalCapacity(normalizedOwner, now);
    const input = await this.normalizeAgentChange(rawInput, normalizedOwner);
    if (input.operation === "install" && input.archiveBase64) this.assertAgentArchiveProposalCapacity(normalizedOwner, Date.now());
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

    if (input.operation === "undo") {
      const result = this.requireAgentResult(normalizedOwner, input.resultId);
      if (!result.undo.available || result.undoneAt) throw new Error("This skill change can no longer be undone.");
      environment = result.environment;
      skillName = result.skill.name;
      skillScope = result.skill.scope;
      source = `change ${result.id}`;
      description = `Restore the state before the approved ${result.operation} change.`;
      approvedContent = result.operation === "update" ? result.previousContent ?? "" : result.appliedContent ?? "";
      contentEvidence = result.operation === "update"
        ? this.fullContentEvidence(approvedContent, this.boundedContentDiff(result.appliedContent ?? "", approvedContent))
        : this.fullContentEvidence(approvedContent, "The complete SKILL.md below is approved for removal.");
      footprint = result.operation === "update"
        ? "Restores one managed SKILL.md. No hooks, scripts, or skill instructions are executed."
        : result.appliedArchiveManifest
          ? "Removes the complete approved archive when every installed file is unchanged. If files were changed, removed, or added later, Manor removes SKILL.md and moves the residual directory to a unique hidden preserved location under the same skills root."
          : "Removes only the approved SKILL.md. If later files exist, Manor moves the residual directory to a unique hidden preserved location under the same skills root so the original name is reusable.";
      summary = `Undo ${result.operation} of ${skillName} in ${this.environmentLabel(environment)}.`;
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
        summary = `Update ${skillName} in ${this.environmentLabel(environment)} (${skillScope} scope). Reason: ${input.reason}`;
      } else if (input.operation === "install") {
        skillName = input.name;
        if (input.archiveBase64) {
          const archive = Buffer.from(input.archiveBase64, "base64");
          const inspected = await this.inspectAgentArchive(skillName, archive);
          input.archiveManifest = inspected.manifest;
          description = this.agentLine(inspected.description, "Skill description", 1024);
          approvedContent = archive;
          contentEvidence = this.archiveContentEvidence(inspected.files, inspected.skillContent);
          footprint = `Writes one validated skill archive containing ${inspected.files.length} files. Archive contents are staged without executing hooks, scripts, or skill instructions.`;
          sourceVerification = "fetched";
        } else {
          const content = input.content ?? "";
          const validated = await this.validateSkillDocument(skillName, content);
          description = this.agentLine(validated.description, "Skill description", 1024);
          approvedContent = content;
          contentEvidence = this.fullContentEvidence(content, "Complete proposed single-document SKILL.md.");
          footprint = "Writes one managed SKILL.md. Agent-managed installs do not add companion files and execute no hooks, scripts, or skill instructions.";
        }
        conflict = await this.assertAgentDestinationAvailable(environment, skillName, skillScope, input.cwd);
        source = input.source;
        summary = `Install ${skillName} in ${this.environmentLabel(environment)} (${skillScope} scope) from ${input.source}.`;
      } else {
        skillName = input.name;
        await this.validateSkillDocument(skillName, skillMarkdown(skillName, input.description, input.instructions));
        description = input.description;
        approvedContent = skillMarkdown(skillName, input.description, input.instructions);
        contentEvidence = this.fullContentEvidence(approvedContent, "Complete proposed single-document SKILL.md.");
        footprint = "Writes one managed SKILL.md. Agent-managed creation does not add companion files and executes no hooks, scripts, or skill instructions.";
        conflict = await this.assertAgentDestinationAvailable(environment, skillName, skillScope, input.cwd);
        summary = `Create ${skillName} in ${this.environmentLabel(environment)} (${skillScope} scope).`;
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
      target: `${this.environmentLabel(environment)} / ${skillScope} scope`,
      footprint,
      conflict,
      verificationPlan: environment === "butler-pi"
        ? "Reload the active Butler resources and confirm the resulting catalog entry and invocation."
        : "Confirm the resulting catalog entry and invocation. New Worker sessions load the change; an existing Worker session may need replacement.",
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

  async applyApprovedAgentChange(owner: string, proposalId: string): Promise<AgentSkillChangeResult> {
    return this.runMutation(() => this.applyApprovedAgentChangeUnlocked(owner, proposalId));
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
    const root = await this.mutableRoot(input.environment, input.scope ?? "user", input.cwd);
    const targetDir = path.join(root, name);
    if (!isWithin(root, targetDir)) throw new Error("Invalid skill destination.");
    await fs.mkdir(root, { recursive: true, mode: 0o700 });
    if (await exists(targetDir)) throw new Error(`A skill named ${name} already exists.`);
    const staged = await fs.mkdtemp(path.join(root, ".manor-create-"));
    try {
      const content = skillMarkdown(name, input.description, input.instructions);
      if (Buffer.byteLength(content, "utf8") > MAX_SKILL_BYTES) throw new Error("Skill content is too large.");
      await fs.writeFile(path.join(staged, "SKILL.md"), content, { encoding: "utf8", mode: 0o600 });
      this.assertValidSkillDir(staged, name);
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
      await fs.chmod(tempFile, 0o600);
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
    if (archive.length === 0 || archive.length > MAX_ARCHIVE_BYTES) throw new Error("Skill archive is empty or too large.");
    const root = await this.mutableRoot(input.environment, input.scope ?? "user", input.cwd);
    await fs.mkdir(root, { recursive: true, mode: 0o700 });
    const staged = await fs.mkdtemp(path.join(root, ".manor-import-"));
    const installedPaths: string[] = [];
    try {
      const extracted = await this.extractArchive(archive, staged);
      for (const entry of extracted.entries) {
        if (await exists(path.join(root, entry.name))) throw new Error(`A skill named ${entry.name} already exists.`);
      }
      for (const entry of extracted.entries) {
        const destination = path.join(root, entry.name);
        await fs.rename(path.join(staged, entry.archiveRoot), destination);
        installedPaths.push(path.join(destination, "SKILL.md"));
      }
    } catch (error) {
      for (const installed of installedPaths) await fs.rm(path.dirname(installed), { recursive: true, force: true });
      throw error;
    } finally {
      await fs.rm(staged, { recursive: true, force: true });
    }
    const records = await this.records(input.environment, input.cwd);
    return installedPaths.map((filePath) => this.publicItem(this.findByPath(records, filePath)));
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
    await fs.mkdir(root, { recursive: true, mode: 0o700 });
    if (await exists(targetDir)) throw new Error(`A skill named ${name} already exists.`);
    const staged = await fs.mkdtemp(path.join(root, ".manor-install-"));
    try {
      await fs.writeFile(path.join(staged, "SKILL.md"), input.content, { encoding: "utf8", mode: 0o600 });
      this.assertValidSkillDir(staged, name);
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
          throw new Error("The fetched skill archive changed after approval was requested. Review and approve a fresh proposal.");
        }
        const imported = await this.importArchiveUnlocked({
          environment: input.environment,
          archiveBase64: input.archiveBase64,
          scope: input.scope ?? "user",
          cwd: input.cwd
        });
        if (imported.length !== 1 || imported[0]?.name !== input.name) throw new Error("The approved skill archive did not install the expected skill.");
        skill = imported[0];
        appliedContent = (await this.read(skill.environment, skill.id, input.cwd)).content;
        appliedArchiveManifest = input.archiveManifest?.map((entry) => ({ ...entry })) ?? null;
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
      createdSkillId = skill.id;
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
      appliedAt: Date.now(),
      undoneAt: null,
      verification: {
        catalogVisible: true,
        invocation: skill.invocation,
        resourceReload: skill.environment === "butler-pi" ? "scheduled" : "next-session"
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
      appliedAt: Date.now(),
      undoneAt: null,
      verification: {
        catalogVisible: original.operation === "update",
        invocation: skill.invocation,
        resourceReload: original.environment === "butler-pi" ? "scheduled" : "next-session"
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
      const name = requestedName ? safeName(requestedName) : safeName(this.githubRepository(source).repository);
      if (content.trim()) {
        this.assertAgentSingleDocument(content);
        return { operation: "install", environment: input.environment, name, content, source, scope: changeScope, cwd };
      }
      const archive = await this.fetchGithubSkillArchive(source);
      return { operation: "install", environment: input.environment, name, archiveBase64: archive.toString("base64"), source, scope: changeScope, cwd };
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

  private assertAgentArchiveProposalCapacity(owner: string, now: number): void {
    this.pruneAgentProposals(now);
    const active = [...this.agentProposals.values()].filter((proposal) =>
      proposal.expiresAt > now && proposal.input.operation === "install" && Boolean(proposal.input.archiveBase64)
    );
    if (active.filter((proposal) => proposal.owner === owner).length >= MAX_PENDING_AGENT_ARCHIVES_PER_OWNER) {
      throw new Error("Too many pending archive skill approvals for this Butler session. Approve, reject, or wait for an existing proposal to expire.");
    }
    if (active.length >= MAX_PENDING_AGENT_ARCHIVES_GLOBAL) {
      throw new Error("Too many pending archive skill approvals. Approve, reject, or wait for an existing proposal to expire.");
    }
  }

  private clearAgentArchivePayload(proposal: AgentSkillProposalRecord): void {
    if (proposal.input.operation !== "install") return;
    proposal.input.archiveBase64 = undefined;
    proposal.input.archiveManifest = undefined;
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

  private runAgentArchiveProposal<T>(work: () => Promise<T>): Promise<T> {
    const run = this.agentArchiveProposalTail.then(work, work);
    this.agentArchiveProposalTail = run.then(() => undefined, () => undefined);
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
    return { ...view };
  }

  private publicAgentResult(result: AgentSkillResultRecord): AgentSkillChangeResult {
    const { owner: _owner, environment: _environment, cwd: _cwd, createdSkillId: _createdSkillId, previousContent: _previousContent, appliedContentHash: _appliedContentHash, appliedContent: _appliedContent, appliedArchiveManifest: _appliedArchiveManifest, undoneAt: _undoneAt, ...view } = result;
    return { ...view, verification: { ...view.verification }, undo: { ...view.undo }, skill: { ...view.skill, capabilities: { ...view.skill.capabilities } } };
  }

  private contentHash(content: string | Buffer): string {
    return crypto.createHash("sha256").update(content).digest("hex");
  }

  private environmentLabel(environmentId: SkillEnvironmentId): string {
    if (environmentId === "butler-pi") return "Butler Pi (butler-pi)";
    return "Worker Pi (worker-pi)";
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

  private async fetchGithubSkillArchive(source: string): Promise<Buffer> {
    const archiveUrl = this.githubArchiveUrl(source);
    const fetchImpl = this.options.fetchImpl ?? globalThis.fetch;
    const response = await fetchImpl(archiveUrl, {
      headers: { accept: "application/zip", "user-agent": "manor-skill-installer" },
      redirect: "follow",
      signal: AbortSignal.timeout(30_000)
    });
    if (!response.ok) throw new Error(`GitHub skill archive download failed with status ${response.status}.`);
    const reportedLength = Number(response.headers.get("content-length"));
    if (Number.isFinite(reportedLength) && reportedLength > MAX_ARCHIVE_BYTES) throw new Error("Skill archive is too large.");
    if (!response.body) throw new Error("GitHub skill archive download returned no content.");
    const reader = response.body.getReader();
    const chunks: Buffer[] = [];
    let total = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_ARCHIVE_BYTES) {
        await reader.cancel();
        throw new Error("Skill archive is too large.");
      }
      chunks.push(Buffer.from(value));
    }
    if (total === 0) throw new Error("GitHub skill archive download returned no content.");
    return Buffer.concat(chunks, total);
  }

  private githubArchiveUrl(source: string): string {
    const { owner, repository } = this.githubRepository(source);
    return `https://github.com/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/archive/HEAD.zip`;
  }

  private githubRepository(source: string): { owner: string; repository: string } {
    let url: URL;
    try {
      url = new URL(source);
    } catch {
      throw new Error("Multi-file agent installs require a public GitHub repository URL.");
    }
    const parts = url.pathname.split("/").filter(Boolean);
    const owner = parts[0] ?? "";
    const repository = (parts[1] ?? "").replace(/\.git$/, "");
    const validSegment = /^[A-Za-z0-9_.-]+$/;
    if (url.protocol !== "https:" || url.hostname !== "github.com" || url.port || url.username || url.password || url.search || url.hash || parts.length !== 2 || !validSegment.test(owner) || !validSegment.test(repository)) {
      throw new Error("Multi-file agent installs require a public GitHub repository URL.");
    }
    return { owner, repository };
  }

  private async inspectAgentArchive(expectedName: string, archive: Buffer): Promise<{
    description: string;
    files: string[];
    skillContent: string;
    manifest: Array<{ path: string; sha256: string }>;
  }> {
    if (archive.length === 0 || archive.length > MAX_ARCHIVE_BYTES) throw new Error("Skill archive is empty or too large.");
    const staged = await fs.mkdtemp(path.join(tmpdir(), "manor-skill-archive-"));
    try {
      const extracted = await this.extractArchive(archive, staged);
      if (extracted.entries.length !== 1) throw new Error("Agent-managed archive installs must contain exactly one skill.");
      const entry = extracted.entries[0]!;
      if (entry.name !== expectedName) throw new Error(`The GitHub archive declares ${entry.name}, not ${expectedName}.`);
      const skillContent = await fs.readFile(path.join(staged, entry.archiveRoot, "SKILL.md"), "utf8");
      if (Buffer.byteLength(skillContent, "utf8") > MAX_AGENT_SKILL_BYTES) {
        throw new Error(`Agent-managed archive SKILL.md content must be ${MAX_AGENT_SKILL_BYTES} bytes or fewer.`);
      }
      const files = extracted.files.map((file) => path.posix.relative(entry.archiveRoot, file));
      const manifest = await Promise.all(files.map(async (file) => ({
        path: file,
        sha256: this.contentHash(await fs.readFile(path.join(staged, entry.archiveRoot, ...file.split("/"))))
      })));
      return { description: entry.description, files, skillContent, manifest };
    } finally {
      await fs.rm(staged, { recursive: true, force: true });
    }
  }

  private archiveContentEvidence(files: string[], skillContent: string): string {
    const visible: string[] = [];
    let bytes = 0;
    for (const file of files) {
      const lineBytes = Buffer.byteLength(`${file}\n`, "utf8");
      if (bytes + lineBytes > MAX_AGENT_ARCHIVE_MANIFEST_EVIDENCE_BYTES) break;
      visible.push(file);
      bytes += lineBytes;
    }
    const omitted = files.length - visible.length;
    const manifest = `${visible.join("\n")}${omitted ? `\n[${omitted} more files omitted; the SHA-256 identifies the complete approved archive]` : ""}`;
    return `Validated archive file manifest (${files.length} files):\n${manifest}\nComplete proposed SKILL.md:\n${AGENT_SKILL_CONTENT_MARKER}\n${JSON.stringify(skillContent)}`;
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
      const mutable = origin === "local" && (isWithin(roots.user, filePath) || projectLocal);
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
      user: path.resolve(agentDir, "skills"),
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
    const resolvedCwd = await this.resolveCwd(cwd);
    const roots = this.roots(environmentId, resolvedCwd);
    return scope === "project" ? this.ensureProjectRoot(roots.project, resolvedCwd) : roots.user;
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

  private async ensureProjectRoot(root: string, cwd: string): Promise<string> {
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
        await fs.mkdir(candidate, { mode: 0o700 });
        current = await fs.realpath(candidate);
      }
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

  private findByPath(records: SkillRecord[], filePath: string): SkillRecord {
    const target = path.resolve(filePath);
    const record = records.find((entry) => path.resolve(entry.filePath) === target);
    if (!record) throw new Error("Installed skill was not discovered.");
    return record;
  }

  private assertValidSkillDir(directory: string, expectedName: string): void {
    const result = loadSkillsFromDir({ dir: directory, source: "staged" });
    if (result.skills.length !== 1 || result.skills[0]?.name !== expectedName) {
      const message = result.diagnostics[0]?.message ?? "SKILL.md must contain a valid matching name and description.";
      throw new Error(message);
    }
  }

  private async extractArchive(archive: Buffer, staged: string): Promise<ExtractedSkillArchive> {
    const zip = await JSZip.loadAsync(archive, { createFolders: false });
    const files = Object.values(zip.files).filter((entry) => !entry.dir);
    if (files.length === 0 || files.length > MAX_ARCHIVE_FILES) throw new Error("Skill archive has an invalid number of files.");
    let expandedBytes = 0;
    const topLevel = new Set<string>();
    for (const entry of files) {
      const rawName = (entry as typeof entry & { unsafeOriginalName?: string }).unsafeOriginalName ?? entry.name;
      const relative = validateArchivePath(rawName);
      const unixMode = typeof entry.unixPermissions === "number" ? entry.unixPermissions : parseInt(String(entry.unixPermissions || "0"), 8);
      if ((unixMode & 0o170000) === 0o120000) throw new Error("Skill archives cannot contain symbolic links.");
      const destination = path.join(staged, ...relative.split("/"));
      if (!isWithin(staged, destination)) throw new Error("Archive contains an unsafe path.");
      await fs.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
      expandedBytes += await this.extractArchiveEntry(entry, destination, expandedBytes, path.posix.basename(relative) === "SKILL.md");
      topLevel.add(relative.split("/")[0]!);
    }
    const entries: ExtractedSkillArchive["entries"] = [];
    const declaredNames = new Set<string>();
    for (const archiveRoot of [...topLevel].sort()) {
      const directory = path.join(staged, archiveRoot);
      if (!(await exists(path.join(directory, "SKILL.md")))) throw new Error(`Imported skill ${archiveRoot} is missing SKILL.md.`);
      const result = loadSkillsFromDir({ dir: directory, source: "staged" });
      const skill = result.skills[0];
      if (result.skills.length !== 1 || !skill) {
        throw new Error(result.diagnostics[0]?.message ?? "SKILL.md must contain a valid name and description.");
      }
      const name = safeName(skill.name);
      if (declaredNames.has(name)) throw new Error(`Skill archive declares ${name} more than once.`);
      declaredNames.add(name);
      entries.push({ archiveRoot, name, description: skill.description });
    }
    return { entries, files: files.map((entry) => validateArchivePath((entry as typeof entry & { unsafeOriginalName?: string }).unsafeOriginalName ?? entry.name)).sort() };
  }

  private async extractArchiveEntry(entry: JSZip.JSZipObject, destination: string, expandedBytes: number, isSkillFile: boolean): Promise<number> {
    const handle = await fs.open(destination, "wx", 0o600);
    let entryBytes = 0;
    let failure: unknown = null;
    try {
      await pipeline(entry.nodeStream("nodebuffer"), new Writable({
        write: (chunk: Buffer | Uint8Array | string, _encoding, callback) => {
          const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          entryBytes += data.length;
          if (expandedBytes + entryBytes > MAX_ARCHIVE_EXPANDED_BYTES) {
            callback(new Error("Expanded skill archive is too large."));
            return;
          }
          if (isSkillFile && entryBytes > MAX_SKILL_BYTES) {
            callback(new Error("Skill content is too large."));
            return;
          }
          void handle.write(data).then(() => callback(), callback);
        }
      }));
    } catch (error) {
      failure = error;
    } finally {
      await handle.close();
    }
    if (failure) {
      await fs.rm(destination, { force: true });
      throw failure;
    }
    return entryBytes;
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
