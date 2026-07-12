import type { ButlerStateStore } from "./state-store.js";
import type { PreviewLeaseView } from "./types.js";

export function preserveMissingPreviewLeaseTombstones(
  store: ButlerStateStore,
  brokerLeaseIds: ReadonlySet<string>,
  storedLeases: PreviewLeaseView[]
): void {
  for (const lease of storedLeases) {
    if (brokerLeaseIds.has(lease.id) || lease.status === "failed") {
      continue;
    }
    store.upsertPreviewLease({
      ...lease,
      status: "failed",
      updatedAt: Date.now(),
      lastError:
        lease.lastError ??
        `Preview ${lease.id} disappeared from the runtime broker before terminal diagnostics were captured.`
    });
  }
}
