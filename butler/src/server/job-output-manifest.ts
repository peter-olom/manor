import crypto from "node:crypto";
import { constants, promises as fs } from "node:fs";
import path from "node:path";

import type { JobOutputManifestEntryView, JobPayloadView } from "./job-payload-types.js";
import {
  jobPayloadsRoot,
  persistJobPayload,
  readCurrentJobPayload,
  updateJobOutputManifestIntegrity
} from "./job-instruction-artifacts.js";
import { runSerializedJobMutation } from "./butler-job-mutation-guard.js";
import { createProjectArtifactFromFile } from "./project-artifacts-policies.js";
import { getProjectArtifactUserDownloadUrl, getProjectArtifactUserUrl } from "./project-artifact-access.js";
import { inspectProofArtifacts } from "./proof-artifact-inspector.js";
import type { ButlerStateStore } from "./state-store.js";
import type { CodexWorkerReportView, PreviewProofRecordView, PreviewVerificationArtifactView, ProjectArtifactView } from "./types.js";

export type ResolvedJobOutputManifestEntry = {
  entry: JobOutputManifestEntryView;
  available: boolean;
  availability: JobOutputManifestEntryView["availability"];
  checksumStatus: JobOutputManifestEntryView["checksumStatus"];
  integrityCheckedAt: number | null;
  integrity: "verified" | "mismatch" | "unverified" | "missing";
  proofOutcome: "passed" | "failed" | "expired" | null;
  artifact: ProjectArtifactView | null;
  proof: PreviewProofRecordView | null;
  report: CodexWorkerReportView | null;
};

export type ReconciledJobOutputFile = {
  relativePath: string;
  artifact: ProjectArtifactView;
  reused: boolean;
};

const MAX_JOB_OUTPUT_FILES = 128;
const MAX_JOB_OUTPUT_DEPTH = 12;
const MAX_JOB_OUTPUT_FILE_BYTES = 100 * 1024 * 1024;
const MAX_JOB_OUTPUT_TOTAL_BYTES = 512 * 1024 * 1024;
const MAX_JOB_OUTPUT_DIRECTORY_ENTRIES = 512;
const MAX_ARTIFACT_INSPECTION_BYTES = 100 * 1024 * 1024;

function assertSafeJobOutputThreadId(threadId: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(threadId) || threadId === "." || threadId === "..") {
    throw new Error(`Job ${threadId} cannot be mapped to a safe durable output directory.`);
  }
}

function withinRoot(candidate: string, root: string): boolean {
  return candidate === root || candidate.startsWith(`${root}${path.sep}`);
}

async function listJobOutputFiles(root: string): Promise<Array<{ filePath: string; relativePath: string; sizeBytes: number }>> {
  const files: Array<{ filePath: string; relativePath: string; sizeBytes: number }> = [];
  let totalBytes = 0;
  let totalEntries = 0;
  const visit = async (directory: string, relativeDirectory: string, depth: number): Promise<void> => {
    if (depth > MAX_JOB_OUTPUT_DEPTH) {
      throw new Error(`Durable job output nesting exceeds ${MAX_JOB_OUTPUT_DEPTH} directories.`);
    }
    const entries = [];
    const opened = await fs.opendir(directory);
    for await (const entry of opened) {
      totalEntries += 1;
      if (totalEntries > MAX_JOB_OUTPUT_DIRECTORY_ENTRIES) {
        throw new Error(`Durable job outputs exceed the ${MAX_JOB_OUTPUT_DIRECTORY_ENTRIES}-entry directory limit.`);
      }
      entries.push(entry);
    }
    entries.sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
    for (const entry of entries) {
      const relativePath = relativeDirectory ? path.posix.join(relativeDirectory, entry.name) : entry.name;
      const filePath = path.join(directory, entry.name);
      const stats = await fs.lstat(filePath);
      if (stats.isSymbolicLink()) {
        throw new Error(`Durable job output ${relativePath} is a symbolic link; only owned regular files are allowed.`);
      }
      if (stats.isDirectory()) {
        await visit(filePath, relativePath, depth + 1);
        continue;
      }
      if (!stats.isFile()) {
        throw new Error(`Durable job output ${relativePath} is not a regular file.`);
      }
      if (stats.nlink > 1) {
        throw new Error(`Durable job output ${relativePath} has multiple hard links and cannot be admitted safely.`);
      }
      if (stats.size > MAX_JOB_OUTPUT_FILE_BYTES) {
        throw new Error(`Durable job output ${relativePath} exceeds ${MAX_JOB_OUTPUT_FILE_BYTES} bytes.`);
      }
      totalBytes += stats.size;
      if (totalBytes > MAX_JOB_OUTPUT_TOTAL_BYTES) {
        throw new Error(`Durable job outputs exceed ${MAX_JOB_OUTPUT_TOTAL_BYTES} bytes in total.`);
      }
      files.push({ filePath, relativePath, sizeBytes: stats.size });
      if (files.length > MAX_JOB_OUTPUT_FILES) {
        throw new Error(`Durable job outputs exceed the ${MAX_JOB_OUTPUT_FILES}-file limit.`);
      }
    }
  };
  await visit(root, "", 0);
  return files;
}

