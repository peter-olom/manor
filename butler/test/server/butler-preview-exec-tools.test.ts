import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { buildButlerStackPreviewTools } from "../../src/server/butler-agent-stack-preview-tools.js";
import type { ButlerAgentToolAccess } from "../../src/server/butler-agent-tool-access.js";

test("Butler preview exec forwards argv and stdin to the runtime broker", async () => {
  const definitions: Array<{
    name: string;
    execute: (toolCallId: string, params: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }>;
  }> = [];
  let receivedInput: Record<string, unknown> | null = null;
  let notedLeaseId: string | null = null;

  const access = {
    runtimeThreadId: "butler:pair-1",
    getWorkerDefaults: () => ({ runtime: "auto", threadId: "thread-1" }),
    defineButlerTool: (definition: (typeof definitions)[number]) => {
      definitions.push(definition);
      return definition;
    },
    getToolUiEffects: () => [],
    runtimeBroker: {
      execInLease: async (input: Record<string, unknown>) => {
        receivedInput = input;
        return {
          leaseId: input.leaseId,
          command: input.command,
          exitCode: 0,
          stdout: "preview ok\n",
          stderr: ""
        };
      }
    },
    store: {
      notePreviewLeaseActivity: (leaseId: string) => {
        notedLeaseId = leaseId;
      }
    },
    requireValidatedPreview: (leaseId: string) => ({ id: leaseId, threadId: "thread-1" })
  } as unknown as ButlerAgentToolAccess;

  buildButlerStackPreviewTools(access);
  const execPreview = definitions.find((definition) => definition.name === "exec_preview");
  assert.ok(execPreview);

  const result = await execPreview.execute("tool-call-1", {
    leaseId: "preview-1",
    commandArgs: ["node", "-"],
    cwd: " /app ",
    stdin: "console.log('preview ok')"
  });

  assert.deepEqual(receivedInput, {
    leaseId: "preview-1",
    command: "",
    commandArgs: ["node", "-"],
    cwd: "/app",
    stdin: "console.log('preview ok')",
    stdinProvided: true
  });
  assert.equal(notedLeaseId, "preview-1");
  assert.match(result.content[0]?.text ?? "", /stdout:\npreview ok/);
});

test("Butler lease tools update sticky preview and stack lifecycle", async () => {
  const definitions: Array<{
    name: string;
    execute: (toolCallId: string, params: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }>;
  }> = [];
  const lifecycleUpdates: Record<string, unknown>[] = [];

  const access = {
    runtimeThreadId: "butler:pair-1",
    getWorkerDefaults: () => ({ runtime: "auto", threadId: "thread-1" }),
    defineButlerTool: (definition: (typeof definitions)[number]) => {
      definitions.push(definition);
      return definition;
    },
    getToolUiEffects: () => [],
    getValidatedStack: () => ({ id: "stack-1", threadId: "thread-1" }),
    requireValidatedPreview: () => ({ id: "preview-1", threadId: "thread-1" }),
    store: {
      setStackLeaseLifecycle: (leaseId: string, patch: Record<string, unknown>) => {
        lifecycleUpdates.push({ kind: "stack", leaseId, ...patch });
        return {
          id: leaseId,
          title: "Warm stack",
          pinned: patch.pinned,
          leaseTtlMs: patch.leaseTtlMs,
          lifecycleState: "active"
        };
      },
      setPreviewLeaseLifecycle: (leaseId: string, patch: Record<string, unknown>) => {
        lifecycleUpdates.push({ kind: "preview", leaseId, ...patch });
        return {
          id: leaseId,
          title: "Warm preview",
          pinned: patch.pinned,
          leaseTtlMs: patch.leaseTtlMs,
          lifecycleState: "active"
        };
      }
    }
  } as unknown as ButlerAgentToolAccess;

  buildButlerStackPreviewTools(access);
  const setStackLease = definitions.find((definition) => definition.name === "set_stack_lease");
  const setPreviewLease = definitions.find((definition) => definition.name === "set_preview_lease");
  assert.ok(setStackLease);
  assert.ok(setPreviewLease);

  const stackResult = await setStackLease.execute("tool-call-1", {
    stackId: "stack-1",
    sticky: true,
    leaseTtlMinutes: 45
  });
  const previewResult = await setPreviewLease.execute("tool-call-2", {
    leaseId: "preview-1",
    sticky: true
  });

  assert.deepEqual(lifecycleUpdates, [
    { kind: "stack", leaseId: "stack-1", pinned: true, leaseTtlMs: 2_700_000, refresh: true },
    { kind: "preview", leaseId: "preview-1", pinned: true, leaseTtlMs: undefined, refresh: true }
  ]);
  assert.match(stackResult.content[0]?.text ?? "", /lease=sticky ttl=45m/);
  assert.match(previewResult.content[0]?.text ?? "", /lease=sticky/);
});

