import assert from "node:assert/strict";
import { chmod, link, mkdir, mkdtemp, readFile, rm, stat, symlink, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import JSZip from "jszip";

import { buildButlerProjectTools } from "../../src/server/butler-agent-project-tools.js";
import type { ButlerAgentToolAccess } from "../../src/server/butler-agent-tool-access.js";
import { handleHarnessArtifactPolicyAction } from "../../src/server/codex-harness-artifact-policy.js";
import { handleHarnessPayloadAction } from "../../src/server/codex-harness-instructions.js";
import { buildJobOutputManifestEntry, reconcileJobOutputManifest, updatePayloadFromWorkerReport } from "../../src/server/codex-harness-payload.js";
import { handleHarnessProofAction } from "../../src/server/codex-harness-proof.js";
import { appendJobOutputManifestEntries, bindJobPayloadDelivery, buildJobPayload, jobPayloadsRoot, persistJobPayload, readCurrentJobPayload, removeCurrentJobPayload, updateJobPayload } from "../../src/server/job-instruction-artifacts.js";
import {
  buildJobOutputManifestUiView,
  formatResolvedJobOutputManifestForReview,
  inspectCurrentJobOutputForReview,
  resolveJobOutputManifest,
  validateReportedArtifactManifestRefs
} from "../../src/server/job-output-manifest.js";
import { createProjectArtifactFromFile, createProjectArtifactFromText } from "../../src/server/project-artifacts-policies.js";
import { ButlerStateStore } from "../../src/server/state-store.js";
import { buildThreadExecutionContract } from "../../src/server/thread-contract.js";

test("job manifest registers and resolves artifacts, proofs, and Worker reports", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "manor-job-output-manifest-"));
  const artifactsDir = path.join(dir, "artifacts");
  const threadId = "thread-output";
  const store = new ButlerStateStore(path.join(dir, "state.json"));
  const contract = buildThreadExecutionContract({
    threadId,
    workspaceCwd: "/repos",
    projectId: "project-1",
    projectLabel: "Project One",
    branch: null,
    taskText: "Research and report",
    notes: []
  });
  const payload = bindJobPayloadDelivery(
    buildJobPayload({ threadId, kind: "delegation", instruction: "Research and report", contract }),
    { turnId: "turn-1" }
  );
  await persistJobPayload(jobPayloadsRoot(artifactsDir), payload);
  store.setThreadJobPayload(payload);
  await removeCurrentJobPayload(jobPayloadsRoot(artifactsDir), threadId);
  const thread = { id: threadId, turns: [{ id: "turn-1" }] } as never;

  const artifactResult = await handleHarnessArtifactPolicyAction({
    action: "artifact.save_text",
    threadId,
    cwd: "/repos",
    artifactsDir,
    thread,
    store,
    runtimeBroker: {} as never,
    params: { title: "Research notes", kind: "research", text: "Durable findings" },
    resolveWorkspaceProject: () => ({ id: "project-1", label: "Project One" })
  });
  const artifactId = (artifactResult?.data?.artifact as { id?: string }).id;
  assert.ok(artifactId);
  assert.ok(await readCurrentJobPayload(jobPayloadsRoot(artifactsDir), threadId));

  const proofResult = await handleHarnessProofAction({
    action: "proof.text",
    params: { title: "Research proof", text: "Sources checked." },
    capability: { threadId, cwd: "/repos" } as never,
    thread,
    store,
    artifactsDir,
    resolveWorkspaceProject: () => ({ id: "project-1", label: "Project One" })
  });
  const proofRunId = (proofResult?.data?.verification as { runId?: string }).runId;
  assert.ok(proofRunId);

  const report = store.recordWorkerReport(threadId, {
    turnId: "turn-1",
    status: "completed",
    summary: "Research complete",
    details: "The durable outputs are ready.",
    evidence: [{
      id: "evidence-1",
      pointId: null,
      matrixRowId: null,
      kind: "file",
      summary: "Saved research",
      details: null,
      command: null,
      exitCode: null,
      proofRunId,
      artifactId,
      route: null,
      logRef: null,
      dataRef: null,
      createdAt: 20
    }]
  });
  await updatePayloadFromWorkerReport({ artifactsDir, store, report });

  const current = await readCurrentJobPayload(jobPayloadsRoot(artifactsDir), threadId);
  assert.ok(current);
  assert.deepEqual(current.outputManifest.entries.map((entry) => entry.kind).sort(), ["project_artifact", "proof", "worker_report"]);
  const resolved = await resolveJobOutputManifest(current, store);
  assert.equal(resolved.every((output) => output.available), true);
  assert.equal(resolved.find((output) => output.entry.proofRunId === proofRunId)?.integrity, "unverified");
  assert.equal(resolved.find((output) => output.entry.reportTurnId === report.turnId)?.integrity, "unverified");
  const uiView = await buildJobOutputManifestUiView(current, store);
  const artifactUiEntry = uiView.entries.find((entry) => entry.referenceId === artifactId);
  assert.equal(uiView.jobId, threadId);
  assert.equal(artifactUiEntry?.currentAttempt, true);
  assert.equal(artifactUiEntry?.available, true);
  assert.equal(artifactUiEntry?.integrity, "verified");
  assert.match(artifactUiEntry?.openUrl ?? "", new RegExp(`/api/project-artifacts/project-1/${artifactId}/file$`));
  assert.match(artifactUiEntry?.downloadUrl ?? "", /\?download=1$/);
  assert.match(await formatResolvedJobOutputManifestForReview(current, store), /Research notes/);
  assert.match(await formatResolvedJobOutputManifestForReview(current, store), /Research complete/);
  await validateReportedArtifactManifestRefs({ payload: current, store, evidence: [{ artifactId }] });

  const otherJobArtifact = await createProjectArtifactFromText({
    artifactsDir,
    projectId: "project-1",
    projectLabel: "Project One",
    threadId: "another-thread",
    kind: "research",
    title: "Another job output",
    text: "This belongs to another job."
  });
  store.upsertProjectArtifact(otherJobArtifact);
  await assert.rejects(
    validateReportedArtifactManifestRefs({ payload: current, store, evidence: [{ artifactId: otherJobArtifact.id }] }),
    /not registered in the current job attempt manifest/
  );
  await assert.rejects(
    validateReportedArtifactManifestRefs({ payload: current, store, evidence: [{ artifactId: "made-up-artifact" }] }),
    /not registered in the current job attempt manifest/
  );

  const workerView = await handleHarnessPayloadAction({
    action: "manifest.current",
    params: {},
    threadId,
    artifactsDir,
    store
  });
  assert.match(workerView?.text ?? "", /project_artifact \| Research notes/);

  const definitions: Array<{ name: string; execute: (id: string, params: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }> }> = [];
  const access = {
    defineButlerTool: (definition: typeof definitions[number]) => { definitions.push(definition); return definition; },
    getToolUiEffects: () => [],
    store
  } as unknown as ButlerAgentToolAccess;
  buildButlerProjectTools(access, artifactsDir);
  const inspect = definitions.find((definition) => definition.name === "inspect_job_output_manifest");
  assert.ok(inspect);
  const butlerView = await inspect.execute("tool-1", { threadId });
  assert.match(butlerView.content[0]?.text ?? "", /worker_report \| Research complete/);
  assert.match(butlerView.content[0]?.text ?? "", /available/);

  const artifact = store.getProjectArtifact("project-1", artifactId);
  assert.ok(artifact);
  assert.equal((await stat(artifact.filePath)).mode & 0o777, 0o444);
  const originalContent = await readFile(artifact.filePath);
  await chmod(artifact.filePath, 0o644);
  await truncate(artifact.filePath, 16 * 1024 * 1024 + 1);
  const largeArtifact = (await resolveJobOutputManifest(current, store)).find((output) => output.entry.artifactId === artifactId);
  assert.equal(largeArtifact?.available, true);
  assert.equal(largeArtifact?.integrity, "unverified");
  assert.equal(largeArtifact?.checksumStatus, "unverified");

  await writeFile(artifact.filePath, originalContent);
  await writeFile(artifact.filePath, "tampered content", "utf8");
  const mismatched = (await resolveJobOutputManifest(current, store)).find((output) => output.entry.artifactId === artifactId);
  assert.equal(mismatched?.available, true);
  assert.equal(mismatched?.integrity, "unverified");
  await assert.rejects(
    validateReportedArtifactManifestRefs({ payload: current, store, evidence: [{ artifactId }], artifactsDir }),
    /no longer matches the registered checksum/
  );
  assert.equal(store.getThreadJobPayload(threadId)?.outputManifest.entries.find((entry) => entry.artifactId === artifactId)?.checksumStatus, "mismatch");

  await writeFile(artifact.filePath, originalContent);
  await rm(artifact.filePath);
  const missing = (await resolveJobOutputManifest(current, store)).find((output) => output.entry.artifactId === artifactId);
  assert.equal(missing?.available, false);
  assert.equal(missing?.integrity, "missing");
  await assert.rejects(
    validateReportedArtifactManifestRefs({ payload: current, store, evidence: [{ artifactId }], artifactsDir }),
    /durable project artifact is unavailable/
  );
  assert.equal(store.getThreadJobPayload(threadId)?.outputManifest.entries.find((entry) => entry.artifactId === artifactId)?.availability, "missing");
});

