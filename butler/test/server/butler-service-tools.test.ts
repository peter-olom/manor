import assert from "node:assert/strict";
import { mkdtemp, mkdir, realpath, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { Value } from "@sinclair/typebox/value";

import { buildButlerServiceTools, resolveEmbeddedServiceFilePath } from "../../src/server/butler-agent-service-tools.js";
import type { ButlerAgentToolAccess } from "../../src/server/butler-agent-tool-access.js";

type ToolDefinition = {
  name: string;
  parameters: object;
  execute: (toolCallId: string, params: Record<string, unknown>) => Promise<{ content: Array<{ text: string }>; details?: Record<string, unknown> }>;
};

function definitionsFor(accessOverrides: Record<string, unknown> = {}): ToolDefinition[] {
  const definitions: ToolDefinition[] = [];
  const access = {
    runtimeThreadId: "butler:pair-1",
    getWorkerDefaults: () => ({ runtime: "auto", threadId: "worker-1" }),
    defineButlerTool: (definition: ToolDefinition) => {
      definitions.push(definition);
      return definition;
    },
    getToolUiEffects: () => [],
    ...accessOverrides
  } as unknown as ButlerAgentToolAccess;
  buildButlerServiceTools(access);
  return definitions;
}

function template(runtimeKind: "container" | "embedded" = "container") {
  return {
    id: runtimeKind === "container" ? "postgres" : "sqlite",
    label: runtimeKind === "container" ? "Postgres" : "SQLite",
    description: "Test service",
    runtimeKind,
    engine: runtimeKind === "container" ? "postgres" : "sqlite",
    image: runtimeKind === "container" ? "postgres:18" : "builtin/sqlite",
    defaultPort: runtimeKind === "container" ? 5432 : 0,
    stackVolumePath: null,
    notes: null,
    command: null,
    workingDir: null,
    envDefaults: {},
    fileName: runtimeKind === "embedded" ? ".manor/sqlite/app.db" : null,
    connection: {
      databaseEnv: null,
      databaseValue: null,
      usernameEnv: null,
      usernameValue: null,
      passwordEnv: null,
      passwordValue: null,
      uriTemplate: null,
      notes: null
    }
  };
}

test("register_service_template exposes a flat provider-portable object schema", () => {
  const definitions = definitionsFor();
  const schema = definitions.find((definition) => definition.name === "register_service_template")?.parameters;
  assert.ok(schema);
  const base = {
    id: "custom",
    label: "Custom",
    description: "Custom service",
    runtimeKind: "container",
    engine: "custom",
    image: "custom:latest",
    port: 8080
  };
  assert.equal(Value.Check(schema, base), true);
  assert.equal(Value.Check(schema, { ...base, image: undefined }), true);
  assert.equal(Value.Check(schema, { ...base, port: undefined }), true);
  assert.equal(Value.Check(schema, { ...base, port: 0 }), true);
  assert.equal(Value.Check(schema, { ...base, port: -1 }), false);
  assert.equal(Value.Check(schema, { ...base, port: 65536 }), false);
  assert.equal(Value.Check(schema, { ...base, port: "8080" }), false);
  assert.equal(Value.Check(schema, {
    id: "embedded",
    label: "Embedded",
    description: "Embedded service",
    runtimeKind: "embedded",
    engine: "sqlite",
    fileName: ".manor/sqlite/app.db"
  }), true);
  assert.equal(Value.Check(schema, {
    id: "embedded",
    label: "Embedded",
    description: "Embedded service",
    runtimeKind: "embedded",
    engine: "sqlite"
  }), true);
});

test("register_service_template enforces runtime-specific service safety before registry writes", async () => {
  let upserts = 0;
  const definitions = definitionsFor({
    normalizeServiceEnv: () => ({}),
    serviceTemplateRegistry: {
      upsert: async (input: Record<string, unknown>) => {
        upserts += 1;
        return { ...input, id: "embedded", label: "Embedded" };
      }
    }
  });
  const register = definitions.find((definition) => definition.name === "register_service_template")!;
  const valid = {
    id: "embedded",
    label: "Embedded",
    description: "Embedded service",
    runtimeKind: "embedded",
    engine: "sqlite",
    fileName: ".manor/sqlite/app.db"
  };
  await register.execute("embedded-valid", valid);
  const container = {
    id: "container",
    label: "Container",
    description: "Container service",
    runtimeKind: "container",
    engine: "postgres",
    image: "postgres:18",
    port: 5432
  };
  await register.execute("container-valid", container);
  await assert.rejects(() => register.execute("runtime-kind", { ...container, runtimeKind: "process" }), /runtimeKind must be container or embedded/);
  await assert.rejects(() => register.execute("container-image", { ...container, image: "" }), /image is required/);
  await assert.rejects(() => register.execute("container-port-missing", { ...container, port: undefined }), /port must be an integer/);
  await assert.rejects(() => register.execute("container-port-fraction", { ...container, port: 5432.5 }), /port must be an integer/);
  await assert.rejects(() => register.execute("container-port-low", { ...container, port: 0 }), /port must be an integer/);
  await assert.rejects(() => register.execute("container-port-high", { ...container, port: 65536 }), /port must be an integer/);
  await assert.rejects(() => register.execute("embedded-missing", { ...valid, fileName: undefined }), /safe relative path/);
  await assert.rejects(() => register.execute("embedded-traversal", { ...valid, fileName: "../escape.db" }), /safe relative path/);
  await assert.rejects(() => register.execute("embedded-absolute", { ...valid, fileName: "/tmp/escape.db" }), /safe relative path/);
  await assert.rejects(() => register.execute("embedded-port", { ...valid, port: 1 }), /port must be 0/);
  assert.equal(upserts, 2);
});

test("service mutations reject resources and stacks owned by another Butler session", async () => {
  let brokerCalls = 0;
  const foreignService = {
    id: "service-foreign",
    threadId: "worker-2",
    title: "Foreign service",
    runtimeKind: "container" as const,
    connection: { host: "foreign", port: 5432, uri: null },
    worktreePath: "/repos/foreign"
  };
  const foreignStack = {
    id: "stack-foreign",
    threadId: "worker-2",
    worktreePath: "/repos/foreign",
    title: "Foreign stack",
    networkName: "foreign",
    storageMode: "ephemeral" as const,
    baseStorageKey: null,
    storageKey: null,
    cloneFromStorageKey: null,
    defaultPromoteTargetStorageKey: null,
    retainsVolumes: false,
    volumeNames: [],
    previewIds: [],
    serviceIds: []
  };
  const definitions = definitionsFor({
    getServiceTemplate: () => template(),
    getValidatedStack: () => foreignStack,
    requireValidatedService: () => foreignService,
    store: { getThread: () => ({ cwd: "/repos/current" }) },
    runtimeBroker: {
      createService: async () => { brokerCalls += 1; },
      execInService: async () => { brokerCalls += 1; },
      stopService: async () => { brokerCalls += 1; }
    }
  });
  const start = definitions.find((definition) => definition.name === "start_service")!;
  const exec = definitions.find((definition) => definition.name === "exec_service")!;
  const stop = definitions.find((definition) => definition.name === "stop_service")!;

  await assert.rejects(() => start.execute("start-foreign-thread", { templateId: "postgres", threadId: "worker-2" }), /can only create runtime resources/);
  await assert.rejects(() => start.execute("start-foreign-stack", { templateId: "postgres", stackId: "stack-foreign" }), /belongs to another Butler session/);
  await assert.rejects(() => exec.execute("exec-foreign", { serviceId: foreignService.id, command: "true" }), /belongs to another Butler session/);
  await assert.rejects(() => stop.execute("stop-foreign", { serviceId: foreignService.id }), /belongs to another Butler session/);
  assert.equal(brokerCalls, 0);
});

test("service reads hide foreign resources and retain access to the handed-off Worker lineage", async () => {
  let brokerReads = 0;
  const ownedService = {
    id: "service-current",
    threadId: "worker-2",
    title: "Current service",
    templateId: "sqlite",
    status: "running",
    storageKind: "ephemeral",
    volumeName: null,
    runtimeKind: "embedded" as const,
    connection: { host: "local-file", port: 0, uri: "file:/repos/current.db" },
    worktreePath: "/repos/current.db"
  };
  const handedOffService = {
    ...ownedService,
    id: "service-previous",
    threadId: "worker-1",
    title: "Previous Worker service",
    connection: { host: "local-file", port: 0, uri: "file:/repos/previous.db" },
    worktreePath: "/repos/previous.db"
  };
  const firstWorkerService = {
    ...ownedService,
    id: "service-first",
    threadId: "worker-0",
    title: "First Worker service",
    connection: { host: "local-file", port: 0, uri: "file:/repos/first.db" },
    worktreePath: "/repos/first.db"
  };
  const foreignService = {
    ...ownedService,
    id: "service-foreign",
    threadId: "worker-other-pair",
    title: "Foreign service",
    connection: { host: "local-file", port: 0, uri: "file:/repos/foreign.db" },
    worktreePath: "/repos/foreign.db"
  };
  const services = [ownedService, handedOffService, firstWorkerService, foreignService];
  const definitions = definitionsFor({
    getWorkerDefaults: () => ({ runtime: "auto", threadId: "worker-2", runtimeOwnerThreadIds: ["worker-2", "worker-1", "worker-0"] }),
    refreshRuntimeInventoryIfAvailable: async () => null,
    requireValidatedService: (serviceId: string) => services.find((service) => service.id === serviceId),
    store: {
      listServiceLeases: () => services,
      noteServiceLeaseActivity: () => undefined
    },
    runtimeBroker: {
      inspectService: async () => { brokerReads += 1; },
      readServiceLogs: async () => { brokerReads += 1; }
    }
  });
  const list = definitions.find((definition) => definition.name === "list_services")!;
  const inspect = definitions.find((definition) => definition.name === "inspect_service")!;
  const logs = definitions.find((definition) => definition.name === "service_logs")!;

  const listText = (await list.execute("list", {})).content[0]?.text ?? "";
  assert.match(listText, /service-current/);
  assert.match(listText, /service-previous/);
  assert.match(listText, /service-first/);
  assert.doesNotMatch(listText, /service-foreign/);
  assert.match((await inspect.execute("inspect-previous", { serviceId: "service-previous" })).content[0]?.text ?? "", /embedded/);
  assert.match((await inspect.execute("inspect-first", { serviceId: "service-first" })).content[0]?.text ?? "", /embedded/);
  assert.match((await logs.execute("logs-previous", { serviceId: "service-previous" })).content[0]?.text ?? "", /does not expose container logs/);
  await assert.rejects(() => inspect.execute("inspect-foreign", { serviceId: "service-foreign" }), /belongs to another Butler session/);
  await assert.rejects(() => logs.execute("logs-foreign", { serviceId: "service-foreign" }), /belongs to another Butler session/);
  assert.equal(brokerReads, 0);
});

test("start_service defaults ownership to the pair's attached Worker", async () => {
  let createdForThread: string | null = null;
  const serviceTemplate = template();
  const store = {
    getThread: () => ({ cwd: "/repos/current", supervisor: { projectId: "current", projectLabel: "Current" } }),
    upsertServiceLease: () => undefined,
    noteServiceLeaseActivity: () => undefined,
    listProjectPolicies: () => []
  };
  const definitions = definitionsFor({
    getServiceTemplate: () => serviceTemplate,
    getValidatedStack: () => null,
    normalizeServiceEnv: () => ({}),
    normalizeStringArray: () => [],
    resolveWorkspaceProject: () => ({ id: "current", label: "Current" }),
    store,
    runtimeBroker: {
      createService: async (input: Record<string, unknown>) => {
        createdForThread = input.threadId as string;
        const now = Date.now();
        return {
          id: input.serviceId,
          threadId: input.threadId,
          projectId: input.projectId,
          projectLabel: input.projectLabel,
          title: input.title,
          stackId: null,
          aliases: [],
          templateId: serviceTemplate.id,
          templateLabel: serviceTemplate.label,
          runtimeKind: "container",
          containerName: `service-${input.serviceId}`,
          targetHost: "postgres",
          targetPort: 5432,
          worktreePath: "/repos/current",
          status: "running",
          storageKind: "ephemeral",
          sticky: false,
          volumeName: null,
          volumeMountPath: null,
          createdAt: now,
          updatedAt: now,
          lastError: null,
          env: {}
        };
      }
    }
  });
  const start = definitions.find((definition) => definition.name === "start_service")!;
  await start.execute("start-owned", { templateId: "postgres" });
  assert.equal(createdForThread, "worker-1");
});

test("list_services includes stable service ids", async () => {
  const definitions = definitionsFor({
    refreshRuntimeInventoryIfAvailable: async () => null,
    store: {
      listServiceLeases: () => [{
        id: "service-123",
        threadId: "worker-1",
        title: "Postgres",
        templateId: "postgres",
        status: "running",
        storageKind: "ephemeral",
        volumeName: null,
        connection: { host: "postgres", port: 5432, uri: "postgres://postgres:5432/app" }
      }]
    }
  });
  const list = definitions.find((definition) => definition.name === "list_services")!;
  const result = await list.execute("list", {});
  assert.match(result.content[0]?.text ?? "", /id=service-123/);
});

test("embedded service paths stay inside approved workspaces and reject traversal or symlinks", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "manor-service-root-"));
  const outsideRoot = await mkdtemp(path.join(os.tmpdir(), "manor-service-outside-"));
  const workspace = path.join(root, "project");
  const outside = path.join(root, "outside");
  await Promise.all([mkdir(workspace), mkdir(outside)]);
  await symlink(outside, path.join(workspace, "linked-outside"));
  const previous = process.env.MANOR_BUTLER_SERVICE_WORKSPACE_ROOTS;
  process.env.MANOR_BUTLER_SERVICE_WORKSPACE_ROOTS = root;
  t.after(() => {
    if (previous === undefined) delete process.env.MANOR_BUTLER_SERVICE_WORKSPACE_ROOTS;
    else process.env.MANOR_BUTLER_SERVICE_WORKSPACE_ROOTS = previous;
  });

  assert.equal(await resolveEmbeddedServiceFilePath(workspace, ".manor/sqlite/app.db"), path.join(await realpath(workspace), ".manor/sqlite/app.db"));
  await assert.rejects(() => resolveEmbeddedServiceFilePath(workspace, "../outside.db"), /path traversal/);
  await assert.rejects(() => resolveEmbeddedServiceFilePath(workspace, "linked-outside/app.db"), /cannot traverse symlink/);
  await assert.rejects(() => resolveEmbeddedServiceFilePath(outsideRoot, "app.db"), /outside approved roots|outside approved/);
});
