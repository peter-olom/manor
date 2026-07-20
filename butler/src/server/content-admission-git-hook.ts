import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { admitContentThroughButler } from "./content-admission-client.js";
import { formatContentAdmissionNotice } from "./content-admission-review.js";

const execFileAsync = promisify(execFile);
const MAX_SNAPSHOT_CHARS = 48_000;
const MAX_NEW_COMMITS = 160;
const INSTRUCTION_PATH = /(^|\/)(agents|claude|gemini|codex)\.md$|(^|\/)readme(?:\.[^/]+)?$|\.github\/(?:copilot-)?instructions|\.cursor\/rules/i;
const SUSPICIOUS_PATTERN = "ignore (all |any )?(previous|prior)|system prompt|prompt injection|assistant instructions|agent instructions|reveal (credentials|secrets)|call (a |the )?tool";

async function git(args: string[], cwd: string, maxBuffer = 4 * 1024 * 1024): Promise<string> {
  return (await execFileAsync("/usr/bin/git", ["-c", "safe.directory=*", ...args], { cwd, maxBuffer })).stdout.trim();
}

function objectIds(value: string): string[] {
  return [...new Set(value.split(/\s+/).filter((entry) => /^[a-f0-9]{40,64}$/i.test(entry)))];
}

async function fetchedObjectIds(cwd: string): Promise<string[]> {
  const fetchHeadPath = await git(["rev-parse", "--git-path", "FETCH_HEAD"], cwd).catch(() => "");
  if (!fetchHeadPath) return [];
  return objectIds(await fs.readFile(fetchHeadPath, "utf8").catch(() => ""));
}

async function beforeObjectIds(filePath: string | undefined): Promise<string[]> {
  return filePath ? objectIds(await fs.readFile(filePath, "utf8").catch(() => "")) : [];
}

function appendSection(sections: string[], title: string, content: string, limit = MAX_SNAPSHOT_CHARS): void {
  if (!content) return;
  const used = sections.join("\n\n").length;
  const remaining = Math.min(limit, MAX_SNAPSHOT_CHARS) - used - title.length - 7;
  if (remaining <= 0) return;
  sections.push(`--- ${title} ---\n${content.slice(0, remaining)}`);
}

export async function repositorySnapshot(cwd: string, beforeRefsPath?: string, operation = "git content update"): Promise<string> {
  const [root, head, remote, before, refs, fetched] = await Promise.all([
    git(["rev-parse", "--show-toplevel"], cwd),
    git(["rev-parse", "HEAD"], cwd).catch(() => ""),
    git(["remote", "get-url", "origin"], cwd).catch(() => "unknown"),
    beforeObjectIds(beforeRefsPath),
    git(["for-each-ref", "--format=%(objectname)"], cwd).then(objectIds).catch(() => []),
    fetchedObjectIds(cwd)
  ]);
  const beforeSet = new Set(before);
  const changedTips = refs.filter((oid) => !beforeSet.has(oid));
  const after = [...new Set([...changedTips, ...fetched, ...(head ? [head] : [])])];
  const revArgs = after.length > 0
    ? ["rev-list", `--max-count=${MAX_NEW_COMMITS}`, ...after, ...(before.length > 0 ? ["--not", ...before] : [])]
    : [];
  const newCommits = revArgs.length > 0 ? objectIds(await git(revArgs, root).catch(() => "")) : [];
  const targets = [...new Set([...changedTips, ...fetched, ...newCommits, ...(head ? [head] : [])])].slice(0, MAX_NEW_COMMITS);
  const sections = [
    `Operation: ${operation}`,
    `Repository: ${remote}`,
    `Current commit: ${head || "unborn"}`,
    `New or selected commit objects sampled: ${targets.length}${targets.length >= MAX_NEW_COMMITS ? " (bounded)" : ""}`
  ];

  const instructionObjects = new Map<string, string>();
  const treeTargets = [...new Set([...changedTips, ...fetched, ...(head ? [head] : [])])].slice(0, 40);
  const trackedNames = new Set<string>();
  for (const oid of treeTargets) {
    const names = (await git(["ls-tree", "-r", "--name-only", oid], root).catch(() => "")).split("\n").filter(Boolean);
    for (const name of names) {
      trackedNames.add(name);
      if (INSTRUCTION_PATH.test(name) && !instructionObjects.has(name)) instructionObjects.set(name, oid);
    }
  }

  for (const [name, oid] of [...instructionObjects.entries()].slice(0, 40)) {
    const content = await git(["show", `${oid}:${name}`], root, 2 * 1024 * 1024).catch(() => "");
    appendSection(sections, `instruction-bearing file ${name}`, content, 32_000);
  }

  if (targets.length > 0) {
    const matches = await git(["grep", "-I", "-n", "-E", SUSPICIOUS_PATTERN, ...targets.slice(0, 80), "--"], root, 8 * 1024 * 1024).catch(() => "");
    appendSection(sections, "instruction-like matches in admitted Git objects", matches, 44_000);
  }

  appendSection(
    sections,
    `tracked file names (${trackedNames.size})`,
    [...trackedNames].sort().join("\n"),
    MAX_SNAPSHOT_CHARS
  );
  return sections.join("\n\n").slice(0, MAX_SNAPSHOT_CHARS);
}

export async function enforcementEnabled(policyPath = process.env.MANOR_CONTENT_ADMISSION_POLICY_PATH): Promise<boolean> {
  if (!policyPath) return false;
  const policy = JSON.parse(await fs.readFile(policyPath, "utf8")) as { mode?: unknown };
  return policy.mode === "enforce";
}

async function main(): Promise<void> {
  const cwd = process.argv[2] || process.cwd();
  const beforeRefsPath = process.argv[3] || undefined;
  const operation = process.argv[4] || "git content update";
  const snapshot = await repositorySnapshot(cwd, beforeRefsPath, operation);
  const result = await admitContentThroughButler("repository", snapshot, `${cwd} ${operation}`);
  if (result.notified) process.stdout.write(`${formatContentAdmissionNotice(result)}\n`);
  if (!result.admitted) process.exitCode = 78;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main().catch(async (_error) => {
    const enforcing = await enforcementEnabled().catch(() => true);
    process.stderr.write(`${formatContentAdmissionNotice({ content: "", review: null, admitted: !enforcing, cached: false, notified: true, unavailable: true })}\n`);
    if (enforcing) process.exitCode = 78;
  });
}