test("manifest-scoped review inspection reads long text and extracts Office content", { timeout: 15_000 }, async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "manor-job-output-review-inspection-"));
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  const artifactsDir = path.join(dir, "artifacts");
  const threadId = "thread-review-inspection";
  const store = new ButlerStateStore(path.join(dir, "state.json"));
  const payload = buildJobPayload({ threadId, kind: "delegation", instruction: "Create reviewable durable outputs" });
  const longMarker = "CONTENT_BEYOND_TWO_THOUSAND_CHARACTERS";
  const longArtifact = await createProjectArtifactFromText({
    artifactsDir,
    projectId: payload.project.id,
    projectLabel: payload.project.label,
    threadId,
    kind: "report",
    title: "Long report",
    text: `${"context ".repeat(400)}${longMarker}`,
    fileName: "long-report.txt"
  });

  const docxPath = path.join(dir, "review.docx");
  const docx = new JSZip();
  docx.file("word/document.xml", "<w:document><w:body><w:p><w:t>OFFICE_BINARY_REVIEW_MARKER</w:t></w:p></w:body></w:document>");
  await writeFile(docxPath, await docx.generateAsync({ type: "nodebuffer" }));
  const officeArtifact = await createProjectArtifactFromFile({
    artifactsDir,
    projectId: payload.project.id,
    projectLabel: payload.project.label,
    threadId,
    kind: "report",
    title: "Office report",
    sourceFilePath: docxPath,
    fileName: "review.docx"
  });

  for (const artifact of [longArtifact, officeArtifact]) store.upsertProjectArtifact(artifact);

  const entries = [longArtifact, officeArtifact].map((artifact) => buildJobOutputManifestEntry(payload, {
    kind: "project_artifact",
    referenceId: artifact.id,
    title: artifact.title,
    projectId: artifact.projectId,
    contentType: artifact.contentType,
    sizeBytes: artifact.sizeBytes,
    checksumSha256: artifact.source.checksumSha256,
    createdAt: artifact.createdAt
  }));
  const withOutputs = appendJobOutputManifestEntries(payload, entries);
  store.setThreadJobPayload(withOutputs);

  const inspectWithin = async (outputId: string, label: string) => {
    let timeout: NodeJS.Timeout | null = null;
    try {
      return await Promise.race([
        inspectCurrentJobOutputForReview({ payload: withOutputs, store, outputId }),
        new Promise<never>((_resolve, reject) => { timeout = setTimeout(() => reject(new Error(`${label} inspection timed out`)), 5_000); })
      ]);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  };
  assert.match(await inspectWithin(entries[0]!.id, "long text"), new RegExp(longMarker));
  assert.match(await inspectWithin(entries[1]!.id, "Office"), /OFFICE_BINARY_REVIEW_MARKER/);
  await assert.rejects(
    inspectCurrentJobOutputForReview({ payload: withOutputs, store, outputId: "artifact-from-another-job" }),
    /not registered to the current attempt/
  );
});

