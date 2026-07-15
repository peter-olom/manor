import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { ButlerStateStore } from "../../src/server/state-store.js";
import {
  groupProofsByTurn,
  isPreviewableProofImage,
  isPreviewableProofVideo,
  proofsForLoadedWorkerWindow,
  proofsForFinalReport,
  WorkerTurnView,
  type WorkerProofArtifact,
  type WorkerProofRecord,
  type WorkerReport,
  type WorkerTurnGroup
} from "../../src/web/WorkerPane.js";

async function createStore(): Promise<ButlerStateStore> {
  const dir = await mkdtemp(path.join(tmpdir(), "manor-worker-proof-"));
  return new ButlerStateStore(path.join(dir, "state.json"));
}

function proof(id: string, runId: string, checkedAt: number): WorkerProofRecord {
  return {
    id,
    previewTitle: runId,
    createdAt: checkedAt,
    updatedAt: checkedAt,
    verification: {
      runId,
      ok: true,
      failureKind: "none",
      checkedAt,
      url: "",
      artifacts: []
    },
    proofReviews: []
  };
}

function imageArtifact(overrides: Partial<WorkerProofArtifact> = {}): WorkerProofArtifact {
  return {
    kind: "file",
    label: "Design screenshot",
    fileName: "design.png",
    contentType: "image/png",
    sizeBytes: 100,
    url: "/api/proofs/design.png",
    downloadUrl: "/api/proofs/design.png?download=1",
    availability: "available",
    ...overrides
  };
}

function videoArtifact(overrides: Partial<WorkerProofArtifact> = {}): WorkerProofArtifact {
  return imageArtifact({
    kind: "video",
    label: "Interaction video",
    fileName: "video.webm",
    contentType: "video/webm",
    url: "/api/proofs/video.webm",
    downloadUrl: "/api/proofs/video.webm?download=1",
    ...overrides
  });
}

function turn(id: string): WorkerTurnGroup {
  return {
    id,
    status: "completed",
    startedAt: 5000,
    completedAt: 6000,
    finalIndex: 0,
    items: [
      {
        id: `${id}:final`,
        type: "agentMessage",
        status: "completed",
        text: "Done",
        at: 6000
      }
    ]
  };
}

test("partial Worker history excludes proofs from before the loaded turn window", () => {
  const turns = [turn("turn-current")];
  const oldProof = proof("proof-old", "run-old", 4_999);
  const currentProof = proof("proof-current", "run-current", 5_000);
  const laterProof = proof("proof-later", "run-later", 5_500);

  assert.deepEqual(
    proofsForLoadedWorkerWindow(turns, [oldProof, currentProof, laterProof], true).map((entry) => entry.id),
    ["proof-current", "proof-later"]
  );
  assert.deepEqual(
    proofsForLoadedWorkerWindow(turns, [oldProof, currentProof, laterProof], false).map((entry) => entry.id),
    ["proof-old", "proof-current", "proof-later"]
  );

  const report: WorkerReport = {
    turnId: "turn-current",
    status: "completed",
    summary: "Done",
    details: null,
    evidence: [{ proofRunId: "run-old" }],
    updatedAt: 6_000
  };
  assert.deepEqual(
    proofsForLoadedWorkerWindow(turns, [oldProof, currentProof], true, [report]).map((entry) => entry.id),
    ["proof-old", "proof-current"]
  );
});

test("worker proof grouping uses report proof references before timestamp fallback", () => {
  const turns = [turn("turn-1"), turn("turn-2")];
  const reports: WorkerReport[] = [
    {
      turnId: "turn-1",
      status: "completed",
      summary: "Turn 1",
      details: null,
      evidence: [{ proofRunId: "proof-run-1" }],
      claims: { claims: [{ proofId: "browser:thread-1:file-proof-1" }] },
      updatedAt: 7000
    },
    {
      turnId: "turn-2",
      status: "completed",
      summary: "Turn 2",
      details: null,
      evidence: [{ proofRunId: "proof-run-2" }],
      updatedAt: 8000
    }
  ];
  const grouped = groupProofsByTurn(
    turns,
    [
      proof("browser:thread-1:file-proof-1", "file-proof-1", 1000),
      proof("browser:thread-1:proof-run-1", "proof-run-1", 1000),
      proof("browser:thread-1:proof-run-2", "proof-run-2", 1000)
    ],
    reports
  );

  assert.deepEqual(grouped.get("turn-1")?.map((entry) => entry.verification.runId), ["file-proof-1", "proof-run-1"]);
  assert.deepEqual(grouped.get("turn-2")?.map((entry) => entry.verification.runId), ["proof-run-2"]);
});

