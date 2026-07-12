import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { ButlerTraceBuffer } from "../../src/server/butler-trace-buffer.js";
import { upsertProviderBackedOperatorMessage } from "../../src/server/butler-operator-messages.js";
import { readPersistedTrace, readPersistedTraceMeta } from "../../src/server/butler-trace-persistence.js";
import type { ButlerMessageView } from "../../src/server/types.js";

test("ButlerTraceBuffer consumes a turn into a meta that survives serialization", () => {
  const buffer = new ButlerTraceBuffer();
  buffer.startTurn("turn-1", 1000);
  buffer.setAssistantItem("turn-1", "assistant-1", 1100);
  buffer.upsertItem({
    turnId: "turn-1",
    itemId: "reasoning-1",
    type: "reasoning",
    status: "completed",
    text: "Plan A",
    at: 1001,
    completedAt: 1001
  });
  buffer.upsertItem({
    turnId: "turn-1",
    itemId: "tool-1",
    type: "command_execution",
    status: "completed",
    text: "ls -la",
    at: 1002,
    completedAt: 1002,
    title: "ls"
  });
  const meta = buffer.consumeForAssistantItem("assistant-1");
  assert.ok(meta);

  const messages: ButlerMessageView[] = [];
  upsertProviderBackedOperatorMessage(
    messages,
    "operator-session-assistant-1",
    "final",
    1100,
    "assistant",
    null,
    { trace: meta.items, traceMeta: meta }
  );

  const json = JSON.parse(JSON.stringify(messages));
  const restored = json[0] as { trace?: unknown; traceMeta?: unknown };
  const restoredTrace = readPersistedTrace(restored.trace);
  const restoredMeta = readPersistedTraceMeta(restored.traceMeta);
  assert.ok(restoredTrace);
  assert.equal(restoredTrace.length, 2);
  assert.equal(restoredTrace[0]?.type, "reasoning");
  assert.equal(restoredTrace[1]?.title, "ls");
  assert.ok(restoredMeta);
  assert.equal(restoredMeta.turnId, "turn-1");
  assert.equal(restoredMeta.startedAt, 1000);
  assert.equal(restoredMeta.completedAt, 1100);
  assert.equal(restoredMeta.items.length, 2);
});

test("ButlerTraceBuffer round-trips through the operator message persistence file", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "manor-butler-trace-persistence-"));
  const file = path.join(dir, "operator-messages.json");
  const messages: ButlerMessageView[] = [];
  const buffer = new ButlerTraceBuffer();
  buffer.startTurn("turn-7", 5000);
  buffer.setAssistantItem("turn-7", "assistant-7", 5050);
  buffer.upsertItem({
    turnId: "turn-7",
    itemId: "tool-1",
    type: "command_execution",
    status: "completed",
    text: "pwd",
    at: 5001,
    completedAt: 5001
  });
  const meta = buffer.consumeForAssistantItem("assistant-7");
  assert.ok(meta);
  upsertProviderBackedOperatorMessage(
    messages,
    "operator-session-assistant-7",
    "ok",
    5050,
    "assistant",
    null,
    { trace: meta.items, traceMeta: meta, normalize: false }
  );
  await import("node:fs/promises").then((fs) => fs.writeFile(file, JSON.stringify(messages), "utf8"));
  const raw = await import("node:fs/promises").then((fs) => fs.readFile(file, "utf8"));
  const parsed = JSON.parse(raw) as Array<{ trace?: unknown; traceMeta?: unknown }>;
  const restored = readPersistedTraceMeta(parsed[0]?.traceMeta);
  assert.ok(restored);
  assert.equal(restored.items.length, 1);
  assert.equal(restored.items[0]?.type, "command_execution");
});

test("provider history refresh preserves an existing Butler trace", () => {
  const trace = [{
    id: "tool-1",
    type: "dynamic_tool_call" as const,
    status: "completed" as const,
    text: "Delegated to Worker",
    title: "delegate_to_worker",
    at: 100,
    completedAt: 110
  }];
  const messages: ButlerMessageView[] = [];
  upsertProviderBackedOperatorMessage(messages, "operator-session-assistant-1", "Accepted. I delegated this to a Worker.", 120, "assistant", null, { trace });

  upsertProviderBackedOperatorMessage(messages, "operator-session-assistant-1", "Accepted. I delegated this to a Worker.", 120, "assistant");

  assert.deepEqual(messages[0]?.trace, trace);
});
