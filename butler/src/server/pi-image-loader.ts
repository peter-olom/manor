import { open, type FileHandle } from "node:fs/promises";
import path from "node:path";

import type { ImageContent } from "@mariozechner/pi-ai";

const PI_MAX_IMAGE_BYTES = 3 * 1024 * 1024;
const PI_MAX_TOTAL_IMAGE_BYTES = 12 * 1024 * 1024;
const PI_IMAGE_MIME_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp"
]);

export type PiImageFile = {
  path: string;
  mimeType?: string;
};

function imageMimeType(filePath: string): string {
  switch (path.extname(filePath).toLowerCase()) {
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".webp":
      return "image/webp";
    case ".gif":
      return "image/gif";
    default:
      throw new Error(`Unsupported local image format: ${filePath}`);
  }
}

function resolveImageMimeType(filePath: string, mimeType: string | undefined): string {
  const normalized = mimeType?.trim().toLowerCase() ?? "";
  const resolved = normalized || imageMimeType(filePath);
  if (!PI_IMAGE_MIME_TYPES.has(resolved)) {
    throw new Error(
      `Unsupported Pi image MIME type "${resolved}" for ${filePath}. ` +
      "Supported types: image/jpeg, image/png, image/gif, image/webp."
    );
  }
  return resolved;
}

async function readPreparedFile(handle: FileHandle, size: number): Promise<string> {
  const buffer = Buffer.allocUnsafe(size);
  let offset = 0;
  while (offset < size) {
    const { bytesRead } = await handle.read(buffer, offset, size - offset, offset);
    if (bytesRead === 0) break;
    offset += bytesRead;
  }
  return buffer.subarray(0, offset).toString("base64");
}

export async function loadPiImageFiles(files: PiImageFile[]): Promise<ImageContent[]> {
  const prepared: Array<{
    handle: FileHandle;
    mimeType: string;
    size: number;
  }> = [];

  try {
    let totalBytes = 0;
    for (const file of files) {
      const mimeType = resolveImageMimeType(file.path, file.mimeType);
      const handle = await open(file.path, "r");
      const preparedFile = { handle, mimeType, size: 0 };
      prepared.push(preparedFile);
      const fileStats = await handle.stat();
      if (!fileStats.isFile()) throw new Error(`Pi image attachment is not a regular file: ${file.path}`);
      if (fileStats.size > PI_MAX_IMAGE_BYTES) {
        throw new Error(
          `Pi image attachment exceeds the 3 MiB limit: ${file.path} is ${fileStats.size} bytes.`
        );
      }
      preparedFile.size = fileStats.size;
      totalBytes += fileStats.size;
      if (totalBytes > PI_MAX_TOTAL_IMAGE_BYTES) {
        throw new Error(
          `Pi image attachments exceed the 12 MiB aggregate limit: ${totalBytes} bytes across ${prepared.length} images.`
        );
      }
    }

    return await Promise.all(
      prepared.map(async (file) => ({
        type: "image" as const,
        data: await readPreparedFile(file.handle, file.size),
        mimeType: file.mimeType
      }))
    );
  } finally {
    await Promise.allSettled(prepared.map((file) => file.handle.close()));
  }
}
