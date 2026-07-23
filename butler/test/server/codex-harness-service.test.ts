import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { CodexHarnessService, HarnessService } from "../../src/server/codex-harness.js";
import { runSerializedJobMutation } from "../../src/server/butler-job-mutation-guard.js";
import {
  buildJobPayload,
  jobPayloadsRoot,
  persistJobPayload
} from "../../src/server/job-instruction-artifacts.js";
import type { RuntimeBrokerClient } from "../../src/server/runtime-broker-client.js";
import type { ServiceTemplateRegistry } from "../../src/server/service-templates.js";
import { ButlerStateStore } from "../../src/server/state-store.js";
import { buildThreadExecutionContract } from "../../src/server/thread-contract.js";

function createHarness(root: string, store: ButlerStateStore, harnessRegistryPath?: string): HarnessService {
  return new HarnessService({
    harnessRegistryPath,
    stateDir: path.join(root, "state"),
    artifactsDir: path.join(root, "artifacts"),
    store,
    runtimeBroker: { listStacks: async () => [] } as unknown as RuntimeBrokerClient,
    serviceTemplateRegistry: { list: () => [], get: () => undefined } as unknown as ServiceTemplateRegistry
  });
}

test("Worker system awareness uses the capability-authenticated read-only collector", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "manor-harness-awareness-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const stateDir = path.join(root, "state");
  await mkdir(stateDir, { recursive: true });
  await writeFile(path.join(stateDir, "butler-ui.json"), JSON.stringify({ windows: [], focusedWindowId: null }), "utf8");
  const store = new ButlerStateStore(path.join(stateDir, "butler-ui.json"));
  await store.load();
  store.upsertThreadSummary({ id: "worker-awareness", cwd: "/workspace", status: "active", source: "pi" });
  let requestedSection: string | null = null;
  let requestedThreadId: string | null = null;
  const harness = new HarnessService({
    stateDir,
    artifactsDir: path.join(root, "artifacts"),
    store,
    runtimeBroker: { listStacks: async () => [] } as unknown as RuntimeBrokerClient,
    serviceTemplateRegistry: { list: () => [], get: () => undefined } as unknown as ServiceTemplateRegistry,
    readSystemAwareness: async (section = "overview", context) => {
      requestedSection = section;
      requestedThreadId = context?.workerThreadId ?? null;
      return { schemaVersion: 1, generatedAt: 1_700_000_000_000, section, readOnly: true, providers: [], provenance: [], errors: [] };
    }
  });
  await harness.load();
  const capability = await harness.ensureThreadCapability("worker-awareness", "/workspace");
  assert.ok(capability);

  const result = await harness.handleAction({ token: capability.token, action: "system.awareness", params: { section: "providers" } });
  assert.equal(requestedSection, "providers");
  assert.equal(requestedThreadId, "worker-awareness");
  assert.equal((result.data?.snapshot as { readOnly?: boolean }).readOnly, true);
  assert.match(result.text, /Mode: read-only/);
  await assert.rejects(() => harness.handleAction({ token: "invalid-token", action: "system.awareness" }), /Invalid harness token/);
  await assert.rejects(() => harness.handleAction({ token: capability.token, action: "system.awareness", params: { section: "secrets" } }), /Unsupported Manor awareness section/);
});

test("harness replaces a malformed capability registry and preserves it for diagnosis", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "manor-harness-corrupt-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const stateDir = path.join(root, "state");
  const registryDir = path.join(root, "harness-state");
  const registryPath = path.join(registryDir, "harness-capabilities.json");
  await mkdir(registryDir, { recursive: true });
  await mkdir(stateDir, { recursive: true });
  await writeFile(path.join(stateDir, "butler-ui.json"), JSON.stringify({ windows: [], focusedWindowId: null }), "utf8");
  await writeFile(registryPath, '{"capabilities":[]} trailing data', "utf8");
  const store = new ButlerStateStore(path.join(stateDir, "butler-ui.json"));
  await store.load();

  const harness = createHarness(root, store, registryPath);
  await harness.load();

  assert.deepEqual(JSON.parse(await readFile(registryPath, "utf8")), { capabilities: [] });
  assert.equal((await readdir(registryDir)).filter((name) => name.startsWith("harness-capabilities.json.corrupt-")).length, 1);
});

