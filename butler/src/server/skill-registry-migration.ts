import crypto from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

import { archiveSkillDirectory } from "./skill-archive.js";

const MARKER = ".manor-legacy-skill-migration-v1";

async function exists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function isWithin(root: string, target: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export async function migrateLegacySkillRegistry(input: {
  sharedRoot: string;
  legacyRoots: string[];
  validateName: (name: string) => string;
  importArchive: (archiveBase64: string) => Promise<void>;
  ownMarker: (markerPath: string) => Promise<void>;
}): Promise<{ migrated: number; skipped: number; failed: number }> {
  const markerPath = path.join(input.sharedRoot, MARKER);
  if (await exists(markerPath)) return { migrated: 0, skipped: 0, failed: 0 };
  const canonicalShared = await fs.realpath(input.sharedRoot);
  let migrated = 0;
  let skipped = 0;
  let failed = 0;
  for (const legacyRoot of input.legacyRoots) {
    const canonicalLegacy = await fs.realpath(path.resolve(legacyRoot)).catch(() => null);
    if (!canonicalLegacy || canonicalLegacy === canonicalShared) continue;
    const entries = await fs.readdir(canonicalLegacy, { withFileTypes: true }).catch(() => []);
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      let name: string;
      try {
        name = input.validateName(entry.name);
      } catch {
        failed += 1;
        console.warn(`Skipping invalid legacy skill directory ${entry.name}.`);
        continue;
      }
      if (await exists(path.join(input.sharedRoot, name))) {
        skipped += 1;
        continue;
      }
      try {
        const source = await fs.realpath(path.join(canonicalLegacy, entry.name));
        if (!isWithin(canonicalLegacy, source)) throw new Error("Legacy skill escapes its registry.");
        const archive = await archiveSkillDirectory(name, source);
        await input.importArchive(archive.toString("base64"));
        migrated += 1;
      } catch (error) {
        failed += 1;
        console.warn(`Could not migrate legacy skill ${name}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
  const stagedMarker = `${markerPath}.${crypto.randomUUID()}.tmp`;
  await fs.writeFile(stagedMarker, `${JSON.stringify({ completedAt: new Date().toISOString(), version: 1, migrated, skipped, failed })}\n`, { mode: 0o644 });
  await input.ownMarker(stagedMarker);
  await fs.rename(stagedMarker, markerPath);
  return { migrated, skipped, failed };
}
