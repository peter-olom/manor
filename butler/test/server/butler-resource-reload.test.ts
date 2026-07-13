import assert from "node:assert/strict";
import test from "node:test";

import { reloadButlerResources } from "../../src/server/butler-agent-session.js";

test("Butler resource reload waits behind the active turn and before the next turn", async () => {
  const order: string[] = [];
  let finishTurn!: () => void;
  const activeTurn = new Promise<void>((resolve) => { finishTurn = resolve; });
  const session = {
    waitForIdle: async () => { order.push("idle"); },
    reload: async () => { order.push("reload"); }
  };
  const access = {
    session: session as never,
    promptQueue: activeTurn.then(() => { order.push("active-turn"); })
  };

  const reload = reloadButlerResources(access);
  const nextTurn = access.promptQueue.then(() => { order.push("next-turn"); });
  assert.deepEqual(order, []);

  finishTurn();
  await Promise.all([reload, nextTurn]);

  assert.deepEqual(order, ["active-turn", "idle", "reload", "next-turn"]);
});

test("Butler resource reload targets the current session after a concurrent replacement", async () => {
  let release!: () => void;
  const activeTurn = new Promise<void>((resolve) => { release = resolve; });
  let reloads = 0;
  const original = { waitForIdle: async () => undefined, reload: async () => { reloads += 1; } };
  const replacement = { waitForIdle: async () => undefined, reload: async () => { reloads += 1; } };
  const access = { session: original as never, promptQueue: activeTurn };

  const reload = reloadButlerResources(access);
  access.session = replacement as never;
  release();
  await reload;

  assert.equal(reloads, 1);
});