test("harness quarantines a valid JSON registry with an invalid shape", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "manor-harness-invalid-shape-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const stateDir = path.join(root, "state");
  const registryDir = path.join(root, "harness-state");
  const registryPath = path.join(registryDir, "harness-capabilities.json");
  await mkdir(registryDir, { recursive: true });
  await mkdir(stateDir, { recursive: true });
  await writeFile(path.join(stateDir, "butler-ui.json"), JSON.stringify({ windows: [], focusedWindowId: null }), "utf8");
  await writeFile(registryPath, "null", "utf8");
  const store = new ButlerStateStore(path.join(stateDir, "butler-ui.json"));
  await store.load();

  await createHarness(root, store, registryPath).load();

  assert.deepEqual(JSON.parse(await readFile(registryPath, "utf8")), { capabilities: [] });
  assert.equal((await readdir(registryDir)).filter((name) => name.startsWith("harness-capabilities.json.corrupt-")).length, 1);
});

test("concurrent capability creation persists one valid complete registry", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "manor-harness-concurrent-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const stateDir = path.join(root, "state");
  const registryPath = path.join(root, "harness-state", "harness-capabilities.json");
  await mkdir(stateDir, { recursive: true });
  await writeFile(path.join(stateDir, "butler-ui.json"), JSON.stringify({ windows: [], focusedWindowId: null }), "utf8");
  const store = new ButlerStateStore(path.join(stateDir, "butler-ui.json"));
  await store.load();
  const harness = createHarness(root, store, registryPath);
  await harness.load();

  await Promise.all(Array.from({ length: 40 }, (_, index) => harness.ensureThreadCapability(`butler:pair-${index}`, "/scratch")));

  const saved = JSON.parse(await readFile(registryPath, "utf8")) as { capabilities: Array<{ threadId: string }> };
  assert.equal(saved.capabilities.length, 40);
  assert.equal(new Set(saved.capabilities.map((entry) => entry.threadId)).size, 40);
});

test("Butler executor capabilities can call only content admission without a Worker record", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "manor-harness-butler-car-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const stateDir = path.join(root, "state");
  await mkdir(stateDir, { recursive: true });
  await writeFile(path.join(stateDir, "butler-ui.json"), JSON.stringify({ windows: [], focusedWindowId: null }), "utf8");
  const store = new ButlerStateStore(path.join(stateDir, "butler-ui.json"));
  await store.load();
  const harness = new HarnessService({
    stateDir,
    artifactsDir: path.join(root, "artifacts"),
    store,
    runtimeBroker: { listStacks: async () => [] } as unknown as RuntimeBrokerClient,
    serviceTemplateRegistry: { list: () => [], get: () => undefined } as unknown as ServiceTemplateRegistry,
    contentAdmission: {
      admit: async () => ({ mode: "review", source: "repository", cacheHit: false, unavailable: false, review: null })
    } as never
  } as never);
  await harness.load();
  const capability = await harness.ensureThreadCapability("butler:pair-1", "/scratch");
  assert.ok(capability);

  const admitted = await harness.handleAction({
    token: capability.token,
    action: "content.admit",
    params: { source: "repository", content: "safe content", metadata: "clone" }
  });

  assert.ok(admitted.data?.admission);
  await assert.rejects(() => harness.handleAction({ token: capability.token, action: "context" }), /unknown thread/i);
});

