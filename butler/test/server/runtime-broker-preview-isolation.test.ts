import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import express from "express";
import { createBrokerBrowserController } from "../../../docker/runtime-broker/broker-browser.mjs";
import { createBrokerCore } from "../../../docker/runtime-broker/broker-core.mjs";
import { createBrokerJsonParserMiddleware } from "../../../docker/runtime-broker/broker-http.mjs";
import {
  createBrokerRuntime,
  resolveHttpHeartbeatUrl,
  resolveTcpHeartbeatTarget
} from "../../../docker/runtime-broker/broker-runtime.mjs";
import { createBrokerStorage } from "../../../docker/runtime-broker/broker-storage.mjs";

test("preview browser targets cannot escape the selected preview", () => {
  const controller = createBrokerBrowserController({
    previewNetwork: "preview",
    sharedWorkNetwork: "shared",
    normalizeString: (value: unknown) => (typeof value === "string" ? value.trim() : ""),
    resolveTargetHost: () => "preview-host"
  });
  const input = {
    leaseId: "preview-1",
    containerName: "manor-preview-1",
    aliases: ["preview-app"],
    targetPort: 3000,
    container: {
      NetworkSettings: {
        Networks: {
          shared: { IPAddress: "10.0.0.12" }
        }
      }
    }
  };

  assert.equal(
    controller.resolvePreviewBrowserTarget({
      ...input,
      requestedTargetUrl: "http://localhost/preview/preview-1/dashboard?tab=run"
    }).targetUrl,
    "http://10.0.0.12:3000/dashboard?tab=run"
  );
  assert.equal(
    controller.resolvePreviewBrowserTarget({
      ...input,
      requestedTargetUrl: "http://preview-app:3000/dashboard"
    }).targetUrl,
    "http://preview-app:3000/dashboard"
  );
  assert.throws(
    () => controller.resolvePreviewBrowserTarget({ ...input, requestedTargetUrl: "https://example.com/" }),
    /does not belong to preview preview-1/
  );
  assert.throws(
    () => controller.resolvePreviewBrowserTarget({ ...input, requestedTargetUrl: "http://preview-app:4000/" }),
    /does not belong to preview preview-1/
  );
  assert.throws(
    () => controller.resolvePreviewBrowserTarget({ ...input, requestedTargetUrl: "http://localhost/preview/preview-2/" }),
    /points to preview preview-2/
  );
});

test("runtime broker rejects shared preview workspace mode", (t) => {
  const egressConfigPath = path.join(os.tmpdir(), `manor-egress-${process.pid}-${Date.now()}.json`);
  fs.writeFileSync(egressConfigPath, '{"profiles":[]}\n', "utf8");
  t.after(() => {
    fs.rmSync(egressConfigPath, { force: true });
  });

  const broker = createBrokerCore({
    previewImage: "node:22",
    previewEgressConfigPath: egressConfigPath,
    routeBase: "/preview"
  });

  assert.throws(
    () =>
      broker.buildLease({
        leaseId: "lease-preview-isolation",
        title: "Preview isolation",
        worktreePath: "/repos/example",
        command: "npm run dev",
        targetPort: 3000,
        workspaceMode: "shared"
      }),
    /shared previews are no longer supported/
  );
});

test("runtime broker creates snapshot preview leases by contract", (t) => {
  const egressConfigPath = path.join(os.tmpdir(), `manor-egress-${process.pid}-${Date.now()}.json`);
  fs.writeFileSync(egressConfigPath, '{"profiles":[]}\n', "utf8");
  t.after(() => {
    fs.rmSync(egressConfigPath, { force: true });
  });

  const broker = createBrokerCore({
    previewImage: "node:22",
    previewEgressConfigPath: egressConfigPath,
    routeBase: "/preview"
  });

  const lease = broker.buildLease({
    leaseId: "lease-preview-isolation",
    title: "Preview isolation",
    worktreePath: "/repos/example",
    command: "npm run dev",
    targetPort: 3000,
    workspaceMode: "snapshot"
  });

  assert.equal(lease.workspaceMode, "snapshot");
  assert.equal(lease.publicPort, null);
  assert.equal(lease.publicUrl, null);
  assert.equal(lease.operatorUrl, "/preview/lease-preview-isolation/");
});

