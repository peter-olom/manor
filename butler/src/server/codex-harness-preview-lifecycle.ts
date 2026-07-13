import type { HarnessCapability } from "./codex-harness-helpers.js";
import type { RuntimeBrokerClient } from "./runtime-broker-client.js";
import type { ButlerStateStore } from "./state-store.js";
import type { PreviewLeaseView } from "./types.js";

export function formatPreviewBootstrapHistory(lease: PreviewLeaseView): string {
  const events = lease.bootstrap.events ?? [];
  if (events.length === 0) {
    return `Bootstrap ${lease.bootstrap.phase}; no lifecycle events were retained.`;
  }
  return events
    .map((event) => `#${event.sequence} +${Math.round(event.elapsedMs / 100) / 10}s ${event.phase}: ${event.message}`)
    .join("\n");
}

export async function waitForHarnessPreview(input: {
  capability: HarnessCapability;
  leaseId: string;
  timeoutSeconds: number;
  runtimeBroker: RuntimeBrokerClient;
  store: ButlerStateStore;
}) {
  const deadline = Date.now() + Math.max(1, input.timeoutSeconds) * 1000;
  let inspected = await input.runtimeBroker.inspectLease(input.leaseId);
  while (
    inspected.bootstrap.phase !== "ready" &&
    inspected.bootstrap.phase !== "failed" &&
    Date.now() < deadline
  ) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    inspected = await input.runtimeBroker.inspectLease(input.leaseId);
  }
  if (inspected.threadId !== input.capability.threadId) {
    throw new Error(`Preview ${input.leaseId} is not attached to this job`);
  }
  input.store.upsertPreviewLease(inspected);
  input.store.notePreviewLeaseActivity(inspected.id);
  return {
    lease: input.store.getPreviewLease(inspected.id) ?? inspected,
    runtime: inspected.runtime,
    pending: inspected.bootstrap.phase !== "ready" && inspected.bootstrap.phase !== "failed"
  };
}

export async function handleHarnessPreviewWait(input: Parameters<typeof waitForHarnessPreview>[0]) {
  const result = await waitForHarnessPreview(input);
  const terminal = result.lease.bootstrap.phase === "ready" || result.lease.bootstrap.phase === "failed";
  const next = result.pending
    ? `\nStill starting. Run manor-harness preview wait ${result.lease.id} again, or inspect logs now with manor-harness preview logs ${result.lease.id}.`
    : "";
  return {
    text: `Preview ${result.lease.title} is ${terminal ? result.lease.bootstrap.phase : "still starting"}. Runtime=${result.runtime.status}.\n${formatPreviewBootstrapHistory(result.lease)}${next}`,
    data: result
  };
}
