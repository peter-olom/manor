import { jobPayloadsRoot, listJobPayloads } from "./job-instruction-artifacts.js";
import type { ButlerStateStore } from "./state-store.js";

export async function restoreDurableJobPayloads(input: {
  artifactsDir: string;
  store: ButlerStateStore;
}): Promise<number> {
  const payloads = await listJobPayloads(jobPayloadsRoot(input.artifactsDir));
  let restored = 0;

  for (const payload of payloads) {
    if (!input.store.getThread(payload.threadId)) continue;

    const current = input.store.getThreadJobPayload(payload.threadId);
    const durableIsNewer = !current ||
      payload.revision > current.revision ||
      (payload.revision === current.revision && payload.updatedAt >= current.updatedAt && payload.checksum !== current.checksum);
    if (!durableIsNewer) continue;

    input.store.setThreadJobPayload(payload);
    restored += 1;
  }

  return restored;
}
