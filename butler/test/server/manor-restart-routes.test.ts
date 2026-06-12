import http from "node:http";
import test from "node:test";
import assert from "node:assert/strict";

import express from "express";

import { registerManorRestartRoutes } from "../../src/server/manor-restart-routes.js";
import type { ManorRestartRequestView } from "../../src/server/types.js";

function makeAuthorizedRequest(id: string): ManorRestartRequestView {
  return {
    id,
    mode: null,
    target: null,
    gitRef: null,
    imageTag: null,
    targetCommit: null,
    targetTag: null,
    includeDesktop: false,
    build: false,
    update: false,
    reason: "Restart Manor.",
    details: null,
    requestedAt: 1,
    status: "authorized",
    authorizedAt: 2
  };
}

function makeRestartRun() {
  return {
    id: "run-1",
    status: "running" as const,
    mode: "image" as const,
    target: "current",
    gitRef: null,
    imageTag: null,
    includeDesktop: false,
    update: false,
    startedAt: 3,
    completedAt: null,
    error: null,
    steps: []
  };
}

async function listen(app: express.Express): Promise<{ origin: string; close: () => Promise<void> }> {
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return {
    origin: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolve) => server.close(() => resolve()))
  };
}

test("restart authorize route starts the authorized request immediately", async () => {
  const app = express();
  app.use(express.json());
  const authorized = makeAuthorizedRequest("restart-request-1");
  let authorizedId: string | null = null;
  let startedId: string | null = null;

  registerManorRestartRoutes(app, {
    requestManorRestartAuthorization: () => authorized,
    authorizeManorRestartRequest: (requestId: string) => {
      authorizedId = requestId;
      return authorized;
    },
    startAuthorizedManorRestart: async (requestId: string) => {
      startedId = requestId;
      return {
        restartRequest: authorized,
        run: makeRestartRun()
      };
    },
    dismissManorRestartRequest: () => undefined,
    getManorRestartStatus: async () => ({
      ok: true,
      active: null,
      latestRun: makeRestartRun(),
      detectedMode: "image"
    })
  });

  const server = await listen(app);
  try {
    const response = await fetch(`${server.origin}/api/manor/restart-requests/${authorized.id}/authorize`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ operatorAction: "authorize_restart" })
    });
    const payload = await response.json();

    assert.equal(response.status, 202);
    assert.equal(payload.ok, true);
    assert.equal(payload.run.id, "run-1");
    assert.equal(authorizedId, authorized.id);
    assert.equal(startedId, authorized.id);
  } finally {
    await server.close();
  }
});

test("restart status route returns the host-controller run", async () => {
  const app = express();
  app.use(express.json());
  const run = makeRestartRun();

  registerManorRestartRoutes(app, {
    requestManorRestartAuthorization: () => makeAuthorizedRequest("restart-request-1"),
    authorizeManorRestartRequest: () => makeAuthorizedRequest("restart-request-1"),
    startAuthorizedManorRestart: async () => ({ restartRequest: makeAuthorizedRequest("restart-request-1"), run }),
    dismissManorRestartRequest: () => undefined,
    getManorRestartStatus: async () => ({
      ok: true,
      active: null,
      latestRun: run,
      detectedMode: "image"
    })
  });

  const server = await listen(app);
  try {
    const response = await fetch(`${server.origin}/api/manor/restart-status`);
    const payload = await response.json() as { latestRun?: { id?: string } };

    assert.equal(response.status, 200);
    assert.equal(payload.latestRun?.id, run.id);
  } finally {
    await server.close();
  }
});