type ArtifactFileInspection = {
  available: boolean;
  stable: boolean;
  sizeBytes: number | null;
  changedAt: number | null;
  checksumSha256: string | null;
};

async function inspectArtifactFile(filePath: string, includeChecksum: boolean): Promise<ArtifactFileInspection> {
  const handle = await fs.open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK).catch(() => null);
  if (!handle) return { available: false, stable: false, sizeBytes: null, changedAt: null, checksumSha256: null };
  try {
    const initial = await handle.stat({ bigint: true });
    if (!initial.isFile() || initial.nlink !== 1n || initial.size > BigInt(MAX_ARTIFACT_INSPECTION_BYTES)) {
      return { available: false, stable: false, sizeBytes: null, changedAt: null, checksumSha256: null };
    }
    const sizeBytes = Number(initial.size);
    const changedAt = Number((initial.mtimeNs > initial.ctimeNs ? initial.mtimeNs : initial.ctimeNs) / 1_000_000n);
    if (!includeChecksum) return { available: true, stable: true, sizeBytes, changedAt, checksumSha256: null };
    const hash = crypto.createHash("sha256");
    let bytesRead = 0;
    const buffer = Buffer.allocUnsafe(64 * 1024);
    while (true) {
      const result = await handle.read(buffer, 0, buffer.byteLength, bytesRead);
      if (result.bytesRead === 0) break;
      bytesRead += result.bytesRead;
      if (bytesRead > MAX_ARTIFACT_INSPECTION_BYTES) throw new Error("Artifact changed beyond the inspection limit.");
      hash.update(buffer.subarray(0, result.bytesRead));
    }
    const final = await handle.stat({ bigint: true });
    const stable = final.dev === initial.dev && final.ino === initial.ino && final.nlink === 1n &&
      final.size === initial.size && final.size === BigInt(bytesRead) &&
      final.mtimeNs === initial.mtimeNs && final.ctimeNs === initial.ctimeNs;
    return { available: true, stable, sizeBytes, changedAt, checksumSha256: stable ? hash.digest("hex") : null };
  } catch {
    return { available: false, stable: false, sizeBytes: null, changedAt: null, checksumSha256: null };
  } finally {
    await handle.close().catch(() => undefined);
  }
}

