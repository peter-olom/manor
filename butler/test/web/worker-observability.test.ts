import assert from "node:assert/strict";
import test from "node:test";

import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { parseHTML } from "linkedom";

import { WorkerJobOutputManifestPanel, WorkerPane, WorkerTurnView, outputArtifactPreview } from "../../src/web/WorkerPane.js";
import { isCurrentWorkerHistoryRequest } from "../../src/web/useWorkerThreadHistory.js";
import { mergeWorkerThreadPages, shapeWorkerTimeline, type WorkerThread } from "../../src/web/worker-timeline.js";

test("Worker history pages merge in chronological order", () => {
  const turn = (index: number) => ({ id: `turn-${index}`, status: "completed", startedAt: index, completedAt: index, items: [] });
  const latest: WorkerThread = { id: "worker-pages", status: "idle", loadedStart: 10, hasMore: true, turnCount: 20, turns: Array.from({ length: 10 }, (_, index) => turn(index + 10)) };
  latest.eventLog = [{ at: 15, method: "runtime.error", summary: "latest" }];
  const earlier: WorkerThread = { id: "worker-pages", status: "idle", loadedStart: 0, hasMore: false, turnCount: 20, turns: Array.from({ length: 10 }, (_, index) => turn(index)), eventLog: [{ at: 5, method: "runtime.error", summary: "earlier" }] };
  const merged = mergeWorkerThreadPages(latest, earlier);
  assert.deepEqual(merged?.turns?.map((entry) => entry.id), Array.from({ length: 20 }, (_, index) => `turn-${index}`));
  assert.deepEqual(merged?.eventLog?.map((entry) => entry.summary), ["earlier", "latest"]);
  assert.equal(merged?.loadedStart, 0);
  assert.equal(merged?.hasMore, false);
});

test("a forward Worker history gap resets to the latest page for backfill", () => {
  const turn = (index: number) => ({ id: `turn-${index}`, status: "completed", startedAt: index, completedAt: index, items: [] });
  const current: WorkerThread = {
    id: "worker-pages",
    status: "idle",
    loadedStart: 10,
    hasMore: true,
    turnCount: 20,
    turns: Array.from({ length: 10 }, (_, index) => turn(index + 10))
  };
  const latest: WorkerThread = {
    id: "worker-pages",
    status: "running",
    loadedStart: 25,
    hasMore: true,
    turnCount: 35,
    turns: Array.from({ length: 10 }, (_, index) => turn(index + 25))
  };

  const refreshed = mergeWorkerThreadPages(current, latest);

  assert.equal(refreshed, latest);
  assert.equal(refreshed?.loadedStart, 25);
  assert.deepEqual(refreshed?.turns?.map((entry) => entry.id), Array.from({ length: 10 }, (_, index) => `turn-${index + 25}`));
});

test("older Worker history pages preserve newer live state", () => {
  const current: WorkerThread = {
    id: "worker-pages",
    status: "running",
    loadedStart: 20,
    turns: [{ id: "turn-20", status: "running", startedAt: 20, completedAt: null, items: [] }],
    supervisor: { summary: "Current supervisor state" },
    jobPayload: { revision: 2, snapshots: [] } as WorkerThread["jobPayload"]
  };
  const older: WorkerThread = {
    id: "worker-pages",
    status: "idle",
    loadedStart: 10,
    turns: [
      { id: "turn-10", status: "completed", startedAt: 10, completedAt: 11, items: [] },
      { id: "turn-20", status: "completed", startedAt: 20, completedAt: 21, items: [] }
    ],
    supervisor: { summary: "Stale supervisor state" },
    jobPayload: { revision: 1, snapshots: [] } as WorkerThread["jobPayload"]
  };

  const merged = mergeWorkerThreadPages(current, older);

  assert.equal(merged?.status, "running");
  assert.equal(merged?.supervisor?.summary, "Current supervisor state");
  assert.equal(merged?.jobPayload?.revision, 2);
  assert.equal(merged?.turns?.find((turn) => turn.id === "turn-20")?.status, "running");
  assert.equal(merged?.loadedStart, 10);

  const refreshed = mergeWorkerThreadPages(merged, {
    ...current,
    status: "idle",
    turns: [{ id: "turn-20", status: "completed", startedAt: 20, completedAt: 22, items: [] }]
  });
  assert.equal(refreshed?.status, "idle");
  assert.equal(refreshed?.turns?.find((turn) => turn.id === "turn-20")?.status, "completed");
  assert.equal(refreshed?.loadedStart, 10);
});