test("runtime broker exposes ordered preview bootstrap lifecycle events", (t) => {
  const egressConfigPath = path.join(os.tmpdir(), `manor-egress-${process.pid}-${Date.now()}.json`);
  const lifecycleStatePath = path.join(os.tmpdir(), `manor-preview-lifecycle-${process.pid}-${Date.now()}.json`);
  fs.writeFileSync(egressConfigPath, '{"profiles":[]}\n', "utf8");
  t.after(() => {
    fs.rmSync(egressConfigPath, { force: true });
    fs.rmSync(lifecycleStatePath, { force: true });
  });
  const leaseBootstrapStates = new Map();
  const broker = createBrokerCore({
    previewImage: "node:22",
    previewEgressConfigPath: egressConfigPath,
    routeBase: "/preview",
    previewLifecycleStatePath: lifecycleStatePath,
    leaseBootstrapStates,
    retainedPreviewLeases: new Map(),
    leaseTransitions: new Map()
  });

  const initial = broker.buildBootstrapConfig({ bootstrapWaitSeconds: 30 }, 3000);
  broker.setLeaseBootstrapState("preview-events", initial);
  broker.mergeLeaseBootstrapState("preview-events", { phase: "starting_container" });
  broker.mergeLeaseBootstrapState("preview-events", {
    phase: "waiting_for_heartbeat",
    lastHeartbeatAt: Date.now(),
    lastHeartbeatError: "connect ECONNREFUSED"
  });
  broker.mergeLeaseBootstrapState("preview-events", {
    phase: "ready",
    readyAt: Date.now(),
    lastHeartbeatAt: Date.now(),
    lastHeartbeatError: null
  });

  const lifecycle = broker.serializeBootstrapState(broker.getLeaseBootstrapState("preview-events", {}, 3000, "running", true));
  assert.equal(lifecycle.phase, "ready");
  assert.equal(lifecycle.heartbeatAttempt, 1);
  assert.equal(lifecycle.events.length, 4);
  assert.deepEqual(lifecycle.events.map((event) => event.sequence), [1, 2, 3, 4]);
  assert.match(lifecycle.events[2].message, /ECONNREFUSED/);
  assert.equal(lifecycle.events[3].message, "Preview is ready.");
  assert.ok(lifecycle.deadlineAt > lifecycle.events[0].at);

  const reloaded = createBrokerCore({
    previewImage: "node:22",
    previewEgressConfigPath: egressConfigPath,
    routeBase: "/preview",
    previewLifecycleStatePath: lifecycleStatePath,
    leaseBootstrapStates: new Map(),
    retainedPreviewLeases: new Map(),
    leaseTransitions: new Map()
  });
  const durable = reloaded.getLeaseBootstrapState("preview-events", {}, 3000, "running", true);
  assert.equal(durable.phase, "ready");
  assert.equal(durable.events.length, 4);
});

test("runtime broker rejects cross-project stack storage keys before resource creation", (t) => {
  const egressConfigPath = path.join(os.tmpdir(), `manor-egress-${process.pid}-${Date.now()}.json`);
  fs.writeFileSync(egressConfigPath, '{"profiles":[]}\n', "utf8");
  t.after(() => fs.rmSync(egressConfigPath, { force: true }));
  const broker = createBrokerCore({ previewImage: "node:22", previewEgressConfigPath: egressConfigPath, routeBase: "/preview" });
  const input = {
    stackId: "stack-alpha",
    threadId: "thread-alpha",
    projectId: "alpha",
    projectLabel: "Alpha",
    worktreePath: "/repos/alpha",
    title: "Alpha stack",
    storageMode: "job"
  };

  assert.throws(
    () => broker.buildStack({ ...input, storageKey: "project-beta-job-thread-beta" }),
    /storageKey is outside the resolved project storage namespace/
  );
  assert.throws(
    () => broker.buildStack({ ...input, cloneFromStorageKey: "project-beta-base" }),
    /cloneFromStorageKey is outside the resolved project storage namespace/
  );
  const stack = broker.buildStack({ ...input, storageKey: "project-alpha-job-thread-alpha" });
  assert.equal(stack.projectId, "alpha");
  assert.equal(stack.storageKey, "project-alpha-job-thread-alpha");
});

test("runtime broker TCP heartbeat defaults to the preview container target", (t) => {
  const egressConfigPath = path.join(os.tmpdir(), `manor-egress-${process.pid}-${Date.now()}.json`);
  fs.writeFileSync(egressConfigPath, '{"profiles":[]}\n', "utf8");
  t.after(() => {
    fs.rmSync(egressConfigPath, { force: true });
  });

  const broker = createBrokerCore({
    previewImage: "node:22",
    previewEgressConfigPath: egressConfigPath,
    routeBase: "/preview"
  });
  const lease = broker.buildLease({
    leaseId: "lease-tcp-heartbeat",
    worktreePath: "/repos/example",
    command: "node tcp-server.js",
    targetPort: 3101,
    heartbeatKind: "tcp"
  });

  assert.equal(lease.bootstrap.heartbeatTarget, null);
  assert.equal(broker.bootstrapConfigFromLabels({ "manor.bootstrap-heartbeat-kind": "tcp" }, 3101).heartbeatTarget, null);
});