export async function reconcileDurableJobOutputFiles(input: {
  payload: JobPayloadView;
  outputsDir: string;
  artifactsDir: string;
  store: ButlerStateStore;
}): Promise<ReconciledJobOutputFile[]> {
  assertSafeJobOutputThreadId(input.payload.threadId);
  const outputsRoot = path.resolve(input.outputsDir);
  const outputsRootEntry = await fs.lstat(outputsRoot).catch(() => null);
  if (!outputsRootEntry?.isDirectory() || outputsRootEntry.isSymbolicLink()) {
    throw new Error("Durable job output storage is unavailable.");
  }
  const realOutputsRoot = await fs.realpath(outputsRoot);
  const jobRoot = path.resolve(outputsRoot, input.payload.threadId);
  if (!withinRoot(jobRoot, outputsRoot)) {
    throw new Error("Durable job output directory escaped the configured output root.");
  }
  const existingJobRoot = await fs.lstat(jobRoot).catch(() => null);
  if (existingJobRoot?.isSymbolicLink()) {
    throw new Error("Durable job output directory cannot be a symbolic link.");
  }
  if (!existingJobRoot) return [];
  if (!existingJobRoot.isDirectory()) {
    throw new Error("Durable job output path must be a directory.");
  }
  const realJobRoot = await fs.realpath(jobRoot);
  if (!withinRoot(realJobRoot, realOutputsRoot)) {
    throw new Error("Durable job output directory resolves outside the configured output root.");
  }

  const files = await listJobOutputFiles(realJobRoot);
  const attemptId = input.payload.protocol.currentAttemptId;
  const existingArtifacts = input.store.listProjectArtifacts(input.payload.project.id).filter((artifact) =>
    artifact.source.createdByThreadId === input.payload.threadId &&
    artifact.metadata.jobOutputAttemptId === attemptId &&
    Boolean(artifact.metadata.jobOutputRelativePath)
  );
  const byPathAndChecksum = new Map(existingArtifacts.map((artifact) => [
    `${artifact.metadata.jobOutputRelativePath}\u0000${artifact.source.checksumSha256 ?? ""}`,
    artifact
  ]));
  const reconciled: ReconciledJobOutputFile[] = [];
  const candidates: ProjectArtifactView[] = [];
  const selectedNew = new Set<string>();
  let actualTotalBytes = 0;
  try {
    for (const file of files) {
      const candidate = await createProjectArtifactFromFile({
        artifactsDir: input.artifactsDir,
        projectId: input.payload.project.id,
        projectLabel: input.payload.project.label,
        threadId: input.payload.threadId,
        kind: "report",
        title: `Job output: ${file.relativePath}`,
        description: `Durable output reconciled from ${file.relativePath}.`,
        sourceFilePath: file.filePath,
        approvedRoots: [realJobRoot],
        fileName: path.basename(file.relativePath),
        tags: ["job-output"],
        metadata: {
          origin: "job-output",
          jobOutputThreadId: input.payload.threadId,
          jobOutputAttemptId: attemptId,
          jobOutputRelativePath: file.relativePath
        }
      });
      candidates.push(candidate);
      actualTotalBytes += candidate.sizeBytes;
      if (actualTotalBytes > MAX_JOB_OUTPUT_TOTAL_BYTES) {
        throw new Error(`Durable job outputs exceed ${MAX_JOB_OUTPUT_TOTAL_BYTES} bytes in total.`);
      }
      const sourceChecksum = candidate.source.checksumSha256 ?? "";
      candidate.metadata.jobOutputSourceChecksum = sourceChecksum;
      const key = `${file.relativePath}\u0000${sourceChecksum}`;
      const existing = byPathAndChecksum.get(key) ?? null;
      const existingInspection = existing ? await inspectArtifactFile(existing.filePath, true) : null;
      if (existing && existingInspection?.stable && existingInspection.checksumSha256 === sourceChecksum) {
        reconciled.push({ relativePath: file.relativePath, artifact: existing, reused: true });
        continue;
      }
      selectedNew.add(candidate.id);
      byPathAndChecksum.set(key, candidate);
      reconciled.push({ relativePath: file.relativePath, artifact: candidate, reused: false });
    }
    await Promise.all(candidates.filter((artifact) => !selectedNew.has(artifact.id)).map((artifact) =>
      fs.rm(path.dirname(artifact.filePath), { recursive: true, force: true })
    ));
    for (const artifact of candidates.filter((candidate) => selectedNew.has(candidate.id))) {
      input.store.upsertProjectArtifact(artifact);
    }
    if (selectedNew.size > 0) await input.store.flushSave();
    return reconciled;
  } catch (error) {
    await Promise.all(candidates.map((artifact) => fs.rm(path.dirname(artifact.filePath), { recursive: true, force: true })));
    throw error;
  }
}

