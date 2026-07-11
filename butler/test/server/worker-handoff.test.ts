import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { buildButlerDelegationContract } from "../../src/server/butler-agent-delegation-contract-builder.js";
import { buildJobPayload, parseJobPayload, remapJobPayloadForWorkerHandoff, updateJobPayload } from "../../src/server/job-instruction-artifacts.js";
import { configureSelfImprovementRequestState, isClosedSelfImprovementWorkerThread, SelfImprovementRequestState } from "../../src/server/self-improvement-request-state.js";
import { ButlerStateStore } from "../../src/server/state-store.js";
import { buildThreadExecutionContract } from "../../src/server/thread-contract.js";
import { buildWorkerHandoffNotes, buildWorkerHandoffPrompt, handoffWorkerAtomically, startWorkerHandoff } from "../../src/server/worker-handoff.js";

function selfImprovementInput() {
  return {
    trigger: "Worker handoff needs repair.",
    symptoms: "The active self-improvement Worker cannot switch harnesses.",
    logs: "source checkout reservation rejected replacement Worker",
    observations: "The reservation remains bound to the previous Worker thread.",
    suspectedCause: "Worker handoff does not transfer checkout ownership.",
    proposedChange: "Transfer the reservation as part of the atomic handoff.",
    risk: "A failed handoff could leave the reservation on the wrong Worker.",
    desiredOutcome: "The replacement Worker exclusively owns the source checkout."
  };
}

test("a cold handoff prompt carries the task boundary even when the latest directive is only progress", () => {
  const prompt = buildWorkerHandoffPrompt({
    threadId: "replacement-worker",
    task: "Read only: inspect the README and make no edits.",
    currentDirective: "Reported the project name from the README.",
    summary: "Continue the README inspection"
  });

  assert.match(prompt, /Task boundary: Read only: inspect the README and make no edits\./);
  assert.match(prompt, /Latest handoff instruction: Reported the project name from the README\./);
  assert.match(prompt, /payload command cannot be read, stop without editing or guessing/);
});