test("runtime broker treats loopback heartbeat targets as preview-container addresses", () => {
  const lease = {
    containerName: "manor-preview-preview-1",
    targetPort: 8080
  };

  assert.equal(resolveHttpHeartbeatUrl(lease, "/health").href, "http://manor-preview-preview-1:8080/health");
  assert.equal(
    resolveHttpHeartbeatUrl(lease, "http://127.0.0.1:8080/health").href,
    "http://manor-preview-preview-1:8080/health"
  );
  assert.equal(
    resolveHttpHeartbeatUrl(lease, "http://localhost/ready").href,
    "http://manor-preview-preview-1:8080/ready"
  );
  assert.equal(
    resolveHttpHeartbeatUrl(lease, "https://health.example.com/ready").href,
    "https://health.example.com/ready"
  );
  assert.deepEqual(resolveTcpHeartbeatTarget(lease, "127.0.0.1:8080"), {
    host: "manor-preview-preview-1",
    port: 8080
  });
  assert.deepEqual(resolveTcpHeartbeatTarget(lease, "db.internal:5432"), {
    host: "db.internal",
    port: 5432
  });
});

test("runtime broker decodes Docker multiplexed log frames", (t) => {
  const egressConfigPath = path.join(os.tmpdir(), `manor-egress-${process.pid}-${Date.now()}.json`);
  fs.writeFileSync(egressConfigPath, '{"profiles":[]}\n', "utf8");
  t.after(() => {
    fs.rmSync(egressConfigPath, { force: true });
  });

  const broker = createBrokerCore({
    previewImage: "node:22",
    previewEgressConfigPath: egressConfigPath,
    routeBase: "/preview"
  });
  const stdout = Buffer.from("ready on 3000\n");
  const stderr = Buffer.from("warning line\n");
  const frame = (streamType: number, payload: Buffer) => {
    const header = Buffer.alloc(8);
    header[0] = streamType;
    header.writeUInt32BE(payload.length, 4);
    return Buffer.concat([header, payload]);
  };

  assert.equal(broker.decodeDockerLogPayload(Buffer.concat([frame(1, stdout), frame(2, stderr)])), "ready on 3000\nwarning line\n");
  assert.equal(broker.decodeDockerLogPayload(Buffer.from("plain log\n")), "plain log\n");
});

