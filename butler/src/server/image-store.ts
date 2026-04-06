import crypto from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

import type { ImageContent } from "@mariozechner/pi-ai";

export type CodexInputItem =
  | {
      type: "text";
      text: string;
    }
  | {
      type: "localImage";
      path: string;
    };

type PersistedImageReference = {
  id: string;
  name: string;
  mimeType: string;
  sizeBytes: number;
  sha256: string;
  createdAt: number;
  filePath: string;
};

export type ImageReferenceView = {
  id: string;
  name: string;
  mimeType: string;
  sizeBytes: number;
  createdAt: number;
  url: string;
};

const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const DEFAULT_IMAGE_PROMPT = "Use the attached reference image for this request.";
const DEFAULT_IMAGES_PROMPT = "Use the attached reference images for this request.";

function ensureImageMimeType(mimeType: string): string {
  const normalized = mimeType.trim().toLowerCase();
  if (!normalized.startsWith("image/")) {
    throw new Error("Only image uploads are supported");
  }
  return normalized;
}

function extensionFromMimeType(mimeType: string): string {
  switch (mimeType) {
    case "image/png":
      return ".png";
    case "image/jpeg":
      return ".jpg";
    case "image/webp":
      return ".webp";
    case "image/gif":
      return ".gif";
    case "image/svg+xml":
      return ".svg";
    case "image/avif":
      return ".avif";
    default:
      return "";
  }
}

function normalizeImageName(name: string, mimeType: string): string {
  const trimmed = name.trim();
  const baseName = trimmed.length > 0 ? path.basename(trimmed) : `reference${extensionFromMimeType(mimeType)}`;
  return baseName.slice(0, 160);
}

function normalizeBase64(data: string): string {
  return data.replace(/^data:[^;]+;base64,/, "").replace(/\s+/g, "");
}

function formatReferenceLines(references: PersistedImageReference[], options?: { includeIds?: boolean }): string[] {
  return references.map((reference) =>
    options?.includeIds ? `- ${reference.id} | ${reference.name}` : `- ${reference.name}`
  );
}

export class ImageReferenceStore {
  private readonly records = new Map<string, PersistedImageReference>();
  private readonly rootDir: string;
  private readonly filesDir: string;
  private readonly indexPath: string;
  private readonly publicBasePath: string;

  constructor(rootDir: string, publicBasePath = "/api/images") {
    this.rootDir = rootDir;
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

      const record = entry as Partial<PersistedImageReference>;
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

      this.records.set(record.id, record as PersistedImageReference);
    }
  }

  list(limit = 20): ImageReferenceView[] {
    return [...this.records.values()]
      .sort((left, right) => right.createdAt - left.createdAt)
      .slice(0, Math.max(1, limit))
      .map((record) => this.toView(record));
  }

  get(id: string): ImageReferenceView | null {
    const record = this.records.get(id);
    return record ? this.toView(record) : null;
  }

  getFilePath(id: string): string | null {
    return this.records.get(id)?.filePath ?? null;
  }

  findByPath(filePath: string): ImageReferenceView | null {
    const normalizedTarget = path.resolve(filePath);
    for (const record of this.records.values()) {
      if (path.resolve(record.filePath) === normalizedTarget) {
        return this.toView(record);
      }
    }
    return null;
  }

  async create(input: { name: string; mimeType: string; data: string; sizeBytes?: number }): Promise<ImageReferenceView> {
    const mimeType = ensureImageMimeType(input.mimeType);
    const normalizedBase64 = normalizeBase64(input.data);
    const buffer = Buffer.from(normalizedBase64, "base64");

    if (buffer.byteLength === 0) {
      throw new Error("Image upload was empty");
    }

    if (buffer.byteLength > MAX_IMAGE_BYTES) {
      throw new Error(`Image upload exceeded ${MAX_IMAGE_BYTES / (1024 * 1024)} MB`);
    }

    if (typeof input.sizeBytes === "number" && input.sizeBytes > MAX_IMAGE_BYTES) {
      throw new Error(`Image upload exceeded ${MAX_IMAGE_BYTES / (1024 * 1024)} MB`);
    }

    const id = crypto.randomUUID();
    const sha256 = crypto.createHash("sha256").update(buffer).digest("hex");
    const name = normalizeImageName(input.name, mimeType);
    const filePath = path.join(this.filesDir, `${id}${extensionFromMimeType(mimeType)}`);
    const createdAt = Date.now();
    const record: PersistedImageReference = {
      id,
      name,
      mimeType,
      sizeBytes: buffer.byteLength,
      sha256,
      createdAt,
      filePath
    };

    await fs.writeFile(filePath, buffer);
    this.records.set(id, record);
    await this.save();
    return this.toView(record);
  }

  buildPromptText(
    text: string,
    imageReferenceIds: string[],
    options?: {
      includeIds?: boolean;
    }
  ): string {
    const trimmedText = text.trim();
    const references = this.resolveRecords(imageReferenceIds);
    if (references.length === 0) {
      return trimmedText;
    }

    const lead = trimmedText || (references.length === 1 ? DEFAULT_IMAGE_PROMPT : DEFAULT_IMAGES_PROMPT);
    const header = options?.includeIds ? "Stored reference images:" : "Attached reference images:";
    return `${lead}\n\n${header}\n${formatReferenceLines(references, options).join("\n")}`;
  }

  buildCodexInput(text: string, imageReferenceIds: string[]): CodexInputItem[] {
    const promptText = this.buildPromptText(text, imageReferenceIds);
    const references = this.resolveRecords(imageReferenceIds);
    const input: CodexInputItem[] = [];

    if (promptText) {
      input.push({ type: "text", text: promptText });
    }

    for (const reference of references) {
      input.push({
        type: "localImage",
        path: reference.filePath
      });
    }

    if (input.length === 0) {
      throw new Error("A message must include text or at least one image");
    }

    return input;
  }

  async loadPiImages(imageReferenceIds: string[]): Promise<ImageContent[]> {
    const references = this.resolveRecords(imageReferenceIds);
    return Promise.all(
      references.map(async (reference) => ({
        type: "image" as const,
        data: (await fs.readFile(reference.filePath)).toString("base64"),
        mimeType: reference.mimeType
      }))
    );
  }

  resolveViews(imageReferenceIds: string[]): ImageReferenceView[] {
    return this.resolveRecords(imageReferenceIds).map((reference) => this.toView(reference));
  }

  private resolveRecords(imageReferenceIds: string[]): PersistedImageReference[] {
    const resolved: PersistedImageReference[] = [];
    const seen = new Set<string>();

    for (const id of imageReferenceIds) {
      if (seen.has(id)) {
        continue;
      }
      seen.add(id);
      const record = this.records.get(id);
      if (!record) {
        throw new Error(`Image reference ${id} was not found`);
      }
      resolved.push(record);
    }

    return resolved;
  }

  private toView(record: PersistedImageReference): ImageReferenceView {
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
