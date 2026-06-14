import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import type { HostControllerClient, ManorRestartStartResult } from "../../src/server/host-controller-client.js";
import { ManorRestartRequestState } from "../../src/server/manor-restart-state.js";

function restartResult(): ManorRestartStartResult {
  return {
    ok: true,
    run: {
      id: "run-1",
      status: "running",
      mode: "source",
      target: "current",
      gitRef: null,
      imageTag: null,
      includeDesktop: false,
      update: false,
      startedAt: 1,
      completedAt: null,
      error: null,
      steps: []
    }
  };
}

test("restart request persistence preserves the final consumed state", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "manor-restart-state-"));
  const statePath = path.join(dir, "restart-requests.json");
  const errors: unknown[] = [];
  const hostController = {
    restart: async () => restartResult()
  } as unknown as HostControllerClient;
  const state = new ManorRestartRequestState(statePath, hostController, (error) => errors.push(error), () => undefined);

  try {
    const pending = state.request({
      reason: "Restart only.",
      build: false,
      update: false
    });
    const authorized = state.authorize(pending.id);
    await state.start(authorized.id);

    const parsed = JSON.parse(await readFile(statePath, "utf8")) as {
      pendingManorRestartRequest: unknown;
      authorizedManorRestartRequest: unknown;
    };

    assert.equal(errors.length, 0);
    assert.equal(parsed.pendingManorRestartRequest, null);
    assert.equal(parsed.authorizedManorRestartRequest, null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