test("harness reconciliation does not erase existing capabilities when thread inventory is empty", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "manor-harness-reconcile-"));
  const stateDir = path.join(root, "state");
  const harnessRegistryPath = path.join(root, "harness-state", "harness-capabilities.json");
  const registryPath = harnessRegistryPath;
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
  const harness = new HarnessService({
    harnessRegistryPath,
    stateDir,
    artifactsDir: path.join(root, "artifacts"),
    store,
    runtimeBroker: { listStacks: async () => [] } as unknown as RuntimeBrokerClient,
    serviceTemplateRegistry: { list: () => [], get: () => undefined } as unknown as ServiceTemplateRegistry
  });

  await harness.load();
  await harness.reconcileThreadCapabilities();

  const saved = JSON.parse(await readFile(registryPath, "utf8")) as { capabilities?: Array<{ threadId?: string; token?: string }> };
  const access = JSON.parse(await readFile(path.join(stateDir, "harness-broker-access.json"), "utf8")) as { grants?: Array<{ threadId?: string; token?: string }> };
  assert.deepEqual(saved.capabilities?.map((entry) => [entry.threadId, entry.token]), [["thread-1", "token-1"]]);
  assert.deepEqual(access.grants?.map((entry) => [entry.threadId, entry.token]), [["thread-1", "token-1"]]);
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

test("completed reports reject artifact evidence outside the current job manifest", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "manor-harness-report-artifact-"));
  const stateDir = path.join(root, "state");
  const codexHomeDir = path.join(root, "codex-home");
  const artifactsDir = path.join(root, "artifacts");
  const threadId = "thread-report-artifact";
  await mkdir(stateDir, { recursive: true });
  await writeFile(path.join(stateDir, "butler-ui.json"), JSON.stringify({ windows: [], focusedWindowId: null }, null, 2), "utf8");
  const store = new ButlerStateStore(path.join(stateDir, "butler-ui.json"));
  await store.load();
  store.upsertThreadSummary({ id: threadId, cwd: "/workspace", status: "active", source: "codex", turns: [{ id: "turn-1", status: "completed", items: [] }] });
  const contract = buildThreadExecutionContract({
    threadId,
    workspaceCwd: "/workspace",
    projectId: "project",
    projectLabel: "Project",
    branch: null,
    taskText: "Return a durable research report.",
    notes: []
  });
  store.setThreadExecutionContract(threadId, contract);
  const payload = buildJobPayload({ threadId, kind: "delegation", instruction: contract.requestedTask, contract });
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
  const capability = await harness.ensureThreadCapability(threadId, "/workspace");
  assert.ok(capability);

  await assert.rejects(
    harness.handleAction({
      token: capability.token,
      action: "report",
      params: {
        status: "completed",
        summary: "Research complete",
        evidence: [{ kind: "file", summary: "Saved report", artifactId: "another-job-artifact" }]
      }
    }),
    /not registered in the current job attempt manifest/
  );
  assert.equal(store.getWorkerReport(threadId), null);
});

