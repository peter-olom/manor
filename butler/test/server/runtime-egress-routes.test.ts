import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import test from "node:test";

import express from "express";

import { registerRuntimeEgressRoutes } from "../../src/server/runtime-egress-routes.js";

async function listen(app: express.Express): Promise<{ url: string; close: () => Promise<void> }> {
  const server = app.listen(0);
  const address = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  };
}

test("runtime egress routes list, add, and remove operator domains", async () => {
  const domains = [
    { domain: "github.com", source: "built-in" as const, removable: false }
  ];
  let mode: "internet" | "restricted" = "internet";
  const client = {
    list: async () => ({ mode, domains }),
    add: async (domain: string) => {
      domains.push({ domain, source: "operator" as const, removable: true });
      return { mode, domains };
    },
    remove: async (domain: string) => {
      const index = domains.findIndex((entry) => entry.domain === domain);
      if (index >= 0) domains.splice(index, 1);
      return { mode, domains };
    },
    setMode: async (next: "internet" | "restricted") => ({ mode: mode = next, domains })
  };
  const app = express();
  app.use(express.json());
  registerRuntimeEgressRoutes({ app, client, operatorGatewayHost: "127.0.0.1" } as never);
  const server = await listen(app);
  try {
    const headers = { "x-manor-local-operator": "1" };
    const initial = await fetch(`${server.url}/api/runtime-egress/domains`, { headers });
    assert.equal(initial.status, 200);
    assert.deepEqual((await initial.json() as { domains: typeof domains }).domains, domains);

    const restricted = await fetch(`${server.url}/api/runtime-egress/mode`, {
      method: "PUT",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ mode: "restricted" })
    });
    assert.equal((await restricted.json() as { mode: string }).mode, "restricted");

    const added = await fetch(`${server.url}/api/runtime-egress/domains`, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ domain: ".asiri.dev" })
    });
    assert.equal(added.status, 201);
    assert.equal(domains.at(-1)?.domain, ".asiri.dev");

    const removed = await fetch(`${server.url}/api/runtime-egress/domains/${encodeURIComponent(".asiri.dev")}`, { method: "DELETE", headers });
    assert.equal(removed.status, 200);
    assert.equal(domains.some((entry) => entry.domain === ".asiri.dev"), false);
  } finally {
    await server.close();
  }
});

test("runtime egress route requires a hostname", async () => {
  const app = express();
  app.use(express.json());
  registerRuntimeEgressRoutes({
    app,
    client: { list: async () => ({ domains: [] }), add: async () => ({ domains: [] }), remove: async () => ({ domains: [] }) },
    operatorGatewayHost: "127.0.0.1"
  } as never);
  const server = await listen(app);
  try {
    const response = await fetch(`${server.url}/api/runtime-egress/domains`, {
      method: "POST",
      headers: { "x-manor-local-operator": "1", "Content-Type": "application/json" },
      body: JSON.stringify({ domain: "" })
    });
    assert.equal(response.status, 400);
    assert.match((await response.json() as { error: string }).error, /hostname/i);
  } finally {
    await server.close();
  }
});

test("runtime egress routes require the operator gateway", async () => {
  const app = express();
  registerRuntimeEgressRoutes({
    app,
    client: { list: async () => ({ domains: [] }), add: async () => ({ domains: [] }), remove: async () => ({ domains: [] }) },
    operatorGatewayHost: "192.0.2.1"
  } as never);
  const server = await listen(app);
  try {
    const response = await fetch(`${server.url}/api/runtime-egress/domains`, { headers: { "x-manor-local-operator": "1" } });
    assert.equal(response.status, 401);
  } finally {
    await server.close();
  }
});
