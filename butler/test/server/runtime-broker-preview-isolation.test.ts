import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import express from "express";
import { createBrokerCore } from "../../../docker/runtime-broker/broker-core.mjs";
import { createBrokerJsonParserMiddleware } from "../../../docker/runtime-broker/broker-http.mjs";
import { createBrokerStorage } from "../../../docker/runtime-broker/broker-storage.mjs";

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
      WorkingDir: "/tmp/manor-preview-workspaces/preview-1"
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
  assert.equal(broker.resolveContainerExecWorkingDir(serviceContainer, "redis"), "/data/redis");
  assert.equal(broker.resolveContainerExecWorkingDir({ Config: {} }, "tmp"), "/tmp");
  assert.equal(broker.resolveContainerExecWorkingDir(previewContainer, ""), "");
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

test("runtime broker starts preview containers before attaching outbound network", () => {
  const source = fs.readFileSync(path.resolve(import.meta.dirname, "../../../docker/runtime-broker/broker.mjs"), "utf8");
  const startIndex = source.indexOf("await runtimeContainer.start();");
  const outboundIndex = source.indexOf("await ensureNetworkConnection(previewOutboundNetwork, lease.containerName);");

  assert.notEqual(startIndex, -1);
  assert.notEqual(outboundIndex, -1);
  assert.ok(startIndex < outboundIndex);
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
              }
            ]
          };
        }
      };
    }
  };
  const storage = createBrokerStorage({
    workspaceContainerName: "worker-host",
    docker
  });

  assert.deepEqual(await storage.resolveWorkspaceMounts(), [
    {
      Type: "volume",
      Source: "manor_repos",
      Target: "/repos",
      ReadOnly: false
    }
  ]);
  assert.deepEqual(await storage.resolveWorkspaceMounts({ readOnly: true }), [
    {
      Type: "volume",
      Source: "manor_repos",
      Target: "/repos",
      ReadOnly: true
    }
  ]);
});

test("runtime broker accepts neutral harness tokens and legacy Codex token headers", (t) => {
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
  assert.equal(broker.authorizeScopedThread(request({ "x-manor-codex-token": "worker-token" }), response(), "thread-1"), true);
  const rejected = response();
  assert.equal(broker.authorizeScopedThread(request({ "x-manor-harness-token": "worker-token" }), rejected, "thread-2"), false);
  assert.deepEqual(rejected.body, { error: "Lease is not attached to this worker job" });
});

test("runtime broker falls back to the legacy access registry during migration", (t) => {
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
      return name === "x-manor-codex-token" ? "legacy-token" : "";
    }
  };
  const response = {
    status() { return this; },
    json() { return this; }
  };

  assert.equal(broker.authorizeScopedThread(request, response, "thread-1"), true);
  fs.writeFileSync(registryPath, "{malformed", "utf8");
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