test("stop_stack retains volumes unless destructive cleanup is explicit", async () => {
  const definitions: Array<{
    name: string;
    execute: (toolCallId: string, params: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }>;
  }> = [];
  const requests: Array<{ stackId: string; dropVolumes: boolean }> = [];
  const access = {
    runtimeThreadId: "butler:pair-1",
    getWorkerDefaults: () => ({ runtime: "auto", threadId: "thread-1" }),
    defineButlerTool: (definition: (typeof definitions)[number]) => {
      definitions.push(definition);
      return definition;
    },
    getToolUiEffects: () => [],
    runtimeBroker: {
      stopStack: async (stackId: string, options: { dropVolumes: boolean }) => requests.push({ stackId, ...options })
    },
    getValidatedStack: (stackId: string) => ({ id: stackId, threadId: "thread-1" }),
    removeStackArtifacts: () => undefined
  } as unknown as ButlerAgentToolAccess;

  buildButlerStackPreviewTools(access);
  const stopStack = definitions.find((definition) => definition.name === "stop_stack");
  assert.ok(stopStack);
  const retained = await stopStack.execute("tool-call-1", { stackId: "stack-1" });
  const dropped = await stopStack.execute("tool-call-2", { stackId: "stack-2", dropVolumes: true });

  assert.deepEqual(requests, [
    { stackId: "stack-1", dropVolumes: false },
    { stackId: "stack-2", dropVolumes: true }
  ]);
  assert.match(retained.content[0]?.text ?? "", /Retained stack volumes/);
  assert.match(dropped.content[0]?.text ?? "", /Dropped retained volumes/);
});