export type JobOutputManifestEntryUiView = {
  id: string;
  kind: JobOutputManifestEntryView["kind"];
  title: string;
  threadId: string;
  projectId: string;
  attemptId: string;
  currentAttempt: boolean;
  sourceTurnId: string | null;
  referenceId: string;
  logicalPath: string | null;
  createdAt: number;
  available: boolean;
  integrity: ResolvedJobOutputManifestEntry["integrity"];
  checksumSha256: string | null;
  checksumStatus: JobOutputManifestEntryView["checksumStatus"];
  integrityCheckedAt: number | null;
  proofOutcome: ResolvedJobOutputManifestEntry["proofOutcome"];
  status: string | null;
  fileName: string | null;
  contentType: string | null;
  openUrl: string | null;
  downloadUrl: string | null;
};

export type JobOutputManifestUiView = {
  jobId: string;
  projectId: string;
  currentAttemptId: string;
  attempt: number;
  entries: JobOutputManifestEntryUiView[];
};

export async function resolveJobOutputManifest(
  payload: JobPayloadView,
  store: ButlerStateStore
): Promise<ResolvedJobOutputManifestEntry[]> {
  const proofs = store.listPreviewProofs();
  return Promise.all(payload.outputManifest.entries.map(async (entry) => {
    const artifact = entry.artifactId
      ? store.getProjectArtifact(entry.projectId, entry.artifactId)
      : null;
    const proof = entry.proofRunId
      ? proofs.find((candidate) => candidate.threadId === entry.threadId && candidate.verification.runId === entry.proofRunId) ?? null
      : null;
    const report = entry.reportTurnId
      ? store.getWorkerReport(entry.threadId, entry.reportTurnId)
      : null;
    const artifactInspection = entry.artifactId && artifact
      ? await inspectArtifactFile(artifact.filePath, false)
      : null;
    const available = artifactInspection?.available ?? Boolean(proof || report);
    const expectedSize = entry.sizeBytes ?? artifact?.sizeBytes ?? null;
    const integrityFresh = Boolean(
      artifactInspection?.available &&
      entry.integrityCheckedAt !== null &&
      artifactInspection.changedAt !== null &&
      artifactInspection.changedAt <= entry.integrityCheckedAt &&
      (expectedSize === null || expectedSize === artifactInspection.sizeBytes)
    );
    const checksumStatus = integrityFresh ? entry.checksumStatus : "unverified";
    const proofOutcome = proof
      ? !proof.verification.ok
        ? "failed"
        : proof.verification.artifacts.length > 0 && proof.verification.artifacts.every((candidate) => candidate.availability !== "available")
          ? "expired"
          : "passed"
      : null;
    return {
      entry: { ...entry },
      available,
      availability: available ? "available" : "missing",
      checksumStatus,
      integrityCheckedAt: integrityFresh ? entry.integrityCheckedAt : null,
      integrity: !available
        ? "missing"
        : checksumStatus === "mismatch"
          ? "mismatch"
          : checksumStatus === "verified"
            ? "verified"
            : "unverified",
      proofOutcome,
      artifact,
      proof,
      report
    };
  }));
}