test("Worker history request guards reject stale selection, generation, and sequence", () => {
  const current = { pairId: "pair-2", threadId: "thread-2", generation: 4, requestId: 8 };
  assert.equal(isCurrentWorkerHistoryRequest(current, current), true);
  assert.equal(isCurrentWorkerHistoryRequest({ ...current, pairId: "pair-1" }, current), false);
  assert.equal(isCurrentWorkerHistoryRequest({ ...current, threadId: "thread-1" }, current), false);
  assert.equal(isCurrentWorkerHistoryRequest({ ...current, generation: 3 }, current), false);
  assert.equal(isCurrentWorkerHistoryRequest({ ...current, requestId: 7 }, current), false);
});

test("Worker history preserves original turn numbers on a partial page", () => {
  const timeline = shapeWorkerTimeline({
    id: "worker-page",
    status: "idle",
    loadedStart: 220,
    turnCount: 230,
    turns: [{
      id: "turn-221",
      status: "failed",
      error: "Stopped without a final reply.",
      startedAt: 100,
      completedAt: 200,
      items: []
    }]
  });

  assert.equal(timeline.turns[0]?.ordinal, 221);
  const markup = renderToStaticMarkup(React.createElement(WorkerTurnView, {
    turn: timeline.turns[0]!,
    index: 0,
    payload: null,
    checklist: null,
    proofs: [],
    onPreviewImage: () => undefined
  }));
  assert.match(markup, /aria-label="Worker turn 221 failed"/);
});

