import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { CodexHarnessService } from "../../src/server/codex-harness.js";
import {
  buildJobPayload,
  jobPayloadsRoot,
  persistJobPayload
} from "../../src/server/job-instruction-artifacts.js";
import type { RuntimeBrokerClient } from "../../src/server/runtime-broker-client.js";
import type { ServiceTemplateRegistry } from "../../src/server/service-templates.js";
import { ButlerStateStore } from "../../src/server/state-store.js";
import { buildThreadExecutionContract } from "../../src/server/thread-contract.js";

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

test("harness reads and updates the current payload for the bound thread", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "manor-harness-payload-"));
  const stateDir = path.join(root, "state");
  const codexHomeDir = path.join(root, "codex-home");
  const artifactsDir = path.join(root, "artifacts");
  await mkdir(stateDir, { recursive: true });
  await writeFile(path.join(stateDir, "butler-ui.json"), JSON.stringify({ windows: [], focusedWindowId: null }, null, 2), "utf8");
  const store = new ButlerStateStore(path.join(stateDir, "butler-ui.json"));
  await store.load();
  store.upsertThreadSummary({ id: "thread-instruction", cwd: "/workspace", status: "active", source: "codex" });
  const contract = buildThreadExecutionContract({
    threadId: "thread-instruction",
    workspaceCwd: "/workspace",
    projectId: "project",
    projectLabel: "Project",
    branch: null,
    taskText: "Read structured payload.",
    notes: []
  });
  store.setThreadExecutionContract(contract.threadId, contract);
  const payload = buildJobPayload({
    threadId: contract.threadId,
    kind: "delegation",
    instruction: contract.requestedTask,
    contract
  });
  await persistJobPayload(jobPayloadsRoot(artifactsDir), payload);
  store.setThreadJobPayload(payload);

  const harness = new CodexHarnessService({
    codexHomeDir,
    stateDir,
    artifactsDir,
    store,
    runtimeBroker: { listStacks: async () => [] } as unknown as RuntimeBrokerClient,
    serviceTemplateRegistry: { list: () => [], get: () => undefined } as unknown as ServiceTemplateRegistry
  });
  await harness.load();
  const capability = await harness.ensureThreadCapability(contract.threadId, "/workspace");
  assert.ok(capability);

  const read = await harness.handleAction({ token: capability.token, action: "payload.current" });
  const updated = await harness.handleAction({
    token: capability.token,
    action: "payload.update",
    params: { status: "completed", summary: "Worker updated payload" }
  });

  assert.match(read.text, /"schemaVersion": "manor.job_payload.v1"/);
  assert.equal((read.data?.payload as { threadId?: string } | undefined)?.threadId, contract.threadId);
  assert.equal((updated.data?.payload as { report?: { summary?: string } } | undefined)?.report?.summary, "Worker updated payload");
});

test("harness recovers the current payload from the thread contract when the payload file is missing", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "manor-harness-payload-fallback-"));
  const stateDir = path.join(root, "state");
  const codexHomeDir = path.join(root, "codex-home");
  const artifactsDir = path.join(root, "artifacts");
  await mkdir(stateDir, { recursive: true });
  await writeFile(path.join(stateDir, "butler-ui.json"), JSON.stringify({ windows: [], focusedWindowId: null }, null, 2), "utf8");
  const store = new ButlerStateStore(path.join(stateDir, "butler-ui.json"));
  await store.load();
  store.upsertThreadSummary({ id: "thread-fallback", cwd: "/workspace", status: "active", source: "codex" });
  const contract = buildThreadExecutionContract({
    threadId: "thread-fallback",
    workspaceCwd: "/workspace",
    projectId: "project",
    projectLabel: "Project",
    branch: null,
    taskText: "Recover the payload from the contract.",
    notes: ["Verify the recovered payload."]
  });
  store.setThreadExecutionContract(contract.threadId, contract);

  const harness = new CodexHarnessService({
    codexHomeDir,
    stateDir,
    artifactsDir,
    store,
    runtimeBroker: { listStacks: async () => [] } as unknown as RuntimeBrokerClient,
    serviceTemplateRegistry: { list: () => [], get: () => undefined } as unknown as ServiceTemplateRegistry
  });
  await harness.load();
  const capability = await harness.ensureThreadCapability(contract.threadId, "/workspace");
  assert.ok(capability);

  const read = await harness.handleAction({ token: capability.token, action: "payload.current" });

  assert.match(read.text, /"schemaVersion": "manor.job_payload.v1"/);
  assert.equal((read.data?.payload as { threadId?: string } | undefined)?.threadId, contract.threadId);
  const saved = JSON.parse(await readFile(path.join(jobPayloadsRoot(artifactsDir), contract.threadId, "current.json"), "utf8")) as { threadId?: string };
  assert.equal(saved.threadId, contract.threadId);
});

test("harness assist responses persist structured instruction artifacts", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "manor-harness-assist-"));
  const stateDir = path.join(root, "state");
  const codexHomeDir = path.join(root, "codex-home");
  const artifactsDir = path.join(root, "artifacts");
  const workspace = path.join(root, "workspace");
  await mkdir(stateDir, { recursive: true });
  await mkdir(workspace, { recursive: true });
  await writeFile(path.join(stateDir, "butler-ui.json"), JSON.stringify({ windows: [], focusedWindowId: null }, null, 2), "utf8");
  const store = new ButlerStateStore(path.join(stateDir, "butler-ui.json"));
  await store.load();
  store.upsertThreadSummary({ id: "thread-assist", cwd: workspace, status: "active", source: "codex" });
  const contract = buildThreadExecutionContract({
    threadId: "thread-assist",
    workspaceCwd: workspace,
    projectId: "project",
    projectLabel: "Project",
    branch: null,
    taskText: "Ask Butler for runtime guidance.",
    notes: []
  });
  store.setThreadExecutionContract(contract.threadId, contract);
  const payload = buildJobPayload({
    threadId: contract.threadId,
    kind: "delegation",
    instruction: contract.requestedTask,
    contract
  });
  await persistJobPayload(jobPayloadsRoot(artifactsDir), payload);
  store.setThreadJobPayload(payload);
  const harness = new CodexHarnessService({
    codexHomeDir,
    stateDir,
    artifactsDir,
    store,
    runtimeBroker: { listStacks: async () => [] } as unknown as RuntimeBrokerClient,
    serviceTemplateRegistry: { list: () => [], get: () => undefined } as unknown as ServiceTemplateRegistry
  });
  await harness.load();
  const capability = await harness.ensureThreadCapability(contract.threadId, workspace);
  assert.ok(capability);

  const result = await harness.handleAction({
    token: capability.token,
    action: "assist.request",
    params: { summary: "Need help", question: "Which harness path should I use?" }
  });
  const read = await harness.handleAction({
    token: capability.token,
    action: "payload.current"
  });

  assert.match(result.text, /Butler guidance/);
  assert.equal((read.data?.payload as { kind?: string } | undefined)?.kind, "assist_context");
});
