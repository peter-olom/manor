import crypto from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

import { writeJsonStateFileAtomic } from "./json-state-file.js";
import { ReferenceMutationQueue } from "./reference-mutation-queue.js";

type PersistedFileReference = {
  id: string;
  name: string;
  mimeType: string;
  sizeBytes: number;
  sha256: string;
  createdAt: number;
  filePath: string;
  sourceReferenceId?: string;
  version?: number;
  lineageVersionHighWater?: number;
};

export type FileReferenceView = {
  id: string;
  name: string;
  mimeType: string;
  sizeBytes: number;
  createdAt: number;
  url: string;
  sourceReferenceId?: string;
  version?: number;
};

export const MAX_FILE_BYTES = 40 * 1024 * 1024;

export async function migrateLegacyReferenceStore(legacyDir: string, targetDir: string): Promise<void> {
  if (path.resolve(legacyDir) === path.resolve(targetDir)) return;
  try {
    await fs.access(path.join(targetDir, "index.json"));
    return;
  } catch {}
  try {
    await fs.access(path.join(legacyDir, "index.json"));
  } catch {
    return;
  }
  await fs.mkdir(path.dirname(targetDir), { recursive: true });
  await fs.cp(legacyDir, targetDir, { recursive: true, errorOnExist: false, force: false });
}

function normalizeMimeType(mimeType: string): string {
  const normalized = mimeType.trim().toLowerCase();
  return normalized.length > 0 ? normalized : "application/octet-stream";
}

function normalizeName(name: string): string {
  const trimmed = name.trim();
  const baseName = trimmed.length > 0 ? path.basename(trimmed) : "reference-file";
  return baseName.slice(0, 220);
}

function normalizeBase64(data: string): string {
  return data.replace(/^data:[^;]+;base64,/, "").replace(/\s+/g, "");
}

function extensionFromName(name: string): string {
  const extension = path.extname(name).trim();
  if (!extension) {
    return "";
  }

  return extension.slice(0, 20);
}

export class FileReferenceStore {
  private readonly records = new Map<string, PersistedFileReference>();
  private readonly filesDir: string;
  private readonly indexPath: string;
  private readonly publicBasePath: string;

  constructor(
    rootDir: string,
    publicBasePath = "/api/files",
    private readonly mutations = new ReferenceMutationQueue()
  ) {
    this.filesDir = path.join(rootDir, "files");
    this.indexPath = path.join(rootDir, "index.json");
    this.publicBasePath = publicBasePath;
  }

  async load(): Promise<void> {
    await fs.mkdir(this.filesDir, { recursive: true });

    let raw: string;
    try {
      raw = await fs.readFile(this.indexPath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return;
      }
      throw error;
    }

    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return;
    }