test("runtime broker reports exact diagnostics when a ready preview exits", async (t) => {
  const egressConfigPath = path.join(os.tmpdir(), `manor-egress-${process.pid}-${Date.now()}.json`);
  fs.writeFileSync(egressConfigPath, '{"profiles":[]}\n', "utf8");
  t.after(() => fs.rmSync(egressConfigPath, { force: true }));

  const context = {
    previewImage: "node:22",
    previewEgressConfigPath: egressConfigPath,
    routeBase: "/preview",
    leaseTransitions: new Map(),
    leaseBootstrapStates: new Map(),
    activeLeaseBootstrapMonitors: new Set(),
    pendingPreviewLeases: new Map(),
    retainedPreviewLeases: new Map()
  };
  const core = createBrokerCore(context);
  core.setLeaseBootstrapState("preview-1", {
    waitSeconds: 120,
    hint: null,
    heartbeatKind: "none",
    heartbeatTarget: null,
    heartbeatIntervalSeconds: 5,
    phase: "ready",
    startedAt: Date.parse("2026-07-12T06:00:00.000Z"),
    readyAt: Date.parse("2026-07-12T06:00:02.000Z"),
    lastHeartbeatAt: Date.parse("2026-07-12T06:00:02.000Z"),
    lastHeartbeatError: null
  });
  const runtime = createBrokerRuntime(context, {
    ...core,
    collectExecOutput: async () => ({ exitCode: 0, stdout: "", stderr: "" })
  });
  const finishedAt = "2026-07-12T06:30:00.000Z";
  const lease = await runtime.serializeInspectedLease("manor-preview-preview-1", {
    Created: "2026-07-12T06:00:00.000Z",
    Config: {
      Labels: {
        "manor.lease-id": "preview-1",
        "manor.thread-id": "thread-1",
        "manor.project-id": "project",
        "manor.project-label": "Project",
        "manor.title": "Broken preview",
        "manor.branch-name": "feature/preview",
        "manor.target-port": "3000"
      },
      WorkingDir: "/repos/project",
      Cmd: ["npm", "start"],
      Env: ["PORT=3000"],
      Image: "node:22"
    },
    State: {
      Running: false,
      Status: "exited",
      StartedAt: "2026-07-12T06:00:01.000Z",
      FinishedAt: finishedAt,
      ExitCode: 137,
      OOMKilled: true,
      Error: "container process was killed"
    }
  });

  assert.equal(lease.status, "failed");
  assert.equal(lease.branchName, "feature/preview");
  assert.equal(lease.bootstrap.phase, "ready");
  assert.deepEqual(lease.runtime, {
    running: false,
    status: "exited",
    startedAt: Date.parse("2026-07-12T06:00:01.000Z"),
    finishedAt: Date.parse(finishedAt),
    exitCode: 137,
    oomKilled: true,
    error: "container process was killed"
  });
  assert.match(lease.lastError, /exitCode=137/);
  assert.match(lease.lastError, /oomKilled=true/);
  assert.match(lease.lastError, /error=container process was killed/);
  assert.match(lease.lastError, /finishedAt=2026-07-12T06:30:00.000Z/);

  core.retainPreviewLease(lease, { ...lease.runtime, error: null });
  const retained = context.retainedPreviewLeases.get("preview-1");
  assert.equal(retained.runtime.finishedAt, Date.parse(finishedAt));
  assert.equal(retained.runtime.exitCode, 137);
  assert.equal(retained.runtime.oomKilled, true);
  assert.equal(retained.runtime.error, null);
});

test("runtime broker retains accurate live runtime state for bootstrap failures", (t) => {
  const egressConfigPath = path.join(os.tmpdir(), `manor-egress-${process.pid}-${Date.now()}.json`);
  fs.writeFileSync(egressConfigPath, '{"profiles":[]}\n', "utf8");
  t.after(() => fs.rmSync(egressConfigPath, { force: true }));
  const context = {
    previewImage: "node:22",
    previewEgressConfigPath: egressConfigPath,
    routeBase: "/preview",
    leaseTransitions: new Map(),
    leaseBootstrapStates: new Map(),
    activeLeaseBootstrapMonitors: new Set(),
    pendingPreviewLeases: new Map(),
    retainedPreviewLeases: new Map()
  };
  const core = createBrokerCore(context);

  core.retainFailedLease(
    { id: "preview-live", status: "failed", lastError: "Bootstrap timed out." },
    "Bootstrap timed out.",
    {
      running: true,
      status: "running",
      startedAt: 100,
      finishedAt: null,
      exitCode: 0,
      oomKilled: false,
      error: null
    }
  );

  const retained = context.retainedPreviewLeases.get("preview-live");
  assert.equal(retained.runtime.running, true);
  assert.equal(retained.runtime.status, "running");
  assert.equal(retained.runtime.finishedAt, null);
});

