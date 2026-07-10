import type { CodexThreadRecord } from "./types.js";

const MAX_REVIEW_PATHS = 2_048;
const MAX_PATH_LENGTH = 1_024;

type PathAccumulator = { paths: Set<string>; overflow: boolean };

function normalizePath(value: string): string | null {
  let candidate = value.trim().replace(/^file:\/\//, "").replaceAll("\\", "/");
  candidate = candidate.replace(/^["'`]+|["'`,;]+$/g, "");
  if (candidate.startsWith("a/") || candidate.startsWith("b/")) candidate = candidate.slice(2);
  while (candidate.startsWith("./")) candidate = candidate.slice(2);
  if (!candidate || candidate === "/dev/null" || candidate.length > MAX_PATH_LENGTH || candidate.includes("\n") || candidate.includes("\0") || /^[a-z]+:\/\//i.test(candidate)) return null;
  return candidate;
}

function addPath(accumulator: PathAccumulator, value: string): void {
  const candidate = normalizePath(value);
  if (!candidate) return;
  if (accumulator.paths.has(candidate)) return;
  if (accumulator.paths.size >= MAX_REVIEW_PATHS) {
    accumulator.overflow = true;
    return;
  }
  accumulator.paths.add(candidate);
}

function scanText(text: string, accumulator: PathAccumulator): void {
  const patterns = [
    /^diff --git a\/(\S+) b\/(\S+)$/gm,
    /^(?:\+\+\+|---) (?:a\/|b\/)?([^\t\r\n]+)(?:\t.*)?$/gm,
    /^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm,
    /(?:^|[\s"'`(])((?:(?:\.{0,2}\/)?[A-Za-z0-9._@+~-]+\/)*(?:[A-Za-z0-9._@+~-]+\.[A-Za-z0-9][A-Za-z0-9._@+~-]{0,31}|Dockerfile|Makefile|Procfile))(?=$|[\s"'`),:;\]])/gm
  ];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      for (const candidate of match.slice(1)) if (candidate) addPath(accumulator, candidate);
    }
  }
}

function scanValue(value: unknown, accumulator: PathAccumulator, seen: WeakSet<object>, depth = 0, pathKey = false): void {
  if (depth > 8 || value === null || value === undefined) return;
  if (typeof value === "string") {
    if (pathKey) addPath(accumulator, value);
    scanText(value, accumulator);
    return;
  }
  if (typeof value !== "object" || seen.has(value)) return;
  seen.add(value);
  if (Array.isArray(value)) {
    for (const entry of value) scanValue(entry, accumulator, seen, depth + 1);
    return;
  }
  for (const [key, entry] of Object.entries(value)) {
    scanValue(entry, accumulator, seen, depth + 1, /(?:^|_)(?:path|file|filename)$/i.test(key) || /^(?:filePath|relativePath)$/i.test(key));
  }
}

export function normalizeWorkerReviewPaths(value: unknown): string[] {
  const accumulator: PathAccumulator = { paths: new Set<string>(), overflow: false };
  if (Array.isArray(value)) for (const entry of value) if (typeof entry === "string") addPath(accumulator, entry);
  return [...accumulator.paths];
}

export function workerFileChangeAttribution(thread: CodexThreadRecord): { paths: string[]; overflow: boolean } {
  const accumulator: PathAccumulator = { paths: new Set<string>(), overflow: false };
  for (const turn of thread.turns) {
    for (const item of turn.items) {
      if (item.type !== "fileChange" && item.type !== "file_change") continue;
      scanText(item.text, accumulator);
      scanValue(item.raw, accumulator, new WeakSet<object>());
    }
  }
  return { paths: [...accumulator.paths], overflow: accumulator.overflow };
}

export function workerFileChangePaths(thread: CodexThreadRecord): string[] {
  return workerFileChangeAttribution(thread).paths;
}

export function workerFileChangeContext(thread: CodexThreadRecord): string {
  const attribution = workerFileChangeAttribution(thread);
  return JSON.stringify({ paths: attribution.paths, attributionUnknown: attribution.overflow });
}