export async function buildJobOutputManifestUiView(
  payload: JobPayloadView,
  store: ButlerStateStore
): Promise<JobOutputManifestUiView> {
  const entries = (await resolveJobOutputManifest(payload, store))
    .filter(({ entry }) => entry.attemptId === payload.protocol.currentAttemptId);
  return {
    jobId: payload.threadId,
    projectId: payload.project.id,
    currentAttemptId: payload.protocol.currentAttemptId,
    attempt: payload.protocol.attempt,
    entries: entries.map(({ entry, available, integrity, checksumStatus, integrityCheckedAt, proofOutcome, artifact, proof, report }) => {
      const proofArtifact = proof?.verification.artifacts.find((candidate) =>
        candidate.availability === "available" && Boolean(candidate.url || candidate.downloadUrl)
      ) ?? null;
      return {
        id: entry.id,
        kind: entry.kind,
        title: entry.title,
        threadId: entry.threadId,
        projectId: entry.projectId,
        attemptId: entry.attemptId,
        currentAttempt: entry.attemptId === payload.protocol.currentAttemptId,
        sourceTurnId: entry.sourceTurnId,
        referenceId: entry.artifactId ?? entry.proofRunId ?? entry.reportTurnId ?? entry.id,
        logicalPath: entry.logicalPath,
        createdAt: entry.createdAt,
        available,
        integrity: entry.kind === "project_artifact" ? integrity : available ? "unverified" : "missing",
        checksumSha256: entry.checksumSha256,
        checksumStatus,
        integrityCheckedAt,
        proofOutcome,
        status: report?.status ?? proofOutcome,
        fileName: artifact?.fileName ?? proofArtifact?.fileName ?? null,
        contentType: artifact?.contentType ?? proofArtifact?.contentType ?? null,
        openUrl: available && artifact
          ? getProjectArtifactUserUrl(artifact)
          : available ? proofArtifact?.url ?? null : null,
        downloadUrl: available && artifact
          ? getProjectArtifactUserDownloadUrl(artifact)
          : available ? proofArtifact?.downloadUrl ?? null : null
      };
    })
  };
}

function truncateText(value: string | null | undefined, maxLength: number): string | null {
  if (!value) return null;
  return value.length <= maxLength ? value : `${value.slice(0, maxLength)}\n[truncated]`;
}

const MAX_JOB_OUTPUT_REVIEW_TEXT_CHARS = 40_000;

function truncateReviewText(value: string): string {
  return value.length <= MAX_JOB_OUTPUT_REVIEW_TEXT_CHARS
    ? value
    : `${value.slice(0, MAX_JOB_OUTPUT_REVIEW_TEXT_CHARS)}\n[truncated ${value.length - MAX_JOB_OUTPUT_REVIEW_TEXT_CHARS} chars]`;
}

function projectArtifactAsProofArtifact(artifact: ProjectArtifactView): PreviewVerificationArtifactView {
  return {
    kind: "file",
    label: artifact.title,
    fileName: artifact.fileName,
    filePath: artifact.filePath,
    contentType: artifact.contentType,
    sizeBytes: artifact.sizeBytes,
    url: null,
    downloadUrl: null,
    availability: "available",
    retainedUntilAt: null,
    expiredAt: null,
    checksumSha256: artifact.source.checksumSha256
  };
}

