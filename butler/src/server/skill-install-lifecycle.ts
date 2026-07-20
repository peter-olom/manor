import crypto from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

import { archiveButlerSkillCandidate, archiveSkillDirectory, extractSkillArchive } from "./skill-archive.js";

function contentHash(content: string | Buffer): string {
  return crypto.createHash("sha256").update(content).digest("hex");
}

function isWithin(root: string, target: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export async function sealButlerSkillCandidate(input: {
  name: string;
  candidatePath: string;
  scratchRoot: string;
  normalizePermissions: (skillPath: string) => Promise<void>;
}): Promise<{ archiveBase64: string; verificationPath: string; cleanup: () => Promise<void> }> {
  const scratchRoot = await fs.realpath(path.resolve(input.scratchRoot));
  const sourceArchive = await archiveButlerSkillCandidate(input.name, input.candidatePath, scratchRoot);
  const stagedRoot = await fs.mkdtemp(path.join(scratchRoot, ".manor-skill-verification-"));
  try {
    const extracted = await extractSkillArchive(sourceArchive, stagedRoot);
    if (extracted.entries.length !== 1 || extracted.entries[0]?.name !== input.name) throw new Error("Prepared candidate did not contain the expected skill.");
    const verificationPath = path.join(stagedRoot, extracted.entries[0].archiveRoot);
    await input.normalizePermissions(verificationPath);
    await fs.chmod(stagedRoot, 0o755);
    const archive = await archiveSkillDirectory(input.name, await fs.realpath(verificationPath));
    return {
      archiveBase64: archive.toString("base64"),
      verificationPath,
      cleanup: () => fs.rm(stagedRoot, { recursive: true, force: true })
    };
  } catch (error) {
    await fs.rm(stagedRoot, { recursive: true, force: true });
    throw error;
  }
}

export async function assertSealedButlerSkillCandidateUnchanged(input: {
  name: string;
  verificationPath: string;
  archiveBase64: string;
  scratchRoot: string;
}): Promise<void> {
  const current = await archiveButlerSkillCandidate(input.name, input.verificationPath, input.scratchRoot);
  if (contentHash(current) !== contentHash(Buffer.from(input.archiveBase64, "base64"))) {
    throw new Error("Prepared skill changed during final verification. Prepare and verify a fresh candidate.");
  }
}

export async function snapshotExistingSkill(rootInput: string, name: string): Promise<{
  archiveBase64: string;
  archiveSha256: string;
} | null> {
  const root = path.resolve(rootInput);
  const target = path.join(root, name);
  const canonicalTarget = await fs.realpath(target).catch(() => null);
  if (!canonicalTarget) return null;
  const canonicalRoot = await fs.realpath(root);
  if (!isWithin(canonicalRoot, canonicalTarget) || canonicalRoot === canonicalTarget) throw new Error("Invalid existing skill destination.");
  const archive = await archiveSkillDirectory(name, canonicalTarget);
  return { archiveBase64: archive.toString("base64"), archiveSha256: contentHash(archive) };
}

export async function replaceExistingSkillArchive<T>(input: {
  root: string;
  name: string;
  archiveBase64: string;
  expectedCurrentSha256: string;
  validateArchive: (archive: Buffer) => Promise<void>;
  importArchive: () => Promise<T>;
}): Promise<T> {
  const canonicalRoot = await fs.realpath(input.root);
  const target = path.join(input.root, input.name);
  const canonicalTarget = await fs.realpath(target).catch(() => null);
  if (!canonicalTarget || !isWithin(canonicalRoot, canonicalTarget) || canonicalRoot === canonicalTarget) {
    throw new Error("The existing skill disappeared or moved after approval was requested. Review and approve a fresh proposal.");
  }
  const currentArchive = await archiveSkillDirectory(input.name, canonicalTarget);
  if (contentHash(currentArchive) !== input.expectedCurrentSha256) {
    throw new Error("The existing skill changed after approval was requested. Review and approve a fresh proposal.");
  }
  await input.validateArchive(Buffer.from(input.archiveBase64, "base64"));
  const backup = path.join(input.root, `.manor-replaced-${input.name}-${crypto.randomUUID()}`);
  await fs.rename(target, backup);
  try {
    const result = await input.importArchive();
    await fs.rm(backup, { recursive: true, force: true }).catch((error) => {
      console.warn(`Could not remove replaced skill backup ${backup}: ${error instanceof Error ? error.message : String(error)}`);
    });
    return result;
  } catch (error) {
    await fs.rm(target, { recursive: true, force: true });
    await fs.rename(backup, target);
    throw error;
  }
}
