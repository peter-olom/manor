import assert from "node:assert/strict";
import test from "node:test";

import { ButlerActivitySummaryState } from "../../src/server/butler-activity-summary-state.js";
import type { ButlerActivityTurnView } from "../../src/server/types.js";

function turn(id: string, startedAt: number): ButlerActivityTurnView {
  return {
    id,
    status: "failed",
    startedAt,
    completedAt: startedAt + 1,
    detail: "Provider failure",
    items: []
  };
}

test("activity summary writes stay ordered when an earlier write is delayed", async () => {
  const turns: ButlerActivityTurnView[] = [];
  const writes: string[][] = [];
  let releaseFirst!: () => void;
  const firstWrite = new Promise<void>((resolve) => { releaseFirst = resolve; });
  const state = new ButlerActivitySummaryState("unused.json", turns, assert.fail, async (_path, snapshot) => {
    writes.push(snapshot.map((entry) => entry.id));
    if (writes.length === 1) await firstWrite;
  });

  const first = state.persistTurn(turn("turn-1", 1));
  await new Promise((resolve) => setImmediate(resolve));
  const second = state.persistTurn(turn("turn-2", 2));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(writes, [["turn-1"]]);

  releaseFirst();
  await Promise.all([first, second]);
  assert.deepEqual(writes, [["turn-1"], ["turn-1", "turn-2"]]);
});

test("activity summary save failures are observed and do not block later saves", async () => {
  const turns: ButlerActivityTurnView[] = [];
  const failures: unknown[] = [];
  const writes: string[][] = [];
  let writeCount = 0;
  const state = new ButlerActivitySummaryState("unused.json", turns, (error) => failures.push(error), async (_path, snapshot) => {
    writeCount += 1;
    if (writeCount === 1) throw new Error("disk unavailable");
    writes.push(snapshot.map((entry) => entry.id));
  });

  await assert.rejects(state.persistTurn(turn("turn-1", 1)), /disk unavailable/);
  assert.equal(failures.length, 1);
  await state.persistTurn(turn("turn-2", 2));

  assert.equal(writeCount, 2);
  assert.deepEqual(writes, [["turn-1", "turn-2"]]);
});
