import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import http from "node:http";
import test from "node:test";

import { RuntimeBrokerClient } from "../../src/server/runtime-broker-client.js";

test("runtime broker client rejects failed browser action payloads", async (t) => {
  const server = http.createServer((request, response) => {
    assert.equal(request.method, "POST");
    assert.equal(request.url, "/browser/sessions/browser-session-1/actions");

    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        ok: false,
        error: "Browser-use action evaluate failed.",
        action: { type: "evaluate", durationMs: 4, status: "failed" },
        state: {
          title: "",
          url: "http://example.test",
          status: 200,
          resolution: "1080p",
          viewport: { width: 1920, height: 1080 },
          actionCount: 1
        }
      })
    );
  });
  t.after(() => server.close());

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  const client = new RuntimeBrokerClient(`http://127.0.0.1:${address.port}`);

  await assert.rejects(
    () =>
      client.runBrowserSessionAction("browser-session-1", {
        type: "evaluate",
        script: "throw new Error('boom')"
      }),
    /Browser-use action evaluate failed/
  );
});
