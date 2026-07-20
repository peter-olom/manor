import crypto from "node:crypto";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import { pipeline } from "node:stream/promises";

import { loadSkillsFromDir } from "@earendil-works/pi-coding-agent";
import JSZip from "jszip";

export const MAX_SKILL_ARCHIVE_BYTES = 10 * 1024 * 1024;
const MAX_EXPANDED_BYTES = 25 * 1024 * 1024;
const MAX_FILES = 200;
const MAX_SKILL_BYTES = 2 * 1024 * 1024;
const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export type ExtractedSkillArchive = {
  entries: Array<{ archiveRoot: string; name: string; description: string }>;
  files: string[];
};

function isWithin(root: string, target: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function safeName(value: unknown): string {
  const name = typeof value === "string" ? value.trim() : "";
  if (!SKILL_NAME.test(name) || name.length > 64) {
    throw new Error("Skill name must be 1-64 lowercase letters, numbers, or single hyphens.");
  }
  return name;
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

async function extractEntry(entry: JSZip.JSZipObject, destination: string, expandedBytes: number, isSkillFile: boolean, executable: boolean): Promise<number> {
  const handle = await fs.open(destination, "wx", executable ? 0o700 : 0o600);
  let entryBytes = 0;
  let failure: unknown = null;
  try {
    await pipeline(entry.nodeStream("nodebuffer"), new Writable({
      write: (chunk: Buffer | Uint8Array | string, _encoding, callback) => {
        const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        entryBytes += data.length;
        if (expandedBytes + entryBytes > MAX_EXPANDED_BYTES) {
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

export async function extractSkillArchive(archive: Buffer, staged: string): Promise<ExtractedSkillArchive> {
  const zip = await JSZip.loadAsync(archive, { createFolders: false });
  const files = Object.values(zip.files).filter((entry) => !entry.dir);
  if (files.length === 0 || files.length > MAX_FILES) throw new Error("Skill archive has an invalid number of files.");
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
    expandedBytes += await extractEntry(entry, destination, expandedBytes, path.posix.basename(relative) === "SKILL.md", (unixMode & 0o111) !== 0);
    topLevel.add(relative.split("/")[0]!);
  }
  const entries: ExtractedSkillArchive["entries"] = [];
  const declaredNames = new Set<string>();
  for (const archiveRoot of [...topLevel].sort()) {
    const directory = path.join(staged, archiveRoot);
    try {
      await fs.access(path.join(directory, "SKILL.md"));
    } catch {
      throw new Error(`Imported skill ${archiveRoot} is missing SKILL.md.`);
    }
    const result = loadSkillsFromDir({ dir: directory, source: "staged" });
    const skill = result.skills[0];
    if (result.skills.length !== 1 || !skill) throw new Error(result.diagnostics[0]?.message ?? "SKILL.md must contain a valid name and description.");
    const name = safeName(skill.name);
    if (declaredNames.has(name)) throw new Error(`Skill archive declares ${name} more than once.`);
    declaredNames.add(name);
    entries.push({ archiveRoot, name, description: skill.description });
  }
  return { entries, files: files.map((entry) => validateArchivePath((entry as typeof entry & { unsafeOriginalName?: string }).unsafeOriginalName ?? entry.name)).sort() };
}

export async function inspectAgentSkillArchive(expectedName: string, archive: Buffer, maxAgentSkillBytes: number): Promise<{ description: string; files: string[]; skillContent: string; manifest: Array<{ path: string; sha256: string }> }> {
  if (archive.length === 0 || archive.length > MAX_SKILL_ARCHIVE_BYTES) throw new Error("Skill archive is empty or too large.");
  const staged = await fs.mkdtemp(path.join(tmpdir(), "manor-skill-archive-"));
  try {
    const extracted = await extractSkillArchive(archive, staged);
    if (extracted.entries.length !== 1) throw new Error("Agent-managed archive installs must contain exactly one skill.");
    const entry = extracted.entries[0]!;
    if (entry.name !== expectedName) throw new Error(`The GitHub archive declares ${entry.name}, not ${expectedName}.`);
    const skillContent = await fs.readFile(path.join(staged, entry.archiveRoot, "SKILL.md"), "utf8");
    if (Buffer.byteLength(skillContent, "utf8") > maxAgentSkillBytes) throw new Error(`Agent-managed archive SKILL.md content must be ${maxAgentSkillBytes} bytes or fewer.`);
    const files = extracted.files.map((file) => path.posix.relative(entry.archiveRoot, file));
    const manifest = await Promise.all(files.map(async (file) => ({
      path: file,
      sha256: crypto.createHash("sha256").update(await fs.readFile(path.join(staged, entry.archiveRoot, ...file.split("/")))).digest("hex")
    })));
    return { description: entry.description, files, skillContent, manifest };
  } finally {
    await fs.rm(staged, { recursive: true, force: true });
  }
}

export async function archiveButlerSkillCandidate(expectedName: string, candidatePath: string, scratchRoot: string): Promise<Buffer> {
  const [canonicalScratch, canonicalCandidate] = await Promise.all([fs.realpath(path.resolve(scratchRoot)), fs.realpath(path.resolve(candidatePath))]);
  if (!isWithin(canonicalScratch, canonicalCandidate) || canonicalScratch === canonicalCandidate) throw new Error("Prepared skill must be a directory inside Butler scratch.");
  return archiveSkillDirectory(expectedName, canonicalCandidate);
}

export async function archiveSkillDirectory(expectedName: string, canonicalCandidate: string): Promise<Buffer> {
  const stats = await fs.lstat(canonicalCandidate);
  if (!stats.isDirectory() || stats.isSymbolicLink()) throw new Error("Prepared skill candidate must be a real directory.");
  const zip = new JSZip();
  let fileCount = 0;
  let expandedBytes = 0;
  const visit = async (directory: string): Promise<void> => {
    for (const entry of (await fs.readdir(directory, { withFileTypes: true })).sort((left, right) => left.name.localeCompare(right.name))) {
      const fullPath = path.join(directory, entry.name);
      if (!isWithin(canonicalCandidate, fullPath) || entry.isSymbolicLink()) throw new Error("Prepared skill contains an unsafe file.");
      const relative = path.relative(canonicalCandidate, fullPath).split(path.sep).join("/");
      validateArchivePath(`${expectedName}/${relative}`);
      if (entry.isDirectory()) {
        await visit(fullPath);
        continue;
      }
      if (!entry.isFile()) throw new Error("Prepared skill contains an unsupported file type.");
      fileCount += 1;
      if (fileCount > MAX_FILES) throw new Error("Prepared skill contains too many files.");
      const contents = await fs.readFile(fullPath);
      expandedBytes += contents.byteLength;
      if (expandedBytes > MAX_EXPANDED_BYTES) throw new Error("Prepared skill is too large.");
      zip.file(`${expectedName}/${relative}`, contents, {
        unixPermissions: (await fs.stat(fullPath)).mode & 0o777,
        date: new Date("1980-01-01T00:00:00.000Z")
      });
    }
  };
  await visit(canonicalCandidate);
  if (fileCount === 0) throw new Error("Prepared skill is empty.");
  const result = loadSkillsFromDir({ dir: canonicalCandidate, source: "staged" });
  if (result.skills.length !== 1 || result.skills[0]?.name !== expectedName) throw new Error(result.diagnostics[0]?.message ?? "SKILL.md must contain a valid matching name and description.");
  const archive = await zip.generateAsync({ type: "nodebuffer", platform: "UNIX", compression: "DEFLATE" });
  if (archive.byteLength > MAX_SKILL_ARCHIVE_BYTES) throw new Error("Prepared skill archive is too large.");
  return archive;
}

export function archiveSkillContentEvidence(files: string[], maxBytes: number): string {
  const visible: string[] = [];
  let bytes = 0;
  for (const file of files) {
    const lineBytes = Buffer.byteLength(`${file}\n`, "utf8");
    if (bytes + lineBytes > maxBytes) break;
    visible.push(file);
    bytes += lineBytes;
  }
  const omitted = files.length - visible.length;
  const manifest = `${visible.join("\n")}${omitted ? `\n[${omitted} more files omitted; the SHA-256 identifies the complete approved archive]` : ""}`;
  return `Validated archive file manifest (${files.length} files):\n${manifest}\nComplete proposed SKILL.md:`;
}