test("a worker handoff keeps the original review baseline and parent lineage", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "manor-worker-handoff-"));
  try {
    const store = new ButlerStateStore(path.join(dir, "state.json"));
    const sourceThreadId = "source-worker";
    const sourceContract = {
      ...buildThreadExecutionContract({
        threadId: sourceThreadId,
        workspaceCwd: dir,
        projectId: "project",
        projectLabel: "Project",
        branch: "main",
        taskText: "Implement worker switching",
        notes: []
      }),
      reviewBaselineCwd: dir,
      reviewBaselineSha: "baseline-sha",
      reviewBaselineTreeSha: "baseline-tree",
      reviewBaselineObjectDir: path.join(dir, "baseline-objects"),
      reviewPeerContexts: [{ sourceThreadId: "peer-worker", baselineTreeSha: "peer-tree", paths: ["one.ts"], recordedAt: 123 }],
      reviewPeerContextOverflow: true
    };

    const built = await buildButlerDelegationContract({
      store,
      threadId: "replacement-worker",
      task: sourceContract.requestedTask,
      workspace: { cwd: dir, branchName: "main" },
      parentThreadId: sourceThreadId,
      reviewBaselineSource: sourceContract
    });

    assert.equal(built.payload.protocol.parentThreadId, sourceThreadId);
    assert.equal(built.contract.reviewBaselineSha, "baseline-sha");
    assert.equal(built.contract.reviewBaselineTreeSha, "baseline-tree");
    assert.equal(built.contract.reviewBaselineObjectDir, path.join(dir, "baseline-objects"));
    assert.deepEqual(built.contract.reviewPeerContexts, sourceContract.reviewPeerContexts);
    assert.notEqual(built.contract.reviewPeerContexts, sourceContract.reviewPeerContexts);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a worker handoff remaps the complete live payload without flattening its revision history", () => {
  const sourceContract = buildThreadExecutionContract({
    threadId: "source-worker",
    workspaceCwd: "/workspace",
    projectId: "project",
    projectLabel: "Project",
    branch: "main",
    taskText: "Implement the switch and capture screenshot proof",
    notes: ["Do not commit the changes."]
  });
  const initial = buildJobPayload({
    threadId: "source-worker",
    kind: "delegation",
    instruction: "Implement the worker switch.",
    contract: sourceContract,
    imageReferenceIds: ["image-one"],
    fileReferenceIds: ["file-one"]
  });
  const current = updateJobPayload(initial, {
    kind: "steering",
    instruction: "Keep the accepted behavior and fix the remaining race.",
    summary: "Fix the handoff race",
    contract: sourceContract,
    imageReferenceIds: ["image-two"],
    fileReferenceIds: ["file-two"],
    checklist: {
      threadId: "source-worker",
      projectId: "project",
      projectLabel: "Project",
      requestedTask: sourceContract.requestedTask,
      items: sourceContract.acceptancePoints.map((text, index) => ({
        id: `point-${index + 1}`,
        text,
        status: index === 0 ? "accepted" : "pending",
        butlerNote: index === 0 ? "Verified before handoff" : null,
        queuedInstruction: null,
        decidedAt: index === 0 ? 123 : null,
        evidence: []
      })),
      heartbeat: { lastThreadEventAt: null, lastWorkerReportAt: null, lastKnownThreadStatus: "idle", stale: false },
      reviewState: "needs_review",
      createdAt: 100,
      updatedAt: 123
    }
  });
  const replacementContract = { ...structuredClone(sourceContract), threadId: "replacement-worker" };

  const remapped = remapJobPayloadForWorkerHandoff(current, {
    threadId: "replacement-worker",
    butlerThreadId: "pair-one",
    parentThreadId: "source-worker",
    contract: replacementContract
  });

  assert.ok(parseJobPayload(remapped));
  assert.equal(remapped.workerDirective, current.workerDirective);
  assert.deepEqual(remapped.checklist, current.checklist);
  assert.deepEqual(remapped.proof, current.proof);
  assert.deepEqual(remapped.constraints, current.constraints);
  assert.deepEqual(remapped.attachments, current.attachments);
  assert.deepEqual(remapped.nodes, current.nodes);
  assert.deepEqual(
    remapped.snapshots.map((snapshot) => ({ ...snapshot, delivery: { ...snapshot.delivery, threadId: "source-worker" } })),
    current.snapshots
  );
  assert.equal(remapped.protocol.taskId, current.protocol.taskId);
  assert.equal(remapped.protocol.attempt, current.protocol.attempt + 1);
  assert.equal(remapped.protocol.parentThreadId, "source-worker");
  assert.equal(remapped.protocol.workerThreadId, "replacement-worker");
  assert.deepEqual(remapped.delivery, { threadId: "replacement-worker", turnId: null, messageId: null });
});

