import { promises as fs } from "node:fs";
import path from "node:path";

const SESSION_DATE_SEARCH_RADIUS_DAYS = 1;
const DAY_MS = 24 * 60 * 60 * 1000;

export function normalizeTimestampMs(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

function parseUuidV7TimestampMs(value: string): number | null {
  const normalized = value.replaceAll("-", "");
  if (!/^[0-9a-f]{32}$/i.test(normalized) || normalized[12]?.toLowerCase() !== "7") {
    return null;
  }

  const timestamp = Number.parseInt(normalized.slice(0, 12), 16);
  return Number.isSafeInteger(timestamp) && timestamp > 0 ? timestamp : null;
}

function addSessionDateDir(targets: Set<string>, sessionsDir: string, timestamp: number, useUtc: boolean): void {
  const date = new Date(timestamp);
  const year = useUtc ? date.getUTCFullYear() : date.getFullYear();
  const month = `${(useUtc ? date.getUTCMonth() : date.getMonth()) + 1}`.padStart(2, "0");
  const day = `${useUtc ? date.getUTCDate() : date.getDate()}`.padStart(2, "0");
  targets.add(path.join(sessionsDir, `${year}`, month, day));
}

function resolveThreadSessionSearchDirs(sessionsDir: string, threadId: string, threadCreatedAt: number | null): string[] {
  const timestamps = [
    normalizeTimestampMs(threadCreatedAt),
    parseUuidV7TimestampMs(threadId)
  ].filter((timestamp): timestamp is number => timestamp !== null);
  if (timestamps.length === 0) {
    return [];
  }

  const targets = new Set<string>();
  for (const timestamp of timestamps) {
    for (let dayOffset = -SESSION_DATE_SEARCH_RADIUS_DAYS; dayOffset <= SESSION_DATE_SEARCH_RADIUS_DAYS; dayOffset += 1) {
      const adjusted = timestamp + dayOffset * DAY_MS;
      addSessionDateDir(targets, sessionsDir, adjusted, true);
      addSessionDateDir(targets, sessionsDir, adjusted, false);
    }
  }
  return [...targets];
}

export async function listFilesRecursive(root: string): Promise<string[]> {
  const entries = await fs.readdir(root, { withFileTypes: true }).catch(() => []);
  const files: string[] = [];

  for (const entry of entries) {
    const entryPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listFilesRecursive(entryPath)));
    } else if (entry.isFile()) {
      files.push(entryPath);
    }
  }

  return files;
}

async function listFilesInDirectory(root: string, predicate: (fileName: string) => boolean): Promise<string[]> {
  const entries = await fs.readdir(root, { withFileTypes: true }).catch(() => []);
  return entries
    .filter((entry) => entry.isFile() && predicate(entry.name))
    .map((entry) => path.join(root, entry.name));
}

export async function listThreadSessionFiles(codexHomeDir: string, threadId: string, threadCreatedAt: number | null): Promise<string[]> {
  const sessionsDir = path.join(codexHomeDir, "sessions");
  const searchDirs = resolveThreadSessionSearchDirs(sessionsDir, threadId, threadCreatedAt);
  if (searchDirs.length > 0) {
    const matches = await Promise.all(searchDirs.map((directory) => listFilesInDirectory(directory, (fileName) => fileName.includes(threadId))));
    return matches.flat();
  }

  return (await listFilesRecursive(sessionsDir)).filter((filePath) => filePath.includes(threadId));
}

export async function listThreadSnapshotFiles(codexHomeDir: string, threadId: string): Promise<string[]> {
  const snapshotsDir = path.join(codexHomeDir, "shell_snapshots");
  return listFilesInDirectory(snapshotsDir, (fileName) => fileName.startsWith(`${threadId}.`));
}
