import assert from "node:assert/strict";
import { chmod, mkdtemp, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { CodexExecMemoryReviewService } from "../../src/server/memory-review.js";
import { ButlerStateStore } from "../../src/server/state-store.js";
import type { CodexThreadExecutionContractView, CodexWorkerReportView } from "../../src/server/types.js";

type MemoryReviewTestCandidate = {
  kind: "checkpoint" | "decision" | "note";
  summary: string;
  details: string | null;
  confidence: "high" | "medium" | "low";
  reason: string;
};

type MemoryReviewTestOutput = {
  candidates: MemoryReviewTestCandidate[];
};

async function createStore(): Promise<{ store: ButlerStateStore; stateDir: string }> {
  const stateDir = await mkdtemp(path.join(tmpdir(), "manor-memory-review-test-"));
  const store = new ButlerStateStore(path.join(stateDir, "state.json"));
  return { store, stateDir };
}

function makeContract(): CodexThreadExecutionContractView {
  return {
    threadId: "thread-1",
    workspaceCwd: "/workspace",
    projectId: "project-1",
    projectLabel: "Project One",
    branch: "main",
    requestedTask: "Review a pull request and report the verdict.",
    operatorGoal: "Know whether the pull request is safe to merge.",
    acceptancePoints: ["Review the diff", "Run checks", "Report verdict"],
    proofExpectation: "not_requested",
    proofExpectationLabel: "no explicit proof request",
    notes: []
  };
}

function seedReportedThread(store: ButlerStateStore): CodexWorkerReportView {
  const contract = makeContract();
  store.upsertThreadSummary({
    id: contract.threadId,
    status: "idle",
    cwd: contract.workspaceCwd,
    turns: [{ id: "turn-1", status: "completed", items: [] }]
  });
  store.setThreadExecutionContract(contract.threadId, contract);
  return store.recordWorkerReport(contract.threadId, {
    turnId: "turn-1",
    status: "completed",
    summary: "PR review completed: request changes.",
    details: "Blocking finding: applicant-facing status misses offer accepted and declined states."
  });
}

function reviewSourcePrefix(report: CodexWorkerReportView): string {
  return `worker-report:${report.turnId}:${report.updatedAt}:`;
}

async function waitFor(assertion: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (assertion()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail("condition was not met before timeout");
}

test("memory review creates pending durable candidates from high and medium confidence output", async () => {
  const { store, stateDir } = await createStore();
  const report = seedReportedThread(store);
  let runnerInput: { cwd: string; prompt: string; timeoutMs: number } | null = null;
  const service = new CodexExecMemoryReviewService({
    store,
    stateDir,
    codexHomeDir: stateDir,
    runner: async (input) => {
      runnerInput = input;
      return {
        candidates: [
          {
            kind: "decision",
            summary: "PR review verdict: request changes for applicant-facing offer status mapping.",
            details: "Accepted and declined offer states need explicit derived-state handling before merge.",
            confidence: "high",
            reason: "A PR verdict and its blocking finding are reusable follow-up context."
          },
          {
            kind: "note",
            summary: "Routine checks passed.",
            details: null,
            confidence: "low",
            reason: "This is ordinary execution noise."
          }
        ]
      };
    }
  });

  const submitted = await service.reviewWorkerReport(report);
  const pending = store.listPendingPromotionCandidates("/workspace");

  assert.equal(submitted.length, 1);
  assert.equal(pending.length, 1);
  assert.equal(pending[0]?.kind, "decision");
  assert.equal(pending[0]?.sourceEntryId.startsWith(`${reviewSourcePrefix(report)}candidate:`), true);
  assert.match(pending[0]?.details ?? "", /Memory review confidence: high/);
  assert.match(pending[0]?.details ?? "", /blocking finding/);
  assert.equal(store.getProjectMemory("/workspace"), null);
  assert.equal(store.getJobMemory(report.threadId)?.entries.some((entry) => entry.id === `${reviewSourcePrefix(report)}review-pending`), true);
  assert.equal(store.getJobMemory(report.threadId)?.entries.some((entry) => entry.id === `${reviewSourcePrefix(report)}review-state`), true);
  assert.ok(runnerInput);
  assert.doesNotMatch(runnerInput.prompt, /latestEvidence/);
});

test("memory review does not duplicate candidates for the same worker report", async () => {
  const { store, stateDir } = await createStore();
  const report = seedReportedThread(store);
  const service = new CodexExecMemoryReviewService({
    store,
    stateDir,
    codexHomeDir: stateDir,
    runner: async () => ({
      candidates: [
        {
          kind: "checkpoint",
          summary: "Durable repo state changed.",
          details: "The local repository was moved into the grouped workspace.",
          confidence: "medium",
          reason: "Repo state can affect future job targeting."
        }
      ]
    })
  });

  await service.reviewWorkerReport(report);
  await service.reviewWorkerReport(report);

  assert.equal(store.listPendingPromotionCandidates("/workspace").length, 1);
});

test("async memory review reruns latest report update and drops stale output", async () => {
  const { store, stateDir } = await createStore();
  const report = seedReportedThread(store);
  let resolveRunner: ((value: { candidates: MemoryReviewTestOutput["candidates"] }) => void) | null = null;
  let runs = 0;
  const service = new CodexExecMemoryReviewService({
    store,
    stateDir,
    codexHomeDir: stateDir,
    runner: async () => {
      runs += 1;
      if (runs === 1) {
        return await new Promise<MemoryReviewTestOutput>((resolve) => {
          resolveRunner = resolve;
        });
      }
      return {
        candidates: [
          {
            kind: "decision",
            summary: "Final report contains durable memory.",
            details: "This should be the only submitted candidate.",
            confidence: "high",
            reason: "The final report supersedes the stale report."
          }
        ]
      };
    }
  });

  service.reviewWorkerReportAsync(report);
  const updatedReport = store.recordWorkerReport(report.threadId, {
    turnId: report.turnId,
    status: "completed",
    summary: "Updated PR review completed.",
    details: "Final report contains durable memory."
  });
  service.reviewWorkerReportAsync(updatedReport);
  await new Promise((resolve) => setImmediate(resolve));
  resolveRunner?.({
    candidates: [
      {
        kind: "decision",
        summary: "Stale report candidate.",
        details: "This should not be submitted.",
        confidence: "high",
        reason: "The stale report should be discarded."
      }
    ]
  });
  await waitFor(() => runs === 2 && store.listPendingPromotionCandidates("/workspace").length === 1);

  const pending = store.listPendingPromotionCandidates("/workspace");
  assert.equal(pending[0]?.summary, "Final report contains durable memory.");
  assert.equal(pending[0]?.sourceEntryId.startsWith(`${reviewSourcePrefix(updatedReport)}candidate:`), true);
});

test("memory review persists outcome candidates after the job thread is deleted", async () => {
  const { store, stateDir } = await createStore();
  const report = seedReportedThread(store);
  let resolveRunner: ((value: MemoryReviewTestOutput) => void) | null = null;
  const service = new CodexExecMemoryReviewService({
    store,
    stateDir,
    codexHomeDir: stateDir,
    runner: async () =>
      await new Promise<MemoryReviewTestOutput>((resolve) => {
        resolveRunner = resolve;
      })
  });

  service.reviewWorkerReportAsync(report);
  await new Promise((resolve) => setImmediate(resolve));
  store.removeThread(report.threadId);
  resolveRunner?.({
    candidates: [
      {
        kind: "decision",
        summary: "Deleted job outcome still matters.",
        details: "The finished work remains valid after the job UI is removed.",
        confidence: "high",
        reason: "Deleting the job does not invalidate the completed work outcome."
      }
    ]
  });
  await waitFor(() => store.listPendingPromotionCandidates("/workspace").length === 1);

  const pending = store.listPendingPromotionCandidates("/workspace");
  assert.equal(store.getThread(report.threadId), undefined);
  assert.equal(pending[0]?.summary, "Deleted job outcome still matters.");
  assert.equal(pending[0]?.projectId, "/workspace");
  assert.equal(store.getJobMemory(report.threadId)?.entries.some((entry) => entry.id === `${reviewSourcePrefix(report)}review-state`), true);
});

test("memory review drops stale output when a newer report is queued before job deletion", async () => {
  const { store, stateDir } = await createStore();
  const report = seedReportedThread(store);
  let resolveRunner: ((value: MemoryReviewTestOutput) => void) | null = null;
  let runs = 0;
  const service = new CodexExecMemoryReviewService({
    store,
    stateDir,
    codexHomeDir: stateDir,
    runner: async () => {
      runs += 1;
      if (runs === 1) {
        return await new Promise<MemoryReviewTestOutput>((resolve) => {
          resolveRunner = resolve;
        });
      }
      return {
        candidates: [
          {
            kind: "decision",
            summary: "Queued report survives deletion.",
            details: "The newer queued report should be reviewed after deletion.",
            confidence: "high",
            reason: "The queued newer report superseded the stale report."
          }
        ]
      };
    }
  });

  service.reviewWorkerReportAsync(report);
  const updatedReport = store.recordWorkerReport(report.threadId, {
    turnId: report.turnId,
    status: "completed",
    summary: "Updated report before deletion.",
    details: "Queued report survives deletion."
  });
  service.reviewWorkerReportAsync(updatedReport);
  await new Promise((resolve) => setImmediate(resolve));
  store.removeThread(report.threadId);
  resolveRunner?.({
    candidates: [
      {
        kind: "decision",
        summary: "Stale deleted-job output.",
        details: "This should not be submitted.",
        confidence: "high",
        reason: "A newer report was queued before deletion."
      }
    ]
  });
  await waitFor(() => runs === 2 && store.listPendingPromotionCandidates("/workspace").length === 1);

  const pending = store.listPendingPromotionCandidates("/workspace");
  assert.equal(store.getThread(report.threadId), undefined);
  assert.equal(pending[0]?.summary, "Queued report survives deletion.");
  assert.equal(pending[0]?.sourceEntryId.startsWith(`${reviewSourcePrefix(updatedReport)}candidate:`), true);
});

test("memory review records completed no-candidate reviews and does not rerun them", async () => {
  const { store, stateDir } = await createStore();
  const report = seedReportedThread(store);
  let runs = 0;
  const service = new CodexExecMemoryReviewService({
    store,
    stateDir,
    codexHomeDir: stateDir,
    runner: async () => {
      runs += 1;
      return { candidates: [] };
    }
  });

  await service.reviewWorkerReport(report);
  await service.reviewWorkerReport(report);

  assert.equal(runs, 1);
  assert.equal(store.listPendingPromotionCandidates("/workspace").length, 0);
  assert.equal(store.getJobMemory(report.threadId)?.entries.some((entry) => entry.id === `${reviewSourcePrefix(report)}review-state`), true);
});

test("memory review removes codex exec scratch files after completion", async () => {
  const { store, stateDir } = await createStore();
  const report = seedReportedThread(store);
  const binDir = await mkdtemp(path.join(tmpdir(), "manor-memory-review-bin-"));
  const fakeCodexPath = path.join(binDir, "codex");
  await writeFile(
    fakeCodexPath,
    [
      "#!/usr/bin/env node",
      'const fs = require("node:fs");',
      "const args = process.argv.slice(2);",
      'const outputIndex = args.indexOf("--output-last-message");',
      "if (outputIndex === -1 || !args[outputIndex + 1]) process.exit(2);",
      'fs.writeFileSync(args[outputIndex + 1], JSON.stringify({ candidates: [] }));'
    ].join("\n"),
    "utf8"
  );
  await chmod(fakeCodexPath, 0o755);
  const originalPath = process.env.PATH;
  process.env.PATH = `${binDir}${path.delimiter}${originalPath ?? ""}`;
  try {
    const service = new CodexExecMemoryReviewService({ store, stateDir, codexHomeDir: stateDir });

    await service.reviewWorkerReport(report);

    assert.deepEqual(await readdir(path.join(stateDir, "memory-review")), []);
  } finally {
    process.env.PATH = originalPath;
  }
});

test("failed memory review is retried because no completed marker is written", async () => {
  const { store, stateDir } = await createStore();
  const report = seedReportedThread(store);
  let runs = 0;
  const service = new CodexExecMemoryReviewService({
    store,
    stateDir,
    codexHomeDir: stateDir,
    runner: async () => {
      runs += 1;
      if (runs === 1) {
        throw new Error("temporary failure");
      }
      return { candidates: [] };
    }
  });

  await assert.rejects(() => service.reviewWorkerReport(report), /temporary failure/);
  await service.reviewWorkerReport(report);

  assert.equal(runs, 2);
  assert.equal(store.getJobMemory(report.threadId)?.entries.some((entry) => entry.id === `${reviewSourcePrefix(report)}review-state`), true);
});

test("startup pending review recovery retries interrupted reviews", async () => {
  const { store, stateDir } = await createStore();
  const report = seedReportedThread(store);
  store.recordJobNote(report.threadId, {
    summary: "Memory review pending.",
    details: "Simulated interrupted review.",
    sourceEntryId: `${reviewSourcePrefix(report)}review-pending`
  });
  let runs = 0;
  const service = new CodexExecMemoryReviewService({
    store,
    stateDir,
    codexHomeDir: stateDir,
    runner: async () => {
      runs += 1;
      return {
        candidates: [
          {
            kind: "note",
            summary: "Recovered memory review candidate.",
            details: "Recovered after a simulated interrupted review.",
            confidence: "medium",
            reason: "Confirms pending reviews are retried on startup."
          }
        ]
      };
    }
  });

  service.reviewPendingReportsAsync();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(runs, 1);
  assert.equal(store.listPendingPromotionCandidates("/workspace")[0]?.summary, "Recovered memory review candidate.");
  assert.equal(store.getJobMemory(report.threadId)?.entries.some((entry) => entry.id === `${reviewSourcePrefix(report)}review-state`), true);
});

test("startup pending review recovery resumes after partial candidate writes", async () => {
  const { store, stateDir } = await createStore();
  const report = seedReportedThread(store);
  store.recordJobNote(report.threadId, {
    summary: "Memory review pending.",
    details: "Simulated interrupted review.",
    sourceEntryId: `${reviewSourcePrefix(report)}review-pending`
  });
  store.submitJobMemoryPromotionCandidate(report.threadId, {
    kind: "decision",
    summary: "Previously written candidate.",
    details: "The process stopped before the completion marker was written.",
    sourceEntryId: `${reviewSourcePrefix(report)}1`
  });
  let runs = 0;
  const service = new CodexExecMemoryReviewService({
    store,
    stateDir,
    codexHomeDir: stateDir,
    runner: async () => {
      runs += 1;
      return {
        candidates: [
          {
            kind: "note",
            summary: "Recovered second candidate.",
            details: "The resumed review should submit only the missing source id.",
            confidence: "medium",
            reason: "Confirms partial candidate writes do not block recovery."
          },
          {
            kind: "decision",
            summary: "Previously written candidate.",
            details: "The process stopped before the completion marker was written.",
            confidence: "high",
            reason: "This candidate was already submitted before interruption."
          }
        ]
      };
    }
  });

  service.reviewPendingReportsAsync();
  await waitFor(() => runs === 1 && store.listPendingPromotionCandidates("/workspace").length === 2);

  const candidates = store.listPendingPromotionCandidates("/workspace");
  assert.deepEqual(
    candidates.map((candidate) => candidate.summary).sort(),
    ["Previously written candidate.", "Recovered second candidate."]
  );
  assert.equal(candidates.filter((candidate) => candidate.summary === "Previously written candidate.").length, 1);
  assert.equal(store.getJobMemory(report.threadId)?.entries.some((entry) => entry.id === `${reviewSourcePrefix(report)}review-state`), true);
});

test("startup pending review recovery handles deleted jobs with retained report history", async () => {
  const { store, stateDir } = await createStore();
  const report = seedReportedThread(store);
  store.recordJobNote(report.threadId, {
    summary: "Memory review pending.",
    details: "Simulated interrupted review before deletion.",
    sourceEntryId: `${reviewSourcePrefix(report)}review-pending`
  });
  store.removeThread(report.threadId);
  await new Promise((resolve) => setTimeout(resolve, 250));

  const reloadedStore = new ButlerStateStore(path.join(stateDir, "state.json"));
  await reloadedStore.load();
  let runs = 0;
  const service = new CodexExecMemoryReviewService({
    store: reloadedStore,
    stateDir,
    codexHomeDir: stateDir,
    runner: async () => {
      runs += 1;
      return {
        candidates: [
          {
            kind: "decision",
            summary: "Deleted job recovery candidate.",
            details: "Startup recovery should still review retained reports for deleted jobs.",
            confidence: "high",
            reason: "The job outcome remains useful after deletion."
          }
        ]
      };
    }
  });

  assert.equal(reloadedStore.getThread(report.threadId), undefined);
  assert.equal(reloadedStore.getWorkerReport(report.threadId, report.turnId)?.summary, report.summary);

  service.reviewPendingReportsAsync();
  await waitFor(() => runs === 1 && reloadedStore.listPendingPromotionCandidates("/workspace").length === 1);

  assert.equal(reloadedStore.getThread(report.threadId), undefined);
  assert.equal(reloadedStore.listPendingPromotionCandidates("/workspace")[0]?.summary, "Deleted job recovery candidate.");
});

test("startup pending review recovery skips already completed reviews", async () => {
  const { store, stateDir } = await createStore();
  const report = seedReportedThread(store);
  store.recordJobNote(report.threadId, {
    summary: "Memory review pending.",
    details: "Simulated pending marker.",
    sourceEntryId: `${reviewSourcePrefix(report)}review-pending`
  });
  store.recordJobNote(report.threadId, {
    summary: "Memory review completed with no durable candidates.",
    details: "Simulated completed marker.",
    sourceEntryId: `${reviewSourcePrefix(report)}review-state`
  });
  const service = new CodexExecMemoryReviewService({
    store,
    stateDir,
    codexHomeDir: stateDir,
    runner: async () => {
      throw new Error("runner should not be called");
    }
  });

  service.reviewPendingReportsAsync();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(store.listPendingPromotionCandidates("/workspace").length, 0);
});

test("disabled memory review does not create candidates", async () => {
  const { store, stateDir } = await createStore();
  const report = seedReportedThread(store);
  const service = new CodexExecMemoryReviewService({
    store,
    stateDir,
    codexHomeDir: stateDir,
    enabled: false,
    runner: async () => {
      throw new Error("runner should not be called");
    }
  });

  const submitted = await service.reviewWorkerReport(report);

  assert.equal(submitted.length, 0);
  assert.equal(store.listPendingPromotionCandidates("/workspace").length, 0);
});
