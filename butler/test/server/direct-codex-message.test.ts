import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { ButlerAgentService } from "../../src/server/butler-agent.js";
import { buildDirectCodexMessagePingSummary } from "../../src/server/direct-codex-message.js";
import { ButlerStateStore } from "../../src/server/state-store.js";

async function createStore(): Promise<ButlerStateStore> {
  const dir = await mkdtemp(path.join(tmpdir(), "manor-direct-codex-test-"));
  return new ButlerStateStore(path.join(dir, "state.json"));
}

function createButlerAgent(store: ButlerStateStore, sessionDir: string): ButlerAgentService {
  return new ButlerAgentService({
    store,
    codexClient: {
      getConnectionState: () => ({
        compose: {
          availableModels: []
        }
      })
    } as never,
    runtimeBroker: {} as never,
    serviceTemplateRegistry: {} as never,
    imageStore: {} as never,
    fileStore: {} as never,
    piAuthPath: path.join(sessionDir, "pi-auth.json"),
    codexAuthPath: path.join(sessionDir, "codex-auth.json"),
    codexConfigDir: sessionDir,
    sessionDir,
    artifactsDir: sessionDir
  });
}

test("direct Codex ping summary includes message and selected context", () => {
  const summary = buildDirectCodexMessagePingSummary({
    text: "Please retry the smoke proof.",
    imageReferenceIds: ["image-1"],
    fileReferenceIds: ["file-1", "file-2"],
    inputItems: [{ type: "mention", path: "app://example" }]
  });

  assert.match(summary, /Please retry the smoke proof/);
  assert.match(summary, /1 image reference/);
  assert.match(summary, /2 file references/);
  assert.match(summary, /1 selected context item/);
});

test("direct Codex messages register Butler supervision callback", async () => {
  const store = await createStore();
  const sessionDir = await mkdtemp(path.join(tmpdir(), "manor-direct-codex-session-"));
  const threadId = "thread-direct-1";
  store.upsertThreadSummary({
    id: threadId,
    status: "active",
    cwd: "/workspace",
    turns: [{ id: "turn-1", status: "completed", items: [] }]
  });

  const agent = createButlerAgent(store, sessionDir);
  await agent.notifyDirectCodexMessage({
    threadId,
    text: "Continue with the operator correction.",
    imageReferenceIds: [],
    fileReferenceIds: [],
    inputItems: []
  });

  const callbacks = agent.getShellSnapshot().supervision.callbacks;
  assert.equal(callbacks.length, 1);
  assert.equal(callbacks[0]?.threadId, threadId);
  assert.equal(callbacks[0]?.lastPrivateSteerText, "Continue with the operator correction.");
  assert.equal(callbacks[0]?.operatorCloseoutStatus, "owed");
  assert.equal(callbacks[0]?.nextWorkerReportAction, "review");
  assert.equal(store.getThread(threadId)?.eventLog[0]?.method, "butler.direct_message.pinged");
});