test("completed reports reconcile durable job outputs inside the report lock", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "manor-harness-report-reconcile-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const stateDir = path.join(root, "state");
  const artifactsDir = path.join(root, "artifacts");
  const outputsDir = path.join(root, "outputs");
  const threadId = "thread-report-reconcile";
  await mkdir(stateDir, { recursive: true });
  await writeFile(path.join(stateDir, "butler-ui.json"), JSON.stringify({ windows: [], focusedWindowId: null }), "utf8");
  const store = new ButlerStateStore(path.join(stateDir, "butler-ui.json"));
  await store.load();
  store.upsertThreadSummary({ id: threadId, cwd: "/workspace", status: "active", source: "codex", turns: [{ id: "turn-1", status: "completed", items: [] }] });
  const contract = buildThreadExecutionContract({ threadId, workspaceCwd: "/workspace", projectId: "project", projectLabel: "Project", branch: null, taskText: "Create a durable report.", notes: [] });
  store.setThreadExecutionContract(threadId, contract);
  const payload = buildJobPayload({ threadId, kind: "delegation", instruction: contract.requestedTask, contract });
  const scopedOutputDir = path.join(outputsDir, payload.workspace.outputDir.replace(/^\/outputs\//, ""));
  await mkdir(scopedOutputDir, { recursive: true });
  await writeFile(path.join(scopedOutputDir, "report.md"), "durable report", "utf8");
  await persistJobPayload(jobPayloadsRoot(artifactsDir), payload);
  store.setThreadJobPayload(payload);
  const harness = new CodexHarnessService({
    stateDir,
    artifactsDir,
    store,
    runtimeBroker: { listStacks: async () => [] } as unknown as RuntimeBrokerClient,
    serviceTemplateRegistry: { list: () => [], get: () => undefined } as unknown as ServiceTemplateRegistry,
    inputActionAccess: { outputsDir, fileStore: {}, imageStore: {}, referenceMutations: {} } as never
  } as never);
  await harness.load();
  const capability = await harness.ensureThreadCapability(threadId, "/workspace");
  assert.ok(capability);

  const result = await Promise.race([
    harness.handleAction({ token: capability.token, action: "report", params: { status: "completed", summary: "Report complete" } }),
    new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error("completed report timed out")), 1_000))
  ]);

  assert.match(result.text, /Recorded completed supervisor report/);
  const entry = store.getThreadJobPayload(threadId)?.outputManifest.entries.find((candidate) => candidate.logicalPath === "report.md");
  assert.ok(entry?.artifactId);
  assert.equal(entry.checksumStatus, "verified");
  assert.equal(store.getWorkerReport(threadId)?.status, "completed");
  assert.equal(store.getThreadJobPayload(threadId)?.report?.summary, "Report complete");
  const reportEntry = store.getThreadJobPayload(threadId)?.outputManifest.entries.find((candidate) => candidate.kind === "worker_report");
  assert.equal(reportEntry?.scopeId, payload.protocol.currentScopeId);
});

test("a queued Worker report does not cross into a refreshed job scope", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "manor-harness-report-lock-"));
  const stateDir = path.join(root, "state");
  const codexHomeDir = path.join(root, "codex-home");
  const artifactsDir = path.join(root, "artifacts");
  const threadId = "thread-report-lock";
  await mkdir(stateDir, { recursive: true });
  await writeFile(path.join(stateDir, "butler-ui.json"), JSON.stringify({ windows: [], focusedWindowId: null }, null, 2), "utf8");
  const store = new ButlerStateStore(path.join(stateDir, "butler-ui.json"));
  await store.load();
  store.upsertThreadSummary({ id: threadId, cwd: "/workspace", status: "active", source: "codex", turns: [{ id: "turn-1", status: "completed", items: [] }] });
  const contract = buildThreadExecutionContract({ threadId, workspaceCwd: "/workspace", projectId: "project", projectLabel: "Project", branch: null, taskText: "Wait for the mutation lock.", notes: [] });
  store.setThreadExecutionContract(threadId, contract);
  const payload = buildJobPayload({ threadId, kind: "delegation", instruction: contract.requestedTask, contract });
  await persistJobPayload(jobPayloadsRoot(artifactsDir), payload);
  store.setThreadJobPayload(payload);
  const harness = new CodexHarnessService({ codexHomeDir, stateDir, artifactsDir, store, runtimeBroker: { listStacks: async () => [] } as unknown as RuntimeBrokerClient, serviceTemplateRegistry: { list: () => [], get: () => undefined } as unknown as ServiceTemplateRegistry });
  await harness.load();
  const capability = await harness.ensureThreadCapability(threadId, "/workspace");
  assert.ok(capability);
  let release!: () => void;
  let lockReady!: () => void;
  const ready = new Promise<void>((resolve) => { lockReady = resolve; });
  const held = runSerializedJobMutation(threadId, async () => { lockReady(); await new Promise<void>((resolve) => { release = resolve; }); });
  await ready;
  let settled = false;
  const report = harness.handleAction({ token: capability.token, action: "report", params: { status: "blocked", summary: "Waiting", details: "The shared lock is held; retry after it releases." } }).finally(() => { settled = true; });
  await new Promise((resolve) => setTimeout(resolve, 25));

  assert.equal(settled, false);
  assert.equal(store.getWorkerReport(threadId), null);
  store.refreshCompletedSupervisionChecklistForFollowup(threadId, "New task", { force: true });
  release();
  await held;
  await assert.rejects(report, /Job scope changed while this report was waiting/);
  assert.equal(store.getWorkerReport(threadId), null);
  assert.equal(store.getThreadJobPayload(threadId)?.report, null);
  assert.equal(store.getThread(threadId)?.executionContract?.requestedTask, "New task");
});

