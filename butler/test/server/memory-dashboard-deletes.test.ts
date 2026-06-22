import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { ButlerStateStore } from "../../src/server/state-store.js";
import type { CodexThreadExecutionContractView } from "../../src/server/types.js";

async function createStore(): Promise<ButlerStateStore> {
  const stateDir = await mkdtemp(path.join(tmpdir(), "manor-memory-delete-test-"));
  return new ButlerStateStore(path.join(stateDir, "state.json"));
}

function contract(threadId: string, projectId: string, projectLabel: string): CodexThreadExecutionContractView {
  return {
    threadId,
    workspaceCwd: "/w",
    projectId,
    projectLabel,
    branch: "main",
    requestedTask: "Task",
    operatorGoal: "Goal",
    acceptancePoints: [],
    proofExpectation: "none",
    proofExpectationLabel: "no proof",
    notes: []
  };
}

function lastEntryId(store: ButlerStateStore, threadId: string): string {
  const memory = store.getJobMemory(threadId);
  if (!memory || memory.entries.length === 0) {
    throw new Error(`No entries in job memory for ${threadId}`);
  }
  return memory.entries[memory.entries.length - 1].id;
}

test("deleteButlerMemory removes the entry by id", async () => {
  const store = await createStore();
  const first = store.recordButlerMemory({ summary: "First note", details: "First body", tags: ["alpha"] });
  const second = store.recordButlerMemory({ summary: "Second note", source: "butler_tool" });
  const third = store.recordButlerMemory({ summary: "Third note" });

  assert.equal(store.listButlerMemory().length, 3);

  assert.equal(store.deleteButlerMemory(second.id), true);
  const remaining = store.listButlerMemory();
  assert.equal(remaining.length, 2);
  assert.equal(remaining[0].id, first.id);
  assert.equal(remaining[1].id, third.id);
});

test("deleteButlerMemory returns false for unknown ids", async () => {
  const store = await createStore();
  store.recordButlerMemory({ summary: "Survives" });
  assert.equal(store.deleteButlerMemory("not-a-real-id"), false);
  assert.equal(store.listButlerMemory().length, 1);
});

test("deleteButlerMemory persists across reload", async () => {
  const stateDir = await mkdtemp(path.join(tmpdir(), "manor-memory-delete-persist-"));
  const statePath = path.join(stateDir, "state.json");
  const store = new ButlerStateStore(statePath);
  const keep = store.recordButlerMemory({ summary: "Keep me" });
  const drop = store.recordButlerMemory({ summary: "Drop me" });
  store.deleteButlerMemory(drop.id);
  await store.flushSave();

  const reloaded = new ButlerStateStore(statePath);
  await reloaded.load();
  const entries = reloaded.listButlerMemory();
  assert.equal(entries.length, 1);
  assert.equal(entries[0].id, keep.id);
  assert.equal(entries[0].summary, "Keep me");
});

test("deleteJobMemoryEntry removes the entry and its promotion candidate", async () => {
  const store = await createStore();
  const threadId = "thread-job-1";
  const projectId = "project-job";
  store.upsertThreadSummary({ id: threadId, cwd: "/w", createdAt: 1, status: "running" });
  store.setThreadExecutionContract(threadId, contract(threadId, projectId, "Project Job"));
  store.recordJobCheckpoint(threadId, { summary: "Implement auth", details: "Done", promote: true });
  const entryId = lastEntryId(store, threadId);

  const before = store.getJobMemory(threadId);
  assert.ok(before);
  assert.equal(before.entries.length, 1);
  assert.equal(before.promotionCandidates.length, 1);

  assert.equal(store.deleteJobMemoryEntry(threadId, entryId), true);

  const after = store.getJobMemory(threadId);
  assert.ok(after);
  assert.equal(after.entries.length, 0);
  assert.equal(after.promotionCandidates.length, 0);
});

test("deleteJobMemoryEntry without promote keeps promotions intact", async () => {
  const store = await createStore();
  const threadId = "thread-job-2";
  const projectId = "project-job-2";
  store.upsertThreadSummary({ id: threadId, cwd: "/w", createdAt: 1, status: "running" });
  store.setThreadExecutionContract(threadId, contract(threadId, projectId, "Project Job 2"));
  store.recordJobCheckpoint(threadId, { summary: "Promoted", promote: true });
  store.recordJobNote(threadId, { summary: "Just a note" });
  const plainId = lastEntryId(store, threadId);

  assert.equal(store.deleteJobMemoryEntry(threadId, plainId), true);

  const after = store.getJobMemory(threadId);
  assert.ok(after);
  assert.equal(after.entries.length, 1);
  assert.equal(after.promotionCandidates.length, 1);
});

test("deleteJobMemoryEntry returns false for unknown thread or entry", async () => {
  const store = await createStore();
  const threadId = "thread-x";
  store.upsertThreadSummary({ id: threadId, cwd: "/w", createdAt: 1, status: "running" });
  store.recordJobCheckpoint(threadId, { summary: "Stays" });
  assert.equal(store.deleteJobMemoryEntry("no-such-thread", "entry"), false);
  assert.equal(store.deleteJobMemoryEntry(threadId, "no-such-entry"), false);
  assert.equal(store.getJobMemory(threadId)?.entries.length, 1);
});

test("deleteProjectMemoryEntry removes the entry and nulls summary when empty", async () => {
  const store = await createStore();
  const threadId = "thread-p-1";
  const projectId = "project-p";
  store.upsertThreadSummary({ id: threadId, cwd: "/w", createdAt: 1, status: "running" });
  store.setThreadExecutionContract(threadId, contract(threadId, projectId, "Project P"));

  const candidate = store.submitJobMemoryPromotionCandidate(threadId, {
    kind: "checkpoint",
    summary: "Stable project fact",
    sourceEntryId: "source-1",
    context: { projectId, projectLabel: "Project P" }
  });
  store.resolvePromotionCandidate(candidate.id, true);

  const project = store.getProjectMemory(projectId);
  assert.ok(project);
  assert.equal(project.entries.length, 1);
  const entryId = project.entries[0].id;

  assert.equal(store.deleteProjectMemoryEntry(projectId, entryId), true);

  const after = store.getProjectMemory(projectId);
  assert.ok(after);
  assert.equal(after.entries.length, 0);
  assert.equal(after.summary, null);
});

test("deleteProjectMemoryEntry returns false for unknown project or entry", async () => {
  const store = await createStore();
  assert.equal(store.deleteProjectMemoryEntry("missing", "entry"), false);
});

test("deletions persist across reload", async () => {
  const stateDir = await mkdtemp(path.join(tmpdir(), "manor-memory-reload-"));
  const statePath = path.join(stateDir, "state.json");
  const store = new ButlerStateStore(statePath);
  const butlerEntry = store.recordButlerMemory({ summary: "Keep" });
  store.deleteButlerMemory(butlerEntry.id);
  await store.flushSave();

  const reloaded = new ButlerStateStore(statePath);
  await reloaded.load();
  assert.equal(reloaded.listButlerMemory().length, 0);
});