test("handoff notes include a worker reply that is newer than the last report", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "manor-worker-handoff-notes-"));
  try {
    const store = new ButlerStateStore(path.join(dir, "state.json"));
    store.upsertThreadSummary({ id: "source-worker", status: "idle", turns: [] });
    const report = store.recordWorkerReport("source-worker", {
      turnId: "turn-report",
      status: "completed",
      summary: "Older completed report.",
      details: null
    });
    store.updateTurn("source-worker", { id: "turn-newer", status: "completed" });
    store.updateItem("source-worker", "turn-newer", {
      id: "reply-newer",
      type: "agentMessage",
      text: "Newer worker progress after the report.",
      at: report.updatedAt + 1
    }, "completed");

    const notes = buildWorkerHandoffNotes(store, "source-worker");
    assert.ok(notes.some((note) => note.includes("Older completed report.")));
    assert.ok(notes.some((note) => note.includes("Newer worker progress after the report.")));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a Pi to Codex handoff repairs workspace ownership before replacement", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "manor-worker-handoff-ownership-"));
  try {
    const store = new ButlerStateStore(path.join(dir, "state.json"));
    store.upsertThreadSummary({ id: "pi-source", source: "pi-rpc", status: "idle", cwd: dir, turns: [] });
    store.setThreadExecutionContract("pi-source", buildThreadExecutionContract({
      threadId: "pi-source",
      workspaceCwd: dir,
      projectId: "project",
      projectLabel: "Project",
      branch: null,
      taskText: "Continue the implementation",
      notes: []
    }));
    const repaired: string[] = [];

    await assert.rejects(() => startWorkerHandoff({
      access: { store } as never,
      sourceThreadId: "pi-source",
      targetHarness: "codex",
      targetModel: "gpt-5.4",
      targetEffort: "high",
      artifactsDir: dir,
      repairWorkspaceOwnership: async (cwd) => {
        repaired.push(cwd);
        throw new Error("ownership repair sentinel");
      }
    }), /ownership repair sentinel/);

    assert.deepEqual(repaired, [dir]);
    await store.flushSave();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a self-improvement handoff transfers the source reservation to the replacement Worker", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "manor-worker-handoff-self-improvement-"));
  const requestState = new SelfImprovementRequestState(path.join(dir, "requests.json"), () => undefined, () => undefined);
  const store = new ButlerStateStore(path.join(dir, "state.json"));
  let requestId: string | null = null;
  try {
    await requestState.load();
    configureSelfImprovementRequestState(requestState);
    store.upsertThreadSummary({ id: "source-worker", status: "idle", cwd: dir, turns: [] });
    store.setThreadExecutionContract("source-worker", buildThreadExecutionContract({
      threadId: "source-worker",
      workspaceCwd: dir,
      projectId: "manor",
      projectLabel: "Manor",
      branch: "main",
      taskText: "Repair Manor Worker handoff",
      notes: []
    }));
    const request = requestState.create(selfImprovementInput());
    requestId = request.id;
    requestState.update(request.id, {
      status: "changes_ready",
      threadId: "source-worker",
      pairId: "self-improvement-pair",
      workspaceCwd: dir,
      completedAt: 123,
      commitSha: "old-commit",
      pullRequestUrl: "https://example.test/old-pr"
    });
    await requestState.flush();
    let replacementWasAuthorized = false;
    let pairAttachmentFlushed = false;

    const result = await handoffWorkerAtomically({
      access: { store } as never,
      sourceThreadId: "source-worker",
      targetHarness: "pi",
      targetModel: "ollama-cloud/glm-5.2",
      targetEffort: "high",
      artifactsDir: dir,
      startHandoff: (handoffInput) => startWorkerHandoff({
        ...handoffInput,
        startWorker: async (_access, options) => {
          replacementWasAuthorized = options.ownsManorSourceCheckoutReservation === true;
          const threadId = "replacement-worker";
          store.upsertThreadSummary({ id: threadId, status: "idle", cwd: dir, turns: [] });
          if (typeof options.input === "function") await options.input(threadId);
          return {
            threadId,
            turnId: "replacement-turn",
            runtime: "pi-rpc",
            harness: "pi",
            provider: "ollama-cloud",
            model: "ollama-cloud/glm-5.2",
            effort: "high"
          };
        }
      }),
      trackCallback: async () => undefined,
      removeCallback: async (threadId) => {
        if (threadId === "source-worker") assert.equal(pairAttachmentFlushed, true);
      },
      attach: () => ({
        attached: true,
        flush: async () => { pairAttachmentFlushed = true; }
      }),
      post: () => undefined
    });

    assert.equal(result.threadId, "replacement-worker");
    assert.equal(replacementWasAuthorized, true);
    assert.equal(requestState.get(request.id)?.status, "running");
    assert.equal(requestState.get(request.id)?.threadId, "replacement-worker");
    assert.equal(requestState.get(request.id)?.pairId, "self-improvement-pair");
    assert.equal(requestState.get(request.id)?.completedAt, null);
    assert.equal(requestState.get(request.id)?.commitSha, null);
    assert.equal(requestState.get(request.id)?.pullRequestUrl, null);
    assert.equal(store.isWorkerThreadRetired("source-worker"), true);
    requestState.update(request.id, { status: "discarded" });
    await requestState.flush();
    assert.equal(isClosedSelfImprovementWorkerThread("source-worker"), true);
    assert.equal(isClosedSelfImprovementWorkerThread("replacement-worker"), true);
  } finally {
    if (requestId && requestState.get(requestId)) {
      requestState.update(requestId, { status: "discarded" });
      await requestState.flush();
    }
    await store.flushSave();
    await rm(dir, { recursive: true, force: true });
  }
});