test("a foreign harness token cannot probe retained failed preview diagnostics", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "manor-runtime-auth-"));
  const accessPath = path.join(dir, "harness-access.json");
  const egressPath = path.join(dir, "preview-egress.json");
  fs.writeFileSync(accessPath, JSON.stringify({ grants: [{ token: "attacker-token", threadId: "thread-attacker" }] }), "utf8");
  fs.writeFileSync(egressPath, JSON.stringify({ profiles: [] }), "utf8");
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const context = {
    brokerToken: "broker-admin-token",
    previewEgressConfigPath: egressPath,
    harnessAccessRegistryPath: accessPath,
    legacyHarnessAccessRegistryPath: null,
    docker: {
      getContainer(name: string) {
        return {
          inspect: async () => {
            if (name === "manor-service-service-secret") {
              return {
                Config: { Labels: { "manor.thread-id": "thread-victim", "manor.stack-id": "" } }
              };
            }
            throw new Error("not found");
          }
        };
      }
    },
    leaseTransitions: new Map(),
    leaseBootstrapStates: new Map(),
    activeLeaseBootstrapMonitors: new Set(),
    pendingPreviewLeases: new Map(),
    retainedPreviewLeases: new Map()
  };
  const broker = createBrokerCore(context);
  broker.retainFailedLease({
    id: "preview-secret",
    threadId: "thread-victim",
    stackId: null,
    status: "failed",
    lastError: "secret bootstrap failure"
  }, "secret bootstrap failure", {
    running: false,
    status: "exited",
    exitCode: 41,
    error: "secret runtime detail"
  });
  const response = {
    statusCode: 200,
    payload: null as unknown,
    status(code: number) { this.statusCode = code; return this; },
    json(payload: unknown) { this.payload = payload; return this; }
  };
  const request = {
    header(name: string) {
      return name === "x-manor-harness-token" ? "attacker-token" : undefined;
    }
  };

  const resource = await broker.requireAuthorizedPreviewResource(request, response, "preview-secret");

  assert.equal(resource, null);
  assert.equal(response.statusCode, 403);
  assert.deepEqual(response.payload, { error: "Lease is not attached to this worker job" });
  assert.doesNotMatch(JSON.stringify(response.payload), /secret bootstrap failure|secret runtime detail|exitCode|41/);

  response.statusCode = 200;
  response.payload = null;
  const service = await broker.requireAuthorizedServiceResource(request, response, "service-secret");
  assert.equal(service, null);
  assert.equal(response.statusCode, 403);
  assert.deepEqual(response.payload, { error: "Lease is not attached to this worker job" });
  const source = fs.readFileSync(path.resolve(import.meta.dirname, "../../../docker/runtime-broker/broker.mjs"), "utf8");
  const processesStart = source.indexOf('app.get("/leases/:leaseId/processes"');
  const logsStart = source.indexOf('app.get("/leases/:leaseId/logs"');
  const execStart = source.indexOf('app.post("/leases/:leaseId/exec"');
  const deleteStart = source.indexOf('app.delete("/leases/:leaseId"');
  for (const route of [
    source.slice(processesStart, logsStart),
    source.slice(execStart, deleteStart)
  ]) {
    assert.ok(route.indexOf("requireAuthorizedPreviewResource") < route.indexOf("rejectIfLeaseRetainedFailed"));
  }
  const stackGetStart = source.indexOf('app.get("/stacks/:stackId"');
  const stackAdoptStart = source.indexOf('app.post("/stacks/:stackId/adopt"');
  const stackGetRoute = source.slice(stackGetStart, stackAdoptStart);
  assert.doesNotMatch(stackGetRoute, /requireStackNetwork/);
  assert.ok(stackGetRoute.indexOf("findStackNetwork") < stackGetRoute.indexOf("authorizeScopedThread"));
  assert.ok(stackGetRoute.indexOf("authorizeScopedThread") < stackGetRoute.indexOf('response.status(404)'));
  const serviceSource = fs.readFileSync(path.resolve(import.meta.dirname, "../../../docker/runtime-broker/broker-services.mjs"), "utf8");
  assert.equal(serviceSource.match(/requireAuthorizedServiceResource\(request, response, request\.params\.serviceId\)/g)?.length, 4);
  assert.doesNotMatch(serviceSource, /requireServiceContainer/);
});

test("runtime broker keeps preview cancellation visible until creation and bootstrap monitoring finish", async (t) => {
  const egressConfigPath = path.join(os.tmpdir(), `manor-egress-${process.pid}-${Date.now()}.json`);
  fs.writeFileSync(egressConfigPath, '{"profiles":[]}\n', "utf8");
  t.after(() => fs.rmSync(egressConfigPath, { force: true }));
  const context = {
    previewImage: "node:22",
    previewEgressConfigPath: egressConfigPath,
    routeBase: "/preview",
    leaseTransitions: new Map(),
    leaseBootstrapStates: new Map(),
    activeLeaseBootstrapMonitors: new Set(),
    pendingPreviewLeases: new Map(),
    retainedPreviewLeases: new Map()
  };
  const core = createBrokerCore(context);
  const lease = {
    id: "preview-cancelled",
    containerName: "manor-preview-preview-cancelled",
    bootstrap: {
      waitSeconds: 10,
      hint: null,
      heartbeatKind: "none",
      heartbeatTarget: null,
      heartbeatIntervalSeconds: 1
    }
  };
  context.pendingPreviewLeases.set(lease.id, lease);
  core.setLeaseTransition(lease.id, "stopping");
  assert.equal(core.clearLeaseTransitionIfIdle(lease.id), false);
  assert.equal(core.getLeaseTransition(lease.id)?.state, "stopping");

  context.pendingPreviewLeases.delete(lease.id);
  context.activeLeaseBootstrapMonitors.add(lease.id);
  assert.equal(core.clearLeaseTransitionIfIdle(lease.id), false);
  context.activeLeaseBootstrapMonitors.delete(lease.id);

  const runtime = createBrokerRuntime(context, {
    ...core,
    collectExecOutput: async () => ({ exitCode: 0, stdout: "", stderr: "" })
  });
  await runtime.monitorLeaseBootstrap(lease);
  assert.equal(context.retainedPreviewLeases.size, 0);
  assert.equal(core.clearLeaseTransitionIfIdle(lease.id), true);
  assert.equal(core.getLeaseTransition(lease.id), null);

  const source = fs.readFileSync(path.resolve(import.meta.dirname, "../../../docker/runtime-broker/broker.mjs"), "utf8");
  const createStart = source.indexOf('app.post("/leases"');
  const createEnd = source.indexOf('app.get("/leases"');
  const createRoute = source.slice(createStart, createEnd);
  assert.ok((createRoute.match(/throwIfPreviewCreationCancelled/g) ?? []).length >= 5);
});