export async function inspectCurrentJobOutputForReview(input: {
  payload: JobPayloadView;
  store: ButlerStateStore;
  outputId: string;
}): Promise<string> {
  const outputId = input.outputId.trim();
  if (!outputId) throw new Error("A current job output ID is required.");
  const resolved = (await resolveJobOutputManifest(input.payload, input.store)).find(({ entry }) =>
    entry.attemptId === input.payload.protocol.currentAttemptId &&
    entry.threadId === input.payload.threadId &&
    entry.projectId === input.payload.project.id &&
    (entry.id === outputId || entry.artifactId === outputId || entry.proofRunId === outputId || entry.reportTurnId === outputId)
  );
  if (!resolved) {
    throw new Error(`Output ${outputId} is not registered to the current attempt of job ${input.payload.threadId}.`);
  }
  if (!resolved.available) {
    throw new Error(`Output ${outputId} is registered but unavailable.`);
  }

  const header = [
    `Output: ${resolved.entry.title}`,
    `Kind: ${resolved.entry.kind}`,
    `Manifest entry: ${resolved.entry.id}`,
    `Reference: ${resolved.entry.artifactId ?? resolved.entry.proofRunId ?? resolved.entry.reportTurnId ?? resolved.entry.id}`,
    `Attempt: ${resolved.entry.attemptId}`
  ].join("\n");

  if (resolved.artifact) {
    const inspection = await inspectProofArtifacts([projectArtifactAsProofArtifact(resolved.artifact)]);
    return truncateReviewText([header, inspection.artifactSummary, inspection.textEvidence || "No extractable artifact text was found."].join("\n\n"));
  }
  if (resolved.proof) {
    const inspection = await inspectProofArtifacts(resolved.proof.verification.artifacts.filter((artifact) => artifact.availability === "available"));
    return truncateReviewText([
      header,
      `Proof result: ${resolved.proof.verification.ok ? "passed" : `failed (${resolved.proof.verification.failureKind})`}`,
      inspection.artifactSummary || "No available proof artifacts.",
      inspection.textEvidence || "No extractable proof text was found."
    ].join("\n\n"));
  }
  if (resolved.report) {
    return truncateReviewText([
      header,
      `Status: ${resolved.report.status}`,
      `Summary: ${resolved.report.summary}`,
      resolved.report.details ? `Details:\n${resolved.report.details}` : "Details: none",
      `Evidence:\n${JSON.stringify(resolved.report.evidence, null, 2)}`
    ].join("\n\n"));
  }
  throw new Error(`Output ${outputId} could not be resolved.`);
}

export async function formatResolvedJobOutputManifestForReview(
  payload: JobPayloadView,
  store: ButlerStateStore
): Promise<string> {
  const currentAttemptId = payload.protocol.currentAttemptId;
  const currentOutputs = (await resolveJobOutputManifest(payload, store))
    .filter(({ entry }) => entry.attemptId === currentAttemptId);
  const inventory = currentOutputs.map(({ entry, availability, checksumStatus, integrityCheckedAt, proofOutcome }) => ({
    id: entry.id,
    kind: entry.kind,
    title: entry.title,
    logicalPath: entry.logicalPath,
    referenceId: entry.artifactId ?? entry.proofRunId ?? entry.reportTurnId ?? entry.id,
    availability,
    checksumStatus,
    integrityCheckedAt,
    proofOutcome,
    checksumSha256: entry.checksumSha256,
    contentType: entry.contentType,
    sizeBytes: entry.sizeBytes,
    sourceTurnId: entry.sourceTurnId,
    createdAt: entry.createdAt
  }));
  const details = currentOutputs.slice(-24)
    .map(({ entry, available, availability, checksumStatus, integrityCheckedAt, integrity, proofOutcome, artifact, proof, report }) => ({
      entry,
      available,
      availability,
      checksumStatus,
      integrityCheckedAt,
      integrity,
      proofOutcome,
      artifact: artifact
        ? {
            id: artifact.id,
            title: artifact.title,
            kind: artifact.kind,
            fileName: artifact.fileName,
            contentType: artifact.contentType,
            sizeBytes: artifact.sizeBytes,
            checksumSha256: artifact.source.checksumSha256,
            textPreview: truncateText(artifact.textPreview, 2_000),
            metadata: artifact.metadata
          }
        : null,
      proof: proof
        ? {
            id: proof.id,
            title: proof.previewTitle,
            runId: proof.verification.runId,
            ok: proof.verification.ok,
            failureKind: proof.verification.failureKind,
            url: proof.verification.url,
            artifacts: proof.verification.artifacts
          }
        : null,
      report: report
        ? {
            turnId: report.turnId,
            status: report.status,
            summary: report.summary,
            details: truncateText(report.details, 4_000),
            evidence: report.evidence
          }
        : null
    }));
  return inventory.length === 0
    ? "No outputs are registered for the current job attempt."
    : JSON.stringify({ currentAttemptId, entryCount: inventory.length, inventory, details }, null, 2);
}