test("job output reconciliation imports deterministic nested files and is idempotent", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "manor-job-output-reconcile-"));
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  const artifactsDir = path.join(dir, "artifacts");
  const outputsDir = path.join(dir, "outputs");
  const threadId = "thread-reconcile";
  const store = new ButlerStateStore(path.join(dir, "state.json"));
  const payload = buildJobPayload({ threadId, kind: "delegation", instruction: "Create durable files" });
  await persistJobPayload(jobPayloadsRoot(artifactsDir), payload);
  store.setThreadJobPayload(payload);
  await mkdir(outputsDir, { recursive: true });
  await chmod(outputsDir, 0o555);
  const empty = await reconcileJobOutputManifest({ artifactsDir, outputsDir, store, threadId });
  assert.deepEqual(empty.outputs, []);
  assert.equal(await stat(outputsDir).then((entry) => entry.mode & 0o777), 0o555);
  await chmod(outputsDir, 0o755);
  const scopedOutputDir = path.join(outputsDir, payload.workspace.outputDir.replace(/^\/outputs\//, ""));
  await mkdir(path.join(scopedOutputDir, "nested"), { recursive: true });
  await writeFile(path.join(scopedOutputDir, "z.txt"), "z", "utf8");
  await writeFile(path.join(scopedOutputDir, "nested", "a.txt"), "a", "utf8");

  const first = await reconcileJobOutputManifest({ artifactsDir, outputsDir, store, threadId });
  assert.deepEqual(first.outputs.map((output) => output.relativePath), ["nested/a.txt", "z.txt"]);
  assert.equal(first.outputs.every((output) => !output.reused), true);
  assert.equal(first.payload.outputManifest.entries.every((entry) => entry.checksumStatus === "verified"), true);
  for (const output of first.outputs) {
    const artifact = store.getProjectArtifact("unknown", output.artifactId);
    assert.ok(artifact);
    assert.equal((await stat(artifact.filePath)).mode & 0o777, 0o444);
  }

  const second = await reconcileJobOutputManifest({ artifactsDir, outputsDir, store, threadId });
  assert.deepEqual(second.outputs.map((output) => output.artifactId), first.outputs.map((output) => output.artifactId));
  assert.equal(second.outputs.every((output) => output.reused), true);
  assert.equal(second.payload.outputManifest.entries.length, 2);

  await writeFile(path.join(scopedOutputDir, "z.txt"), "changed", "utf8");
  const third = await reconcileJobOutputManifest({ artifactsDir, outputsDir, store, threadId });
  assert.notEqual(third.outputs.find((output) => output.relativePath === "z.txt")?.artifactId, first.outputs.find((output) => output.relativePath === "z.txt")?.artifactId);
  assert.equal(third.payload.outputManifest.entries.length, 3);
});

