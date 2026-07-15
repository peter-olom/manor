import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { ButlerSseHub, resolveSseStateChannels, type RuntimeServerAccess } from "../../src/server/server-runtime-helpers.js";

test("SSE state subscriptions default to compatibility snapshots", () => {
  assert.deepEqual(resolveSseStateChannels(undefined), ["shell", "butlerLive", "runtime", "threads"]);
});

test("SSE state subscriptions can request only the runtime snapshot", () => {
  assert.deepEqual(resolveSseStateChannels("runtime,unknown,runtime"), ["runtime"]);
  assert.deepEqual(resolveSseStateChannels(""), []);
});

test("SSE flush computes and serializes only subscribed state channels", () => {
  const calls = { shell: 0, butlerLive: 0, runtime: 0, runtimeSerializations: 0, threads: 0 };
  const access = {
    butlerAgent: {
      getShellSnapshot: () => ({}),
      getCodexAuthStatus: () => ({}),
      getLiveSnapshot: () => {
        calls.butlerLive += 1;
        return {};
      }
    },
    codexClient: { getConnectionState: () => ({}) },
    scratchPadStore: { getSnapshot: () => ({}) },
    serviceTemplateRegistry: { list: () => [] },
    store: {
      getShellSnapshot: () => {
        calls.shell += 1;
        return { butler: {} };
      },
      getRuntimeSnapshot: () => {
        calls.runtime += 1;
        return {
          toJSON: () => {
            calls.runtimeSerializations += 1;
            return { previewProofsByThreadId: {} };
          }
        };
      },
      listOpenThreadDetails: () => {
        calls.threads += 1;
        return [];
      }
    }
  } as unknown as RuntimeServerAccess;
  const hub = new ButlerSseHub(access);
  const writes: string[][] = [[], []];
  const clients = writes.map((entries) => ({
    write: (chunk: string) => {
      entries.push(chunk);
      return true;
    }
  })) as unknown as Array<Parameters<ButlerSseHub["addClient"]>[0]>;

  hub.flush();
  assert.deepEqual(calls, { shell: 0, butlerLive: 0, runtime: 0, runtimeSerializations: 0, threads: 0 });

  for (const client of clients) hub.addClient(client, ["runtime"]);
  hub.flush();

  assert.deepEqual(calls, { shell: 0, butlerLive: 0, runtime: 1, runtimeSerializations: 1, threads: 0 });
  assert.equal(writes.every((entries) => entries.length === 1 && entries[0]?.includes("event: runtime")), true);

  for (const entries of writes) entries.length = 0;
  hub.broadcastWorkerThreadRefreshed("worker-1");
  assert.equal(writes.every((entries) => entries.length === 1 && entries[0]?.includes("event: workerThreadRefreshed") && entries[0]?.includes('"threadId":"worker-1"')), true);
});

test("gateway keeps proxy streaming unbuffered while gzip remains enabled", () => {
  const config = readFileSync(new URL("../../../docker/butler-gateway/nginx.conf", import.meta.url), "utf8");
  const mainLocation = config.match(/location \/ \{([\s\S]*?)\n  \}/)?.[1] ?? "";

  assert.match(config, /\bgzip on;/);
  assert.match(mainLocation, /\bproxy_buffering off;/);
  assert.doesNotMatch(mainLocation, /\bproxy_buffering on;/);
  assert.doesNotMatch(mainLocation, /\bchunked_transfer_encoding off;/);
});