test("thread detail exposes worker report history for per-turn proof anchoring", async () => {
  const store = await createStore();
  store.upsertThreadSummary({
    id: "thread-1",
    status: "idle",
    cwd: "/workspace",
    turns: [
      { id: "turn-1", status: "completed", items: [] },
      { id: "turn-2", status: "completed", items: [] }
    ]
  });

  store.recordWorkerReport("thread-1", {
    turnId: "turn-1",
    status: "completed",
    summary: "First turn",
    evidence: [{ id: "ev-1", pointId: null, matrixRowId: null, kind: "browser_flow", summary: "proof one", details: null, command: null, exitCode: null, proofRunId: "proof-1", artifactId: null, route: null, logRef: null, dataRef: null, createdAt: 1 }]
  });
  store.recordWorkerReport("thread-1", {
    turnId: "turn-2",
    status: "completed",
    summary: "Second turn",
    evidence: [{ id: "ev-2", pointId: null, matrixRowId: null, kind: "browser_flow", summary: "proof two", details: null, command: null, exitCode: null, proofRunId: "proof-2", artifactId: null, route: null, logRef: null, dataRef: null, createdAt: 2 }]
  });

  const detail = store.getThreadDetail("thread-1");
  assert.deepEqual(detail?.workerReports?.map((report) => [report.turnId, report.evidence[0]?.proofRunId]), [
    ["turn-1", "proof-1"],
    ["turn-2", "proof-2"]
  ]);
  assert.equal(detail?.workerReport?.turnId, "turn-2");
});

test("worker proof screenshots open through the in-app preview callback", () => {
  const screenshot = proof("image-proof", "image-run", 1_000);
  screenshot.verification.artifacts = [imageArtifact()];
  const markup = renderToStaticMarkup(React.createElement(WorkerTurnView, {
    turn: turn("turn-1"),
    index: 0,
    payload: null,
    checklist: null,
    proofs: [screenshot],
    onPreviewImage: () => undefined
  }));
  assert.match(markup, /class="worker-proof-shots"/);
  assert.match(markup, /<button[^>]*title="Design screenshot"/);
  assert.doesNotMatch(markup, /target="_blank"/);
});

test("generic image file proofs are eligible for inline preview", () => {
  assert.equal(isPreviewableProofImage(imageArtifact()), true);
  assert.equal(isPreviewableProofImage(imageArtifact({ contentType: "application/pdf" })), false);
  assert.equal(isPreviewableProofImage(imageArtifact({ availability: "expired" })), false);
});

test("available video proofs are eligible for inline playback", () => {
  assert.equal(isPreviewableProofVideo(videoArtifact()), true);
  assert.equal(isPreviewableProofVideo(videoArtifact({ availability: "expired" })), false);
  assert.equal(isPreviewableProofVideo(videoArtifact({ url: null })), false);
});

test("worker proof video renders inline with direct actions", () => {
  const recording = proof("video-proof", "video-run", 1_000);
  recording.verification.artifacts = [videoArtifact()];
  const markup = renderToStaticMarkup(React.createElement(WorkerTurnView, {
    turn: turn("turn-1"),
    index: 0,
    payload: null,
    checklist: null,
    proofs: [recording],
    onPreviewImage: () => undefined
  }));
  assert.match(markup, /<video[^>]*src="\/api\/proofs\/video\.webm"/);
  assert.match(markup, /controls=""/);
  assert.match(markup, /playsInline=""/);
  assert.match(markup, /preload="none"/);
  assert.match(markup, />Expand<\/button>/);
  assert.match(markup, />Open<\/a>/);
  assert.match(markup, />Download<\/a>/);
});

