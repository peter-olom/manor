import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import express from "express";

import { registerProjectArtifactPolicyRoutes } from "../../src/server/project-artifact-policy-routes.js";
import type { ProjectArtifactView } from "../../src/server/types.js";

test("project artifact open responses sandbox active content", async (t) => {
  const artifactsDir = await fs.mkdtemp(path.join(os.tmpdir(), "manor-artifact-route-"));
  t.after(() => fs.rm(artifactsDir, { recursive: true, force: true }));
  const filePath = path.join(artifactsDir, "active.html");
  await fs.writeFile(filePath, "<script>globalThis.compromised = true</script>", "utf8");
  const artifact = {
    id: "artifact-1",
    projectId: "boardwalk",
    projectLabel: "Boardwalk",
    kind: "reference",
    title: "Active content",
    description: null,
    fileName: "active.html",
    filePath,
    contentType: "text/html",
    sizeBytes: 48,
    tags: [],
    metadata: {},
    source: { kind: "generated", url: null, createdByThreadId: null, checksumSha256: null },
    textPreview: null,
    createdAt: 1,
    updatedAt: 1
  } satisfies ProjectArtifactView;
  const app = express();
  registerProjectArtifactPolicyRoutes({
    app,
    artifactsDir,
    store: { getProjectArtifact: () => artifact } as never,
    runtimeBroker: {} as never
  });
  const server = http.createServer(app);
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;

  const response = await fetch(`http://127.0.0.1:${port}/api/project-artifacts/boardwalk/artifact-1/file`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-security-policy"), "sandbox; default-src 'none'");
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.equal(response.headers.get("cross-origin-resource-policy"), "same-origin");
  assert.match(response.headers.get("content-disposition") ?? "", /^inline/);
});
