import { promises as fs } from "node:fs";

export const MAX_TEXT_PREVIEW_BYTES = 1024 * 1024;

export class InvalidTextPreviewError extends Error {}

export async function readTextPreview(filePath: string): Promise<{ text: string; truncated: boolean }> {
  const handle = await fs.open(filePath, "r");
  try {
    const buffer = Buffer.allocUnsafe(MAX_TEXT_PREVIEW_BYTES + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, 0);
    const bytes = buffer.subarray(0, bytesRead);
    if (bytes.includes(0)) throw new InvalidTextPreviewError("This file contains binary data and cannot be previewed as text");
    const truncated = bytesRead > MAX_TEXT_PREVIEW_BYTES;
    try {
      const text = new TextDecoder("utf-8", { fatal: true }).decode(
        bytes.subarray(0, MAX_TEXT_PREVIEW_BYTES),
        { stream: truncated }
      );
      return { text, truncated };
    } catch {
      throw new InvalidTextPreviewError("This file is not valid UTF-8 text");
    }
  } finally {
    await handle.close();
  }
}