test("all proof records for a worker turn render in one evidence group", () => {
  const screenshot = proof("image-proof", "image-run", 1_000);
  screenshot.previewTitle = "Counter initial state";
  screenshot.verification.artifacts = [imageArtifact({ label: "Initial state", sizeBytes: 101 })];
  const recording = proof("browser-proof", "browser-run", 2_000);
  recording.previewTitle = "click-counter";
  recording.verification.artifacts = [
    imageArtifact({ label: "Final screenshot", fileName: "final.png", url: "/api/proofs/final.png" }),
    videoArtifact()
  ];

  const markup = renderToStaticMarkup(React.createElement(WorkerTurnView, {
    turn: turn("turn-1"),
    index: 0,
    payload: null,
    checklist: null,
    proofs: [screenshot, recording],
    onPreviewImage: () => undefined
  }));

  assert.equal(markup.match(/class="worker-proof-card /g)?.length, 1);
  assert.match(markup, /Evidence attached/);
  assert.match(markup, /1 browser run/);
  assert.match(markup, /<h3>click-counter<\/h3>/);
  assert.match(markup, /3 artifacts · 2 screenshots · 1 video/);
  assert.match(markup, /2 source records/);
  assert.match(markup, /Counter initial state/);
  assert.match(markup, /browser-run/);
});

test("standalone screenshot copies become aliases on their browser capture", () => {
  const copy = proof("copy-proof", "file-copy", 2_000);
  copy.previewTitle = "Counter at three";
  copy.verification.artifacts = [imageArtifact({ kind: "file", label: "Counter at three", sizeBytes: 123, url: "/api/proofs/state-at-3.png" })];
  const browser = proof("browser-proof", "browser-run", 1_000);
  browser.previewTitle = "click-counter";
  browser.verification.artifacts = [imageArtifact({ kind: "screenshot", label: "state-at-3", sizeBytes: 123, url: "/api/proofs/state-at-3.png" })];

  const markup = renderToStaticMarkup(React.createElement(WorkerTurnView, {
    turn: turn("turn-1"),
    index: 0,
    payload: null,
    checklist: null,
    proofs: [browser, copy],
    onPreviewImage: () => undefined
  }));

  assert.equal(markup.match(/<img /g)?.length, 1);
  assert.match(markup, /1 linked copy/);
  assert.match(markup, /state-at-3 · Counter at three/);
  assert.match(markup, /2 source records/);
});

test("same-sized screenshots remain visible when their immutable identities differ", () => {
  const standalone = proof("standalone", "standalone-run", 2_000);
  standalone.verification.artifacts = [imageArtifact({ label: "Standalone", sizeBytes: 123, url: "/api/proofs/standalone.png" })];
  const browser = proof("browser", "browser-run", 1_000);
  browser.verification.artifacts = [imageArtifact({ kind: "screenshot", label: "Browser", sizeBytes: 123, url: "/api/proofs/browser.png" })];

  const markup = renderToStaticMarkup(React.createElement(WorkerTurnView, {
    turn: turn("turn-1"),
    index: 0,
    payload: null,
    checklist: null,
    proofs: [standalone, browser],
    onPreviewImage: () => undefined
  }));

  assert.equal(markup.match(/<img /g)?.length, 2);
  assert.doesNotMatch(markup, /linked cop/);
  assert.ok(markup.indexOf('alt="Browser"') < markup.indexOf('alt="Standalone"'));
});

test("expanded proof galleries provide button and keyboard cycling", async () => {
  const workerSource = await readFile(new URL("../../src/web/WorkerPane.tsx", import.meta.url), "utf8");
  const previewSource = await readFile(new URL("../../src/web/ImagePreviewModal.tsx", import.meta.url), "utf8");
  assert.match(workerSource, /cyclePreview\(-1\)/);
  assert.match(workerSource, /cyclePreview\(1\)/);
  assert.match(workerSource, /const browserEntries = browserProofs\.flatMap/);
  assert.match(workerSource, /\.sort\(compareProofEntries\)/);
  assert.match(workerSource, /const gallery = mediaEntries\.map/);
  assert.match(previewSource, /aria-label="Previous proof"/);
  assert.match(previewSource, /aria-label="Next proof"/);
  assert.match(previewSource, /aria-live="polite" aria-atomic="true"/);
  assert.match(previewSource, /aria-label="Close proof preview"/);
  assert.match(previewSource, /event\.key === "ArrowLeft"/);
  assert.match(previewSource, /event\.key === "ArrowRight"/);
});

test("expired video proof remains visible without an unusable player", () => {
  const recording = proof("video-proof", "video-run", 1_000);
  recording.verification.artifacts = [videoArtifact({ availability: "expired", url: null, downloadUrl: null })];
  const markup = renderToStaticMarkup(React.createElement(WorkerTurnView, {
    turn: turn("turn-1"),
    index: 0,
    payload: null,
    checklist: null,
    proofs: [recording],
    onPreviewImage: () => undefined
  }));
  assert.doesNotMatch(markup, /<video/);
  assert.match(markup, /Interaction video · expired/);
});

test("latest worker report presents referenced proof and falls back to newest visual proof", () => {
  const older = proof("proof-older", "run-older", 1000);
  older.verification.artifacts = [imageArtifact({ url: "/api/proofs/older.png" })];
  const newer = proof("proof-newer", "run-newer", 2000);
  newer.verification.artifacts = [imageArtifact({ url: "/api/proofs/newer.png" })];
  const newest = proof("proof-newest", "run-newest", 2500);
  newest.verification.artifacts = [imageArtifact({ url: "/api/proofs/newest.png" })];
  const fourth = proof("proof-fourth", "run-fourth", 500);
  fourth.verification.artifacts = [imageArtifact({ url: "/api/proofs/fourth.png" })];
  const referenced: WorkerReport = {
    turnId: "turn-1",
    status: "completed",
    summary: "Done",
    details: null,
    evidence: [{ proofRunId: "run-older" }],
    updatedAt: 3000
  };
  const unreferenced = { ...referenced, evidence: [] };

  const proofs = [older, newer, newest, fourth];
  assert.deepEqual(proofsForFinalReport(referenced, proofs).map((entry) => entry.id), [
    "proof-newest",
    "proof-newer",
    "proof-older",
    "proof-fourth"
  ]);
  assert.deepEqual(proofsForFinalReport(unreferenced, proofs).map((entry) => entry.id), [
    "proof-newest",
    "proof-newer",
    "proof-older",
    "proof-fourth"
  ]);
});

test("latest report fallback never adopts visual proof from an earlier report window", () => {
  const earlier: WorkerReport = {
    turnId: "turn-1",
    status: "completed",
    summary: "Earlier task",
    details: null,
    evidence: [],
    updatedAt: 2_000
  };
  const latest: WorkerReport = {
    turnId: "turn-2",
    status: "completed",
    summary: "Later non-visual task",
    details: null,
    evidence: [],
    updatedAt: 5_000
  };
  const stale = proof("stale-proof", "stale-run", 1_500);
  stale.verification.artifacts = [imageArtifact({ url: "/api/proofs/stale.png" })];

  assert.deepEqual(proofsForFinalReport(latest, [stale], [earlier, latest]), []);
});

test("latest report fallback includes a video-only visual proof", () => {
  const report: WorkerReport = {
    turnId: "turn-1",
    status: "completed",
    summary: "Video task",
    details: null,
    evidence: [],
    updatedAt: 3_000
  };
  const video = proof("video-proof", "video-run", 2_500);
  video.verification.artifacts = [videoArtifact()];

  assert.deepEqual(proofsForFinalReport(report, [video]).map((entry) => entry.id), ["video-proof"]);
});

test("latest report fallback stops at the next Worker turn", () => {
  const report: WorkerReport = {
    turnId: "turn-1",
    status: "completed",
    summary: "Visual task",
    details: null,
    evidence: [],
    updatedAt: 5_000
  };
  const current = proof("current-proof", "current-run", 5_100);
  const nextTask = proof("next-proof", "next-run", 5_300);
  current.verification.artifacts = [imageArtifact({ url: "/api/proofs/current.png" })];
  nextTask.verification.artifacts = [imageArtifact({ url: "/api/proofs/next.png" })];
  const turns = [turn("turn-1"), turn("turn-2")];
  turns[0]!.startedAt = 4_000;
  turns[1]!.startedAt = 5_200;

  assert.deepEqual(proofsForFinalReport(report, [current, nextTask], [report], turns).map((entry) => entry.id), ["current-proof"]);
});

test("proof gallery does not hide screenshot overflow", async () => {
  const source = await readFile(new URL("../../src/web/WorkerPane.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(source, /proofs\.slice\(0, 4\)/);
  assert.doesNotMatch(source, /filter\(isPreviewableProofImage\)\.slice\(0, 3\)/);
});

test("unreferenced report anchors every recent visual proof bundle to its final turn", () => {
  const turns = [turn("turn-1"), turn("turn-2")];
  turns[0]!.startedAt = 1000;
  turns[0]!.completedAt = 2000;
  turns[1]!.startedAt = 3000;
  turns[1]!.completedAt = 5000;
  const report: WorkerReport = {
    turnId: "turn-2",
    status: "completed",
    summary: "Visual task complete",
    details: null,
    evidence: [],
    updatedAt: 5000
  };
  const proofs = [
    proof("visual-1", "visual-run-1", 3500),
    proof("visual-2", "visual-run-2", 4000),
    proof("visual-3", "visual-run-3", 4500),
    proof("visual-4", "visual-run-4", 4600)
  ];
  for (const [index, entry] of proofs.entries()) {
    entry.verification.artifacts = [imageArtifact({ url: `/api/proofs/visual-${index + 1}.png` })];
  }

  assert.deepEqual(groupProofsByTurn(turns, proofs, [report]).get("turn-2")?.map((entry) => entry.id), [
    "visual-4",
    "visual-3",
    "visual-2",
    "visual-1"
  ]);
});

test("proof from an active next turn stays with that turn", () => {
  const report: WorkerReport = {
    turnId: "turn-1",
    status: "completed",
    summary: "Visual task complete",
    details: null,
    evidence: [],
    updatedAt: 5_000
  };
  const current = proof("current-proof", "current-run", 5_100);
  const nextTask = proof("next-proof", "next-run", 5_300);
  current.verification.artifacts = [imageArtifact({ url: "/api/proofs/current.png" })];
  nextTask.verification.artifacts = [imageArtifact({ url: "/api/proofs/next.png" })];
  const turns = [turn("turn-1"), turn("turn-2")];
  turns[0]!.startedAt = 4_000;
  turns[1]!.startedAt = 5_200;
  turns[1]!.completedAt = null;
  turns[1]!.status = "running";

  const grouped = groupProofsByTurn(turns, [current, nextTask], [report]);
  assert.deepEqual(grouped.get("turn-1")?.map((entry) => entry.id), ["current-proof"]);
  assert.deepEqual(grouped.get("turn-2")?.map((entry) => entry.id), ["next-proof"]);
});

test("completed command-only turns still render attached proof", async () => {
  const source = await readFile(new URL("../../src/web/WorkerPane.tsx", import.meta.url), "utf8");
  assert.match(source, /<WorkerProofBundleList proofs=\{proofs\} onPreviewImage=\{onPreviewImage\} \/>/);
  assert.doesNotMatch(source, /finalItem \? <WorkerProofBundleList proofs=\{proofs\}/);
});

test("preview annotation inserts are consumed by the pair composer", async () => {
  const streamSource = await readFile(new URL("../../src/web/useEventStream.ts", import.meta.url), "utf8");
  const pairSource = await readFile(new URL("../../src/web/PairShell.tsx", import.meta.url), "utf8");
  assert.match(streamSource, /source\.addEventListener\("composerPrefill"/);
  assert.match(pairSource, /onComposerPrefill/);
  assert.match(pairSource, /setComposerAttachments/);
  assert.match(pairSource, /imageReferenceIds: composerAttachments/);
});
