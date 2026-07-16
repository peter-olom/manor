import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import type { AddressInfo } from "node:net";
import path from "node:path";
import test from "node:test";
import express from "express";

import { formatButlerMemoryRetrieval, retrieveButlerMemory } from "../../src/server/memory-retrieval.js";
import { ButlerStateStore } from "../../src/server/state-store.js";
import type { CodexThreadExecutionContractView } from "../../src/server/types.js";

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

function mountRoutes(store: ButlerStateStore): express.Express {
  const app = express();
  app.use(express.json());

  app.get("/api/memory/butler", (req, res) => {
    const projectId = typeof req.query.projectId === "string" && req.query.projectId ? req.query.projectId : null;
    const query = typeof req.query.query === "string" ? req.query.query : null;
    let entries = store.listButlerMemory();
    if (projectId) entries = entries.filter((entry) => entry.tags.includes(`project:${projectId}`));
    if (query && query.trim()) {
      const needle = query.trim().toLowerCase();
      entries = entries.filter(
        (entry) =>
          entry.summary.toLowerCase().includes(needle) ||
          (entry.details ? entry.details.toLowerCase().includes(needle) : false) ||
          entry.tags.some((tag) => tag.toLowerCase().includes(needle))
      );
    }
    res.json({ entries });
  });

  app.get("/api/memory/projects", (req, res) => {
    const projectId = typeof req.query.projectId === "string" && req.query.projectId ? req.query.projectId : null;
    const query = typeof req.query.query === "string" ? req.query.query : null;
    let projects = store.listProjectMemories();
    if (projectId) projects = projects.filter((memory) => memory.projectId === projectId);
    res.json({ projects });
  });

  app.get("/api/memory/jobs", (req, res) => {
    const projectId = typeof req.query.projectId === "string" && req.query.projectId ? req.query.projectId : null;
    res.json({ jobs: store.listJobMemories(projectId) });
  });

  app.get("/api/memory/retrieve", (req, res) => {
    const projectId = typeof req.query.projectId === "string" ? req.query.projectId : null;
    const query = typeof req.query.query === "string" ? req.query.query : null;
    const includeGlobal = req.query.includeGlobal === "1";
    const includeProvenance = req.query.includeProvenance === "1";
    const retrieval = retrieveButlerMemory(store, { projectId, query, includeGlobal, includeProvenance });
    res.json({ retrieval, formatted: formatButlerMemoryRetrieval(retrieval) });
  });

  app.delete("/api/memory/butler/:id", (req, res) => {
    const ok = store.deleteButlerMemory(req.params.id);
    if (!ok) {
      res.status(404).json({ error: "Butler memory entry not found" });
      return;
    }
    res.json({ ok: true });
  });

  app.delete("/api/memory/jobs/:threadId/entries/:entryId", (req, res) => {
    const ok = store.deleteJobMemoryEntry(req.params.threadId, req.params.entryId);
    if (!ok) {
      res.status(404).json({ error: "Job memory entry not found" });
      return;
    }
    res.json({ ok: true });
  });

  app.delete("/api/memory/projects/:projectId/entries/:entryId", (req, res) => {
    const ok = store.deleteProjectMemoryEntry(req.params.projectId, req.params.entryId);
    if (!ok) {
      res.status(404).json({ error: "Project memory entry not found" });
      return;
    }
    res.json({ ok: true });
  });

  return app;
}

async function listen(app: express.Express): Promise<{ url: string; close: () => Promise<void> }> {
  const server = app.listen(0);
  const address = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      })
  };
}

test("GET /api/memory/butler returns all entries and supports query", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "manor-mem-route-"));
  const store = new ButlerStateStore(path.join(dir, "state.json"));
  store.recordButlerMemory({ summary: "Use Linear-style spacing", tags: ["ui", "design"] });
  store.recordButlerMemory({ summary: "Prefer dark themes by default", tags: ["ui"] });
  store.recordButlerMemory({ summary: "Keep memory out of chat UI" });

  const app = mountRoutes(store);
  const { url, close } = await listen(app);
  try {
    const all = await fetch(`${url}/api/memory/butler`).then((r) => r.json() as Promise<{ entries: Array<{ summary: string }> }>);
    assert.equal(all.entries.length, 3);

    const filtered = await fetch(`${url}/api/memory/butler?query=dark`).then((r) => r.json() as Promise<{ entries: Array<{ summary: string }> }>);
    assert.equal(filtered.entries.length, 1);
    assert.equal(filtered.entries[0].summary, "Prefer dark themes by default");
  } finally {
    await close();
  }
});

