import { constants, promises as fs } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import path from "node:path";

import { Type } from "@sinclair/typebox";

import type { ButlerAgentToolAccess, ButlerCustomTool } from "./butler-agent-tool-access.js";
import { MAX_TEXT_PREVIEW_BYTES, readTextPreviewHandle } from "./text-preview.js";

type FilesystemInspectionOperation = "list" | "stat" | "find" | "read";
type FilesystemInspectionEntryType = "any" | "file" | "directory" | "symlink";

type FilesystemInspectionParams = {
  operation: FilesystemInspectionOperation;
  path: string;
  maxDepth?: number;
  nameContains?: string;
  type?: FilesystemInspectionEntryType;
  limit?: number;
  maxBytes?: number;
};

type FilesystemInspectionEntry = {
  path: string;
  name: string;
  type: "file" | "directory" | "symlink" | "other";
  size: number;
  mtimeMs: number;
};

const DEFAULT_APPROVED_ROOTS = ["/repos"];
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 200;
const MAX_DEPTH = 5;
const DEFAULT_READ_BYTES = 64 * 1024;

function parseApprovedRoots(raw = process.env.MANOR_BUTLER_FS_INSPECTION_ROOTS): string[] {
  const roots = (raw ?? "")
    .split(path.delimiter)
    .map((entry) => entry.trim())
    .filter(Boolean);
  return roots.length > 0 ? roots : DEFAULT_APPROVED_ROOTS;
}

function normalizeRoot(root: string): string {
  return path.resolve(root);
}

function isInsideRoot(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!!relative && !relative.startsWith("..") && !path.isAbsolute(relative));
}

async function resolveApprovedPath(requestedPath: string, approvedRoots: string[]): Promise<{ requested: string; root: string; realRoot: string }> {
  const requested = path.resolve(requestedPath);
  const roots = await Promise.all(
    approvedRoots.map(async (rawRoot) => {
      const root = normalizeRoot(rawRoot);
      const realRoot = await fs.realpath(root).catch(() => root);
      return { root, realRoot };
    })
  );
  const approved = roots.find((entry) => isInsideRoot(requested, entry.root) || isInsideRoot(requested, entry.realRoot));
  if (!approved) {
    throw new Error(`Path ${requested} is outside approved read-only roots: ${roots.map((entry) => entry.root).join(", ")}`);
  }

  const realRequested = await fs.realpath(requested).catch(() => requested);
  if (!isInsideRoot(realRequested, approved.realRoot)) {
    throw new Error(`Path ${requested} resolves outside approved read-only root ${approved.root}`);
  }

  return { requested, root: approved.root, realRoot: approved.realRoot };
}

function sameFile(left: Awaited<ReturnType<FileHandle["stat"]>>, right: Awaited<ReturnType<typeof fs.lstat>>): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

async function verifyOpenedFilePath(handle: FileHandle, requested: string, realRoot: string): Promise<void> {
  const openedStats = await handle.stat();
  if (!openedStats.isFile()) throw new Error(`${requested} is not a regular file`);

  const procTarget = await fs.readlink(`/proc/self/fd/${handle.fd}`).catch(() => null);
  if (procTarget) {
    if (procTarget.endsWith(" (deleted)") || !isInsideRoot(path.resolve(procTarget), realRoot)) {
      throw new Error(`Path ${requested} resolves outside approved read-only root ${realRoot}`);
    }
    return;
  }

  const before = await fs.lstat(requested);
  if (!before.isFile() || !sameFile(openedStats, before)) throw new Error(`Path ${requested} changed while it was being opened`);
  const currentRealPath = await fs.realpath(requested);
  if (!isInsideRoot(currentRealPath, realRoot)) throw new Error(`Path ${requested} resolves outside approved read-only root ${realRoot}`);
  const after = await fs.lstat(requested);
  if (!after.isFile() || !sameFile(openedStats, after)) throw new Error(`Path ${requested} changed while it was being opened`);
}

async function openApprovedRegularFile(requested: string, realRoot: string): Promise<FileHandle> {
  const handle = await fs.open(requested, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    await verifyOpenedFilePath(handle, requested, realRoot);
    return handle;
  } catch (error) {
    await handle.close();
    throw error;
  }
}

function entryType(stats: Awaited<ReturnType<typeof fs.lstat>>): FilesystemInspectionEntry["type"] {
  if (stats.isSymbolicLink()) return "symlink";
  if (stats.isDirectory()) return "directory";
  if (stats.isFile()) return "file";
  return "other";
}

function toEntry(filePath: string, stats: Awaited<ReturnType<typeof fs.lstat>>): FilesystemInspectionEntry {
  return {
    path: filePath,
    name: path.basename(filePath),
    type: entryType(stats),
    size: Number(stats.size),
    mtimeMs: Number(stats.mtimeMs)
  };
}

function matchesEntry(entry: FilesystemInspectionEntry, params: FilesystemInspectionParams): boolean {
  const wantedType = params.type ?? "any";
  if (wantedType !== "any" && entry.type !== wantedType) return false;
  const needle = params.nameContains?.trim().toLowerCase();
  if (needle && !entry.name.toLowerCase().includes(needle)) return false;
  return true;
}

function clampInteger(value: number | undefined, fallback: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(value as number)));
}