test("a failed reservation save restores the source Worker before handoff cleanup", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "manor-worker-handoff-reservation-save-"));
  const requestState = new SelfImprovementRequestState(path.join(dir, "requests.json"), () => undefined, () => undefined);
  const store = new ButlerStateStore(path.join(dir, "state.json"));
  let requestId: string | null = null;
  try {
    await requestState.load();
    configureSelfImprovementRequestState(requestState);
    store.upsertThreadSummary({ id: "source-worker", status: "idle", cwd: dir, turns: [] });
    const request = requestState.create(selfImprovementInput());
    requestId = request.id;
    requestState.update(request.id, {
      status: "changes_ready",
      threadId: "source-worker",
      pairId: "self-improvement-pair",
      workspaceCwd: dir,
      completedAt: 789,
      commitSha: "source-commit"
    });
    await requestState.flush();
    const durableFlush = requestState.flush.bind(requestState);
    let rejectNextFlush = true;
    requestState.flush = async () => {
      if (rejectNextFlush) {
        rejectNextFlush = false;
        throw new Error("reservation persistence failed");
      }
      await durableFlush();
    };
    const calls: string[] = [];

    await assert.rejects(() => handoffWorkerAtomically({
      access: { store } as never,
      sourceThreadId: "source-worker",
      targetHarness: "pi",
      targetModel: "ollama-cloud/glm-5.2",
      targetEffort: "high",
      artifactsDir: dir,
      startHandoff: async () => ({
        threadId: "replacement-worker",
        turnId: "turn-new",
        runtime: "pi-rpc",
        harness: "pi",
        provider: "ollama-cloud",
        model: "ollama-cloud/glm-5.2",
        effort: "high"
      }),
      trackCallback: async (threadId) => { calls.push(`track:${threadId}`); },
      removeCallback: async (threadId) => { calls.push(`remove:${threadId}`); },
      attach: () => ({ attached: true, rollback: () => { calls.push("rollback"); return true; } }),
      post: () => { calls.push("post"); },
      deleteWorker: async (_access, threadId) => { calls.push(`delete:${threadId}`); return {}; }
    }), /reservation persistence failed/);

    assert.equal(requestState.get(request.id)?.status, "changes_ready");
    assert.equal(requestState.get(request.id)?.threadId, "source-worker");
    assert.equal(requestState.get(request.id)?.completedAt, 789);
    assert.equal(requestState.get(request.id)?.commitSha, "source-commit");
    assert.deepEqual(calls, [
      "track:replacement-worker",
      "rollback",
      "remove:replacement-worker",
      "delete:replacement-worker"
    ]);
  } finally {
    if (requestId && requestState.get(requestId)) {
      requestState.update(requestId, { status: "discarded" });
      await requestState.flush();
    }
    await store.flushSave();
    await rm(dir, { recursive: true, force: true });
  }
});

