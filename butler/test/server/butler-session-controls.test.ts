import assert from "node:assert/strict";
import { test } from "node:test";

import { cloneButlerSession, forkButlerSession, getButlerSessionControls } from "../../src/server/butler-session-controls.js";

function createAccess(options: { idle?: boolean; forkPoints?: Array<{ entryId: string; text: string }> } = {}) {
  const createdBranches: string[] = [];
  let operatorSaves = 0;
  let activitySaves = 0;
  const branch = [
    { id: "root", parentId: null, type: "model_change", timestamp: "2026-01-01T00:00:00.000Z" },
    { id: "user-1", parentId: "root", type: "message", timestamp: "2026-01-01T00:00:01.000Z" },
    { id: "assistant-1", parentId: "user-1", type: "message", timestamp: "2026-01-01T00:00:02.000Z" },
    { id: "user-2", parentId: "assistant-1", type: "message", timestamp: "2026-01-01T00:00:03.000Z" },
    { id: "assistant-2", parentId: "user-2", type: "message", timestamp: "2026-01-01T00:00:04.000Z" }
  ];
  const access = {
    session: {
      sessionId: "butler-test",
      isIdle: options.idle ?? true,
      isCompacting: false,
      isStreaming: false,
      autoCompactionEnabled: true,
      pendingMessageCount: 0,
      sessionName: "Butler test",
      getSessionStats: () => ({
        userMessages: 2,
        assistantMessages: 2,
        toolCalls: 1,
        totalMessages: 5,
        tokens: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, total: 15 },
        cost: 0.01,
        contextUsage: { tokens: 15, contextWindow: 100, percent: 15 }
      }),
      getUserMessagesForForking: () => options.forkPoints ?? [
        { entryId: "user-1", text: "First" },
        { entryId: "user-2", text: "Second" }
      ],
      sessionManager: {
        getEntries: () => [],
        getBranch: () => branch,
        createBranchedSession: (entryId: string) => { createdBranches.push(entryId); return "/sessions/fork.jsonl"; },
        buildSessionContext: () => ({ messages: [{ role: "user", content: "kept" }] })
      },
      agent: { state: { messages: [] as unknown[] } }
    },
    modelRegistry: null,
    pending: false,
    pendingChatCallbacks: new Map(),
    operatorMessages: [
      { id: "one", at: Date.parse("2026-01-01T00:00:01.000Z") },
      { id: "two", at: Date.parse("2026-01-01T00:00:03.000Z") },
      { id: "three", at: Date.parse("2026-01-01T00:00:04.000Z") }
    ],
    pendingOperatorMessages: [],
    activityTurns: [
      { id: "early", startedAt: Date.parse("2026-01-01T00:00:01.000Z"), completedAt: Date.parse("2026-01-01T00:00:02.000Z") },
      { id: "late", startedAt: Date.parse("2026-01-01T00:00:04.000Z"), completedAt: Date.parse("2026-01-01T00:00:05.000Z") }
    ],
    activitySummaryTurns: [],
    activeActivityTurnId: null,
    traceBuffer: { reset() {} },
    saveOperatorMessageState: async () => { operatorSaves += 1; },
    saveActivitySummaryState: async () => { activitySaves += 1; },
    emit() { return true; },
    lastError: "old"
  };
  return { access, createdBranches, saves: () => ({ operatorSaves, activitySaves }) };
}

test("Butler controls expose the embedded Pi session tree and stats", () => {
  const { access } = createAccess();
  const controls = getButlerSessionControls(access as never);
  assert.equal(controls.supported, true);
  assert.equal(controls.runtime, "pi");
  assert.equal(controls.sessionName, "Butler test");
  assert.equal(controls.stats?.tokens.total, 15);
  assert.equal(controls.stats?.usage.requests, 0);
  assert.deepEqual(controls.forkPoints.map((point) => point.entryId), ["user-1", "user-2"]);
  assert.equal(controls.leafId, "assistant-2");
});

test("Butler fork validates the point and resyncs persisted transcript state", async () => {
  const { access, createdBranches, saves } = createAccess();
  await forkButlerSession(access as never, "user-2");
  assert.deepEqual(createdBranches, ["assistant-1"]);
  assert.deepEqual(access.session.agent.state.messages, [{ role: "user", content: "kept" }]);
  assert.deepEqual(access.operatorMessages.map((message) => message.id), ["one"]);
  assert.deepEqual(access.activityTurns.map((turn) => turn.id), ["early"]);
  assert.deepEqual(saves(), { operatorSaves: 1, activitySaves: 1 });
  assert.equal(access.lastError, null);
});

test("Butler fork prunes from the selected occurrence when prompts are identical", async () => {
  const repeated = createAccess({
    forkPoints: [
      { entryId: "user-1", text: "Repeat this" },
      { entryId: "user-2", text: "Repeat this" }
    ]
  });
  repeated.access.operatorMessages.splice(0, repeated.access.operatorMessages.length,
    { id: "first", role: "user", text: "Repeat this", at: Date.parse("2026-01-01T00:00:00.500Z") },
    { id: "first-reply", role: "assistant", text: "Done", at: Date.parse("2026-01-01T00:00:02.000Z") },
    { id: "second", role: "user", text: "Repeat this", at: Date.parse("2026-01-01T00:00:02.500Z") },
    { id: "second-reply", role: "assistant", text: "Done again", at: Date.parse("2026-01-01T00:00:04.000Z") }
  );

  await forkButlerSession(repeated.access as never, "user-1");

  assert.deepEqual(repeated.createdBranches, ["root"]);
  assert.deepEqual(repeated.access.operatorMessages, []);
});

test("Butler fork rejects stale points and busy sessions before mutation", async () => {
  const stale = createAccess({ forkPoints: [] });
  await assert.rejects(forkButlerSession(stale.access as never, "user-2"), /no longer available/);
  assert.deepEqual(stale.createdBranches, []);

  const busy = createAccess({ idle: false });
  await assert.rejects(forkButlerSession(busy.access as never, "user-2"), /Wait for Butler/);
  assert.deepEqual(busy.createdBranches, []);

  const followingUp = createAccess();
  followingUp.access.pendingChatCallbacks.set("worker-1", {});
  await assert.rejects(cloneButlerSession(followingUp.access as never), /active Worker follow-ups/);
  assert.deepEqual(followingUp.createdBranches, []);
});

test("Butler clone creates a new persisted branch at the active leaf", async () => {
  const { access, createdBranches } = createAccess();
  await cloneButlerSession(access as never);
  assert.deepEqual(createdBranches, ["assistant-2"]);
  assert.deepEqual(access.operatorMessages.map((message) => message.id), ["one", "two", "three"]);
});
