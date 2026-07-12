import type { ButlerAgentToolAccess } from "./butler-agent-tool-access.js";
import { withRequestedLeaseLifecycle } from "./butler-runtime-lease-tool-helpers.js";
import { assertRuntimeResourceOwned } from "./butler-runtime-tool-ownership.js";
import { formatPreviewRuntimeDiagnostics } from "./runtime-broker-client.js";

const OBSERVATION_MAX_MS = 15_000;
const POLL_MS = 250;

type PreviewLease = Awaited<ReturnType<ButlerAgentToolAccess["runtimeBroker"]["createLease"]>> & {
  pinned?: boolean;
  leaseTtlMs?: number | null;
};
type PreviewRuntime = Awaited<ReturnType<ButlerAgentToolAccess["runtimeBroker"]["inspectLease"]>>["runtime"];

async function waitForPoll(signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw new Error("start_preview was cancelled");
  await new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error("start_preview was cancelled"));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, POLL_MS);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export async function observeStartedPreview(input: {
  access: ButlerAgentToolAccess;
  lease: PreviewLease;
  lifecycle: { sticky?: boolean; leaseTtlMinutes?: number };
  bootstrapWaitSeconds?: number;
  signal?: AbortSignal;
}): Promise<{ lease: PreviewLease; runtime: PreviewRuntime | null; pending: boolean }> {
  let lease = input.lease;
  let runtime: PreviewRuntime | null = null;
  const configuredWaitSeconds = input.bootstrapWaitSeconds ?? lease.bootstrap.waitSeconds ?? 120;
  const deadline = Date.now() + Math.min(OBSERVATION_MAX_MS, Math.max(1_000, configuredWaitSeconds * 1_000 + POLL_MS));

  while (lease.bootstrap.phase !== "ready" && lease.bootstrap.phase !== "failed" && Date.now() < deadline) {
    const inspected = await input.access.runtimeBroker.inspectLease(lease.id);
    assertRuntimeResourceOwned(input.access, inspected, `Preview ${inspected.id}`);
    runtime = inspected.runtime;
    lease = withRequestedLeaseLifecycle(inspected, input.lifecycle);
    input.access.store.upsertPreviewLease(lease);
    const runtimeTerminal = !runtime.running && !["created", "starting", "restarting"].includes(runtime.status);
    if (lease.status === "failed" || lease.bootstrap.phase === "failed" || runtimeTerminal) break;
    if (lease.bootstrap.phase === "ready") break;
    await waitForPoll(input.signal);
  }

  const runtimeTerminal = runtime && !runtime.running && !["created", "starting", "restarting"].includes(runtime.status);
  if (lease.status === "failed" || lease.bootstrap.phase === "failed" || runtimeTerminal) {
    const failure = lease.lastError || lease.bootstrap.lastHeartbeatError || runtime?.error || "Preview failed during bootstrap.";
    const diagnostics = runtime ? ` ${formatPreviewRuntimeDiagnostics(runtime)}.` : "";
    throw new Error(`Preview ${lease.id} failed during bootstrap: ${failure}.${diagnostics}`);
  }

  return { lease, runtime, pending: lease.bootstrap.phase !== "ready" };
}