test("a failed pair save restores both the source reservation and pair attachment", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "manor-worker-handoff-pair-save-"));
  const requestState = new SelfImprovementRequestState(path.join(dir, "requests.json"), () => undefined, () => undefined);
  const store = new ButlerStateStore(path.join(dir, "state.json"));
  let requestId: string | null = null;
  try {
    await requestState.load();
    configureSelfImprovementRequestState(requestState);
    store.upsertThreadSummary({ id: "source-worker", status: "idle", cwd: dir, turns: [] });
    const request = requestState.create(selfImprovementInput());
    requestId = request.id;
    requestState.update(request.id, {
      status: "changes_ready",
      threadId: "source-worker",
      pairId: "self-improvement-pair",
      workspaceCwd: dir,
      completedAt: 987,
      commitSha: "source-commit"
    });
    await requestState.flush();
    const calls: string[] = [];
    let flushCount = 0;

    await assert.rejects(() => handoffWorkerAtomically({
      access: { store } as never,
      sourceThreadId: "source-worker",
      targetHarness: "pi",
      targetModel: "ollama-cloud/glm-5.2",
      targetEffort: "high",
      artifactsDir: dir,
      startHandoff: async () => ({
        threadId: "replacement-worker",
        turnId: "turn-new",
        runtime: "pi-rpc",
        harness: "pi",
        provider: "ollama-cloud",
        model: "ollama-cloud/glm-5.2",
        effort: "high"
      }),
      trackCallback: async (threadId) => { calls.push(`track:${threadId}`); },
      removeCallback: async (threadId) => { calls.push(`remove:${threadId}`); },
      attach: () => ({
        attached: true,
        rollback: () => { calls.push("rollback"); return true; },
        flush: async () => {
          flushCount += 1;
          calls.push(`flush:${flushCount}`);
          if (flushCount === 1) throw new Error("pair persistence failed");
        }
      }),
      post: () => { calls.push("post"); },
      deleteWorker: async (_access, threadId) => { calls.push(`delete:${threadId}`); return {}; }
    }), /pair persistence failed/);

    assert.equal(requestState.get(request.id)?.status, "changes_ready");
    assert.equal(requestState.get(request.id)?.threadId, "source-worker");
    assert.equal(requestState.get(request.id)?.completedAt, 987);
    assert.equal(requestState.get(request.id)?.commitSha, "source-commit");
    assert.deepEqual(calls, [
      "track:replacement-worker",
      "flush:1",
      "rollback",
      "flush:2",
      "remove:replacement-worker",
      "delete:replacement-worker"
    ]);
  } finally {
    if (requestId && requestState.get(requestId)) {
      requestState.update(requestId, { status: "discarded" });
      await requestState.flush();
    }
    await store.flushSave();
    await rm(dir, { recursive: true, force: true });
  }
});