test("GET /api/memory/retrieve returns the exact formatted Butler brief", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "manor-mem-route-"));
  const store = new ButlerStateStore(path.join(dir, "state.json"));
  store.recordButlerMemory({ summary: "Use compact memory rows", details: "Keep provenance visible.", tags: ["memory"] });
  const app = mountRoutes(store);
  const { url, close } = await listen(app);
  try {
    const payload = await fetch(`${url}/api/memory/retrieve?query=memory&includeGlobal=1&includeProvenance=1`)
      .then((response) => response.json() as Promise<{ retrieval: { butlerMemories: Array<{ summary: string }> }; formatted: string }>);
    assert.equal(payload.retrieval.butlerMemories[0]?.summary, "Use compact memory rows");
    assert.match(payload.formatted, /Global Butler memories:/);
    assert.match(payload.formatted, /Use compact memory rows/);
    assert.match(payload.formatted, /source=butler_tool/);
  } finally {
    await close();
  }
});

test("DELETE /api/memory/butler/:id removes the entry", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "manor-mem-route-"));
  const store = new ButlerStateStore(path.join(dir, "state.json"));
  const entry = store.recordButlerMemory({ summary: "Doomed" });
  const app = mountRoutes(store);
  const { url, close } = await listen(app);
  try {
    const ok = await fetch(`${url}/api/memory/butler/${entry.id}`, { method: "DELETE" });
    assert.equal(ok.status, 200);
    assert.equal(store.listButlerMemory().length, 0);

    const notFound = await fetch(`${url}/api/memory/butler/missing`, { method: "DELETE" });
    assert.equal(notFound.status, 404);
  } finally {
    await close();
  }
});

test("GET /api/memory/projects returns project memories and supports projectId filter", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "manor-mem-route-"));
  const store = new ButlerStateStore(path.join(dir, "state.json"));
  const threadA = "thread-a";
  const threadB = "thread-b";
  store.upsertThreadSummary({ id: threadA, cwd: "/w", createdAt: 1, status: "running" });
  store.upsertThreadSummary({ id: threadB, cwd: "/w", createdAt: 1, status: "running" });
  store.setThreadExecutionContract(threadA, contract(threadA, "project-a", "Project A"));
  store.setThreadExecutionContract(threadB, contract(threadB, "project-b", "Project B"));

  const cA = store.submitJobMemoryPromotionCandidate(threadA, {
    kind: "decision",
    summary: "A fact",
    sourceEntryId: "sa",
    context: { projectId: "project-a", projectLabel: "Project A" }
  });
  store.resolvePromotionCandidate(cA.id, true);
  const cB = store.submitJobMemoryPromotionCandidate(threadB, {
    kind: "decision",
    summary: "B fact",
    sourceEntryId: "sb",
    context: { projectId: "project-b", projectLabel: "Project B" }
  });
  store.resolvePromotionCandidate(cB.id, true);

  const app = mountRoutes(store);
  const { url, close } = await listen(app);
  try {
    const all = await fetch(`${url}/api/memory/projects`).then((r) => r.json() as Promise<{ projects: unknown[] }>);
    assert.equal(all.projects.length, 2);

    const onlyA = await fetch(`${url}/api/memory/projects?projectId=project-a`).then((r) => r.json() as Promise<{ projects: Array<{ projectId: string }> }>);
    assert.equal(onlyA.projects.length, 1);
    assert.equal(onlyA.projects[0].projectId, "project-a");
  } finally {
    await close();
  }
});