    this.records.clear();
    for (const entry of parsed) {
      if (!entry || typeof entry !== "object") {
        continue;
      }

      const record = entry as Partial<PersistedFileReference>;
      if (
        typeof record.id !== "string" ||
        typeof record.name !== "string" ||
        typeof record.mimeType !== "string" ||
        typeof record.sizeBytes !== "number" ||
        typeof record.sha256 !== "string" ||
        typeof record.createdAt !== "number" ||
        typeof record.filePath !== "string"
      ) {
        continue;
      }

      const filePath = path.join(this.filesDir, path.basename(record.filePath));
      try {
        await fs.chmod(filePath, 0o444);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          continue;
        }
        throw error;
      }
      this.records.set(record.id, { ...(record as PersistedFileReference), filePath });
    }
  }

  list(limit = 50): FileReferenceView[] {
    return [...this.records.values()]
      .sort((left, right) => right.createdAt - left.createdAt)
      .slice(0, Math.max(1, limit))
      .map((record) => this.toView(record));
  }

  get(id: string): FileReferenceView | null {
    const record = this.records.get(id);
    return record ? this.toView(record) : null;
  }

  getFilePath(id: string): string | null {
    return this.records.get(id)?.filePath ?? null;
  }

  async create(input: { name: string; mimeType: string; data: string; sizeBytes?: number; sourceReferenceId?: string; version?: number }): Promise<FileReferenceView> {
    const normalizedBase64 = normalizeBase64(input.data);
    return this.createFromBuffer({
      name: input.name,
      mimeType: input.mimeType,
      buffer: Buffer.from(normalizedBase64, "base64"),
      sizeBytes: input.sizeBytes,
      sourceReferenceId: input.sourceReferenceId,
      version: input.version
    });
  }

  async createFromBuffer(input: { name: string; mimeType: string; buffer: Buffer; sizeBytes?: number; sourceReferenceId?: string; version?: number }): Promise<FileReferenceView> {
    return this.mutations.run(() => this.createFromBufferNow(input));
  }

  async createVersionFromBuffer(input: { name: string; mimeType: string; buffer: Buffer; sizeBytes?: number; sourceReferenceId: string }): Promise<FileReferenceView> {
    return this.mutations.run(() => {
      const source = this.records.get(input.sourceReferenceId);
      if (!source) throw new Error("Source file reference was not found");
      const rootId = this.lineageRootId(source);
      const root = this.records.get(rootId) ?? source;
      const liveMaximum = [...this.records.values()].reduce(
        (maximum, record) => this.lineageRootId(record) === rootId ? Math.max(maximum, record.version ?? 1) : maximum,
        1
      );
      const previousHighWater = root.lineageVersionHighWater;
      const version = Math.max(previousHighWater ?? 1, liveMaximum) + 1;
      root.lineageVersionHighWater = version;
      return this.createFromBufferNow({ ...input, version }).catch((error) => {
        if (previousHighWater === undefined) delete root.lineageVersionHighWater;
        else root.lineageVersionHighWater = previousHighWater;
        throw error;
      });
    });
  }

  async delete(id: string): Promise<boolean> {
    return this.mutations.run(async () => {
      const record = this.records.get(id);
      if (!record) return false;

      this.records.delete(id);
      try {
        await this.save();
      } catch (error) {
        this.records.set(id, record);
        throw error;
      }

      try {
        await fs.rm(record.filePath, { force: true });
        return true;
      } catch (error) {
        this.records.set(id, record);
        await this.save();
        throw error;
      }
    });
  }

  private async createFromBufferNow(input: { name: string; mimeType: string; buffer: Buffer; sizeBytes?: number; sourceReferenceId?: string; version?: number }): Promise<FileReferenceView> {
    const mimeType = normalizeMimeType(input.mimeType);
    const buffer = input.buffer;
    if (buffer.byteLength === 0) {
      throw new Error("File upload was empty");
    }

    if (buffer.byteLength > MAX_FILE_BYTES) {
      throw new Error(`File upload exceeded ${MAX_FILE_BYTES / (1024 * 1024)} MB`);
    }

    if (typeof input.sizeBytes === "number" && input.sizeBytes > MAX_FILE_BYTES) {
      throw new Error(`File upload exceeded ${MAX_FILE_BYTES / (1024 * 1024)} MB`);
    }

    const id = crypto.randomUUID();
    const name = normalizeName(input.name);
    const filePath = path.join(this.filesDir, `${id}${extensionFromName(name)}`);
    const createdAt = Date.now();
    const record: PersistedFileReference = {
      id,
      name,
      mimeType,
      sizeBytes: buffer.byteLength,
      sha256: crypto.createHash("sha256").update(buffer).digest("hex"),
      createdAt,
      filePath,
      ...(input.sourceReferenceId ? { sourceReferenceId: input.sourceReferenceId, version: input.version ?? 2 } : {})
    };

    await fs.writeFile(filePath, buffer, { mode: 0o444 });
    await fs.chmod(filePath, 0o444);
    this.records.set(id, record);
    try {
      await this.save();
    } catch (error) {
      this.records.delete(id);
      await fs.rm(filePath, { force: true }).catch(() => undefined);
      throw error;
    }
    return this.toView(record);
  }

  private lineageRootId(record: PersistedFileReference): string {
    let current = record;
    const seen = new Set<string>();
    while (current.sourceReferenceId && !seen.has(current.sourceReferenceId)) {
      seen.add(current.id);
      const parent = this.records.get(current.sourceReferenceId);
      if (!parent) break;
      current = parent;
    }
    return current.id;
  }

  resolveViews(fileReferenceIds: string[]): FileReferenceView[] {
    return this.resolveRecords(fileReferenceIds).map((record) => this.toView(record));
  }

  private resolveRecords(fileReferenceIds: string[]): PersistedFileReference[] {
    const resolved: PersistedFileReference[] = [];
    const seen = new Set<string>();

    for (const id of fileReferenceIds) {
      if (seen.has(id)) {
        continue;
      }
      seen.add(id);
      const record = this.records.get(id);
      if (!record) {
        throw new Error(`File reference ${id} was not found`);
      }
      resolved.push(record);
    }

    return resolved;
  }

  private toView(record: PersistedFileReference): FileReferenceView {
    return {
      id: record.id,
      name: record.name,
      mimeType: record.mimeType,
      sizeBytes: record.sizeBytes,
      createdAt: record.createdAt,
      url: `${this.publicBasePath}/${record.id}`,
      ...(record.sourceReferenceId ? { sourceReferenceId: record.sourceReferenceId, version: record.version ?? 2 } : {})
    };
  }

  private async save(): Promise<void> {
    const payload = [...this.records.values()].sort((left, right) => right.createdAt - left.createdAt);
    await writeJsonStateFileAtomic(this.indexPath, payload);
  }

}