test("a failed attachment rolls back the pair and removes the replacement callback and worker", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "manor-worker-handoff-atomic-"));
  try {
    const store = new ButlerStateStore(path.join(dir, "state.json"));
    store.upsertThreadSummary({
      id: "source-worker",
      status: "idle",
      turns: [{ id: "turn-source", status: "completed", items: [] }]
    });
    const calls: string[] = [];

    await assert.rejects(() => handoffWorkerAtomically({
      access: { store } as never,
      sourceThreadId: "source-worker",
      targetHarness: "pi",
      targetModel: "opencode-go/minimax-m3",
      targetEffort: "medium",
      artifactsDir: dir,
      startHandoff: async () => ({
        threadId: "replacement-worker",
        turnId: "turn-new",
        runtime: "pi-rpc",
        harness: "pi",
        provider: "opencode-go",
        model: "opencode-go/minimax-m3",
        effort: "medium"
      }),
      trackCallback: async (threadId) => { calls.push(`track:${threadId}`); },
      removeCallback: async (threadId) => {
        calls.push(`remove:${threadId}`);
        if (threadId === "source-worker") throw new Error("callback state save failed");
      },
      attach: (_result, text) => {
        assert.match(text, /Switched Worker .* to opencode-go\/minimax-m3 using the Pi harness in job replacement-worker/);
        calls.push("attach");
        return { attached: true, rollback: () => { calls.push("rollback"); return true; } };
      },
      post: () => { calls.push("post"); },
      deleteWorker: async (_access, threadId) => { calls.push(`delete:${threadId}`); return {}; }
    }), /callback state save failed/);

    assert.deepEqual(calls, [
      "track:replacement-worker",
      "attach",
      "remove:source-worker",
      "rollback",
      "remove:replacement-worker",
      "delete:replacement-worker"
    ]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a rejected pair attachment removes the replacement instead of orphaning it", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "manor-worker-handoff-rejected-attachment-"));
  try {
    const store = new ButlerStateStore(path.join(dir, "state.json"));
    store.upsertThreadSummary({ id: "source-worker", status: "idle", turns: [] });
    const calls: string[] = [];

    await assert.rejects(() => handoffWorkerAtomically({
      access: { store } as never,
      sourceThreadId: "source-worker",
      targetHarness: "pi",
      targetModel: "ollama-cloud/glm-5.2",
      targetEffort: "high",
      artifactsDir: dir,
      startHandoff: async () => ({
        threadId: "replacement-worker",
        turnId: "turn-new",
        runtime: "pi-rpc",
        harness: "pi",
        provider: "ollama-cloud",
        model: "ollama-cloud/glm-5.2",
        effort: "high"
      }),
      trackCallback: async (threadId) => { calls.push(`track:${threadId}`); },
      removeCallback: async (threadId) => { calls.push(`remove:${threadId}`); },
      attach: () => { calls.push("attach:rejected"); return { attached: false }; },
      post: () => { calls.push("post"); },
      deleteWorker: async (_access, threadId) => { calls.push(`delete:${threadId}`); return {}; }
    }), /session changed before the replacement Worker could be attached/);

    assert.deepEqual(calls, [
      "track:replacement-worker",
      "attach:rejected",
      "remove:replacement-worker",
      "delete:replacement-worker"
    ]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a failure after source callback removal restores source supervision", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "manor-worker-handoff-late-rollback-"));
  const requestState = new SelfImprovementRequestState(path.join(dir, "requests.json"), () => undefined, () => undefined);
  let requestId: string | null = null;
  try {
    await requestState.load();
    configureSelfImprovementRequestState(requestState);
    const store = new ButlerStateStore(path.join(dir, "state.json"));
    store.upsertThreadSummary({
      id: "source-worker",
      status: "idle",
      turns: [{ id: "turn-source", status: "completed", items: [] }]
    });
    const request = requestState.create(selfImprovementInput());
    requestId = request.id;
    requestState.update(request.id, {
      status: "changes_ready",
      threadId: "source-worker",
      pairId: "self-improvement-pair",
      workspaceCwd: dir,
      completedAt: 456,
      commitSha: "restored-commit"
    });
    await requestState.flush();
    const calls: string[] = [];
    const affinity: unknown[] = [];

    await assert.rejects(() => handoffWorkerAtomically({
      access: {
        store,
        recordSuccessfulWorkerSelection: (selection: unknown) => { affinity.push(selection); }
      } as never,
      sourceThreadId: "source-worker",
      targetHarness: "pi",
      targetModel: "ollama-cloud/glm-5.2",
      targetEffort: null,
      artifactsDir: dir,
      startHandoff: async () => ({
        threadId: "replacement-worker",
        turnId: "turn-new",
        runtime: "pi-rpc",
        harness: "pi",
        provider: "ollama-cloud",
        model: "ollama-cloud/glm-5.2",
        effort: null
      }),
      trackCallback: async (threadId) => { calls.push(`track:${threadId}`); },
      removeCallback: async (threadId) => { calls.push(`remove:${threadId}`); },
      attach: () => ({ attached: true, rollback: () => { calls.push("rollback"); return true; } }),
      post: () => { calls.push("post"); throw new Error("operator post failed"); },
      deleteWorker: async (_access, threadId) => { calls.push(`delete:${threadId}`); return {}; }
    }), /operator post failed/);

    assert.deepEqual(calls, [
      "track:replacement-worker",
      "remove:source-worker",
      "post",
      "rollback",
      "remove:replacement-worker",
      "delete:replacement-worker",
      "track:source-worker"
    ]);
    assert.deepEqual(affinity, []);
    assert.equal(store.isWorkerThreadRetired("source-worker"), false);
    assert.equal(requestState.get(request.id)?.status, "changes_ready");
    assert.equal(requestState.get(request.id)?.threadId, "source-worker");
    assert.equal(requestState.get(request.id)?.completedAt, 456);
    assert.equal(requestState.get(request.id)?.commitSha, "restored-commit");
  } finally {
    if (requestId && requestState.get(requestId)) {
      requestState.update(requestId, { status: "discarded" });
      await requestState.flush();
    }
    await rm(dir, { recursive: true, force: true });
  }
});

test("a committed handoff records its provider affinity after callback and pair commit", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "manor-worker-handoff-affinity-"));
  try {
    const store = new ButlerStateStore(path.join(dir, "state.json"));
    store.upsertThreadSummary({ id: "source-worker", status: "idle", turns: [] });
    const calls: string[] = [];

    await handoffWorkerAtomically({
      access: {
        store,
        recordSuccessfulWorkerSelection: () => { calls.push("record"); }
      } as never,
      sourceThreadId: "source-worker",
      targetHarness: "pi",
      targetModel: "ollama-cloud/glm-5.2",
      targetEffort: "high",
      artifactsDir: dir,
      startHandoff: async () => ({
        threadId: "replacement-worker",
        turnId: "turn-new",
        runtime: "pi-rpc",
        harness: "pi",
        provider: "ollama-cloud",
        model: "ollama-cloud/glm-5.2",
        effort: "high"
      }),
      trackCallback: async (threadId) => { calls.push(`track:${threadId}`); },
      removeCallback: async (threadId) => { calls.push(`remove:${threadId}`); },
      attach: () => { calls.push("attach"); return { attached: true }; },
      post: () => { calls.push("post"); }
    });

    assert.deepEqual(calls, ["track:replacement-worker", "attach", "remove:source-worker", "post", "record"]);
    assert.equal(store.isWorkerThreadRetired("source-worker"), true);
    await store.flushSave();
    const reloaded = new ButlerStateStore(path.join(dir, "state.json"));
    await reloaded.load();
    assert.equal(reloaded.isWorkerThreadRetired("source-worker"), true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a handoff acknowledgement distinguishes duplicate provider and model routes by harness", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "manor-worker-handoff-route-"));
  try {
    const store = new ButlerStateStore(path.join(dir, "state.json"));
    store.upsertThreadSummary({ id: "source-worker", status: "idle", turns: [] });
    const messages: string[] = [];

    await handoffWorkerAtomically({
      access: { store } as never,
      sourceThreadId: "source-worker",
      targetHarness: "pi",
      targetModel: "openai-codex/shared-model",
      targetEffort: "high",
      artifactsDir: dir,
      startHandoff: async () => ({
        threadId: "replacement-worker",
        turnId: "turn-new",
        runtime: "pi-rpc",
        harness: "pi",
        provider: "openai-codex",
        model: "openai-codex/shared-model",
        effort: "high"
      }),
      trackCallback: async () => undefined,
      removeCallback: async () => undefined,
      attach: (_result, text) => { messages.push(text); return { attached: true }; },
      post: (_threadId, text) => { messages.push(text); }
    });

    assert.equal(messages.length, 2);
    assert.ok(messages.every((message) => message.includes("openai-codex/shared-model using the Pi harness")));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