test("DELETE /api/memory/projects/:projectId/entries/:entryId removes an entry", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "manor-mem-route-"));
  const store = new ButlerStateStore(path.join(dir, "state.json"));
  const threadId = "thread-p";
  const projectId = "project-p";
  store.upsertThreadSummary({ id: threadId, cwd: "/w", createdAt: 1, status: "running" });
  store.setThreadExecutionContract(threadId, contract(threadId, projectId, "Project P"));
  const c = store.submitJobMemoryPromotionCandidate(threadId, {
    kind: "checkpoint",
    summary: "Project fact",
    sourceEntryId: "src",
    context: { projectId, projectLabel: "Project P" }
  });
  store.resolvePromotionCandidate(c.id, true);

  const project = store.getProjectMemory(projectId);
  assert.ok(project);
  const entryId = project.entries[0].id;

  const app = mountRoutes(store);
  const { url, close } = await listen(app);
  try {
    const ok = await fetch(`${url}/api/memory/projects/${projectId}/entries/${entryId}`, { method: "DELETE" });
    assert.equal(ok.status, 200);
    const after = store.getProjectMemory(projectId);
    assert.ok(after);
    assert.equal(after.entries.length, 0);
  } finally {
    await close();
  }
});

test("GET /api/memory/jobs returns all job memories and supports projectId filter", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "manor-mem-route-"));
  const store = new ButlerStateStore(path.join(dir, "state.json"));
  const threadA = "thread-ja";
  const threadB = "thread-jb";
  store.upsertThreadSummary({ id: threadA, cwd: "/work/a", createdAt: 1, status: "running" });
  store.upsertThreadSummary({ id: threadB, cwd: "/work/b", createdAt: 1, status: "running" });
  store.setThreadExecutionContract(threadA, contract(threadA, "project-a", "Project A"));
  store.setThreadExecutionContract(threadB, contract(threadB, "project-b", "Project B"));
  store.recordJobCheckpoint(threadA, { summary: "A checkpoint" });
  store.recordJobCheckpoint(threadB, { summary: "B checkpoint" });

  const app = mountRoutes(store);
  const { url, close } = await listen(app);
  try {
    const all = await fetch(`${url}/api/memory/jobs`).then((r) => r.json() as Promise<{ jobs: Array<{ threadId: string }> }>);
    assert.equal(all.jobs.length, 2);

    const onlyA = await fetch(`${url}/api/memory/jobs?projectId=/work/a`).then((r) => r.json() as Promise<{ jobs: Array<{ threadId: string; projectId: string }> }>);
    assert.equal(onlyA.jobs.length, 1);
    assert.equal(onlyA.jobs[0].threadId, threadA);
    assert.equal(onlyA.jobs[0].projectId, "/work/a");
  } finally {
    await close();
  }
});

test("DELETE /api/memory/jobs/:threadId/entries/:entryId removes a job entry", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "manor-mem-route-"));
  const store = new ButlerStateStore(path.join(dir, "state.json"));
  const threadId = "thread-jd";
  const projectId = "project-jd";
  store.upsertThreadSummary({ id: threadId, cwd: "/w", createdAt: 1, status: "running" });
  store.setThreadExecutionContract(threadId, contract(threadId, projectId, "Project JD"));
  store.recordJobCheckpoint(threadId, { summary: "Stays" });
  const note = store.recordJobNote(threadId, { summary: "Removed" });
  const removedId = note.entries[note.entries.length - 1].id;

  const app = mountRoutes(store);
  const { url, close } = await listen(app);
  try {
    const ok = await fetch(`${url}/api/memory/jobs/${threadId}/entries/${removedId}`, { method: "DELETE" });
    assert.equal(ok.status, 200);
    const after = store.getJobMemory(threadId);
    assert.ok(after);
    assert.equal(after.entries.length, 1);
    assert.equal(after.entries[0].summary, "Stays");
  } finally {
    await close();
  }
});

test("DELETE returns 404 for unknown ids", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "manor-mem-route-"));
  const store = new ButlerStateStore(path.join(dir, "state.json"));
  const app = mountRoutes(store);
  const { url, close } = await listen(app);
  try {
    const a = await fetch(`${url}/api/memory/jobs/missing/entries/missing`, { method: "DELETE" });
    assert.equal(a.status, 404);
    const b = await fetch(`${url}/api/memory/projects/missing/entries/missing`, { method: "DELETE" });
    assert.equal(b.status, 404);
  } finally {
    await close();
  }
});