test("job output reconciliation rejects symlinks and hard links", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "manor-job-output-links-"));
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  const artifactsDir = path.join(dir, "artifacts");
  const outputsDir = path.join(dir, "outputs");
  const threadId = "thread-links";
  const store = new ButlerStateStore(path.join(dir, "state.json"));
  const payload = buildJobPayload({ threadId, kind: "delegation", instruction: "Reject unsafe outputs" });
  await persistJobPayload(jobPayloadsRoot(artifactsDir), payload);
  store.setThreadJobPayload(payload);
  const scopedOutputDir = path.join(outputsDir, payload.workspace.outputDir.replace(/^\/outputs\//, ""));
  await mkdir(scopedOutputDir, { recursive: true });
  const outside = path.join(dir, "outside.txt");
  const candidate = path.join(scopedOutputDir, "candidate.txt");
  await writeFile(outside, "outside", "utf8");
  await symlink(outside, candidate);
  await assert.rejects(reconcileJobOutputManifest({ artifactsDir, outputsDir, store, threadId }), /symbolic link/);
  await rm(candidate);
  await link(outside, candidate);
  await assert.rejects(reconcileJobOutputManifest({ artifactsDir, outputsDir, store, threadId }), /hard links/);
  assert.equal(store.getThreadJobPayload(threadId)?.outputManifest.entries.length, 0);
});

