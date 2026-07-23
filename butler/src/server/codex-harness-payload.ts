import {
  appendJobOutputManifestEntries,
  assertJobPayloadWorkerAuthority,
  buildJobPayload,
  jobPayloadsRoot,
  persistJobPayload,
  readCurrentJobPayload,
  updateJobPayload
} from "./job-instruction-artifacts.js";
import type { JobOutputManifestEntryView, JobOutputManifestKind, JobPayloadView } from "./job-payload-types.js";
import type { ButlerStateStore } from "./state-store.js";
import type { CodexWorkerReportView, CodexThreadRecord } from "./types.js";
import { runSerializedJobMutation } from "./butler-job-mutation-guard.js";
import { reconcileDurableJobOutputFiles } from "./job-output-manifest.js";

export type JobOutputManifestRegistration = {
  kind: JobOutputManifestKind;
  referenceId: string;
  title: string;
  projectId?: string | null;
  sourceTurnId?: string | null;
  logicalPath?: string | null;
  contentType?: string | null;
  sizeBytes?: number | null;
  checksumSha256?: string | null;
  availability?: JobOutputManifestEntryView["availability"];
  checksumStatus?: JobOutputManifestEntryView["checksumStatus"];
  integrityCheckedAt?: number | null;
  createdAt?: number;
};

type JobOutputReconciliationInput = {
  artifactsDir: string;
  outputsDir: string;
  store: ButlerStateStore;
  threadId: string;
  sourceTurnId?: string | null;
};

type JobOutputReconciliationResult = {
  payload: JobPayloadView;
  outputs: Array<{ relativePath: string; artifactId: string; reused: boolean }>;
};

async function loadOrRecoverCurrentPayload(input: {
  payloadRoot: string;
  store: ButlerStateStore;
  threadId: string;
  fallbackInstruction: string;
}): Promise<JobPayloadView> {
  const fromFile = await readCurrentJobPayload(input.payloadRoot, input.threadId);
  if (fromFile) {
    input.store.setThreadJobPayload(fromFile);
    return fromFile;
  }

  const fromStore = input.store.getThreadJobPayload(input.threadId);
  if (fromStore) {
    await persistJobPayload(input.payloadRoot, fromStore);
    return fromStore;
  }

  const thread = input.store.getThread(input.threadId);
  if (!thread) {
    throw new Error(`Cannot register durable output for unknown job ${input.threadId}.`);
  }
  const contract = thread.executionContract ?? null;
  const instruction = contract?.requestedTask ||
    contract?.operatorGoal ||
    thread.supervisor.latestUserPrompt ||
    input.fallbackInstruction;
  const recovered = buildJobPayload({
    threadId: input.threadId,
    kind: "delegation",
    instruction,
    summary: contract?.operatorGoal || contract?.requestedTask || null,
    contract,
    checklist: thread.supervisionChecklist
  });
  await persistJobPayload(input.payloadRoot, recovered);
  input.store.setThreadJobPayload(recovered);
  return recovered;
}

export function buildJobOutputManifestEntry(
  payload: JobPayloadView,
  input: JobOutputManifestRegistration
): JobOutputManifestEntryView {
  const referenceId = input.referenceId.trim();
  if (!referenceId) {
    throw new Error("Job output reference ID is required.");
  }
  return {
    id: `${payload.protocol.currentAttemptId}:${input.kind}:${referenceId}`,
    kind: input.kind,
    title: input.title.trim() || referenceId,
    threadId: payload.threadId,
    projectId: input.projectId?.trim() || payload.project.id,
    attemptId: payload.protocol.currentAttemptId,
    sourceTurnId: input.sourceTurnId?.trim() || null,
    artifactId: input.kind === "project_artifact" ? referenceId : null,
    proofRunId: input.kind === "proof" ? referenceId : null,
    reportTurnId: input.kind === "worker_report" ? referenceId : null,
    logicalPath: input.logicalPath?.trim() || null,
    contentType: input.contentType?.trim() || null,
    sizeBytes: typeof input.sizeBytes === "number" && Number.isFinite(input.sizeBytes) ? input.sizeBytes : null,
    checksumSha256: input.checksumSha256?.trim() || null,
    availability: input.availability ?? "available",
    checksumStatus: input.checksumStatus ?? (input.kind === "project_artifact" ? "verified" : "unverified"),
    integrityCheckedAt: input.integrityCheckedAt ?? (input.kind === "project_artifact" ? input.createdAt ?? Date.now() : null),
    createdAt: input.createdAt ?? Date.now()
  };
}

