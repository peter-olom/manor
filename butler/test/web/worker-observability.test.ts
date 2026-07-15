import assert from "node:assert/strict";
import test from "node:test";

import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { WorkerTurnView } from "../../src/web/WorkerPane.js";
import { isCurrentWorkerHistoryRequest } from "../../src/web/useWorkerThreadHistory.js";
import { mergeWorkerThreadPages, shapeWorkerTimeline, type WorkerThread } from "../../src/web/worker-timeline.js";

test("Worker history pages merge in chronological order", () => {
  const turn = (index: number) => ({ id: `turn-${index}`, status: "completed", startedAt: index, completedAt: index, items: [] });
  const latest: WorkerThread = { id: "worker-pages", status: "idle", loadedStart: 10, hasMore: true, turnCount: 20, turns: Array.from({ length: 10 }, (_, index) => turn(index + 10)) };
  latest.eventLog = [{ at: 15, method: "runtime.error", summary: "latest" }];
  const earlier: WorkerThread = { id: "worker-pages", status: "idle", loadedStart: 0, hasMore: false, turnCount: 20, turns: Array.from({ length: 10 }, (_, index) => turn(index)), eventLog: [{ at: 5, method: "runtime.error", summary: "earlier" }] };
  const merged = mergeWorkerThreadPages(latest, earlier);
  assert.deepEqual(merged?.turns?.map((entry) => entry.id), Array.from({ length: 20 }, (_, index) => `turn-${index}`));
  assert.deepEqual(merged?.eventLog?.map((entry) => entry.summary), ["earlier", "latest"]);
  assert.equal(merged?.loadedStart, 0);
  assert.equal(merged?.hasMore, false);
});

test("a forward Worker history gap resets to the latest page for backfill", () => {
  const turn = (index: number) => ({ id: `turn-${index}`, status: "completed", startedAt: index, completedAt: index, items: [] });
  const current: WorkerThread = {
    id: "worker-pages",
    status: "idle",
    loadedStart: 10,
    hasMore: true,
    turnCount: 20,
    turns: Array.from({ length: 10 }, (_, index) => turn(index + 10))
  };
  const latest: WorkerThread = {
    id: "worker-pages",
    status: "running",
    loadedStart: 25,
    hasMore: true,
    turnCount: 35,
    turns: Array.from({ length: 10 }, (_, index) => turn(index + 25))
  };

  const refreshed = mergeWorkerThreadPages(current, latest);

  assert.equal(refreshed, latest);
  assert.equal(refreshed?.loadedStart, 25);
  assert.deepEqual(refreshed?.turns?.map((entry) => entry.id), Array.from({ length: 10 }, (_, index) => `turn-${index + 25}`));
});

test("older Worker history pages preserve newer live state", () => {
  const current: WorkerThread = {
    id: "worker-pages",
    status: "running",
    loadedStart: 20,
    turns: [{ id: "turn-20", status: "running", startedAt: 20, completedAt: null, items: [] }],
    supervisor: { summary: "Current supervisor state" },
    jobPayload: { revision: 2, snapshots: [] } as WorkerThread["jobPayload"]
  };
  const older: WorkerThread = {
    id: "worker-pages",
    status: "idle",
    loadedStart: 10,
    turns: [
      { id: "turn-10", status: "completed", startedAt: 10, completedAt: 11, items: [] },
      { id: "turn-20", status: "completed", startedAt: 20, completedAt: 21, items: [] }
    ],
    supervisor: { summary: "Stale supervisor state" },
    jobPayload: { revision: 1, snapshots: [] } as WorkerThread["jobPayload"]
  };

  const merged = mergeWorkerThreadPages(current, older);

  assert.equal(merged?.status, "running");
  assert.equal(merged?.supervisor?.summary, "Current supervisor state");
  assert.equal(merged?.jobPayload?.revision, 2);
  assert.equal(merged?.turns?.find((turn) => turn.id === "turn-20")?.status, "running");
  assert.equal(merged?.loadedStart, 10);

  const refreshed = mergeWorkerThreadPages(merged, {
    ...current,
    status: "idle",
    turns: [{ id: "turn-20", status: "completed", startedAt: 20, completedAt: 22, items: [] }]
  });
  assert.equal(refreshed?.status, "idle");
  assert.equal(refreshed?.turns?.find((turn) => turn.id === "turn-20")?.status, "completed");
  assert.equal(refreshed?.loadedStart, 10);
});