test("a queued Worker report does not cross into a newer Worker turn", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "manor-harness-report-turn-"));
  const stateDir = path.join(root, "state");
  const codexHomeDir = path.join(root, "codex-home");
  const artifactsDir = path.join(root, "artifacts");
  const threadId = "thread-report-turn";
  await mkdir(stateDir, { recursive: true });
  await writeFile(path.join(stateDir, "butler-ui.json"), JSON.stringify({ windows: [], focusedWindowId: null }, null, 2), "utf8");
  const store = new ButlerStateStore(path.join(stateDir, "butler-ui.json"));
  await store.load();
  store.upsertThreadSummary({ id: threadId, cwd: "/workspace", status: "active", source: "codex", turns: [{ id: "turn-1", status: "completed", items: [] }] });
  const contract = buildThreadExecutionContract({ threadId, workspaceCwd: "/workspace", projectId: "project", projectLabel: "Project", branch: null, taskText: "Keep reports on their Worker turn.", notes: [] });
  store.setThreadExecutionContract(threadId, contract);
  const payload = buildJobPayload({ threadId, kind: "delegation", instruction: contract.requestedTask, contract });
  await persistJobPayload(jobPayloadsRoot(artifactsDir), payload);
  store.setThreadJobPayload(payload);
  const harness = new CodexHarnessService({ codexHomeDir, stateDir, artifactsDir, store, runtimeBroker: { listStacks: async () => [] } as unknown as RuntimeBrokerClient, serviceTemplateRegistry: { list: () => [], get: () => undefined } as unknown as ServiceTemplateRegistry });
  await harness.load();
  const capability = await harness.ensureThreadCapability(threadId, "/workspace");
  assert.ok(capability);
  const originalScope = store.getThread(threadId)?.supervisionChecklist;
  let release!: () => void;
  let lockReady!: () => void;
  const ready = new Promise<void>((resolve) => { lockReady = resolve; });
  const held = runSerializedJobMutation(threadId, async () => { lockReady(); await new Promise<void>((resolve) => { release = resolve; }); });
  await ready;
  let settled = false;
  const report = harness.handleAction({ token: capability.token, action: "report", params: { status: "blocked", summary: "Old turn report", details: "The earlier Worker turn completed before this newer turn started." } }).finally(() => { settled = true; });
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(settled, false);
  store.upsertThreadSummary({ id: threadId, cwd: "/workspace", status: "active", source: "codex", turns: [{ id: "turn-1", status: "completed", items: [] }, { id: "turn-2", status: "active", items: [] }] });
  assert.equal(store.getThread(threadId)?.supervisionChecklist, originalScope);
  release();
  await held;

  await assert.rejects(report, /Worker turn changed while this report was waiting/);
  assert.equal(store.getWorkerReport(threadId), null);
  assert.equal(store.getThreadJobPayload(threadId)?.report, null);
  await assert.rejects(
    harness.handleAction({ token: capability.token, action: "report", params: { status: "blocked", summary: "Stale explicit report", details: "This report belongs to the earlier Worker turn.", turnId: "turn-1" } }),
    /requested Worker turn is no longer current/
  );
  assert.equal(store.getWorkerReport(threadId), null);
});