test("review formatting selects only the newest report from the current work scope", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "manor-job-output-review-"));
  const store = new ButlerStateStore(path.join(dir, "state.json"));
  const payload = buildJobPayload({ threadId: "thread-review", kind: "delegation", instruction: "Review all outputs" });
  const entries = Array.from({ length: 30 }, (_, index) => buildJobOutputManifestEntry(payload, {
    kind: "worker_report",
    referenceId: `turn-${index + 1}`,
    title: `Output ${index + 1}`,
    createdAt: index + 1
  }));
  const withOutputs = appendJobOutputManifestEntries(payload, entries);

  const formatted = JSON.parse(await formatResolvedJobOutputManifestForReview(withOutputs, store)) as {
    entryCount: number;
    inventory: Array<{ referenceId: string }>;
    details: unknown[];
  };
  assert.equal(formatted.entryCount, 1);
  assert.equal(formatted.inventory[0]?.referenceId, "turn-30");
  assert.equal(formatted.details.length, 1);
  await rm(dir, { recursive: true, force: true });
});

test("output UI separates the current report, unclaimed current outputs, and earlier task scopes", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "manor-job-output-scope-ui-"));
  const store = new ButlerStateStore(path.join(dir, "state.json"));
  const initial = buildJobPayload({ threadId: "thread-scope-ui", kind: "delegation", instruction: "Run the old preview" });
  const oldScopeId = initial.protocol.currentScopeId;
  const withOldOutputs = appendJobOutputManifestEntries(initial, [
    buildJobOutputManifestEntry(initial, { kind: "project_artifact", referenceId: "old-log", title: "Old preview log", logicalPath: "preview.log", createdAt: 1 }),
    buildJobOutputManifestEntry(initial, { kind: "worker_report", referenceId: "turn-old", title: "Old Worker report", createdAt: 2 })
  ]);
  const replacement = updateJobPayload(withOldOutputs, { kind: "steering", instruction: "Push the current branch", replaceOutputScope: true });
  const current = appendJobOutputManifestEntries(replacement, [
    buildJobOutputManifestEntry(replacement, { kind: "project_artifact", referenceId: "push-log", title: "Push log", logicalPath: "push.log", createdAt: 3 }),
    buildJobOutputManifestEntry(replacement, { kind: "worker_report", referenceId: "turn-push", title: "Push report", createdAt: 4 })
  ]);

  const view = await buildJobOutputManifestUiView(current, store);
  assert.notEqual(view.currentScopeId, oldScopeId);
  assert.deepEqual(view.entries.map((entry) => entry.referenceId), ["turn-push"]);
  assert.deepEqual(view.otherCurrentScopeEntries.map((entry) => entry.referenceId), ["push-log"]);
  assert.deepEqual(view.historicalEntries.map((entry) => entry.referenceId), ["old-log", "turn-old"]);
  await rm(dir, { recursive: true, force: true });
});

test("a late report stays with its dispatched scope after another task replaces it", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "manor-job-output-late-report-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const artifactsDir = path.join(dir, "artifacts");
  const threadId = "thread-late-report";
  const store = new ButlerStateStore(path.join(dir, "state.json"));
  const initial = bindJobPayloadDelivery(buildJobPayload({
    threadId,
    kind: "delegation",
    instruction: "Run task A",
    report: { status: "completed", summary: "Earlier A report", details: null, updatedAt: 1, evidence: [] }
  }), { turnId: "turn-a" });
  const scopeA = initial.protocol.currentScopeId;
  const replacement = bindJobPayloadDelivery(updateJobPayload(initial, {
    kind: "steering",
    instruction: "Run task B",
    replaceOutputScope: true
  }), { turnId: "turn-b" });
  const scopeB = replacement.protocol.currentScopeId;
  assert.notEqual(scopeB, scopeA);
  assert.equal(replacement.report, null);
  await persistJobPayload(jobPayloadsRoot(artifactsDir), replacement);
  store.setThreadJobPayload(replacement);

  const reportB = store.recordWorkerReport(threadId, {
    turnId: "turn-b",
    status: "completed",
    summary: "Task B complete",
    details: null,
    evidence: []
  });
  await updatePayloadFromWorkerReport({ artifactsDir, store, report: reportB });
  const reportA = store.recordWorkerReport(threadId, {
    turnId: "turn-a",
    status: "completed",
    summary: "Task A arrived late",
    details: null,
    evidence: []
  });
  await updatePayloadFromWorkerReport({ artifactsDir, store, report: reportA });

  const current = await readCurrentJobPayload(jobPayloadsRoot(artifactsDir), threadId);
  assert.ok(current);
  assert.equal(current.protocol.currentScopeId, scopeB);
  assert.equal(current.report?.summary, "Task B complete");
  const reportAEntry = current.outputManifest.entries.find((entry) => entry.reportTurnId === "turn-a");
  const reportBEntry = current.outputManifest.entries.find((entry) => entry.reportTurnId === "turn-b");
  assert.equal(reportAEntry?.scopeId, scopeA);
  assert.equal(reportBEntry?.scopeId, scopeB);
  const view = await buildJobOutputManifestUiView(current, store);
  assert.deepEqual(view.entries.map((entry) => entry.referenceId), ["turn-b"]);
  assert.deepEqual(view.historicalEntries.map((entry) => entry.referenceId), ["turn-a"]);
});