async function listDirectory(dirPath: string): Promise<FilesystemInspectionEntry[]> {
  const names = await fs.readdir(dirPath);
  const entries = await Promise.all(
    names.sort((left, right) => left.localeCompare(right)).map(async (name) => {
      const filePath = path.join(dirPath, name);
      return toEntry(filePath, await fs.lstat(filePath));
    })
  );
  return entries;
}

async function findEntries(rootPath: string, params: FilesystemInspectionParams): Promise<FilesystemInspectionEntry[]> {
  const maxDepth = clampInteger(params.maxDepth, 2, 0, MAX_DEPTH);
  const limit = clampInteger(params.limit, DEFAULT_LIMIT, 1, MAX_LIMIT);
  const rootEntry = toEntry(rootPath, await fs.lstat(rootPath));
  const output: FilesystemInspectionEntry[] = matchesEntry(rootEntry, params) ? [rootEntry] : [];

  async function walk(dirPath: string, depth: number): Promise<void> {
    if (output.length >= limit) return;
    const children = await listDirectory(dirPath);
    for (const child of children) {
      if (matchesEntry(child, params)) output.push(child);
      if (output.length >= limit) return;
      if (child.type === "directory" && depth < maxDepth) await walk(child.path, depth + 1);
    }
  }

  if (maxDepth > 0 && output.length < limit) await walk(rootPath, 1);
  return output.slice(0, limit);
}

function formatEntry(entry: FilesystemInspectionEntry): string {
  return `${entry.type.padEnd(9)} ${entry.size.toString().padStart(8)} ${entry.path}`;
}

export async function inspectReadOnlyFilesystem(
  params: FilesystemInspectionParams,
  options?: { approvedRoots?: string[]; beforeRead?: () => void | Promise<void> }
): Promise<{ text: string; details: Record<string, unknown> }> {
  const approvedRoots = options?.approvedRoots ?? parseApprovedRoots();
  const { requested, realRoot } = await resolveApprovedPath(params.path, approvedRoots);

  if (params.operation === "read") {
    const maxBytes = clampInteger(params.maxBytes, DEFAULT_READ_BYTES, 1, MAX_TEXT_PREVIEW_BYTES);
    const handle = await openApprovedRegularFile(requested, realRoot);
    try {
      const stats = await handle.stat();
      const target = toEntry(requested, stats);
      await options?.beforeRead?.();
      const preview = await readTextPreviewHandle(handle, { maxBytes });
      return {
        text: preview.truncated ? `${preview.text}\n\n[File content truncated at ${maxBytes} bytes.]` : preview.text,
        details: {
          operation: params.operation,
          approvedRoots: approvedRoots.map(normalizeRoot),
          target,
          maxBytes,
          truncated: preview.truncated
        }
      };
    } finally {
      await handle.close();
    }
  }

  const stats = await fs.lstat(requested);
  const target = toEntry(requested, stats);

  if (params.operation === "stat") {
    return {
      text: formatEntry(target),
      details: { operation: params.operation, approvedRoots: approvedRoots.map(normalizeRoot), target }
    };
  }

  if (target.type !== "directory") {
    throw new Error(`${requested} is a ${target.type}; ${params.operation} requires a directory`);
  }

  const limit = clampInteger(params.limit, DEFAULT_LIMIT, 1, MAX_LIMIT);
  const entries = params.operation === "list" ? (await listDirectory(requested)).filter((entry) => matchesEntry(entry, params)).slice(0, limit) : await findEntries(requested, params);
  const text = entries.length > 0 ? entries.map(formatEntry).join("\n") : `No matching entries under ${requested}.`;
  return {
    text,
    details: {
      operation: params.operation,
      approvedRoots: approvedRoots.map(normalizeRoot),
      target,
      maxDepth: params.operation === "find" ? clampInteger(params.maxDepth, 2, 0, MAX_DEPTH) : 1,
      limit,
      entries
    }
  };
}

export function buildButlerFilesystemTools(access: ButlerAgentToolAccess): ButlerCustomTool[] {
  return [
    access.defineButlerTool({
      name: "inspect_filesystem",
      label: "Inspect filesystem",
      description: "Read UTF-8 text, list, stat, or perform a bounded find under approved local roots such as /repos.",
      promptSnippet:
        "inspect_filesystem: read selected text files and answer local filesystem questions directly with read-only read/list/stat/find under approved roots like /repos; reads reject binary data and are size-bounded; never use it for writes, deletes, shell execution, or unrestricted traversal.",
      parameters: Type.Object({
        operation: Type.Union([Type.Literal("list"), Type.Literal("stat"), Type.Literal("find"), Type.Literal("read")]),
        path: Type.String({ minLength: 1 }),
        maxDepth: Type.Optional(Type.Number({ minimum: 0, maximum: MAX_DEPTH })),
        nameContains: Type.Optional(Type.String()),
        type: Type.Optional(Type.Union([Type.Literal("any"), Type.Literal("file"), Type.Literal("directory"), Type.Literal("symlink")])),
        limit: Type.Optional(Type.Number({ minimum: 1, maximum: MAX_LIMIT })),
        maxBytes: Type.Optional(Type.Number({ minimum: 1, maximum: MAX_TEXT_PREVIEW_BYTES }))
      }),
      uiEffects: access.getToolUiEffects("inspect_filesystem"),
      execute: async (_toolCallId, params) => {
        const result = await inspectReadOnlyFilesystem(params as FilesystemInspectionParams);
        return {
          content: [{ type: "text", text: result.text }],
          details: result.details
        };
      }
    })
  ];
}
