import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { recordReviewPanelVerdict } from "../../src/server/review-panel.js";
import { ScratchPadStore } from "../../src/server/scratch-pad-store.js";
import { buildThreadExecutionContract } from "../../src/server/thread-contract.js";
import type { CodexThreadRecord } from "../../src/server/types.js";

test("scratch pad items persist, launch, derive ready state, review, and cleanup", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "manor-scratch-pad-"));
  try {
    const statePath = path.join(dir, "scratch-pad.json");
    const store = new ScratchPadStore(statePath);
    await store.load();

    const created = store.create({
      text: "Explore async scratch items deeply.",
      depth: "prototype",
      resultKind: "prototype",
      attachments: [
        {
          id: "file-ref-1",
          kind: "file",
          referenceId: "file-1",
          name: "notes.md",
          mimeType: "text/markdown",
          sizeBytes: 18,
          url: "/api/files/file-1",
          available: true,
          used: false,
          note: null,
          createdAt: 1
        }
      ]
    });
    assert.equal(created.status, "captured");
    assert.equal(created.attachments[0]?.used, false);
    assert.equal(created.title, "Explore async scratch items deeply.");
    assert.equal(created.workspaceMode, "managed_worktree");

    const started = store.start(created.id, {
      threadId: "thread-1",
      cwd: "/repos/.manor-worktrees/manor/butler--scratch",
      workspaceMode: "managed_worktree",
      branchName: "butler/scratch"
    });
    assert.equal(started.status, "exploring");
    assert.equal(started.threadId, "thread-1");
    assert.equal(started.attachments[0]?.used, true);
    assert.equal(started.cwd, "/repos/.manor-worktrees/manor/butler--scratch");
    assert.equal(started.workspaceMode, "managed_worktree");
    assert.equal(started.branchName, "butler/scratch");

    const ready = store.getSnapshot((threadId) =>
      threadId === "thread-1"
        ? ({
            workerReport: {
              threadId,
              turnId: "turn-1",
              status: "completed",
              evidence: [],
              summary: "Done",
              details: null,
              createdAt: started.updatedAt + 1,
              updatedAt: started.updatedAt + 1
            },
            supervisionChecklist: {
              threadId,
              projectId: "manor",
              projectLabel: "Manor",
              requestedTask: "Explore async scratch items deeply.",
              items: [
                {
                  id: "point-1",
                  text: "Explore async scratch items deeply",
                  status: "accepted",
                  butlerNote: "Verified enough.",
                  queuedInstruction: null,
                  decidedAt: started.updatedAt + 2,
                  evidence: []
                }
              ],
              heartbeat: {
                lastThreadEventAt: null,
                lastWorkerReportAt: started.updatedAt + 1,
                lastKnownThreadStatus: "idle",
                stale: false
              },
              reviewState: "reviewed",
              createdAt: started.updatedAt,
              updatedAt: started.updatedAt + 2
            }
          } as CodexThreadRecord)
        : null
    );
    assert.equal(ready.items[0]?.status, "ready_for_review");
    assert.equal(ready.items[0]?.readiness.status, "ready");
    assert.equal(ready.items[0]?.dossier.acceptedEvidence, 1);
    assert.equal(ready.counts.ready_for_review, 1);
    assert.equal(ready.readinessCounts.ready, 1);

    const reviewed = store.review(created.id, "accepted");
    assert.equal(reviewed.status, "accepted");
    await store.flushSave();

    const restored = new ScratchPadStore(statePath);
    await restored.load();
    assert.equal(restored.getSnapshot().items[0]?.status, "accepted");
    assert.equal(restored.getSnapshot().items[0]?.workspaceMode, "managed_worktree");
    assert.equal(restored.getSnapshot().items[0]?.branchName, "butler/scratch");

    const removed = restored.remove(created.id);
    assert.equal(removed?.status, "accepted");
    await restored.flushSave();

    const cleaned = new ScratchPadStore(statePath);
    await cleaned.load();
    assert.deepEqual(cleaned.getSnapshot().items, []);
    assert.equal(cleaned.getSnapshot().counts.accepted, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("scratch pad removal drops the item from snapshots and persisted state", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "manor-scratch-pad-remove-"));
  try {
    const statePath = path.join(dir, "scratch-pad.json");
    const store = new ScratchPadStore(statePath);
    await store.load();

    const keep = store.create({ text: "Keep this scratch item." });
    const remove = store.create({ text: "Delete this scratch item.", workspaceMode: "existing", cwd: "/repos/manor" });
    assert.equal(remove.workspaceMode, "existing");

    const removed = store.remove(remove.id);
    assert.equal(removed?.id, remove.id);
    assert.deepEqual(store.getSnapshot().items.map((item) => item.id), [keep.id]);

    await store.flushSave();
    const restored = new ScratchPadStore(statePath);
    await restored.load();
    assert.deepEqual(restored.getSnapshot().items.map((item) => item.id), [keep.id]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("scratch pad snapshot separates worker report from Butler review readiness", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "manor-scratch-pad-readiness-"));
  try {
    const statePath = path.join(dir, "scratch-pad.json");
    const store = new ScratchPadStore(statePath);
    await store.load();

    const created = store.create({ text: "Investigate a weak report." });
    const started = store.start(created.id, { threadId: "thread-rework" });
    const snapshot = store.getSnapshot((threadId) =>
      threadId === "thread-rework"
        ? ({
            workerReport: {
              threadId,
              turnId: "turn-1",
              status: "completed",
              summary: "Done",
              details: null,
              evidence: [],
              createdAt: started.updatedAt + 1,
              updatedAt: started.updatedAt + 1
            },
            supervisionChecklist: {
              threadId,
              projectId: "manor",
              projectLabel: "Manor",
              requestedTask: "Investigate a weak report.",
              items: [
                {
                  id: "point-1",
                  text: "Investigate a weak report",
                  status: "rejected",
                  butlerNote: "Evidence was too thin.",
                  queuedInstruction: "Run a focused verification pass.",
                  decidedAt: started.updatedAt + 2,
                  evidence: []
                }
              ],
              heartbeat: {
                lastThreadEventAt: null,
                lastWorkerReportAt: started.updatedAt + 1,
                lastKnownThreadStatus: "idle",
                stale: false
              },
              reviewState: "needs_review",
              createdAt: started.updatedAt,
              updatedAt: started.updatedAt + 2
            }
          } as CodexThreadRecord)
        : null
    );

    assert.equal(snapshot.items[0]?.status, "exploring");
    assert.equal(snapshot.items[0]?.readiness.status, "needs_rework");
    assert.equal(snapshot.items[0]?.dossier.nextAction, "Send one private rework pass.");
    assert.equal(snapshot.readinessCounts.needs_rework, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("scratch pad review-panel concerns keep results in needs rework", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "manor-scratch-pad-panel-rework-"));
  try {
    const statePath = path.join(dir, "scratch-pad.json");
    const store = new ScratchPadStore(statePath);
    await store.load();

    const created = store.create({ text: "Prototype the scratchpad workflow and prove it locally." });
    const started = store.start(created.id, { threadId: "thread-panel-rework" });
    const baseContract = buildThreadExecutionContract({
      threadId: "thread-panel-rework",
      workspaceCwd: "/repos/manor",
      projectId: "manor",
      projectLabel: "Manor",
      branch: null,
      taskText: created.text,
      requestedTask: created.text,
      operatorGoal: "Prove concern-driven scratchpad rework.",
      taskCategory: "prototype",
      inferredWorkDepth: "deep",
      attachmentCount: 0,
      notes: []
    });
    let contract = recordReviewPanelVerdict(baseContract, {
      role: "qa",
      verdict: "concern",
      concerns: ["The local proof is too thin."],
      requiredFollowUp: "Run one focused browser smoke before operator closeout."
    });
    contract = recordReviewPanelVerdict(contract, {
      role: "product",
      verdict: "concern",
      concerns: ["The local proof is too thin."],
      requiredFollowUp: "Run one focused browser smoke before operator closeout."
    });
    const snapshot = store.getSnapshot((threadId) =>
      threadId === "thread-panel-rework"
        ? ({
            workerReport: {
              threadId,
              turnId: "turn-1",
              status: "completed",
              summary: "Prototype is done.",
              details: null,
              evidence: [],
              createdAt: started.updatedAt + 1,
              updatedAt: started.updatedAt + 1
            },
            executionContract: contract,
            supervisionChecklist: {
              threadId,
              projectId: "manor",
              projectLabel: "Manor",
              requestedTask: created.text,
              items: [
                {
                  id: "point-1",
                  text: "Prototype the scratchpad workflow",
                  status: "accepted",
                  butlerNote: "Accepted base prototype evidence.",
                  queuedInstruction: null,
                  decidedAt: started.updatedAt + 2,
                  evidence: []
                }
              ],
              heartbeat: {
                lastThreadEventAt: null,
                lastWorkerReportAt: started.updatedAt + 1,
                lastKnownThreadStatus: "idle",
                stale: false
              },
              reviewState: "needs_review",
              createdAt: started.updatedAt,
              updatedAt: started.updatedAt + 2
            }
          } as CodexThreadRecord)
        : null
    );

    assert.equal(snapshot.items[0]?.status, "exploring");
    assert.equal(snapshot.items[0]?.readiness.status, "needs_rework");
    assert.equal(snapshot.items[0]?.dossier.nextAction, "Send one private rework pass.");
    assert.match(snapshot.items[0]?.dossier.reviewerSummary ?? "", /QA reviewer/);
    assert.deepEqual(snapshot.items[0]?.dossier.reviewerConcerns, [
      "Run one focused browser smoke before operator closeout.",
      "The local proof is too thin."
    ]);
    assert.equal(snapshot.readinessCounts.needs_rework, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
