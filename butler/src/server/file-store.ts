import crypto from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

type PersistedFileReference = {
  id: string;
  name: string;
  mimeType: string;
  sizeBytes: number;
  sha256: string;
  createdAt: number;
  filePath: string;
};

export type FileReferenceView = {
  id: string;
  name: string;
  mimeType: string;
  sizeBytes: number;
  createdAt: number;
  url: string;
};

const MAX_FILE_BYTES = 40 * 1024 * 1024;

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

  constructor(rootDir: string, publicBasePath = "/api/files") {
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

      this.records.set(record.id, record as PersistedFileReference);
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

  async create(input: { name: string; mimeType: string; data: string; sizeBytes?: number }): Promise<FileReferenceView> {
    const mimeType = normalizeMimeType(input.mimeType);
    const normalizedBase64 = normalizeBase64(input.data);
    const buffer = Buffer.from(normalizedBase64, "base64");
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
      filePath
    };

    await fs.writeFile(filePath, buffer);
    this.records.set(id, record);
    await this.save();
    return this.toView(record);
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
      url: `${this.publicBasePath}/${record.id}`
    };
  }

  private async save(): Promise<void> {
    const payload = [...this.records.values()].sort((left, right) => right.createdAt - left.createdAt);
    await fs.writeFile(this.indexPath, JSON.stringify(payload, null, 2), "utf8");
  }
}