test("runtime broker resolves exec cwd inside the container", (t) => {
  const egressConfigPath = path.join(os.tmpdir(), `manor-egress-${process.pid}-${Date.now()}.json`);
  fs.writeFileSync(egressConfigPath, '{"profiles":[]}\n', "utf8");
  t.after(() => {
    fs.rmSync(egressConfigPath, { force: true });
  });

  const broker = createBrokerCore({
    previewImage: "node:22",
    previewEgressConfigPath: egressConfigPath,
    routeBase: "/preview"
  });
  const previewContainer = {
    Config: {
      WorkingDir: "/tmp",
      Labels: {
        "manor.worktree-source-path": "/repos/project",
        "manor.worktree-runtime-path": "/tmp/manor-preview-workspaces/preview-1"
      }
    }
  };
  const serviceContainer = {
    Config: {
      WorkingDir: "/data"
    }
  };

  assert.equal(
    broker.resolveContainerExecWorkingDir(previewContainer, "apps/demo"),
    "/tmp/manor-preview-workspaces/preview-1/apps/demo"
  );
  assert.equal(
    broker.resolveContainerExecWorkingDir(previewContainer, "/tmp/manor-preview-workspaces/preview-1/apps/demo"),
    "/tmp/manor-preview-workspaces/preview-1/apps/demo"
  );
  assert.equal(
    broker.resolveContainerExecWorkingDir(previewContainer, "/repos/project/apps/demo"),
    "/tmp/manor-preview-workspaces/preview-1/apps/demo"
  );
  assert.equal(
    broker.resolveContainerExecWorkingDir(previewContainer, "/outputs/thread-1"),
    "/outputs/thread-1"
  );
  assert.equal(broker.resolveContainerExecWorkingDir(serviceContainer, "redis"), "/data/redis");
  assert.equal(broker.resolveContainerExecWorkingDir({ Config: {} }, "tmp"), "/tmp");
  assert.equal(
    broker.resolveContainerExecWorkingDir(previewContainer, ""),
    "/tmp/manor-preview-workspaces/preview-1"
  );
});

test("runtime broker shell quoting preserves command variables for nested snapshot shells", (t) => {
  const egressConfigPath = path.join(os.tmpdir(), `manor-egress-${process.pid}-${Date.now()}.json`);
  fs.writeFileSync(egressConfigPath, '{"profiles":[]}\n', "utf8");
  t.after(() => {
    fs.rmSync(egressConfigPath, { force: true });
  });

  const broker = createBrokerCore({
    previewImage: "node:22",
    previewEgressConfigPath: egressConfigPath,
    routeBase: "/preview"
  });
  const command = 'printf "%s" "$result"';
  const evaluated = spawnSync("sh", ["-uc", `printf '%s' ${broker.shellQuote(command)}`], {
    encoding: "utf8"
  });

  assert.equal(evaluated.status, 0);
  assert.equal(evaluated.stdout, command);
});

