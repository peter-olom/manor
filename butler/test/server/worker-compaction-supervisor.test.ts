import assert from "node:assert/strict";
import { test } from "node:test";

import { WorkerCompactionSupervisor } from "../../src/server/worker-compaction-supervisor.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
}

function fixture(options: { deadlineMs?: number } = {}) {
  const callbacks = new Map<string, () => void>();
  const unregistered: string[] = [];
  const compact = deferred<void>();
  let now = 1_000;
  let probe = { attemptId: "probe-1", state: "idle", busy: false, compacting: false, pendingMessageCount: 0, activityAt: null, acknowledgedWait: null, confirmedDead: false } as const;
  const supervisor = new WorkerCompactionSupervisor({
    client: {
      compactThread: async () => compact.promise,
      probeThread: async () => probe
    } as never,
    watchdogs: {
      register: (input: { id: string; callback: () => void }) => {
        callbacks.set(input.id, input.callback);
        return { id: input.id, unregister: () => undefined } as never;
      },
      unregister: (id: string) => {
        callbacks.delete(id);
        unregistered.push(id);
        return true;
      }
    },
    now: () => now,
    deadlineMs: options.deadlineMs
  });
  return {
    supervisor,
    compact,
    callbacks,
    unregistered,
    setNow: (value: number) => { now = value; },
    setProbe: (value: typeof probe) => { probe = value; }
  };
}

async function flush(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}

test("manual Worker compaction starts asynchronously and completes from Pi lifecycle events", async () => {
  const current = fixture();
  const operation = await current.supervisor.start("worker-1", "Keep decisions");
  assert.equal(operation.status, "starting");
  assert.ok(operation.id);
  assert.equal(current.callbacks.has("worker-compaction:worker-1"), true);

  current.supervisor.handleRuntimeEvent({ threadId: "worker-1", status: "started", error: null });
  assert.equal(current.supervisor.get("worker-1")?.status, "running");

  current.supervisor.handleRuntimeEvent({ threadId: "worker-1", status: "completed", error: null });
  assert.equal(current.supervisor.get("worker-1")?.status, "completed");
  assert.equal(current.unregistered.at(-1), "worker-compaction:worker-1");
});

test("a late RPC timeout cannot override a running compaction", async () => {
  const current = fixture();
  await current.supervisor.start("worker-1", "");
  current.supervisor.handleRuntimeEvent({ threadId: "worker-1", status: "started", error: null });
  current.setProbe({ attemptId: "probe-2", state: "busy", busy: true, compacting: true, pendingMessageCount: 0, activityAt: null, acknowledgedWait: "Worker is compacting context.", confirmedDead: false });
  current.compact.reject(new Error("Timeout waiting for response to compact. Stderr: "));
  await flush();
  assert.equal(current.supervisor.get("worker-1")?.status, "running");

  current.supervisor.handleRuntimeEvent({ threadId: "worker-1", status: "completed", error: null });
  assert.equal(current.supervisor.get("worker-1")?.status, "completed");
});

test("an ambiguous compact timeout stays supervised when the immediate probe is idle", async () => {
  const current = fixture();
  await current.supervisor.start("worker-1", "");
  current.compact.reject(new Error("Timeout waiting for response to compact. Stderr: "));
  await flush();

  assert.equal(current.supervisor.get("worker-1")?.status, "starting");
  assert.equal(current.callbacks.has("worker-compaction:worker-1"), true);
  current.supervisor.handleRuntimeEvent({ threadId: "worker-1", status: "completed", error: null });
  assert.equal(current.supervisor.get("worker-1")?.status, "completed");
});

test("duplicate compaction requests are rejected while preflight is pending", async () => {
  const probe = deferred<never>();
  const supervisor = new WorkerCompactionSupervisor({
    client: { probeThread: () => probe.promise, compactThread: async () => undefined } as never,
    watchdogs: { register: () => ({ unregister: () => undefined }), unregister: () => true } as never
  });
  const first = supervisor.start("worker-1", "");
  await assert.rejects(() => supervisor.start("worker-1", ""), /already in progress/);
  probe.reject(new Error("probe failed"));
  await assert.rejects(() => first, /probe failed/);
});

test("Pi failure events expose the real compaction error", async () => {
  const current = fixture();
  await current.supervisor.start("worker-1", "");
  current.supervisor.handleRuntimeEvent({ threadId: "worker-1", status: "failed", error: "Provider rejected the summary." });
  assert.deepEqual(current.supervisor.get("worker-1"), {
    id: current.supervisor.get("worker-1")?.id,
    status: "failed",
    startedAt: 1_000,
    completedAt: 1_000,
    error: "Provider rejected the summary."
  });
});

test("the watchdog protects live compaction past the deadline and fails missing terminal evidence", async () => {
  const current = fixture({ deadlineMs: 100 });
  await current.supervisor.start("worker-1", "");
  current.setNow(1_101);
  current.setProbe({ attemptId: "probe-2", state: "busy", busy: true, compacting: true, pendingMessageCount: 0, activityAt: null, acknowledgedWait: "Worker is compacting context.", confirmedDead: false });
  current.callbacks.get("worker-compaction:worker-1")?.();
  await flush();
  assert.equal(current.supervisor.get("worker-1")?.status, "running");

  current.setProbe({ attemptId: "probe-3", state: "idle", busy: false, compacting: false, pendingMessageCount: 0, activityAt: null, acknowledgedWait: null, confirmedDead: false });
  current.callbacks.get("worker-compaction:worker-1")?.();
  await flush();
  assert.equal(current.supervisor.get("worker-1")?.status, "failed");
  assert.match(current.supervisor.get("worker-1")?.error ?? "", /without a completion result/);
});