test("start_preview forwards the delegated job branch", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "manor-preview-branch-"));
  try {
    const definitions: Array<{
      name: string;
      execute: (toolCallId: string, params: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }>;
    }> = [];
    let leaseInput: Record<string, unknown> | null = null;
    const access = {
      runtimeThreadId: "butler:pair-1",
      getWorkerDefaults: () => ({ runtime: "auto", threadId: "thread-1" }),
      defineButlerTool: (definition: (typeof definitions)[number]) => {
        definitions.push(definition);
        return definition;
      },
      getToolUiEffects: () => [],
      getValidatedStack: () => null,
      normalizeStringArray: () => [],
      normalizeServiceEnv: () => ({}),
      resolveWorkspaceProject: () => ({ id: "project", label: "Project" }),
      store: {
        getThread: () => ({
          cwd,
          supervisor: { projectId: "project", projectLabel: "Project" },
          executionContract: { branch: "feature/preview" }
        }),
        upsertPreviewLease: () => undefined
      },
      runtimeBroker: {
        createLease: async (input: Record<string, unknown>) => {
          leaseInput = input;
          return {
            id: input.leaseId,
            title: input.title,
            operatorUrl: "http://localhost/preview",
            workspaceMode: "snapshot",
            bootstrap: { phase: "ready", hint: null },
            pinned: false,
            lifecycleState: "active",
            leaseTtlMs: null,
            expiresAt: null
          };
        }
      }
    } as unknown as ButlerAgentToolAccess;

    buildButlerStackPreviewTools(access);
    const startPreview = definitions.find((definition) => definition.name === "start_preview");
    assert.ok(startPreview);
    await startPreview.execute("tool-call-1", {
      threadId: "thread-1",
      cwd,
      title: "Preview",
      command: "npm start",
      port: 3000
    });
    assert.equal(leaseInput?.branchName, "feature/preview");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("start_preview surfaces exit tombstones and never reports an observed pending bootstrap as started", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "manor-preview-exit-"));
  try {
    const definitions: Array<{
      name: string;
      execute: (toolCallId: string, params: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }>;
    }> = [];
    const savedLeases: Array<Record<string, unknown>> = [];
    const now = Date.now();
    const createdLease = {
      id: "preview-exited",
      threadId: "thread-1",
      projectId: "project",
      projectLabel: "Project",
      title: "Exited preview",
      stackId: null,
      aliases: [],
      worktreePath: cwd,
      branchName: null,
      containerName: "preview-exited",
      targetHost: "preview-exited",
      targetPort: 3000,
      publicPort: null,
      publicUrl: null,
      tailnetUrl: null,
      routePrefix: "/preview/preview-exited/",
      operatorUrl: "http://localhost/preview/preview-exited/",
      command: "node exit.js",
      workspaceMode: "snapshot" as const,
      image: "node:22",
      egressProfile: "internet" as const,
      egressDomains: [],
      status: "running" as const,
      createdAt: now,
      updatedAt: now,
      lastError: null,
      bootstrap: {
        waitSeconds: 5,
        hint: null,
        heartbeatKind: "http" as const,
        heartbeatTarget: "/",
        heartbeatIntervalSeconds: 1,
        phase: "starting_container" as const,
        startedAt: now,
        readyAt: null,
        lastHeartbeatAt: null,
        lastHeartbeatError: null
      }
    };
    const exactError = "Preview preview-exited exited before readiness";
    let failImmediately = true;
    const access = {
      runtimeThreadId: "butler:pair-1",
      getWorkerDefaults: () => ({ runtime: "auto", threadId: "thread-1" }),
      defineButlerTool: (definition: (typeof definitions)[number]) => {
        definitions.push(definition);
        return definition;
      },
      getToolUiEffects: () => [],
      getValidatedStack: () => null,
      normalizeStringArray: () => [],
      normalizeServiceEnv: () => ({}),
      resolveWorkspaceProject: () => ({ id: "project", label: "Project" }),
      store: {
        getThread: () => ({ cwd, supervisor: { projectId: "project", projectLabel: "Project" } }),
        upsertPreviewLease: (lease: Record<string, unknown>) => savedLeases.push(lease)
      },
      runtimeBroker: {
        createLease: async () => createdLease,
        inspectLease: async () => failImmediately ? ({
          ...createdLease,
          status: "failed",
          updatedAt: now + 10,
          lastError: exactError,
          bootstrap: { ...createdLease.bootstrap, phase: "failed", lastHeartbeatError: exactError },
          runtime: { running: false, status: "exited", startedAt: now, finishedAt: now + 10, exitCode: 23, oomKilled: false, error: exactError }
        }) : ({
          ...createdLease,
          bootstrap: { ...createdLease.bootstrap, phase: "waiting_for_heartbeat", lastHeartbeatError: "connection refused" },
          runtime: { running: true, status: "running", startedAt: now, finishedAt: null, exitCode: null, oomKilled: false, error: null }
        })
      }
    } as unknown as ButlerAgentToolAccess;

    buildButlerStackPreviewTools(access);
    const startPreview = definitions.find((definition) => definition.name === "start_preview");
    assert.ok(startPreview);
    await assert.rejects(
      () => startPreview.execute("tool-call-exit", { cwd, title: "Exited preview", command: "node exit.js", port: 3000 }),
      (error: Error) => {
        assert.match(error.message, new RegExp(exactError));
        assert.match(error.message, /runtimeStatus=exited exitCode=23 oomKilled=false/);
        return true;
      }
    );
    assert.equal(savedLeases.length, 2);
    assert.equal(savedLeases.at(-1)?.status, "failed");
    assert.equal((savedLeases.at(-1)?.bootstrap as { phase?: string }).phase, "failed");

    failImmediately = false;
    const pending = await startPreview.execute("tool-call-pending", {
      cwd,
      title: "Pending preview",
      command: "node server.js",
      port: 3000,
      bootstrapWaitSeconds: 1
    });
    assert.match(pending.content[0]?.text ?? "", /is still starting/);
    assert.doesNotMatch(pending.content[0]?.text ?? "", /Started preview/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("Butler browser action tool rejects failed browser action payloads", async () => {
  const definitions: Array<{
    name: string;
    execute: (toolCallId: string, params: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }>;
  }> = [];

  const access = {
    runtimeThreadId: "butler:pair-1",
    getWorkerDefaults: () => ({ runtime: "auto", threadId: "thread-1" }),
    defineButlerTool: (definition: (typeof definitions)[number]) => {
      definitions.push(definition);
      return definition;
    },
    getToolUiEffects: () => [],
    runtimeBroker: {
      inspectBrowserSession: async () => ({ tracked: { threadId: "thread-1" } }),
      runBrowserSessionAction: async () => {
        throw new Error("Browser-use action evaluate failed.");
      }
    }
  } as unknown as ButlerAgentToolAccess;

  buildButlerStackPreviewTools(access);
  const browserAction = definitions.find((definition) => definition.name === "browser_session_action");
  assert.ok(browserAction);

  await assert.rejects(
    () =>
      browserAction.execute("tool-call-1", {
        sessionId: "browser-session-1",
        actionType: "evaluate",
        script: "throw new Error('boom')",
        label: "Evaluation failure",
        fileName: "evaluation-failure.png"
      }),
    /Browser-use action evaluate failed/
  );
});

test("Butler browser and desktop action schemas match required capture metadata at execution", async () => {
  const definitions: Array<{
    name: string;
    execute: (toolCallId: string, params: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }>;
  }> = [];
  const browserInputs: Record<string, unknown>[] = [];
  const desktopInputs: Record<string, unknown>[] = [];
  const access = {
    runtimeThreadId: "butler:pair-1",
    getWorkerDefaults: () => ({ runtime: "auto", threadId: "thread-1" }),
    defineButlerTool: (definition: (typeof definitions)[number]) => {
      definitions.push(definition);
      return definition;
    },
    getToolUiEffects: () => [],
    runtimeBroker: {
      inspectBrowserSession: async () => ({ tracked: { threadId: "thread-1" } }),
      inspectDesktopSession: async () => ({ tracked: { threadId: "thread-1" } }),
      runBrowserSessionAction: async (_sessionId: string, input: Record<string, unknown>) => {
        browserInputs.push(input);
        return { action: { type: input.type }, state: { url: "http://example.test", actionCount: 1 } };
      },
      runDesktopSessionAction: async (_sessionId: string, input: Record<string, unknown>) => {
        desktopInputs.push(input);
        return { action: { type: input.type }, state: { actionCount: 1 } };
      }
    }
  } as unknown as ButlerAgentToolAccess;

  buildButlerStackPreviewTools(access);
  const browserAction = definitions.find((definition) => definition.name === "browser_session_action");
  const desktopAction = definitions.find((definition) => definition.name === "desktop_session_action");
  assert.ok(browserAction);
  assert.ok(desktopAction);

  await assert.rejects(
    () => browserAction.execute("tool-call-1", { sessionId: "browser-1", actionType: "evaluate", script: "return true", autoCapture: false }),
    /requires a screenshot label/
  );
  await assert.rejects(
    () => desktopAction.execute("tool-call-2", { sessionId: "desktop-1", actionType: "wait", ms: 1 }),
    /requires a screenshot label/
  );
  await browserAction.execute("tool-call-3", {
    sessionId: "browser-1",
    actionType: "evaluate",
    script: "return true",
    autoCapture: false,
    label: "Evaluation complete",
    fileName: "evaluation-complete.png"
  });
  await desktopAction.execute("tool-call-4", {
    sessionId: "desktop-1",
    actionType: "wait",
    ms: 1,
    label: "Wait complete",
    fileName: "wait-complete.png"
  });

  assert.equal(browserInputs.length, 1);
  assert.equal(browserInputs[0]?.autoCapture, false);
  assert.equal(desktopInputs.length, 1);
  assert.equal(desktopInputs[0]?.type, "wait");
});

test("runtime mutators reject stacks, previews, browser sessions, and desktop sessions owned by another pair", async () => {
  const definitions: Array<{
    name: string;
    execute: (toolCallId: string, params: Record<string, unknown>) => Promise<unknown>;
  }> = [];
  let mutationCount = 0;
  const access = {
    runtimeThreadId: "butler:pair-1",
    getWorkerDefaults: () => ({ runtime: "auto", threadId: "thread-1" }),
    defineButlerTool: (definition: (typeof definitions)[number]) => {
      definitions.push(definition);
      return definition;
    },
    getToolUiEffects: () => [],
    getValidatedStack: () => ({ id: "stack-2", threadId: "thread-2" }),
    requireValidatedPreview: () => ({ id: "preview-2", threadId: "thread-2" }),
    runtimeBroker: {
      inspectBrowserSession: async () => ({ tracked: { threadId: "thread-2" } }),
      inspectDesktopSession: async () => ({ tracked: { threadId: "thread-2" } }),
      stopStack: async () => { mutationCount += 1; },
      stopLease: async () => { mutationCount += 1; },
      runBrowserSessionAction: async () => { mutationCount += 1; },
      runDesktopSessionAction: async () => { mutationCount += 1; }
    },
    store: {
      getPreviewLease: () => null,
      markPreviewLeaseStopping: () => null
    },
    removeStackArtifacts: () => undefined
  } as unknown as ButlerAgentToolAccess;

  buildButlerStackPreviewTools(access);
  const tool = (name: string) => {
    const found = definitions.find((definition) => definition.name === name);
    assert.ok(found);
    return found;
  };

  await assert.rejects(() => tool("stop_stack").execute("1", { stackId: "stack-2" }), /another Butler session/);
  await assert.rejects(() => tool("stop_preview").execute("2", { leaseId: "preview-2" }), /another Butler session/);
  await assert.rejects(
    () => tool("browser_session_action").execute("3", {
      sessionId: "browser-2",
      actionType: "wait_for",
      autoCapture: false,
      label: "Foreign browser",
      fileName: "foreign-browser.png"
    }),
    /another Butler session/
  );
  await assert.rejects(
    () => tool("desktop_session_action").execute("4", {
      sessionId: "desktop-2",
      actionType: "wait",
      label: "Foreign desktop",
      fileName: "foreign-desktop.png"
    }),
    /another Butler session/
  );
  assert.equal(mutationCount, 0);
});

test("start_stack rejects guessed and cloned storage from another project", async () => {
  const definitions: Array<{
    name: string;
    execute: (toolCallId: string, params: Record<string, unknown>) => Promise<unknown>;
  }> = [];
  let createCount = 0;
  const access = {
    runtimeThreadId: "butler:pair-1",
    getWorkerDefaults: () => ({ runtime: "auto", threadId: "thread-alpha" }),
    defineButlerTool: (definition: (typeof definitions)[number]) => {
      definitions.push(definition);
      return definition;
    },
    getToolUiEffects: () => [],
    store: {
      getThread: () => ({
        cwd: "/repos/alpha",
        supervisor: { projectId: "alpha", projectLabel: "Alpha" }
      })
    },
    resolveWorkspaceProject: () => ({ id: "alpha", label: "Alpha" }),
    runtimeBroker: {
      createStack: async () => {
        createCount += 1;
        throw new Error("createStack should not be reached");
      }
    }
  } as unknown as ButlerAgentToolAccess;

  buildButlerStackPreviewTools(access);
  const startStack = definitions.find((definition) => definition.name === "start_stack");
  assert.ok(startStack);
  await assert.rejects(
    () => startStack.execute("1", {
      title: "Guessed stack",
      storageMode: "custom",
      storageKey: "project-beta-job-thread-beta"
    }),
    /storageKey is outside the resolved project storage namespace/
  );
  await assert.rejects(
    () => startStack.execute("2", {
      title: "Cloned stack",
      storageMode: "job",
      cloneFromStorageKey: "project-beta-base"
    }),
    /cloneFromStorageKey is outside the resolved project storage namespace/
  );
  assert.equal(createCount, 0);
});

test("runtime starts bind to the attached Worker and reject explicit foreign job ids", async () => {
  const definitions: Array<{
    name: string;
    execute: (toolCallId: string, params: Record<string, unknown>) => Promise<unknown>;
  }> = [];
  let createCount = 0;
  const access = {
    runtimeThreadId: "butler:pair-1",
    getWorkerDefaults: () => ({ runtime: "auto", threadId: "thread-1" }),
    defineButlerTool: (definition: (typeof definitions)[number]) => {
      definitions.push(definition);
      return definition;
    },
    getToolUiEffects: () => [],
    runtimeBroker: {
      createStack: async () => { createCount += 1; }
    },
    store: { getThread: () => null },
    resolveWorkspaceProject: () => ({ id: "project", label: "Project" })
  } as unknown as ButlerAgentToolAccess;

  buildButlerStackPreviewTools(access);
  const startStack = definitions.find((definition) => definition.name === "start_stack");
  assert.ok(startStack);
  await assert.rejects(
    () => startStack.execute("1", { threadId: "thread-2", title: "Foreign stack" }),
    /only create runtime resources for thread-1/
  );
  assert.equal(createCount, 0);
});

test("stop_preview restores cached state when the broker stop fails", async () => {
  const definitions: Array<{
    name: string;
    execute: (toolCallId: string, params: Record<string, unknown>) => Promise<unknown>;
  }> = [];
  const cached = { id: "preview-1", threadId: "thread-1", status: "running" };
  const restored: unknown[] = [];
  const access = {
    runtimeThreadId: "butler:pair-1",
    getWorkerDefaults: () => ({ runtime: "auto", threadId: "thread-1" }),
    defineButlerTool: (definition: (typeof definitions)[number]) => {
      definitions.push(definition);
      return definition;
    },
    getToolUiEffects: () => [],
    requireValidatedPreview: () => cached,
    runtimeBroker: { stopLease: async () => { throw new Error("broker unavailable"); } },
    store: {
      getPreviewLease: () => cached,
      markPreviewLeaseStopping: () => ({ ...cached, status: "stopping" }),
      upsertPreviewLease: (lease: unknown) => restored.push(lease)
    }
  } as unknown as ButlerAgentToolAccess;

  buildButlerStackPreviewTools(access);
  const stopPreview = definitions.find((definition) => definition.name === "stop_preview");
  assert.ok(stopPreview);
  await assert.rejects(() => stopPreview.execute("1", { leaseId: "preview-1" }), /broker unavailable/);
  assert.deepEqual(restored, [cached]);
});

test("promote_stack requires an exact confirmation and a target in the stack project lineage", async () => {
  const definitions: Array<{
    name: string;
    execute: (toolCallId: string, params: Record<string, unknown>) => Promise<unknown>;
  }> = [];
  const requests: unknown[] = [];
  const stack = {
    id: "stack-1",
    threadId: "thread-1",
    projectId: "alpha",
    baseStorageKey: "project-alpha-base",
    storageKey: "project-alpha-job-1",
    cloneFromStorageKey: "project-alpha-base",
    defaultPromoteTargetStorageKey: "project-alpha-base"
  };
  const access = {
    runtimeThreadId: "butler:pair-1",
    getWorkerDefaults: () => ({ runtime: "auto", threadId: "thread-1" }),
    defineButlerTool: (definition: (typeof definitions)[number]) => {
      definitions.push(definition);
      return definition;
    },
    getToolUiEffects: () => [],
    getValidatedStack: () => stack,
    runtimeBroker: {
      promoteStack: async (input: unknown) => {
        requests.push(input);
        return {
          promotedVolumes: ["volume-1"],
          sourceStorageKey: stack.storageKey,
          targetStorageKey: stack.baseStorageKey
        };
      },
      inspectStack: async () => stack
    },
    store: {
      upsertStackLease: () => undefined,
      noteStackLeaseActivity: () => undefined
    }
  } as unknown as ButlerAgentToolAccess;

  buildButlerStackPreviewTools(access);
  const promoteStack = definitions.find((definition) => definition.name === "promote_stack");
  assert.ok(promoteStack);
  await assert.rejects(
    () => promoteStack.execute("1", {
      stackId: "stack-1",
      targetStorageKey: "project-beta-base",
      confirmTargetStorageKey: "project-beta-base"
    }),
    /outside this stack's project storage lineage/
  );
  await assert.rejects(
    () => promoteStack.execute("2", {
      stackId: "stack-1",
      targetStorageKey: "project-alpha-base",
      confirmTargetStorageKey: "wrong-key"
    }),
    /must exactly match/
  );
  await promoteStack.execute("3", {
    stackId: "stack-1",
    targetStorageKey: "project-alpha-base",
    confirmTargetStorageKey: "project-alpha-base"
  });
  assert.deepEqual(requests, [{ stackId: "stack-1", targetStorageKey: "project-alpha-base" }]);
});

test("runtime action outputs are visible to the model, redacted, and bounded", async () => {
  const definitions: Array<{
    name: string;
    execute: (toolCallId: string, params: Record<string, unknown>) => Promise<{ content: Array<{ text: string }>; details?: Record<string, unknown> }>;
  }> = [];
  const secret = "ghp_1234567890abcdefghijklmnop";
  const largeOutput = { token: secret, text: "x".repeat(10_000) };
  const access = {
    runtimeThreadId: "butler:pair-1",
    getWorkerDefaults: () => ({ runtime: "auto", threadId: "thread-1" }),
    defineButlerTool: (definition: (typeof definitions)[number]) => {
      definitions.push(definition);
      return definition;
    },
    getToolUiEffects: () => [],
    runtimeBroker: {
      inspectBrowserSession: async () => ({ tracked: { threadId: "thread-1" } }),
      inspectDesktopSession: async () => ({ tracked: { threadId: "thread-1" } }),
      runBrowserSessionAction: async () => ({
        action: { type: "evaluate", output: largeOutput },
        state: { url: "http://example.test", actionCount: 1 }
      }),
      runDesktopSessionAction: async () => ({
        action: { type: "window_list", output: largeOutput },
        state: { actionCount: 1 }
      })
    }
  } as unknown as ButlerAgentToolAccess;

  buildButlerStackPreviewTools(access);
  const browserAction = definitions.find((definition) => definition.name === "browser_session_action");
  const desktopAction = definitions.find((definition) => definition.name === "desktop_session_action");
  const currentScreen = definitions.find((definition) => definition.name === "desktop_current_screen");
  assert.ok(browserAction);
  assert.ok(desktopAction);
  assert.ok(currentScreen);
  const browserResult = await browserAction.execute("1", {
    sessionId: "browser-1",
    actionType: "evaluate",
    script: "return window.state",
    autoCapture: false,
    label: "Browser state",
    fileName: "browser-state.png"
  });
  const desktopResult = await desktopAction.execute("2", {
    sessionId: "desktop-1",
    actionType: "window_list",
    label: "Desktop windows",
    fileName: "desktop-windows.png"
  });
  const currentScreenResult = await currentScreen.execute("3", {
    sessionId: "desktop-1",
    label: "Current screen",
    fileName: "current-screen.png"
  });

  for (const result of [browserResult, desktopResult, currentScreenResult]) {
    const text = result.content[0]?.text ?? "";
    assert.match(text, /Output:/);
    assert.match(text, /\[REDACTED\]/);
    assert.match(text, /\[truncated\]/);
    assert.doesNotMatch(text, new RegExp(secret));
    assert.ok(text.length < 8_500);
  }
});

test("list_stacks and list_previews include stable ids and hide foreign resources", async () => {
  const definitions: Array<{
    name: string;
    execute: (toolCallId: string, params: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }>;
  }> = [];
  const access = {
    runtimeThreadId: "butler:pair-1",
    getWorkerDefaults: () => ({ runtime: "auto", threadId: "thread-2", runtimeOwnerThreadIds: ["thread-2", "thread-1", "thread-0"] }),
    defineButlerTool: (definition: (typeof definitions)[number]) => {
      definitions.push(definition);
      return definition;
    },
    getToolUiEffects: () => [],
    refreshRuntimeInventoryIfAvailable: async () => null,
    describeStackStorage: () => "mode=ephemeral",
    store: {
      listStackLeases: () => [
        { id: "stack-current", title: "Current", threadId: "thread-2", status: "running", networkName: "net-2", previewIds: [], serviceIds: [] },
        { id: "stack-previous", title: "Previous Worker", threadId: "thread-1", status: "running", networkName: "net-1", previewIds: [], serviceIds: [] },
        { id: "stack-first", title: "First Worker", threadId: "thread-0", status: "running", networkName: "net-0", previewIds: [], serviceIds: [] },
        { id: "stack-foreign", title: "Foreign", threadId: "thread-other-pair", status: "running", networkName: "net-foreign", previewIds: [], serviceIds: [] }
      ],
      listPreviewLeases: () => [
        { id: "preview-current", title: "Current preview", threadId: "thread-2", status: "ready", bootstrap: { phase: "ready" }, operatorUrl: "/preview/current/" },
        { id: "preview-previous", title: "Previous Worker preview", threadId: "thread-1", status: "ready", bootstrap: { phase: "ready" }, operatorUrl: "/preview/previous/" },
        { id: "preview-first", title: "First Worker preview", threadId: "thread-0", status: "ready", bootstrap: { phase: "ready" }, operatorUrl: "/preview/first/" },
        { id: "preview-foreign", title: "Foreign preview", threadId: "thread-other-pair", status: "ready", bootstrap: { phase: "ready" }, operatorUrl: "/preview/foreign/" }
      ]
    }
  } as unknown as ButlerAgentToolAccess;

  buildButlerStackPreviewTools(access);
  const listStacks = definitions.find((definition) => definition.name === "list_stacks");
  const listPreviews = definitions.find((definition) => definition.name === "list_previews");
  assert.ok(listStacks);
  assert.ok(listPreviews);
  const stackText = (await listStacks.execute("1", {})).content[0]?.text ?? "";
  const previewText = (await listPreviews.execute("2", {})).content[0]?.text ?? "";
  assert.match(stackText, /id=stack-current/);
  assert.match(stackText, /id=stack-previous/);
  assert.match(stackText, /id=stack-first/);
  assert.doesNotMatch(stackText, /stack-foreign/);
  assert.match(previewText, /id=preview-current/);
  assert.match(previewText, /id=preview-previous/);
  assert.match(previewText, /id=preview-first/);
  assert.doesNotMatch(previewText, /preview-foreign/);
});

test("stop_browser_session validates the supplied preview association before stopping", async () => {
  const definitions: Array<{
    name: string;
    execute: (toolCallId: string, params: Record<string, unknown>) => Promise<unknown>;
  }> = [];
  let stopped = false;
  const access = {
    runtimeThreadId: "butler:pair-1",
    getWorkerDefaults: () => ({ runtime: "auto", threadId: "thread-1" }),
    defineButlerTool: (definition: (typeof definitions)[number]) => {
      definitions.push(definition);
      return definition;
    },
    getToolUiEffects: () => [],
    requireValidatedPreview: (leaseId: string) => ({ id: leaseId, threadId: "thread-1" }),
    runtimeBroker: {
      inspectBrowserSession: async () => ({
        tracked: { kind: "preview", leaseId: "preview-1", threadId: "thread-1" }
      }),
      stopBrowserSession: async () => { stopped = true; }
    }
  } as unknown as ButlerAgentToolAccess;

  buildButlerStackPreviewTools(access);
  const stopBrowser = definitions.find((definition) => definition.name === "stop_browser_session");
  assert.ok(stopBrowser);
  await assert.rejects(
    () => stopBrowser.execute("1", { sessionId: "browser-1", leaseId: "preview-2" }),
    /is not attached to preview preview-2/
  );
  assert.equal(stopped, false);
});

test("proof review lists exact coverage instead of reviewing an ambiguous multi-run bundle", async () => {
  const definitions: Array<{
    name: string;
    execute: (toolCallId: string, params: Record<string, unknown>) => Promise<{
      content: Array<{ text: string }>;
      details?: Record<string, unknown>;
    }>;
  }> = [];
  let visionReviews = 0;
  const access = {
    runtimeThreadId: "butler:pair-1",
    getWorkerDefaults: () => ({ runtime: "auto", threadId: "thread-proof" }),
    defineButlerTool: (definition: (typeof definitions)[number]) => {
      definitions.push(definition);
      return definition;
    },
    getToolUiEffects: () => [],
    store: {
      listPreviewProofs: () => [
        {
          id: "proof-reviewed",
          threadId: "thread-proof",
          previewTitle: "Reviewed page",
          updatedAt: 100,
          verification: { runId: "run-reviewed", ok: true, failureKind: "none" },
          proofReviews: [{ verdict: "credible" }]
        },
        {
          id: "proof-pending",
          threadId: "thread-proof",
          previewTitle: "Pending page",
          updatedAt: 200,
          verification: { runId: "run-pending", ok: true, failureKind: "none" },
          proofReviews: []
        }
      ]
    },
    reviewProofScreenshot: async () => {
      visionReviews += 1;
      throw new Error("vision review should not run for an ambiguous selector");
    }
  } as unknown as ButlerAgentToolAccess;

  buildButlerStackPreviewTools(access);
  const reviewProof = definitions.find((definition) => definition.name === "review_preview_proof");
  assert.ok(reviewProof);

  const result = await reviewProof.execute("review-multiple", { threadId: "thread-proof" });

  assert.equal(visionReviews, 0);
  assert.match(result.content[0]?.text ?? "", /run-reviewed: verification=passed \| review=credible/);
  assert.match(result.content[0]?.text ?? "", /run-pending: verification=passed \| review=unreviewed/);
  assert.equal(result.details?.requiresExactRunId, true);
});

test("exact proof review requires an owned thread or lease scope", async () => {
  const definitions: Array<{
    name: string;
    execute: (toolCallId: string, params: Record<string, unknown>) => Promise<unknown>;
  }> = [];
  let visionReviews = 0;
  const access = {
    runtimeThreadId: "butler:pair-1",
    getWorkerDefaults: () => ({ runtime: "auto", threadId: "thread-owned" }),
    defineButlerTool: (definition: (typeof definitions)[number]) => {
      definitions.push(definition);
      return definition;
    },
    getToolUiEffects: () => [],
    resolvePreviewProof: () => ({
      preview: { id: "preview-foreign", threadId: "thread-foreign" },
      verification: { runId: "run-foreign" }
    }),
    reviewProofScreenshot: async () => {
      visionReviews += 1;
      throw new Error("foreign proof must not reach vision review");
    }
  } as unknown as ButlerAgentToolAccess;

  buildButlerStackPreviewTools(access);
  const reviewProof = definitions.find((definition) => definition.name === "review_preview_proof");
  assert.ok(reviewProof);

  await assert.rejects(
    () => reviewProof.execute("review-unscoped", { runId: "run-foreign" }),
    /must be scoped by leaseId or threadId/
  );
  await assert.rejects(
    () => reviewProof.execute("review-foreign", { threadId: "thread-owned", runId: "run-foreign" }),
    /Proof run run-foreign belongs to another Butler session/
  );
  assert.equal(visionReviews, 0);
});