test("runtime broker creates a fresh snapshot without deleting a pre-existing destination", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "manor-preview-bootstrap-"));
  const source = path.join(root, "source");
  const destination = path.join(root, "runtime", "preview-1");
  const marker = path.join(root, "operator-command-ran");
  const egressConfigPath = path.join(root, "preview-egress.json");
  fs.mkdirSync(source);
  fs.writeFileSync(path.join(source, "package.json"), '{"name":"preview-smoke"}\n', "utf8");
  fs.writeFileSync(egressConfigPath, '{"profiles":[]}\n', "utf8");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const broker = createBrokerCore({ routeBase: "/preview", previewEgressConfigPath: egressConfigPath });
  const command = broker.buildSnapshotWorkspaceCommand(
    source,
    destination,
    `test -f package.json && printf ready > ${broker.shellQuote(marker)}`
  );
  const first = spawnSync("sh", ["-lc", command], { encoding: "utf8", cwd: os.tmpdir() });
  assert.equal(first.status, 0, first.stderr);
  assert.equal(fs.readFileSync(marker, "utf8"), "ready");

  fs.rmSync(marker);
  const second = spawnSync("sh", ["-lc", command], { encoding: "utf8", cwd: os.tmpdir() });
  assert.notEqual(second.status, 0);
  assert.equal(fs.existsSync(marker), false);
  assert.equal(fs.readFileSync(path.join(destination, "package.json"), "utf8"), '{"name":"preview-smoke"}\n');

  fs.rmSync(destination, { recursive: true });
  const symlinkTarget = path.join(root, "symlink-target");
  fs.mkdirSync(symlinkTarget);
  fs.symlinkSync(symlinkTarget, destination, "dir");
  const symlinked = spawnSync("sh", ["-lc", command], { encoding: "utf8", cwd: os.tmpdir() });
  assert.notEqual(symlinked.status, 0);
  assert.equal(fs.existsSync(marker), false);
  assert.deepEqual(fs.readdirSync(symlinkTarget), []);
});

test("runtime broker starts preview containers before attaching outbound network", () => {
  const source = fs.readFileSync(path.resolve(import.meta.dirname, "../../../docker/runtime-broker/broker.mjs"), "utf8");
  const startIndex = source.indexOf("await runtimeContainer.start();");
  const outboundIndex = source.indexOf("await ensureNetworkConnection(previewOutboundNetwork, lease.containerName);");

  assert.notEqual(startIndex, -1);
  assert.notEqual(outboundIndex, -1);
  assert.ok(startIndex < outboundIndex);
});

test("runtime broker retains exited preview containers and keeps their logs readable", () => {
  const source = fs.readFileSync(path.resolve(import.meta.dirname, "../../../docker/runtime-broker/broker.mjs"), "utf8");
  const createStart = source.indexOf("const runtimeContainer = await docker.createContainer({");
  const createEnd = source.indexOf("await runtimeContainer.start();", createStart);
  const logsStart = source.indexOf('app.get("/leases/:leaseId/logs"');
  const logsEnd = source.indexOf('app.post("/leases/:leaseId/exec"', logsStart);

  assert.notEqual(createStart, -1);
  assert.notEqual(createEnd, -1);
  assert.match(source.slice(createStart, createEnd), /AutoRemove: false/);
  assert.notEqual(logsStart, -1);
  assert.notEqual(logsEnd, -1);
  assert.doesNotMatch(source.slice(logsStart, logsEnd), /rejectIfLeaseUnavailable|rejectIfLeaseRetainedFailed/);
  assert.match(source.slice(createStart, createEnd), /"manor\.branch-name": lease\.branchName/);
});

test("runtime broker can resolve source workspace mounts as read-only", async () => {
  const docker = {
    getContainer(name: string) {
      assert.equal(name, "worker-host");
      return {
        async inspect() {
          return {
            Mounts: [
              {
                Type: "volume",
                Name: "manor_repos",
                Destination: "/repos",
                RW: true
              },
              {
                Type: "bind",
                Source: "/tmp/ignored",
                Destination: "/tmp/ignored",
                RW: true
              },
              {
                Type: "volume",
                Name: "manor_inputs",
                Destination: "/inputs",
                RW: false
              },
              {
                Type: "volume",
                Name: "manor_outputs",
                Destination: "/outputs",
                RW: true
              }
            ]
          };
        }
      };
    }
  };
  const prepared: string[] = [];
  const storage = createBrokerStorage({ workspaceContainerName: "worker-host", docker }, {
    prepareWorkspaceOutputSubpath: async (outputSubpath: string) => prepared.push(outputSubpath)
  });

  await assert.rejects(storage.resolveWorkspaceMounts(), /safe outputSubpath/);
  assert.deepEqual(await storage.resolveWorkspaceMounts({ outputSubpath: "thread-1" }), [
    {
      Type: "volume",
      Source: "manor_repos",
      Target: "/repos",
      ReadOnly: false
    },
    {
      Type: "volume",
      Source: "manor_inputs",
      Target: "/inputs",
      ReadOnly: true
    },
    {
      Type: "volume",
      Source: "manor_outputs",
      Target: "/outputs/thread-1",
      ReadOnly: false,
      VolumeOptions: { Subpath: "thread-1" }
    }
  ]);
  assert.deepEqual(await storage.resolveWorkspaceMounts({ readOnly: true, outputSubpath: "thread-2" }), [
    {
      Type: "volume",
      Source: "manor_repos",
      Target: "/repos",
      ReadOnly: true
    },
    {
      Type: "volume",
      Source: "manor_inputs",
      Target: "/inputs",
      ReadOnly: true
    },
    {
      Type: "volume",
      Source: "manor_outputs",
      Target: "/outputs/thread-2",
      ReadOnly: false,
      VolumeOptions: { Subpath: "thread-2" }
    }
  ]);
  assert.deepEqual(prepared, ["thread-1", "thread-2"]);
});

