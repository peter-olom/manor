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
