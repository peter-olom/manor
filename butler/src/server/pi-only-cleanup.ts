import { promises as fs } from "node:fs";
import path from "node:path";

import type { CodexThreadSummary } from "./types.js";

const THREAD_SCOPED_ARTIFACT_ROOTS = ["files", "job-payloads", "job-instructions"];

async function removeNonPiDirectories(root: string): Promise<void> {
  const entries = await fs.readdir(root, { withFileTypes: true }).catch(() => []);
  await Promise.all(entries
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("pi-"))
    .map((entry) => fs.rm(path.join(root, entry.name), { recursive: true, force: true })));
}

export async function purgeNonPiWorkerArtifacts(artifactsDir: string, threads: CodexThreadSummary[]): Promise<void> {
  await Promise.all(THREAD_SCOPED_ARTIFACT_ROOTS.map((directory) => removeNonPiDirectories(path.join(artifactsDir, directory))));

  const activeBaselineDirectories = new Set(threads
    .map((thread) => thread.executionContract?.reviewBaselineObjectDir)
    .filter((value): value is string => Boolean(value))
    .map((value) => path.resolve(path.dirname(value))));
  const reviewRoot = path.join(artifactsDir, "review-baselines");
  const entries = await fs.readdir(reviewRoot, { withFileTypes: true }).catch(() => []);
  await Promise.all(entries
    .filter((entry) => entry.isDirectory() && !activeBaselineDirectories.has(path.resolve(reviewRoot, entry.name)))
    .map((entry) => fs.rm(path.join(reviewRoot, entry.name), { recursive: true, force: true })));
}