test("runtime broker accepts only neutral harness token headers", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "manor-harness-access-"));
  const registryPath = path.join(root, "harness-broker-access.json");
  const egressConfigPath = path.join(root, "preview-egress.json");
  fs.writeFileSync(egressConfigPath, '{"profiles":[]}\n', "utf8");
  fs.writeFileSync(registryPath, JSON.stringify({
    grants: [{ token: "worker-token", threadId: "thread-1" }]
  }), "utf8");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const broker = createBrokerCore({
    brokerToken: "operator-token",
    harnessAccessRegistryPath: registryPath,
    previewEgressConfigPath: egressConfigPath
  });
  const response = () => ({
    statusCode: 200,
    body: null as unknown,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: unknown) {
      this.body = payload;
      return this;
    }
  });
  const request = (headers: Record<string, string>) => ({
    header(name: string) {
      return headers[name] || "";
    }
  });

  assert.equal(broker.authorizeScopedThread(request({ "x-manor-harness-token": "worker-token" }), response(), "thread-1"), true);
  assert.equal(broker.authorizeScopedThread(request({ "x-manor-codex-token": "worker-token" }), response(), "thread-1"), false);
  const rejected = response();
  assert.equal(broker.authorizeScopedThread(request({ "x-manor-harness-token": "worker-token" }), rejected, "thread-2"), false);
  assert.deepEqual(rejected.body, { error: "Lease is not attached to this worker job" });
});

test("runtime broker ignores retired access registries", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "manor-legacy-harness-access-"));
  const registryPath = path.join(root, "harness-broker-access.json");
  const legacyRegistryPath = path.join(root, "codex-broker-access.json");
  const egressConfigPath = path.join(root, "preview-egress.json");
  fs.writeFileSync(egressConfigPath, '{"profiles":[]}\n', "utf8");
  fs.writeFileSync(legacyRegistryPath, JSON.stringify({
    grants: [{ token: "legacy-token", threadId: "thread-1" }]
  }), "utf8");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const broker = createBrokerCore({
    brokerToken: "operator-token",
    harnessAccessRegistryPath: registryPath,
    legacyHarnessAccessRegistryPath: legacyRegistryPath,
    previewEgressConfigPath: egressConfigPath
  });
  const request = {
    header(name: string) {
      return name === "x-manor-harness-token" ? "legacy-token" : "";
    }
  };
  const response = {
    status() { return this; },
    json() { return this; }
  };

  assert.equal(broker.authorizeScopedThread(request, response, "thread-1"), false);
});

test("runtime broker preview proxy routes keep request bodies streamable", async (t) => {
  const app = express();
  app.use(createBrokerJsonParserMiddleware(express.json()));
  app.post("/routes/preview/:leaseId/api/echo", async (request, response) => {
    const chunks = [];
    for await (const chunk of request) {
      chunks.push(Buffer.from(chunk));
    }
    response.json({ body: Buffer.concat(chunks).toString("utf8") });
  });
  app.post("/leases", (request, response) => {
    response.json({ parsed: request.body });
  });

  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const address = server.address();
  assert.equal(typeof address, "object");
  assert.notEqual(address, null);
  const baseUrl = `http://127.0.0.1:${address.port}`;

  const previewResponse = await fetch(`${baseUrl}/routes/preview/lease-1/api/echo`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ marker: "preview-body" })
  });
  assert.equal(previewResponse.status, 200);
  assert.deepEqual(await previewResponse.json(), { body: '{"marker":"preview-body"}' });

  const apiResponse = await fetch(`${baseUrl}/leases`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ marker: "parsed-api" })
  });
  assert.equal(apiResponse.status, 200);
  assert.deepEqual(await apiResponse.json(), { parsed: { marker: "parsed-api" } });
});
