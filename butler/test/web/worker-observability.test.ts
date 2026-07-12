import assert from "node:assert/strict";
import test from "node:test";

import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { WorkerTurnView } from "../../src/web/WorkerPane.js";
import { shapeWorkerTimeline, type WorkerThread } from "../../src/web/worker-timeline.js";

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