export async function registerJobOutput(input: {
  artifactsDir: string;
  store: ButlerStateStore;
  threadId: string;
  output: JobOutputManifestRegistration;
}): Promise<JobPayloadView> {
  return runSerializedJobMutation(input.threadId, async () => {
    const payloadRoot = jobPayloadsRoot(input.artifactsDir);
    const currentPayload = await loadOrRecoverCurrentPayload({
      payloadRoot,
      store: input.store,
      threadId: input.threadId,
      fallbackInstruction: "Register the durable output produced for this job."
    });
    assertJobPayloadWorkerAuthority(currentPayload, input.threadId);
    const nextPayload = appendJobOutputManifestEntries(currentPayload, [buildJobOutputManifestEntry(currentPayload, input.output)]);
    await persistJobPayload(payloadRoot, nextPayload);
    input.store.setThreadJobPayload(nextPayload);
    return nextPayload;
  });
}

export async function reconcileJobOutputManifestUnlocked(input: JobOutputReconciliationInput): Promise<JobOutputReconciliationResult> {
  const payloadRoot = jobPayloadsRoot(input.artifactsDir);
  const currentPayload = await loadOrRecoverCurrentPayload({
    payloadRoot,
    store: input.store,
    threadId: input.threadId,
    fallbackInstruction: "Reconcile the durable files produced for this job."
  });
  assertJobPayloadWorkerAuthority(currentPayload, input.threadId);
  const outputs = await reconcileDurableJobOutputFiles({
    payload: currentPayload,
    outputsDir: input.outputsDir,
    artifactsDir: input.artifactsDir,
    store: input.store
  });
  const entries = outputs.map(({ artifact, relativePath }) => buildJobOutputManifestEntry(currentPayload, {
    kind: "project_artifact",
    referenceId: artifact.id,
    title: artifact.title,
    projectId: artifact.projectId,
    sourceTurnId: input.sourceTurnId ?? null,
    logicalPath: relativePath,
    contentType: artifact.contentType,
    sizeBytes: artifact.sizeBytes,
    checksumSha256: artifact.source.checksumSha256,
    availability: "available",
    checksumStatus: "verified",
    integrityCheckedAt: artifact.createdAt,
    createdAt: artifact.createdAt
  }));
  const nextPayload = appendJobOutputManifestEntries(currentPayload, entries);
  await persistJobPayload(payloadRoot, nextPayload);
  input.store.setThreadJobPayload(nextPayload);
  if (outputs.some((output) => !output.reused)) {
    input.store.addEvent(input.threadId, "harness/manifest/reconciled", `Reconciled ${outputs.length} durable job output file${outputs.length === 1 ? "" : "s"}.`);
  }
  return {
    payload: nextPayload,
    outputs: outputs.map((output) => ({ relativePath: output.relativePath, artifactId: output.artifact.id, reused: output.reused }))
  };
}

export function reconcileJobOutputManifest(input: JobOutputReconciliationInput): Promise<JobOutputReconciliationResult> {
  return runSerializedJobMutation(input.threadId, () => reconcileJobOutputManifestUnlocked(input));
}