test("a no-item Codex failure becomes a durable visible Worker diagnostic", () => {
  const thread: WorkerThread = {
    id: "worker-1",
    status: "idle",
    turns: [{
      id: "turn-failed",
      status: "failed",
      error: "Provider rejected the request before producing output.",
      startedAt: 100,
      completedAt: 200,
      items: []
    }],
    eventLog: [{ at: 150, method: "runtime.error", summary: "Connection closed while starting the turn." }]
  };

  const timeline = shapeWorkerTimeline(thread);
  assert.equal(timeline.turns.length, 1);
  assert.equal(timeline.turns[0]?.status, "failed");
  assert.deepEqual(timeline.turns[0]?.items.map((item) => ({ type: item.type, status: item.status, text: item.text })), [
    { type: "error", status: "failed", text: "Connection closed while starting the turn." },
    { type: "error", status: "failed", text: "Provider rejected the request before producing output." }
  ]);

  const markup = renderToStaticMarkup(React.createElement(WorkerTurnView, {
    turn: timeline.turns[0]!,
    index: 0,
    payload: null,
    checklist: null,
    proofs: [],
    onPreviewImage: () => undefined
  }));
  assert.match(markup, /aria-label="Worker turn 1 failed"/);
  assert.match(markup, /worker-turn-status is-failed">failed/);
  assert.match(markup, /<details[^>]*open/);
  assert.match(markup, /Provider rejected the request before producing output/);
  assert.match(markup, /Connection closed while starting the turn/);
});

test("a cancelled no-item turn renders as a stopped terminal turn", () => {
  const timeline = shapeWorkerTimeline({
    id: "worker-cancelled",
    status: "idle",
    turns: [{
      id: "turn-cancelled",
      status: "cancelled",
      startedAt: 100,
      completedAt: 200,
      items: []
    }]
  });

  assert.equal(timeline.turns.length, 1);
  const markup = renderToStaticMarkup(React.createElement(WorkerTurnView, {
    turn: timeline.turns[0]!,
    index: 0,
    payload: null,
    checklist: null,
    proofs: [],
    onPreviewImage: () => undefined
  }));
  assert.match(markup, /aria-label="Worker turn 1 stopped"/);
  assert.match(markup, /worker-turn-status is-failed">stopped/);
});

test("the Worker lane passes artifact preview handling into the timeline", () => {
  const markup = renderToStaticMarkup(React.createElement(WorkerPane, {
    pair: {
      id: "pair-artifact-preview",
      worker: {
        threadId: "worker-artifact-preview",
        status: "idle",
        provider: "openai-codex",
        model: "gpt-5",
        task: "Create a report",
        cwd: "/repos/manor",
        handoffPrompt: "Create a report",
        startedAt: 1,
        lastRevertAt: null,
        lastReportAt: null,
        lastReportStatus: null,
        lastReportSummary: null,
        lastReviewedReportAt: null
      },
      compose: {
        worker: {
          effort: null,
          availableModels: [],
          availableEfforts: []
        }
      }
    } as never,
    timeline: {
      turns: [],
      report: null,
      reports: [],
      payload: null,
      outputManifest: {
        jobId: "job-artifact-preview",
        projectId: "workspace:shared",
        currentAttemptId: "attempt-job-artifact-preview-1",
        currentScopeId: "scope-current",
        attempt: 1,
        entries: [{
          id: "artifact-entry",
          kind: "project_artifact",
          title: "Preview report",
          threadId: "worker-artifact-preview",
          projectId: "workspace:shared",
          attemptId: "attempt-job-artifact-preview-1",
          scopeId: "scope-current",
          currentAttempt: true,
          currentScope: true,
          sourceTurnId: "turn-1",
          referenceId: "artifact-report-1",
          logicalPath: "report.md",
          createdAt: 1,
          available: true,
          integrity: "verified",
          checksumSha256: "abc123",
          checksumStatus: "verified",
          integrityCheckedAt: 2,
          status: null,
          fileName: "report.md",
          contentType: "text/markdown",
          previewKind: "markdown",
          openUrl: "/api/project-artifacts/workspace%3Ashared/artifact-report-1/file",
          downloadUrl: "/api/project-artifacts/workspace%3Ashared/artifact-report-1/file?download=1"
        }],
        otherCurrentScopeEntries: [{
          id: "proof-entry",
          kind: "proof",
          title: "Preview proof report",
          threadId: "worker-artifact-preview",
          projectId: "workspace:shared",
          attemptId: "attempt-job-artifact-preview-1",
          scopeId: "scope-current",
          currentAttempt: true,
          currentScope: true,
          sourceTurnId: "turn-1",
          referenceId: "file-proof",
          logicalPath: null,
          createdAt: 2,
          available: true,
          integrity: "unverified",
          checksumSha256: null,
          checksumStatus: "unverified",
          integrityCheckedAt: null,
          status: "passed",
          fileName: "proof-report.md",
          contentType: "text/markdown",
          previewKind: "markdown",
          openUrl: "/api/artifacts/files/worker-artifact-preview/file-proof/proof-report.md",
          downloadUrl: "/api/artifacts/files/worker-artifact-preview/file-proof/proof-report.md?download=1"
        }],
        historicalEntries: []
      },
      checklist: null,
      fallback: []
    },
    proofRecords: [],
    onWorkerModelChange: () => undefined,
    onWorkerEffortChange: () => undefined,
    onHandoff: async () => false,
    onOpenProviderSettings: () => undefined,
    onAttachAnnotatedProof: async () => undefined,
    onPreviewProjectFile: () => undefined
  }));

  assert.match(markup, /aria-label="Worker lane"/);
  assert.match(markup, /worker-output-pinned/);
  assert.match(markup, /worker-output-pinned-count/);
});

test("opening a markdown proof sends the proof file to the in-app viewer", async () => {
  const originalDescriptors = new Map<PropertyKey, PropertyDescriptor | undefined>([
    ["window", Object.getOwnPropertyDescriptor(globalThis, "window")],
    ["document", Object.getOwnPropertyDescriptor(globalThis, "document")],
    ["IS_REACT_ACT_ENVIRONMENT", Object.getOwnPropertyDescriptor(globalThis, "IS_REACT_ACT_ENVIRONMENT")]
  ]);
  const setGlobal = (key: PropertyKey, value: unknown) => Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  const dom = parseHTML("<html><body><div id=\"root\"></div></body></html>");
  setGlobal("window", dom.window);
  setGlobal("document", dom.document);
  setGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = dom.document.getElementById("root");
  assert.ok(container);
  const root = createRoot(container);
  let openedPreview: ReturnType<typeof outputArtifactPreview> = null;

  try {
    await act(async () => root.render(React.createElement(WorkerJobOutputManifestPanel, {
      manifest: {
        jobId: "job-proof-preview",
        projectId: "workspace:shared",
        currentAttemptId: "attempt-job-proof-preview-1",
        currentScopeId: "scope-current",
        attempt: 1,
        entries: [{
          id: "proof-markdown",
          kind: "proof",
          title: "Markdown proof",
          threadId: "worker-proof-preview",
          projectId: "workspace:shared",
          attemptId: "attempt-job-proof-preview-1",
          scopeId: "scope-current",
          currentAttempt: true,
          currentScope: true,
          sourceTurnId: "turn-1",
          referenceId: "file-proof",
          logicalPath: null,
          createdAt: 1,
          available: true,
          integrity: "unverified",
          checksumSha256: null,
          checksumStatus: "unverified",
          integrityCheckedAt: null,
          status: "passed",
          fileName: "report.md",
          contentType: "text/markdown",
          previewKind: "markdown",
          openUrl: "/api/artifacts/files/worker-proof-preview/file-proof/report.md",
          downloadUrl: "/api/artifacts/files/worker-proof-preview/file-proof/report.md?download=1"
        }],
        otherCurrentScopeEntries: [],
        historicalEntries: []
      },
      onOpenArtifact: (entry) => { openedPreview = outputArtifactPreview(entry); }
    })));
    const openButton = dom.document.querySelector('button[aria-label="Open Markdown proof"]') as HTMLButtonElement | null;
    assert.ok(openButton);
    await act(async () => openButton.click());
    assert.deepEqual(openedPreview, {
      id: "file-proof",
      name: "report.md",
      mimeType: "text/markdown",
      previewKind: "markdown",
      previewUrl: "/api/artifacts/files/worker-proof-preview/file-proof/report.md?preview=1",
      downloadUrl: "/api/artifacts/files/worker-proof-preview/file-proof/report.md?download=1"
    });
  } finally {
    await act(async () => root.unmount());
    for (const [key, descriptor] of originalDescriptors) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete (globalThis as Record<PropertyKey, unknown>)[key];
    }
  }
});

test("the Worker lane renders durable job outputs with provenance, integrity, and actions", () => {
  const markup = renderToStaticMarkup(React.createElement(WorkerJobOutputManifestPanel, {
    manifest: {
      jobId: "pi-job-3ebf4711d2d4",
      projectId: "workspace:shared",
      currentAttemptId: "attempt-pi-job-3ebf4711d2d4-2",
      attempt: 2,
      entries: [
        {
          id: "artifact-entry",
          kind: "project_artifact",
          title: "Relocation options report",
          threadId: "pi-job-3ebf4711d2d4",
          projectId: "workspace:shared",
          attemptId: "attempt-pi-job-3ebf4711d2d4-2",
          currentAttempt: true,
          sourceTurnId: "turn-65",
          referenceId: "artifact-report-1",
          logicalPath: "reports/relocation-options.md",
          createdAt: 20,
          available: true,
          integrity: "verified",
          checksumSha256: "abcdef1234567890",
          checksumStatus: "verified",
          integrityCheckedAt: 21,
          status: null,
          fileName: "relocation-options.md",
          contentType: "text/markdown",
          previewKind: "markdown",
          openUrl: "/api/project-artifacts/workspace%3Ashared/artifact-report-1/file",
          downloadUrl: "/api/project-artifacts/workspace%3Ashared/artifact-report-1/file?download=1"
        },
        {
          id: "proof-entry",
          kind: "proof",
          title: "Source verification",
          threadId: "pi-job-3ebf4711d2d4",
          projectId: "workspace:shared",
          attemptId: "attempt-pi-job-3ebf4711d2d4-2",
          currentAttempt: true,
          sourceTurnId: "turn-60",
          referenceId: "proof-run-1",
          logicalPath: null,
          createdAt: 10,
          available: true,
          integrity: "unverified",
          checksumSha256: null,
          checksumStatus: "unverified",
          integrityCheckedAt: null,
          status: "recorded",
          fileName: "sources.txt",
          contentType: "text/plain",
          previewKind: "text",
          openUrl: "/api/proofs/proof-run-1/sources.txt",
          downloadUrl: null
        },
        {
          id: "report-entry",
          kind: "worker_report",
          title: "Worker report",
          threadId: "pi-job-3ebf4711d2d4",
          projectId: "workspace:shared",
          attemptId: "attempt-pi-job-3ebf4711d2d4-2",
          currentAttempt: true,
          sourceTurnId: "turn-65",
          referenceId: "turn-65",
          logicalPath: null,
          createdAt: 30,
          available: false,
          integrity: "missing",
          checksumSha256: null,
          checksumStatus: "unverified",
          integrityCheckedAt: null,
          status: "completed",
          fileName: null,
          contentType: null,
          previewKind: null,
          openUrl: null,
          downloadUrl: null
        }
      ]
    }
  }));

  assert.match(markup, /aria-label="Current task outputs"/);
  assert.match(markup, /Job 3ebf4711d2d4 · Attempt 2/);
  assert.match(markup, /Relocation options report/);
  assert.match(markup, /Attempt 2/);
  assert.match(markup, /reports\/relocation-options\.md/);
  assert.match(markup, />Available</);
  assert.match(markup, />Checksum verified</);
  assert.match(markup, /worker-output-integrity is-record">Not checksum-backed/);
  assert.match(markup, /sha256 abcdef1234/);
  assert.match(markup, /Integrity checked/);
  assert.match(markup, />Missing</);
  assert.match(markup, /href="\/api\/project-artifacts\/workspace%3Ashared\/artifact-report-1\/file"/);
  assert.match(markup, /href="\/api\/project-artifacts\/workspace%3Ashared\/artifact-report-1\/file\?download=1"/);
});

test("the Worker job output surface makes an empty manifest explicit", () => {
  const markup = renderToStaticMarkup(React.createElement(WorkerJobOutputManifestPanel, {
    manifest: {
      jobId: "pi-job-empty",
      projectId: "workspace:shared",
      currentAttemptId: "attempt-pi-job-empty-1",
      attempt: 1,
      entries: []
    }
  }));

  assert.match(markup, /0 outputs/);
  assert.match(markup, /No outputs claimed by the current Worker report/);
});

test("the Worker output surface keeps unclaimed and earlier task outputs collapsed", () => {
  const entry = (id: string, currentScope: boolean, attempt = 3) => ({
    id,
    kind: "worker_report" as const,
    title: id,
    threadId: "pi-job-scoped",
    projectId: "workspace:shared",
    attemptId: `attempt-pi-job-scoped-${attempt}`,
    scopeId: currentScope ? "scope-current" : "scope-old",
    currentAttempt: attempt === 3,
    currentScope,
    sourceTurnId: id,
    referenceId: id,
    logicalPath: null,
    createdAt: currentScope ? 2 : 1,
    available: true,
    integrity: "unverified" as const,
    checksumSha256: null,
    checksumStatus: "unverified" as const,
    integrityCheckedAt: null,
    status: "completed",
    fileName: null,
    contentType: null,
    previewKind: null,
    openUrl: null,
    downloadUrl: null
  });
  const markup = renderToStaticMarkup(React.createElement(WorkerJobOutputManifestPanel, {
    manifest: {
      jobId: "pi-job-scoped",
      projectId: "workspace:shared",
      currentAttemptId: "attempt-pi-job-scoped-3",
      currentScopeId: "scope-current",
      attempt: 3,
      entries: [entry("Current report", true)],
      otherCurrentScopeEntries: [entry("Unclaimed log", true)],
      historicalEntries: [entry("Old preview report", false, 1)]
    }
  }));

  assert.match(markup, /Current task outputs/);
  assert.match(markup, /Other outputs from this task \(1\)/);
  assert.match(markup, /Earlier task outputs \(1\)/);
  assert.match(markup, /<details class="worker-output-history">/);
  assert.match(markup, /Old preview report[\s\S]*Attempt 1/);
});

test("the Worker output surface separates failed proof outcome and suppresses missing artifact actions", () => {
  const markup = renderToStaticMarkup(React.createElement(WorkerJobOutputManifestPanel, {
    manifest: {
      jobId: "pi-job-status",
      projectId: "workspace:shared",
      currentAttemptId: "attempt-pi-job-status-1",
      attempt: 1,
      entries: [
        {
          id: "missing-artifact",
          kind: "project_artifact",
          title: "Missing report",
          threadId: "pi-job-status",
          projectId: "workspace:shared",
          attemptId: "attempt-pi-job-status-1",
          currentAttempt: true,
          sourceTurnId: "turn-1",
          referenceId: "artifact-missing",
          logicalPath: "report.md",
          createdAt: 1,
          available: false,
          integrity: "missing",
          checksumSha256: "deadbeef",
          checksumStatus: "unverified",
          integrityCheckedAt: 2,
          status: null,
          fileName: "report.md",
          contentType: "text/markdown",
          previewKind: null,
          openUrl: "/api/project-artifacts/workspace%3Ashared/artifact-missing/file",
          downloadUrl: "/api/project-artifacts/workspace%3Ashared/artifact-missing/file?download=1"
        },
        {
          id: "expired-proof",
          kind: "proof",
          title: "Expired browser proof",
          threadId: "pi-job-status",
          projectId: "workspace:shared",
          attemptId: "attempt-pi-job-status-1",
          currentAttempt: true,
          sourceTurnId: "turn-1",
          referenceId: "proof-expired",
          logicalPath: null,
          createdAt: 2,
          available: true,
          integrity: "unverified",
          checksumSha256: null,
          checksumStatus: "unverified",
          integrityCheckedAt: null,
          status: "expired",
          fileName: null,
          contentType: null,
          previewKind: null,
          openUrl: null,
          downloadUrl: null
        },
        {
          id: "missing-proof",
          kind: "proof",
          title: "Missing browser proof",
          threadId: "pi-job-status",
          projectId: "workspace:shared",
          attemptId: "attempt-pi-job-status-1",
          currentAttempt: true,
          sourceTurnId: "turn-1",
          referenceId: "proof-missing",
          logicalPath: null,
          createdAt: 3,
          available: true,
          integrity: "unverified",
          checksumSha256: null,
          checksumStatus: "unverified",
          integrityCheckedAt: null,
          status: "missing",
          fileName: null,
          contentType: null,
          previewKind: null,
          openUrl: null,
          downloadUrl: null
        }
      ]
    }
  }));

  assert.match(markup, /worker-output-outcome is-negative">Proof expired/);
  assert.match(markup, /worker-output-outcome is-negative">Proof missing/);
  assert.match(markup, /worker-output-integrity is-record">Not checksum-backed/);
  assert.doesNotMatch(markup, /href="\/api\/project-artifacts\/workspace%3Ashared\/artifact-missing/);
  assert.doesNotMatch(markup, /aria-label="Open Missing report"/);
  assert.doesNotMatch(markup, /aria-label="Download Missing report"/);
});

test("the Worker output surface offers download-only actions for non-previewable files", () => {
  const markup = renderToStaticMarkup(React.createElement(WorkerJobOutputManifestPanel, {
    manifest: {
      jobId: "pi-job-docx",
      projectId: "workspace:shared",
      currentAttemptId: "attempt-pi-job-docx-1",
      currentScopeId: "scope-current",
      attempt: 1,
      entries: [{
        id: "docx-entry",
        kind: "project_artifact",
        title: "Word brief",
        threadId: "pi-job-docx",
        projectId: "workspace:shared",
        attemptId: "attempt-pi-job-docx-1",
        scopeId: "scope-current",
        currentAttempt: true,
        currentScope: true,
        sourceTurnId: "turn-1",
        referenceId: "artifact-docx",
        logicalPath: "brief.docx",
        createdAt: 1,
        available: true,
        integrity: "verified",
        checksumSha256: "abc123",
        checksumStatus: "verified",
        integrityCheckedAt: 2,
        status: null,
        fileName: "brief.docx",
        contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        previewKind: null,
        openUrl: null,
        downloadUrl: "/api/project-artifacts/workspace%3Ashared/artifact-docx/file?download=1"
      }]
    }
  }));

  assert.match(markup, />Download only</);
  assert.match(markup, /aria-label="Download Word brief"/);
  assert.doesNotMatch(markup, /aria-label="Open Word brief"/);
});
