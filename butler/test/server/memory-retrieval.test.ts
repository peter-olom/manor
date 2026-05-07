import assert from "node:assert/strict";
import { access, writeFile, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { formatButlerMemoryRetrieval, retrieveButlerMemory } from "../../src/server/memory-retrieval.js";
import { ButlerStateStore } from "../../src/server/state-store.js";
import type { JobMemoryView, PersistedUiState } from "../../src/server/types.js";

async function createStoreWithState(state: PersistedUiState): Promise<ButlerStateStore> {
  const dir = await mkdtemp(path.join(tmpdir(), "manor-memory-test-"));
  const statePath = path.join(dir, "state.json");
  await writeFile(statePath, JSON.stringify(state, null, 2));
  const store = new ButlerStateStore(statePath);
  await store.load();
  return store;
}

async function createStatePath(state: PersistedUiState): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "manor-memory-test-"));
  const statePath = path.join(dir, "state.json");
  await writeFile(statePath, JSON.stringify(state, null, 2));
  return statePath;
}

function makeJobMemory(overrides: Partial<JobMemoryView>): JobMemoryView {
  return {
    threadId: "job-alpha",
    projectId: "alpha",
    projectLabel: "Alpha",
    operatorGoal: "Keep checkout memory durable.",
    requestedTask: "Complete checkout follow-up.",
    currentPlan: ["Review checkout callback"],
    latestCheckpoint: "Checkout API seeded",
    nextAction: "Run proof review",
    blockers: [],
    assumptions: ["Use scoped project memory"],
    proofRequirements: [],
    notes: [],
    decisions: [],
    entries: [
      {
        id: "entry-alpha",
        kind: "checkpoint",
        summary: "Checkout API seeded",
        details: "The checkout path now has durable setup evidence.",
        nextAction: "Run proof review",
        blockers: [],
        plan: ["Review checkout callback"],
        assumptions: [],
        proofRequirements: [],
        promote: false,
        promotionCandidateId: null,
        at: 10
      }
    ],
    promotionCandidates: [],
    updatedAt: 10,
    ...overrides
  };
}

test("memory retrieval scopes project rollups and query-matched job memory", async () => {
  const store = await createStoreWithState({
    windows: [],
    focusedWindowId: null,
    jobMemoriesByThreadId: {
      "job-alpha": makeJobMemory({}),
      "job-beta": makeJobMemory({
        threadId: "job-beta",
        projectId: "beta",
        projectLabel: "Beta",
        latestCheckpoint: "Profile import finished",
        requestedTask: "Finish profile import.",
        entries: [],
        updatedAt: 20
      })
    },
    projectMemoriesByProjectId: {
      alpha: {
        projectId: "alpha",
        projectLabel: "Alpha",
        summary: "Checkout work is the active durable outcome.",
        entries: [
          {
            id: "project-entry-alpha",
            sourceThreadId: "job-alpha",
            kind: "checkpoint",
            summary: "Checkout API seeded",
            details: "Use this as the current checkout baseline.",
            acceptedAt: 11
          }
        ],
        updatedAt: 11
      },
      beta: {
        projectId: "beta",
        projectLabel: "Beta",
        summary: "Profile import finished.",
        entries: [],
        updatedAt: 20
      }
    },
    butlerMemoryEntries: [
      {
        id: "global-1",
        summary: "Checkout answers should use scoped retrieval.",
        details: "Avoid broad memory for casual chat.",
        source: "butler_tool",
        sourceMessageId: null,
        tags: ["checkout", "scope"],
        createdAt: 12
      }
    ]
  });

  const retrieval = retrieveButlerMemory(store, { projectId: "alpha", query: "checkout", includeGlobal: true });

  assert.deepEqual(retrieval.projectRollups.map((memory) => memory.projectId), ["alpha"]);
  assert.deepEqual(retrieval.jobMemories.map((memory) => memory.threadId), ["job-alpha"]);
  assert.deepEqual(retrieval.butlerMemories.map((memory) => memory.id), ["global-1"]);
  assert.equal(retrieval.pendingPromotionCandidates.length, 0);
  assert.match(formatButlerMemoryRetrieval(retrieval), /Checkout API seeded/);
});

test("pending memory outcomes survive without live thread context and promote into project memory", async () => {
  const store = await createStoreWithState({
    windows: [],
    focusedWindowId: null,
    jobMemoriesByThreadId: {
      "job-alpha": makeJobMemory({
        promotionCandidates: [
          {
            id: "candidate-alpha",
            threadId: "job-alpha",
            projectId: "alpha",
            projectLabel: "Alpha",
            kind: "decision",
            sourceEntryId: "entry-alpha",
            summary: "Durable outcome: checkout callback verified.",
            details: "This should become project memory after Butler accepts it.",
            status: "pending",
            createdAt: 30,
            updatedAt: 30,
            resolvedAt: null
          }
        ],
        updatedAt: 30
      })
    }
  });

  assert.deepEqual(store.listPendingPromotionCandidates("alpha").map((candidate) => candidate.id), ["candidate-alpha"]);

  const resolved = store.resolvePromotionCandidate("candidate-alpha", true);
  assert.equal(resolved?.status, "accepted");

  const projectMemory = store.getProjectMemory("alpha");
  assert.equal(projectMemory?.summary, "Durable outcome: checkout callback verified.");
  assert.equal(projectMemory?.entries[0]?.sourceThreadId, "job-alpha");
  assert.equal(store.getJobMemory("job-alpha")?.promotionCandidates[0]?.status, "accepted");

  const retrieval = retrieveButlerMemory(store, { projectId: "alpha", query: "callback verified" });
  assert.equal(retrieval.projectRollups[0]?.summary, "Durable outcome: checkout callback verified.");
  assert.equal(retrieval.pendingPromotionCandidates.length, 0);
});

test("sqlite memory store restores durable memory when json memory is missing", async () => {
  const statePath = await createStatePath({
    windows: [],
    focusedWindowId: null,
    jobMemoriesByThreadId: {
      "job-alpha": makeJobMemory({
        latestCheckpoint: "SQLite checkpoint survived",
        updatedAt: 40
      })
    },
    projectMemoriesByProjectId: {
      alpha: {
        projectId: "alpha",
        projectLabel: "Alpha",
        summary: "SQLite project rollup survived",
        entries: [],
        updatedAt: 41
      }
    }
  });

  const firstStore = new ButlerStateStore(statePath);
  await firstStore.load();
  await access(path.join(path.dirname(statePath), "butler-memory.sqlite"));

  await writeFile(statePath, JSON.stringify({ windows: [], focusedWindowId: null }, null, 2));

  const secondStore = new ButlerStateStore(statePath);
  await secondStore.load();
  const retrieval = retrieveButlerMemory(secondStore, { projectId: "alpha", query: "SQLite" });

  assert.equal(retrieval.projectRollups[0]?.summary, "SQLite project rollup survived");
  assert.equal(retrieval.jobMemories[0]?.latestCheckpoint, "SQLite checkpoint survived");
});
