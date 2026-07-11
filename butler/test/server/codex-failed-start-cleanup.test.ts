import assert from "node:assert/strict";
import test from "node:test";

import { cleanupFailedCodexStart, rejectFailedCodexStart } from "../../src/server/codex-failed-start-cleanup.js";

function cleanupOptions(events: string[]) {
  return {
    revokeCapability: async () => { events.push("revoke"); },
    restoreCapability: async () => { events.push("restore-capability"); },
    markDeleted: () => { events.push("mark-deleted"); },
    restoreDeleted: () => { events.push("restore-thread"); },
    removeThreadDurably: async () => { events.push("remove-thread"); return true; },
    flushState: async () => { events.push("flush-state"); },
    clearOperationState: () => { events.push("clear-operation"); },
    unsubscribe: async () => { events.push("unsubscribe"); },
    emitChange: () => { events.push("emit-change"); }
  };
}

test("failed Codex start cleanup revokes capability before durable deletion and unsubscribe", async () => {
  const events: string[] = [];
  await cleanupFailedCodexStart(cleanupOptions(events));
  assert.deepEqual(events, [
    "revoke",
    "mark-deleted",
    "remove-thread",
    "clear-operation",
    "unsubscribe",
    "emit-change"
  ]);
});

test("failed Codex start capability revocation restores capability without deleting the thread", async () => {
  const events: string[] = [];
  const options = cleanupOptions(events);
  options.revokeCapability = async () => { events.push("revoke"); throw new Error("revoke failed"); };

  await assert.rejects(() => cleanupFailedCodexStart(options), /revoke failed/);
  assert.deepEqual(events, ["revoke", "restore-capability"]);
});

test("failed Codex durable cleanup restores the tombstone and capability before returning failure", async () => {
  const events: string[] = [];
  const options = cleanupOptions(events);
  options.removeThreadDurably = async () => { events.push("remove-thread"); throw new Error("persistence failed"); };

  await assert.rejects(() => cleanupFailedCodexStart(options), /persistence failed/);
  assert.deepEqual(events, [
    "revoke",
    "mark-deleted",
    "remove-thread",
    "restore-thread",
    "flush-state",
    "restore-capability"
  ]);
});

test("failed Codex harness start errors keep Worker as the execution role", async () => {
  await assert.rejects(
    () => rejectFailedCodexStart(new Error("start failed"), async () => { throw new Error("cleanup failed"); }),
    (error: unknown) => {
      assert.ok(error instanceof AggregateError);
      assert.match(error.message, /Worker start through the Codex harness failed/);
      assert.doesNotMatch(error.message, /Codex Worker/);
      return true;
    }
  );
});