export async function handleHarnessManifestAction(input: {
  action: string;
  artifactsDir: string;
  outputsDir: string | null;
  store: ButlerStateStore;
  threadId: string;
  sourceTurnId: string | null;
}): Promise<{ text: string; data?: Record<string, unknown> } | null> {
  if (input.action !== "manifest.reconcile") return null;
  if (!input.outputsDir) throw new Error("Durable job output storage is unavailable.");
  const reconciled = await reconcileJobOutputManifest({ ...input, outputsDir: input.outputsDir });
  return {
    text: reconciled.outputs.length === 0
      ? "No durable output files were found for this job."
      : reconciled.outputs.map((output) => `${output.relativePath} | artifact=${output.artifactId} | ${output.reused ? "existing" : "saved"}`).join("\n"),
    data: { outputs: reconciled.outputs, outputManifest: reconciled.payload.outputManifest }
  };
}

export async function updatePayloadFromWorkerReport(input: {
  artifactsDir: string;
  store: ButlerStateStore;
  report: CodexWorkerReportView;
}): Promise<void> {
  await runSerializedJobMutation(input.report.threadId, async () => {
    const payloadRoot = jobPayloadsRoot(input.artifactsDir);
    const currentPayload = await loadOrRecoverCurrentPayload({
      payloadRoot,
      store: input.store,
      threadId: input.report.threadId,
      fallbackInstruction: input.report.summary || "Record the Worker report for this job."
    });
    assertJobPayloadWorkerAuthority(currentPayload, input.report.threadId);
    let nextPayload = updateJobPayload(currentPayload, {
      kind: "worker_report",
      instruction: [input.report.summary, input.report.details].filter(Boolean).join("\n\n"),
      summary: input.report.summary,
      status: input.report.status,
      turnId: input.report.turnId,
      report: {
        status: input.report.status,
        summary: input.report.summary,
        details: input.report.details,
        updatedAt: input.report.updatedAt,
        evidence: input.report.evidence
      }
    });
    const outputEntries = [
      buildJobOutputManifestEntry(nextPayload, {
        kind: "worker_report",
        referenceId: input.report.turnId,
        title: input.report.summary,
        projectId: nextPayload.project.id,
        sourceTurnId: input.report.turnId,
        createdAt: input.report.updatedAt
      })
    ];
    for (const evidence of input.report.evidence) {
      if (evidence.proofRunId) {
        const proof = input.store.listPreviewProofs().find((candidate) =>
          candidate.threadId === input.report.threadId && candidate.verification.runId === evidence.proofRunId
        );
        if (proof) {
          outputEntries.push(buildJobOutputManifestEntry(nextPayload, {
            kind: "proof",
            referenceId: proof.verification.runId,
            title: proof.previewTitle,
            projectId: proof.projectId,
            sourceTurnId: input.report.turnId,
            createdAt: proof.createdAt
          }));
        }
      }
    }
    nextPayload = appendJobOutputManifestEntries(nextPayload, outputEntries, Math.max(nextPayload.updatedAt, input.report.updatedAt));
    await persistJobPayload(payloadRoot, nextPayload);
    input.store.setThreadJobPayload(nextPayload);
  });
}

export async function updatePayloadFromAssist(input: {
  artifactsDir: string;
  store: ButlerStateStore;
  thread: CodexThreadRecord;
  summary: string;
  text: string;
}): Promise<void> {
  await runSerializedJobMutation(input.thread.id, async () => {
    const payloadRoot = jobPayloadsRoot(input.artifactsDir);
    const currentPayload = await loadOrRecoverCurrentPayload({
      payloadRoot,
      store: input.store,
      threadId: input.thread.id,
      fallbackInstruction: input.summary || "Update the job instructions."
    });
    assertJobPayloadWorkerAuthority(currentPayload, input.thread.id);
    const nextPayload = updateJobPayload(currentPayload, {
      kind: "assist_context",
      instruction: input.text,
      summary: input.summary,
      contract: input.thread.executionContract ?? null
    });
    await persistJobPayload(payloadRoot, nextPayload);
    input.store.setThreadJobPayload(nextPayload);
  });
}
