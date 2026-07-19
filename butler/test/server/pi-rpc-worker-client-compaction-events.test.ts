import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { PiProviderRuntimeMapper } from "../../src/server/pi-provider-events.js";
import { PiRpcWorkerClient } from "../../src/server/pi-rpc-worker-client.js";
import { ButlerStateStore } from "../../src/server/state-store.js";

test("manual Pi compaction lifecycle is observable without an active prompt generation", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "manor-pi-manual-compaction-"));
  try {
    const threadId = "pi-manual-compaction";
    const store = new ButlerStateStore(path.join(dir, "state.json"));
    await store.load();
    store.upsertThreadSummary({ id: threadId, cwd: dir, source: "pi-rpc", status: { type: "idle" }, turns: [] });
    const client = new PiRpcWorkerClient({ store, piAuthPath: path.join(dir, "auth.json"), sessionRootDir: path.join(dir, "sessions") });
    const session = {
      threadId,
      client: {},
      mapper: new PiProviderRuntimeMapper(threadId),
      unsubscribe: null,
      cwd: dir,
      activityVersion: 0,
      acceptedEventVersion: null,
      eventStreamVersion: null,
      pendingPromptGenerations: [],
      operationTurnIds: [],
      transportClosed: false
    };
    const access = client as unknown as {
      sessions: Map<string, typeof session>;
      handleSessionEvent: (current: typeof session, event: Record<string, unknown>) => void;
    };
    access.sessions.set(threadId, session);
    const events: Array<{ status: string; error: string | null }> = [];
    client.on("workerCompaction", (event) => events.push({ status: event.status, error: event.error }));

    access.handleSessionEvent(session, { type: "compaction_start", reason: "overflow" });
    access.handleSessionEvent(session, { type: "compaction_end", reason: "overflow", aborted: false });
    access.handleSessionEvent(session, { type: "compaction_start", reason: "manual" });
    access.handleSessionEvent(session, { type: "compaction_end", reason: "manual", aborted: false });

    assert.deepEqual(events, [
      { status: "started", error: null },
      { status: "completed", error: null }
    ]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