export async function validateReportedArtifactManifestRefs(input: {
  payload: JobPayloadView | null;
  store: ButlerStateStore;
  evidence: Array<{ artifactId: string | null }>;
  artifactsDir?: string;
}): Promise<JobPayloadView | null> {
  const artifactIds = [...new Set(input.evidence.map((entry) => entry.artifactId?.trim() || null).filter((id): id is string => Boolean(id)))];
  if (artifactIds.length === 0) return input.payload;
  if (!input.payload) {
    throw new Error("Completed report references project artifacts, but this job has no output manifest.");
  }
  return runSerializedJobMutation(input.payload.threadId, async () => {
    const payloadRoot = input.artifactsDir ? jobPayloadsRoot(input.artifactsDir) : null;
    const payload = payloadRoot
      ? await readCurrentJobPayload(payloadRoot, input.payload!.threadId) ?? input.payload!
      : input.payload!;
    const currentEntries = payload.outputManifest.entries.filter((entry) =>
      entry.attemptId === payload.protocol.currentAttemptId &&
      entry.kind === "project_artifact" &&
      entry.projectId === payload.project.id &&
      Boolean(entry.artifactId)
    );
    const checkedAt = Date.now();
    const updates: Parameters<typeof updateJobOutputManifestIntegrity>[1] = [];
    let failure: Error | null = null;
    for (const artifactId of artifactIds) {
      const manifestEntry = currentEntries.find((entry) => entry.artifactId === artifactId);
      if (!manifestEntry) {
        throw new Error(`Completed report references artifact ${artifactId}, but it is not registered in the current job attempt manifest.`);
      }
      const artifact = input.store.getProjectArtifact(manifestEntry.projectId, artifactId);
      const inspection = artifact ? await inspectArtifactFile(artifact.filePath, true) : null;
      if (!artifact || !inspection?.available) {
        updates.push({ entryId: manifestEntry.id, availability: "missing", checksumStatus: "unverified", integrityCheckedAt: checkedAt });
        failure ??= new Error(`Completed report references artifact ${artifactId}, but its durable project artifact is unavailable.`);
        continue;
      }
      const expectedChecksum = manifestEntry.checksumSha256 ?? artifact.source.checksumSha256 ?? null;
      if (!expectedChecksum) {
        updates.push({ entryId: manifestEntry.id, availability: "available", checksumStatus: "unverified", integrityCheckedAt: checkedAt });
        failure ??= new Error(`Completed report references artifact ${artifactId}, but it has no registered checksum to verify.`);
        continue;
      }
      if (!inspection.stable || !inspection.checksumSha256) {
        updates.push({ entryId: manifestEntry.id, availability: "available", checksumStatus: "unverified", integrityCheckedAt: checkedAt });
        failure ??= new Error(`Completed report references artifact ${artifactId}, but its durable content changed while it was being verified.`);
        continue;
      }
      if (inspection.checksumSha256 !== expectedChecksum) {
        updates.push({ entryId: manifestEntry.id, availability: "available", checksumStatus: "mismatch", integrityCheckedAt: checkedAt });
        failure ??= new Error(`Completed report references artifact ${artifactId}, but its durable content no longer matches the registered checksum.`);
        continue;
      }
      updates.push({ entryId: manifestEntry.id, availability: "available", checksumStatus: "verified", integrityCheckedAt: checkedAt });
    }
    const nextPayload = updateJobOutputManifestIntegrity(payload, updates);
    if (payloadRoot) await persistJobPayload(payloadRoot, nextPayload);
    input.store.setThreadJobPayload(nextPayload);
    if (failure) throw failure;
    return nextPayload;
  });
}
