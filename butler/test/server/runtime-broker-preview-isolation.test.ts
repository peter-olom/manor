import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createBrokerCore } from "../../../docker/runtime-broker/broker-core.mjs";
import { createBrokerStorage } from "../../../docker/runtime-broker/broker-storage.mjs";

test("runtime broker forces preview leases into snapshot workspace mode", (t) => {
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
    workspaceMode: "shared"
  });

  assert.equal(lease.workspaceMode, "snapshot");
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
      assert.equal(name, "codex-box");
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
    codexWorkspaceContainerName: "codex-box",
    docker
  });

  assert.deepEqual(await storage.resolveCodexWorkspaceMounts(), [
    {
      Type: "volume",
      Source: "manor_repos",
      Target: "/repos",
      ReadOnly: false
    }
  ]);
  assert.deepEqual(await storage.resolveCodexWorkspaceMounts({ readOnly: true }), [
    {
      Type: "volume",
      Source: "manor_repos",
      Target: "/repos",
      ReadOnly: true
    }
  ]);
});