test("Worker history request guards reject stale selection, generation, and sequence", () => {
  const current = { pairId: "pair-2", threadId: "thread-2", generation: 4, requestId: 8 };
  assert.equal(isCurrentWorkerHistoryRequest(current, current), true);
  assert.equal(isCurrentWorkerHistoryRequest({ ...current, pairId: "pair-1" }, current), false);
  assert.equal(isCurrentWorkerHistoryRequest({ ...current, threadId: "thread-1" }, current), false);
  assert.equal(isCurrentWorkerHistoryRequest({ ...current, generation: 3 }, current), false);
  assert.equal(isCurrentWorkerHistoryRequest({ ...current, requestId: 7 }, current), false);
});

test("Worker history preserves original turn numbers on a partial page", () => {
  const timeline = shapeWorkerTimeline({
    id: "worker-page",
    status: "idle",
    loadedStart: 220,
    turnCount: 230,
    turns: [{
      id: "turn-221",
      status: "failed",
      error: "Stopped without a final reply.",
      startedAt: 100,
      completedAt: 200,
      items: []
    }]
  });

  assert.equal(timeline.turns[0]?.ordinal, 221);
  const markup = renderToStaticMarkup(React.createElement(WorkerTurnView, {
    turn: timeline.turns[0]!,
    index: 0,
    payload: null,
    checklist: null,
    proofs: [],
    onPreviewImage: () => undefined
  }));
  assert.match(markup, /aria-label="Worker turn 221 failed"/);
});

test("a no-item Codex failure becomes a durable visible Worker diagnostic", () => {
  const thread: WorkerThread = {
    id: "worker-1",
    status: "idle",
    turns: [{
      id: "turn-failed",
      status: "failed",
      error: "Provider rejected the request before producing output.",
      startedAt: 100,
      completedAt: 200,
      items: []
    }],
    eventLog: [{ at: 150, method: "runtime.error", summary: "Connection closed while starting the turn." }]
  };

  const timeline = shapeWorkerTimeline(thread);
  assert.equal(timeline.turns.length, 1);
  assert.equal(timeline.turns[0]?.status, "failed");
  assert.deepEqual(timeline.turns[0]?.items.map((item) => ({ type: item.type, status: item.status, text: item.text })), [
    { type: "error", status: "failed", text: "Connection closed while starting the turn." },
    { type: "error", status: "failed", text: "Provider rejected the request before producing output." }
  ]);

  const markup = renderToStaticMarkup(React.createElement(WorkerTurnView, {
    turn: timeline.turns[0]!,
    index: 0,
    payload: null,
    checklist: null,
    proofs: [],
    onPreviewImage: () => undefined
  }));
  assert.match(markup, /aria-label="Worker turn 1 failed"/);
  assert.match(markup, /worker-turn-status is-failed">failed/);
  assert.match(markup, /<details[^>]*open/);
  assert.match(markup, /Provider rejected the request before producing output/);
  assert.match(markup, /Connection closed while starting the turn/);
});

test("a cancelled no-item turn renders as a stopped terminal turn", () => {
  const timeline = shapeWorkerTimeline({
    id: "worker-cancelled",
    status: "idle",
    turns: [{
      id: "turn-cancelled",
      status: "cancelled",
      startedAt: 100,
      completedAt: 200,
      items: []
    }]
  });

  assert.equal(timeline.turns.length, 1);
  const markup = renderToStaticMarkup(React.createElement(WorkerTurnView, {
    turn: timeline.turns[0]!,
    index: 0,
    payload: null,
    checklist: null,
    proofs: [],
    onPreviewImage: () => undefined
  }));
  assert.match(markup, /aria-label="Worker turn 1 stopped"/);
  assert.match(markup, /worker-turn-status is-failed">stopped/);
});