test("harness rejects payload writes when the stored protocol targets another worker", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "manor-harness-payload-authority-"));
  const stateDir = path.join(root, "state");
  const codexHomeDir = path.join(root, "codex-home");
  const artifactsDir = path.join(root, "artifacts");
  await mkdir(stateDir, { recursive: true });
  await writeFile(path.join(stateDir, "butler-ui.json"), JSON.stringify({ windows: [], focusedWindowId: null }, null, 2), "utf8");
  const store = new ButlerStateStore(path.join(stateDir, "butler-ui.json"));
  await store.load();
  store.upsertThreadSummary({ id: "thread-bound", cwd: "/workspace", status: "active", source: "codex" });
  const contract = buildThreadExecutionContract({
    threadId: "thread-bound",
    workspaceCwd: "/workspace",
    projectId: "project",
    projectLabel: "Project",
    branch: null,
    taskText: "Respect the bound worker thread.",
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
  await writeFile(
    path.join(jobPayloadsRoot(artifactsDir), contract.threadId, "current.json"),
    JSON.stringify({ ...payload, protocol: { ...payload.protocol, workerThreadId: "thread-other" } }, null, 2),
    "utf8"
  );

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

  await assert.rejects(
    () => harness.handleAction({
      token: capability.token,
      action: "payload.update",
      params: { status: "completed", summary: "Wrong worker" }
    }),
    /not bound to this worker thread/
  );
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
  assert.match(result.text, /Worker shell supports normal source, install, build, test, script, editing, and Git work/);
  assert.match(result.text, /Use a preview when a clean runtime, managed service lifecycle, runtime isolation, or browser proof is useful/);
  assert.doesNotMatch(result.text, /Run all project commands inside a preview/);
  assert.equal((read.data?.payload as { kind?: string } | undefined)?.kind, "assist_context");
});

test("preview browser startup surfaces the consumed CAR notice to Worker", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "manor-harness-browser-car-"));
  const stateDir = path.join(root, "state");
  const artifactsDir = path.join(root, "artifacts");
  await mkdir(stateDir, { recursive: true });
  await writeFile(path.join(stateDir, "butler-ui.json"), JSON.stringify({ windows: [], focusedWindowId: null }), "utf8");
  const store = new ButlerStateStore(path.join(stateDir, "butler-ui.json"));
  await store.load();
  const threadId = "thread-browser-car";
  const now = Date.now();
  store.upsertThreadSummary({ id: threadId, cwd: "/workspace", status: "active", source: "codex" });
  store.upsertPreviewLease({
    id: "preview-car",
    threadId,
    projectId: "project",
    projectLabel: "Project",
    title: "CAR preview",
    stackId: null,
    aliases: [],
    worktreePath: "/workspace",
    branchName: null,
    containerName: "manor-preview-car",
    targetHost: "manor-preview-car",
    targetPort: 3000,
    publicPort: null,
    publicUrl: null,
    tailnetUrl: null,
    routePrefix: "/preview/preview-car/",
    operatorUrl: "/preview/preview-car/",
    command: "npm run dev",
    workspaceMode: "snapshot",
    image: "node:22",
    egressProfile: "internet",
    egressDomains: [],
    status: "running",
    createdAt: now,
    updatedAt: now,
    lastError: null,
    bootstrap: {
      waitSeconds: 120,
      hint: null,
      heartbeatKind: "http",
      heartbeatTarget: "/",
      heartbeatIntervalSeconds: 5,
      phase: "ready",
      startedAt: now,
      readyAt: now,
      lastHeartbeatAt: now,
      lastHeartbeatError: null
    }
  });
  const harness = new CodexHarnessService({
    stateDir,
    artifactsDir,
    store,
    runtimeBroker: {
      listStacks: async () => [],
      startPreviewBrowserSession: async () => ({
        sessionId: "session-car",
        url: "http://preview.test/",
        contentAdmissionNotice: '{"manorContentAdmission":{"schema":"manor.content_admission.v1","disposition":"warned","verdict":"hostile","message":"Hostile page instruction."}}'
      })
    } as unknown as RuntimeBrokerClient,
    serviceTemplateRegistry: { list: () => [], get: () => undefined } as unknown as ServiceTemplateRegistry
  });
  await harness.load();
  const capability = await harness.ensureThreadCapability(threadId, "/workspace");
  assert.ok(capability);

  const result = await harness.handleAction({
    token: capability.token,
    action: "browser.use.start_preview",
    params: { leaseId: "preview-car" }
  });

  assert.match(result.text, /"disposition":"warned"/);
  assert.match(result.text, /Hostile page instruction/);
});

