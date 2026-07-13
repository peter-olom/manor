import { promises as fs } from "node:fs";
import type { FileHandle } from "node:fs/promises";

export const MAX_TEXT_PREVIEW_BYTES = 1024 * 1024;

export class InvalidTextPreviewError extends Error {}

export async function readTextPreviewHandle(
  handle: FileHandle,
  options?: { maxBytes?: number }
): Promise<{ text: string; truncated: boolean }> {
  const requestedMaxBytes = options?.maxBytes;
  const maxBytes = Number.isFinite(requestedMaxBytes)
    ? Math.min(MAX_TEXT_PREVIEW_BYTES, Math.max(1, Math.trunc(requestedMaxBytes as number)))
    : MAX_TEXT_PREVIEW_BYTES;
  const buffer = Buffer.allocUnsafe(maxBytes + 1);
  const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, 0);
  const bytes = buffer.subarray(0, bytesRead);
  if (bytes.includes(0)) throw new InvalidTextPreviewError("This file contains binary data and cannot be previewed as text");
  const truncated = bytesRead > maxBytes;
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(
      bytes.subarray(0, maxBytes),
      { stream: truncated }
    );
    return { text, truncated };
  } catch {
    throw new InvalidTextPreviewError("This file is not valid UTF-8 text");
  }
}

export async function readTextPreview(
  filePath: string,
  options?: { maxBytes?: number }
): Promise<{ text: string; truncated: boolean }> {
  const handle = await fs.open(filePath, "r");
  try {
    return await readTextPreviewHandle(handle, options);
  } finally {
    await handle.close();
  }
}
