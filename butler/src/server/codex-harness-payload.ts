import {
  jobPayloadsRoot,
  persistJobPayload,
  readCurrentJobPayload,
  updateJobPayload
} from "./job-instruction-artifacts.js";
import type { ButlerStateStore } from "./state-store.js";
import type { CodexWorkerReportView, CodexThreadRecord } from "./types.js";

export async function updatePayloadFromWorkerReport(input: {
  artifactsDir: string;
  store: ButlerStateStore;
  report: CodexWorkerReportView;
}): Promise<void> {
  const payloadRoot = jobPayloadsRoot(input.artifactsDir);
  const currentPayload = await readCurrentJobPayload(payloadRoot, input.report.threadId);
  if (!currentPayload) {
    return;
  }
  const nextPayload = updateJobPayload(currentPayload, {
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
  await persistJobPayload(payloadRoot, nextPayload);
  input.store.setThreadJobPayload(nextPayload);
}

export async function updatePayloadFromAssist(input: {
  artifactsDir: string;
  store: ButlerStateStore;
  thread: CodexThreadRecord;
  summary: string;
  text: string;
}): Promise<void> {
  const payloadRoot = jobPayloadsRoot(input.artifactsDir);
  const currentPayload = await readCurrentJobPayload(payloadRoot, input.thread.id);
  if (!currentPayload) {
    return;
  }
  const nextPayload = updateJobPayload(currentPayload, {
    kind: "assist_context",
    instruction: input.text,
    summary: input.summary,
    contract: input.thread.executionContract ?? null
  });
  await persistJobPayload(payloadRoot, nextPayload);
  input.store.setThreadJobPayload(nextPayload);
}
