import assert from "node:assert/strict";
import { mkdtemp, readFile, rename, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { ButlerAgentService } from "../../src/server/butler-agent.js";
import { postOperatorJobReply, type OperatorJobReplyAccess } from "../../src/server/butler-operator-closeout.js";
import { OperatorMessageStateWriteQueue } from "../../src/server/butler-operator-messages.js";
import { ButlerStateStore } from "../../src/server/state-store.js";
import type { ButlerThreadCallbackView } from "../../src/server/types.js";

test("operator message writes cannot rename an older snapshot after a newer one", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "manor-message-write-order-"));
  const target = path.join(dir, "operator-messages.json");
  const olderTemp = path.join(dir, "older.tmp");
  const newerTemp = path.join(dir, "newer.tmp");
  const queue = new OperatorMessageStateWriteQueue();
  let releaseOlder!: () => void;
  let markOlderReady!: () => void;
  let newerStarted = false;
  const olderReady = new Promise<void>((resolve) => { markOlderReady = resolve; });
  const olderBlocked = new Promise<void>((resolve) => { releaseOlder = resolve; });
  const older = queue.run(async () => { await writeFile(olderTemp, "older"); markOlderReady(); await olderBlocked; await rename(olderTemp, target); });
  await olderReady;
  const newer = queue.run(async () => { newerStarted = true; await writeFile(newerTemp, "newer"); await rename(newerTemp, target); });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(newerStarted, false);
  releaseOlder();
  await Promise.all([older, newer]);
  assert.equal(await readFile(target, "utf8"), "newer");
});

test("late closeout persistence cannot close a review that has moved to retry", async () => {
  const sessionDir = await mkdtemp(path.join(tmpdir(), "manor-late-closeout-"));
  const store = new ButlerStateStore(path.join(sessionDir, "state.json"));
  const threadId = "thread-late-closeout";
  store.upsertThreadSummary({ id: threadId, status: "idle", cwd: "/workspace", turns: [{ id: "turn-1", status: "completed", items: [] }] });
  const agent = new ButlerAgentService({
    store,
    piRpcWorkerClient: { getConnectionState: () => ({ compose: { availableModels: [] } }) } as never,
    runtimeBroker: {} as never,
    serviceTemplateRegistry: {} as never,
    imageStore: {} as never,
    fileStore: {} as never,
    piAuthPath: path.join(sessionDir, "pi-auth.json"),
    workerAuthPath: path.join(sessionDir, "worker-auth.json"),
    workerConfigDir: sessionDir,
    sessionDir,
    artifactsDir: sessionDir
  });
  await agent.notifyDirectCodexMessage({ threadId, text: "Finish it.", requestedAt: 1, scopeDisposition: "replace" });
  for (const item of store.getSupervisionChecklist(threadId)?.items ?? []) store.reviewAcceptancePoint({ threadId, pointId: item.id, status: "accepted" });
  const access = agent as unknown as OperatorJobReplyAccess & { pendingChatCallbacks: Map<string, ButlerThreadCallbackView> };
  const pending = access.pendingChatCallbacks.get(threadId)!;
  pending.reviewState = "running";
  pending.reviewStage = "supervising_closeout";
  let release!: () => void;
  let markSaving!: () => void;
  const blockedSave = new Promise<void>((resolve) => { release = resolve; });
  const saving = new Promise<void>((resolve) => { markSaving = resolve; });
  const savedMessageIds: string[][] = [];
  access.saveOperatorMessageState = async (messages = access.operatorMessages) => {
    if (savedMessageIds.length === 0) { markSaving(); await blockedSave; }
    savedMessageIds.push(messages.map((message) => message.id));
  };
  let replies = 0;
  access.operatorSink = { onOperatorReply: () => { replies += 1; } };

  const closeout = postOperatorJobReply(access, threadId, "Finished.", pending);
  await saving;
  pending.reviewState = "queued";
  pending.reviewStage = "retry_wait";
  release();

  await assert.rejects(closeout, /superseded before closeout completed/);
  assert.equal(pending.reviewState, "queued");
  assert.equal(replies, 0);
  assert.equal(access.operatorMessages.some((message) => message.text === "Finished."), false);
  assert.equal(savedMessageIds.at(-1)?.some((id) => id.startsWith("callback-fallback-")), false);
  agent.dispose();
});

test("closeout persistence merges messages added by another thread while saving", async () => {
  const sessionDir = await mkdtemp(path.join(tmpdir(), "manor-concurrent-closeout-"));
  const store = new ButlerStateStore(path.join(sessionDir, "state.json"));
  const threadId = "thread-concurrent-closeout";
  store.upsertThreadSummary({ id: threadId, status: "idle", cwd: "/workspace", turns: [{ id: "turn-1", status: "completed", items: [] }] });
  const agent = new ButlerAgentService({
    store,
    piRpcWorkerClient: { getConnectionState: () => ({ compose: { availableModels: [] } }) } as never,
    runtimeBroker: {} as never,
    serviceTemplateRegistry: {} as never,
    imageStore: {} as never,
    fileStore: {} as never,
    piAuthPath: path.join(sessionDir, "pi-auth.json"),
    workerAuthPath: path.join(sessionDir, "worker-auth.json"),
    workerConfigDir: sessionDir,
    sessionDir,
    artifactsDir: sessionDir
  });
  await agent.notifyDirectCodexMessage({ threadId, text: "Finish it.", requestedAt: 1, scopeDisposition: "replace" });
  for (const item of store.getSupervisionChecklist(threadId)?.items ?? []) store.reviewAcceptancePoint({ threadId, pointId: item.id, status: "accepted" });
  const access = agent as unknown as OperatorJobReplyAccess & { pendingChatCallbacks: Map<string, ButlerThreadCallbackView> };
  const pending = access.pendingChatCallbacks.get(threadId)!;
  pending.reviewState = "running";
  pending.reviewStage = "supervising_closeout";
  let release!: () => void;
  let markSaving!: () => void;
  const blockedSave = new Promise<void>((resolve) => { release = resolve; });
  const saving = new Promise<void>((resolve) => { markSaving = resolve; });
  const savedMessageIds: string[][] = [];
  access.saveOperatorMessageState = async (messages = access.operatorMessages) => {
    if (savedMessageIds.length === 0) { markSaving(); await blockedSave; }
    savedMessageIds.push(messages.map((message) => message.id));
  };

  const closeout = postOperatorJobReply(access, threadId, "Finished.", pending);
  await saving;
  access.operatorMessages.push({ id: "concurrent-message", role: "assistant", text: "Other thread update.", at: 2, taskDurationMs: null, kind: "message" });
  release();
  await closeout;

  assert.equal(access.operatorMessages.some((message) => message.id === "concurrent-message"), true);
  assert.equal(access.operatorMessages.some((message) => message.text === "Finished."), true);
  assert.equal(savedMessageIds.at(-1)?.includes("concurrent-message"), true);
  assert.equal(savedMessageIds.at(-1)?.some((id) => id.startsWith("callback-fallback-")), true);
  agent.dispose();
});
