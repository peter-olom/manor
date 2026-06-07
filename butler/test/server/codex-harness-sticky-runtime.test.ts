import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { matchHarnessThreadPreview, matchHarnessThreadStack } from "../../src/server/codex-harness-runtime.js";
import { ButlerStateStore } from "../../src/server/state-store.js";
import type { PreviewLeaseView, StackLeaseView } from "../../src/server/types.js";

async function createStore(): Promise<ButlerStateStore> {
  const dir = await mkdtemp(path.join(tmpdir(), "manor-sticky-runtime-test-"));
  return new ButlerStateStore(path.join(dir, "state.json"));
}

function stackLease(input: Partial<StackLeaseView> = {}): StackLeaseView {
  const now = Date.now();
  return {
    id: "stack-1",
    threadId: "owner-thread",
    projectId: "project",
    projectLabel: "Project",
    title: "Warm stack",
    worktreePath: "/repos/project",
    networkName: "manor-stack-1",
    status: "running",
    storageMode: "ephemeral",
    retainsVolumes: false,
    baseStorageKey: null,
    storageKey: null,
    cloneFromStorageKey: null,
    defaultPromoteTargetStorageKey: null,
    volumeNames: [],
    createdAt: now,
    updatedAt: now,
    lastError: null,
    previewIds: [],
    serviceIds: [],
    ...input
  };
}

function previewLease(input: Partial<PreviewLeaseView> = {}): PreviewLeaseView {
  const now = Date.now();
  return {
    id: "preview-1",
    threadId: "owner-thread",
    projectId: "project",
    projectLabel: "Project",
    title: "Warm preview",
    stackId: null,
    aliases: ["warm"],
    worktreePath: "/repos/project",
    branchName: null,
    containerName: "manor-preview-1",
    targetHost: "manor-preview-1",
    targetPort: 3000,
    publicPort: null,
    publicUrl: null,
    tailnetUrl: null,
    routePrefix: "/preview/preview-1/",
    operatorUrl: "/preview/preview-1/",
    command: "npm run dev",
    workspaceMode: "snapshot",
    image: "node:22",
    egressProfile: "internet",
    egressDomains: [],
    status: "running",
    createdAt: now,
    updatedAt: now,
    lastError: null,
    bootstrap: {
      waitSeconds: 120,
      hint: null,
      heartbeatKind: "http",
      heartbeatTarget: "/",
      heartbeatIntervalSeconds: 5,
      phase: "ready",
      startedAt: now,
      readyAt: now,
      lastHeartbeatAt: now,
      lastHeartbeatError: null
    },
    ...input
  };
}

test("sticky stack and preview leases are selectable by another Codex job", async () => {
  const store = await createStore();
  store.upsertStackLease(stackLease({ pinned: true }));
  store.upsertPreviewLease(previewLease({ pinned: true }));

  assert.equal(matchHarnessThreadStack(store, "next-thread", "Warm stack")?.id, "stack-1");
  assert.equal(matchHarnessThreadPreview(store, "next-thread", "warm")?.id, "preview-1");
});

test("non-sticky job-owned leases stay scoped to their owning Codex job", async () => {
  const store = await createStore();
  store.upsertStackLease(stackLease());
  store.upsertPreviewLease(previewLease());

  assert.equal(matchHarnessThreadStack(store, "next-thread", "Warm stack"), null);
  assert.equal(matchHarnessThreadPreview(store, "next-thread", "warm"), null);
});
