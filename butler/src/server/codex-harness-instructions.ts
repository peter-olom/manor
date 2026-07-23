import {
  assertJobPayloadWorkerAuthority,
  buildJobPayload,
  formatJobOutputManifestText,
  formatPayloadCurrentText,
  jobPayloadsRoot,
  persistJobPayload,
  readCurrentJobPayload,
  selectCurrentJobOutputEntries,
  updateJobPayload
} from "./job-instruction-artifacts.js";
import { normalizeString } from "./codex-harness-helpers.js";
import { runSerializedJobMutation } from "./butler-job-mutation-guard.js";
import type { ButlerStateStore } from "./state-store.js";
import type { JobPayloadView } from "./job-payload-types.js";

type HarnessPayloadActionInput = {
  action: string;
  params: Record<string, unknown>;
  threadId: string;
  artifactsDir: string;
  store: ButlerStateStore;
};

async function loadCurrentPayload(input: {
  rootDir: string;
  threadId: string;
  store: ButlerStateStore;
}): Promise<JobPayloadView | null> {
  const fromFile = await readCurrentJobPayload(input.rootDir, input.threadId);
  if (fromFile) {
    input.store.setThreadJobPayload(fromFile);
    return fromFile;
  }

  const fromStore = input.store.getThreadJobPayload(input.threadId);
  if (fromStore) {
    await persistJobPayload(input.rootDir, fromStore);
    return fromStore;
  }

  const thread = input.store.getThread(input.threadId);
  const contract = thread?.executionContract ?? null;
  if (!contract) {
    return null;
  }

  const payload = buildJobPayload({
    threadId: input.threadId,
    kind: "delegation",
    instruction: contract.requestedTask || contract.operatorGoal || "Read this Manor job payload before working.",
    summary: contract.operatorGoal || contract.requestedTask || null,
    contract,
    checklist: thread?.supervisionChecklist ?? null
  });
  await persistJobPayload(input.rootDir, payload);
  input.store.setThreadJobPayload(payload);
  return payload;
}

export async function handleHarnessPayloadAction(input: HarnessPayloadActionInput): Promise<{ text: string; data?: Record<string, unknown> } | null> {
  if (input.action !== "payload.current" && input.action !== "payload.update" && input.action !== "manifest.current") {
    return null;
  }
  return runSerializedJobMutation(input.threadId, () => handleHarnessPayloadActionLocked(input));
}

async function handleHarnessPayloadActionLocked(input: HarnessPayloadActionInput): Promise<{ text: string; data?: Record<string, unknown> }> {
  const rootDir = jobPayloadsRoot(input.artifactsDir);
  const current = await loadCurrentPayload({ rootDir, threadId: input.threadId, store: input.store });

  if (input.action === "payload.current") {
    return {
      text: formatPayloadCurrentText(current),
      data: { payload: current }
    };
  }

  if (input.action === "manifest.current") {
    const entries = current ? selectCurrentJobOutputEntries(current) : [];
    return {
      text: formatJobOutputManifestText(current),
      data: { manifest: { version: 1, entries } }
    };
  }

  if (!current) {
    throw new Error("No Manor job payload is stored for this thread.");
  }
  assertJobPayloadWorkerAuthority(current, input.threadId);

  const summary = normalizeString(input.params.summary);
  const details = normalizeString(input.params.details);
  const status = normalizeString(input.params.status);
  if (!summary && !details && !status) {
    throw new Error("payload.update requires summary, details, or status.");
  }

  const next = updateJobPayload(current, {
    kind: "worker_report",
    instruction: [summary, details].filter(Boolean).join("\n\n") || `Worker status: ${status}`,
    summary: summary || status || current.display.summary,
    status: status === "blocked" ? "blocked" : status === "completed" ? "completed" : undefined,
    report: {
      status: status || "updated",
      summary: summary || current.display.summary,
      details: details || null,
      updatedAt: Date.now(),
      evidence: Array.isArray(input.params.evidence) ? input.params.evidence : []
    }
  });
  await persistJobPayload(rootDir, next);
  input.store.setThreadJobPayload(next);
  return {
    text: "Updated the current Manor job payload.",
    data: { payload: next }
  };
}
