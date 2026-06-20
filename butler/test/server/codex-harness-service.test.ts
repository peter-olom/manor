import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { CodexHarnessService } from "../../src/server/codex-harness.js";
import type { RuntimeBrokerClient } from "../../src/server/runtime-broker-client.js";
import type { ServiceTemplateRegistry } from "../../src/server/service-templates.js";
import { ButlerStateStore } from "../../src/server/state-store.js";

test("harness reconciliation does not erase existing capabilities when thread inventory is empty", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "manor-harness-reconcile-"));
  const stateDir = path.join(root, "state");
  const codexHomeDir = path.join(root, "codex-home");
  const registryPath = path.join(codexHomeDir, "manor", "harness-capabilities.json");
  await mkdir(stateDir, { recursive: true });
  await mkdir(path.dirname(registryPath), { recursive: true });
  await writeFile(path.join(stateDir, "butler-ui.json"), JSON.stringify({ windows: [], focusedWindowId: null }, null, 2), "utf8");
  await writeFile(
    registryPath,
    JSON.stringify({
      capabilities: [
        {
          id: "capability-1",
          token: "token-1",
          threadId: "thread-1",
          cwd: "/repos/testamy",
          createdAt: 1,
          updatedAt: 1
        }
      ]
    }, null, 2),
    "utf8"
  );

  const store = new ButlerStateStore(path.join(stateDir, "butler-ui.json"));
  await store.load();
  const harness = new CodexHarnessService({
    codexHomeDir,
    stateDir,
    artifactsDir: path.join(root, "artifacts"),
    store,
    runtimeBroker: { listStacks: async () => [] } as unknown as RuntimeBrokerClient,
    serviceTemplateRegistry: { list: () => [], get: () => undefined } as unknown as ServiceTemplateRegistry
  });

  await harness.load();
  await harness.reconcileThreadCapabilities();

  const saved = JSON.parse(await readFile(registryPath, "utf8")) as { capabilities?: Array<{ threadId?: string; token?: string }> };
  assert.deepEqual(saved.capabilities?.map((entry) => [entry.threadId, entry.token]), [["thread-1", "token-1"]]);
});
