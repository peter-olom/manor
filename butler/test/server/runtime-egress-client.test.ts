import assert from "node:assert/strict";
import test from "node:test";

import { RuntimeEgressClient } from "../../src/server/runtime-egress-client.js";

test("runtime egress client authenticates internal policy requests", async () => {
  let authorization = "";
  const client = new RuntimeEgressClient(
    "http://egress:8092",
    "test-token",
    (async (_input, init) => {
      authorization = new Headers(init?.headers).get("authorization") ?? "";
      return Response.json({ domains: [] });
    }) as typeof fetch
  );

  assert.deepEqual(await client.list(), { domains: [] });
  assert.equal(authorization, "Bearer test-token");
});

test("runtime egress client refuses requests without its internal token", async () => {
  const client = new RuntimeEgressClient("http://egress:8092", null, (async () => Response.json({ domains: [] })) as typeof fetch);
  await assert.rejects(() => client.list(), /token is not configured/i);
});