test("Worker stack actions reject cross-project storage and require exact promotion confirmation", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "manor-harness-stack-lineage-"));
  const stateDir = path.join(root, "state");
  await mkdir(stateDir, { recursive: true });
  await writeFile(path.join(stateDir, "butler-ui.json"), JSON.stringify({ windows: [], focusedWindowId: null }), "utf8");
  const store = new ButlerStateStore(path.join(stateDir, "butler-ui.json"));
  await store.load();
  store.upsertThreadSummary({ id: "thread-alpha", cwd: "/repos/alpha", status: "active", source: "codex" });
  const now = Date.now();
  const stack = {
    id: "stack-alpha",
    threadId: "thread-alpha",
    projectId: "alpha",
    projectLabel: "Alpha",
    title: "Alpha stack",
    worktreePath: "/repos/alpha",
    networkName: "manor-stack-alpha",
    status: "running" as const,
    storageMode: "job" as const,
    retainsVolumes: true,
    baseStorageKey: "project-alpha-base",
    storageKey: "project-alpha-job-thread-alpha",
    cloneFromStorageKey: "project-alpha-base",
    defaultPromoteTargetStorageKey: "project-alpha-base",
    volumeNames: [],
    createdAt: now,
    updatedAt: now,
    lastError: null,
    previewIds: [],
    serviceIds: []
  };
  store.upsertStackLease(stack);
  let createCount = 0;
  const promotions: Array<{ stackId: string; targetStorageKey?: string | null }> = [];
  const runtimeBroker = {
    listStacks: async () => [],
    createStack: async () => {
      createCount += 1;
      return stack;
    },
    promoteStack: async (input: { stackId: string; targetStorageKey?: string | null }) => {
      promotions.push(input);
      return {
        ok: true as const,
        stackId: input.stackId,
        sourceStorageKey: stack.storageKey,
        targetStorageKey: input.targetStorageKey ?? "",
        promotedVolumes: []
      };
    },
    inspectStack: async () => stack
  } as unknown as RuntimeBrokerClient;
  const harness = new HarnessService({
    stateDir,
    artifactsDir: path.join(root, "artifacts"),
    store,
    runtimeBroker,
    serviceTemplateRegistry: { list: () => [], get: () => undefined } as unknown as ServiceTemplateRegistry
  });
  await harness.load();
  const capability = await harness.ensureThreadCapability("thread-alpha", "/repos/alpha");
  assert.ok(capability);

  await assert.rejects(
    () => harness.handleAction({
      token: capability.token,
      action: "stack.start_stateful",
      params: { title: "Guessed stack", storageKey: "project-beta-job-thread-beta" }
    }),
    /storageKey is outside the resolved project storage namespace/
  );
  await assert.rejects(
    () => harness.handleAction({
      token: capability.token,
      action: "stack.start_stateful",
      params: { title: "Cloned stack", cloneFromStorageKey: "project-beta-base" }
    }),
    /cloneFromStorageKey is outside the resolved project storage namespace/
  );
  await assert.rejects(
    () => harness.handleAction({
      token: capability.token,
      action: "stack.promote",
      params: {
        stackId: stack.id,
        targetStorageKey: "project-beta-base",
        confirmTargetStorageKey: "project-beta-base"
      }
    }),
    /outside this stack's project storage lineage/
  );
  await assert.rejects(
    () => harness.handleAction({
      token: capability.token,
      action: "stack.promote",
      params: {
        stackId: stack.id,
        targetStorageKey: stack.baseStorageKey,
        confirmTargetStorageKey: "wrong-key"
      }
    }),
    /must exactly match/
  );
  await harness.handleAction({
    token: capability.token,
    action: "stack.promote",
    params: {
      stackId: stack.id,
      targetStorageKey: stack.baseStorageKey,
      confirmTargetStorageKey: stack.baseStorageKey
    }
  });

  assert.equal(createCount, 0);
  assert.deepEqual(promotions, [{ stackId: stack.id, targetStorageKey: stack.baseStorageKey }]);
});