test("an explicitly captured current scope binds a report from a later Worker turn", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "manor-job-output-explicit-report-scope-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const artifactsDir = path.join(dir, "artifacts");
  const threadId = "thread-explicit-report-scope";
  const store = new ButlerStateStore(path.join(dir, "state.json"));
  const payload = bindJobPayloadDelivery(buildJobPayload({
    threadId,
    kind: "delegation",
    instruction: "Run the current task"
  }), { turnId: "turn-dispatch" });
  await persistJobPayload(jobPayloadsRoot(artifactsDir), payload);
  store.setThreadJobPayload(payload);

  const report = store.recordWorkerReport(threadId, {
    turnId: "turn-report-later",
    status: "completed",
    summary: "Current task complete",
    details: null,
    evidence: []
  });
  await updatePayloadFromWorkerReport({ artifactsDir, store, report, scopeId: payload.protocol.currentScopeId });

  const current = await readCurrentJobPayload(jobPayloadsRoot(artifactsDir), threadId);
  assert.equal(current?.report?.summary, "Current task complete");
  assert.equal(current?.outputManifest.entries.at(-1)?.scopeId, payload.protocol.currentScopeId);
});

test("manifest current returns the same selected current-scope entries in text and structured data", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "manor-job-output-current-manifest-"));
  const artifactsDir = path.join(dir, "artifacts");
  const store = new ButlerStateStore(path.join(dir, "state.json"));
  const initial = buildJobPayload({ threadId: "thread-current-manifest", kind: "delegation", instruction: "Prepare the first report" });
  const withOldReport = appendJobOutputManifestEntries(initial, [
    buildJobOutputManifestEntry(initial, { kind: "worker_report", referenceId: "turn-old", title: "Old report", createdAt: 1 })
  ]);
  const replacement = updateJobPayload(withOldReport, { kind: "steering", instruction: "Prepare a replacement report", replaceOutputScope: true });
  const current = appendJobOutputManifestEntries(replacement, [
    buildJobOutputManifestEntry(replacement, { kind: "project_artifact", referenceId: "artifact-old", title: "Superseded draft", logicalPath: "report.md", createdAt: 2 }),
    buildJobOutputManifestEntry(replacement, { kind: "project_artifact", referenceId: "artifact-current", title: "Current draft", logicalPath: "report.md", createdAt: 3 }),
    buildJobOutputManifestEntry(replacement, { kind: "worker_report", referenceId: "turn-current", title: "Current report", createdAt: 4 })
  ]);
  await persistJobPayload(jobPayloadsRoot(artifactsDir), current);
  store.setThreadJobPayload(current);

  const result = await handleHarnessPayloadAction({ action: "manifest.current", params: {}, threadId: current.threadId, artifactsDir, store });
  const entries = (result?.data?.manifest as { entries: Array<{ artifactId: string | null; reportTurnId: string | null }> }).entries;
  assert.deepEqual(entries.map((entry) => entry.artifactId ?? entry.reportTurnId), ["artifact-current", "turn-current"]);
  assert.match(result?.text ?? "", /Current draft/);
  assert.match(result?.text ?? "", /Current report/);
  assert.doesNotMatch(result?.text ?? "", /Old report|Superseded draft/);
  await rm(dir, { recursive: true, force: true });
});
