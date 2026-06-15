import crypto from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

function stateFileTimestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

async function quarantineStateFile(filePath: string): Promise<void> {
  try {
    await fs.rename(filePath, `${filePath}.corrupt-${stateFileTimestamp()}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
}

export async function readJsonStateFile<T>(filePath: string, fallback: T): Promise<T> {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    if (!raw.trim()) return fallback;
    return JSON.parse(raw) as T;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return fallback;
    if (error instanceof SyntaxError) {
      await quarantineStateFile(filePath);
      return fallback;
    }
    throw error;
  }
}

export async function writeJsonStateFileAtomic(filePath: string, value: unknown): Promise<void> {
  const directory = path.dirname(filePath);
  const basename = path.basename(filePath);
  const temporaryPath = path.join(directory, `.${basename}.${process.pid}.${Date.now()}.${crypto.randomUUID()}.tmp`);

  try {
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    await fs.rename(temporaryPath, filePath);
  } catch (error) {
    await fs.rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
}
