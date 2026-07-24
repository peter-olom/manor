import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  appendJobOutputManifestEntries,
  bindJobPayloadDelivery,
  buildJobPayload,
  formatJobPayloadMessage,
  listJobPayloads,
  persistJobPayload,
  parseJobPayload,
  readCurrentJobPayload,
  updateJobPayload
} from "../../src/server/job-instruction-artifacts.js";
import { buildThreadExecutionContract } from "../../src/server/thread-contract.js";

test("job payloads persist structured JSON and keep chat text readable", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "manor-job-payload-"));
  const contract = buildThreadExecutionContract({
    threadId: "thread-payload",
    workspaceCwd: "/workspace",
    projectId: "project",
    projectLabel: "Project",
    branch: "main",
    taskText: "- Build payload support\n- Verify harness access",
    notes: ["Use structured payloads."]
  });
  const payload = buildJobPayload({
    threadId: contract.threadId,
    kind: "delegation",
    instruction: contract.requestedTask,
    contract
  });

  await persistJobPayload(dir, payload);
  const listed = await listJobPayloads(dir);
  const read = await readCurrentJobPayload(dir, contract.threadId);
  const prompt = formatJobPayloadMessage("delegation", contract.threadId, "Build a simple todo app.");

  assert.equal(listed.length, 1);
  assert.equal(read?.payloadId, payload.payloadId);
  assert.equal(read?.schemaVersion, "manor.job_payload.v1");
  assert.equal(read?.protocol.workerThreadId, contract.threadId);
  assert.equal(read?.protocol.reportChannel, "manor-harness");
  assert.equal(read?.snapshots.length, 1);
  assert.equal(read?.snapshots[0]?.nodeId, read?.currentNodeId);
  assert.equal(read?.snapshots[0]?.display.summary, read?.display.summary);
  assert.deepEqual(read?.checklist.map((point) => point.text), contract.acceptancePoints);
  assert.ok(payload.proof.includes("build, typecheck, or equivalent command result"));
  assert.ok(payload.proof.includes("intent-fit note"));
  assert.match(prompt, /We're going to build a simple todo app/);
  assert.match(prompt, /I put the job details in Manor/);
  assert.match(prompt, /manor-harness --thread thread-payload payload current/);
  assert.doesNotMatch(prompt, /MANOR INSTRUCTION/);
});

test("job payload messages lead follow-ups with the requested action", () => {
  const prompt = formatJobPayloadMessage("steering", "thread-payload", "Please confirm if local storage holds the todos.");

  assert.match(prompt, /^Please confirm if local storage holds the todos\./);
  assert.match(prompt, /I updated the job payload/);
  assert.match(prompt, /manor-harness --thread thread-payload payload current/);
});

test("job payload updates mutate the current payload node graph", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "manor-job-payload-update-"));
  const payload = buildJobPayload({
    threadId: "thread-payload",
    kind: "delegation",
    instruction: "Initial job"
  });
  const updated = updateJobPayload(payload, {
    kind: "steering",
    instruction: "Retry the proof with a focused screenshot.",
    imageReferenceIds: ["image-1"]
  });

  await persistJobPayload(dir, updated);
  const read = await readCurrentJobPayload(dir, "thread-payload");

  assert.equal(read?.revision, 2);
  assert.equal(read?.kind, "steering");
  assert.equal(read?.protocol.workerThreadId, "thread-payload");
  assert.equal(read?.protocol.version, 2);
  assert.equal(read?.nodes.length, 2);
  assert.equal(read?.nodes[1]?.parentId, read?.nodes[0]?.id);
  assert.equal(read?.snapshots.length, 2);
  assert.equal(read?.snapshots[1]?.nodeId, read?.nodes[1]?.id);
  assert.equal(read?.snapshots[1]?.display.summary, "Retry the proof with a focused screenshot.");
  assert.deepEqual(read?.attachments.images, ["image-1"]);
});

test("job payloads migrate old records and preserve registered outputs across updates", () => {
  const payload = buildJobPayload({
    threadId: "thread-payload",
    kind: "delegation",
    instruction: "Create a durable report"
  });
  const legacy = structuredClone(payload) as unknown as Record<string, unknown>;
  delete legacy.outputManifest;
  legacy.checksum = "legacy-checksum";
  const migrated = parseJobPayload(legacy);
  assert.deepEqual(migrated?.outputManifest, { version: 1, entries: [] });
  assert.notEqual(migrated?.checksum, payload.checksum);

  const withOutput = appendJobOutputManifestEntries(payload, [{
    id: "attempt-thread-payload-1:project_artifact:artifact-1",
    kind: "project_artifact",
    title: "Research report",
    threadId: "thread-payload",
    projectId: "unknown",
    attemptId: payload.protocol.currentAttemptId,
    sourceTurnId: "turn-1",
    artifactId: "artifact-1",
    proofRunId: null,
    reportTurnId: null,
    logicalPath: "report.md",
    contentType: "text/markdown",
    sizeBytes: 42,
    checksumSha256: "abc123",
    availability: "available",
    checksumStatus: "verified",
    integrityCheckedAt: 10,
    createdAt: 10
  }], 10);
  const updated = updateJobPayload(withOutput, {
    kind: "steering",
    instruction: "Check the report once more."
  });

  assert.equal(updated.outputManifest.entries.length, 1);
  assert.equal(updated.outputManifest.entries[0]?.artifactId, "artifact-1");
  assert.notEqual(updated.checksum, payload.checksum);
});

test("legacy payload migration binds its durable directory and manifest entries to one explicit scope", () => {
  const payload = buildJobPayload({ threadId: "thread-legacy-scope", kind: "delegation", instruction: "Preserve the legacy output" });
  const withOutput = appendJobOutputManifestEntries(payload, [{
    id: "legacy-output",
    kind: "worker_report",
    title: "Legacy report",
    threadId: payload.threadId,
    projectId: payload.project.id,
    attemptId: payload.protocol.currentAttemptId,
    scopeId: payload.protocol.currentScopeId,
    sourceTurnId: "turn-1",
    artifactId: null,
    proofRunId: null,
    reportTurnId: "turn-1",
    logicalPath: null,
    contentType: null,
    sizeBytes: null,
    checksumSha256: null,
    availability: "available",
    checksumStatus: "unverified",
    integrityCheckedAt: null,
    createdAt: 1
  }]);
  const legacy = structuredClone(withOutput) as unknown as Record<string, unknown>;
  const protocol = legacy.protocol as Record<string, unknown>;
  const workspace = legacy.workspace as Record<string, unknown>;
  const outputManifest = legacy.outputManifest as { entries: Array<Record<string, unknown>> };
  delete protocol.currentScopeId;
  delete protocol.currentScopeStartedAt;
  delete workspace.outputDir;
  delete outputManifest.entries[0]?.scopeId;
  legacy.checksum = "legacy-checksum";

  const migrated = parseJobPayload(legacy);
  assert.ok(migrated);
  assert.equal(migrated.protocol.currentScopeId, `scope-legacy-${migrated.protocol.currentAttemptId}`);
  assert.equal(migrated.workspace.outputDir, `/outputs/${migrated.threadId}`);
  assert.equal(migrated.outputManifest.entries[0]?.scopeId, migrated.protocol.currentScopeId);
});

test("job output manifest rejects current-attempt overflow", () => {
  const payload = buildJobPayload({ threadId: "thread-cap", kind: "delegation", instruction: "Bound outputs" });
  const entries = Array.from({ length: 513 }, (_, index) => ({
    id: `${payload.protocol.currentAttemptId}:worker_report:turn-${index}`,
    kind: "worker_report" as const,
    title: `Report ${index}`,
    threadId: payload.threadId,
    projectId: payload.project.id,
    attemptId: payload.protocol.currentAttemptId,
    sourceTurnId: `turn-${index}`,
    artifactId: null,
    proofRunId: null,
    reportTurnId: `turn-${index}`,
    logicalPath: null,
    contentType: null,
    sizeBytes: null,
    checksumSha256: null,
    availability: "available" as const,
    checksumStatus: "unverified" as const,
    integrityCheckedAt: null,
    createdAt: index
  }));
  assert.throws(() => appendJobOutputManifestEntries(payload, entries), /512-entry safety limit/);
});

test("job payload delivery binding updates the current node snapshot", () => {
  const payload = updateJobPayload(
    buildJobPayload({
      threadId: "thread-payload",
      kind: "delegation",
      instruction: "Initial job"
    }),
    {
      kind: "steering",
      instruction: "Check the preview again."
    }
  );

  const bound = bindJobPayloadDelivery(payload, { turnId: "turn-two" });

  assert.equal(bound.delivery.turnId, "turn-two");
  assert.equal(bound.nodes[0]?.turnId, null);
  assert.equal(bound.nodes[1]?.turnId, "turn-two");
  assert.equal(bound.snapshots[0]?.delivery.turnId, null);
  assert.equal(bound.snapshots[1]?.delivery.turnId, "turn-two");
});

test("job payload reads validate stored JSON", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "manor-job-payload-invalid-"));
  const threadDir = path.join(dir, "thread-payload");
  await mkdir(threadDir, { recursive: true });
  await writeFile(path.join(threadDir, "current.json"), JSON.stringify({
    schemaVersion: "manor.job_payload.v1",
    payloadId: "invalid",
    threadId: "thread-payload"
  }));

  const listed = await listJobPayloads(dir);
  const read = await readCurrentJobPayload(dir, "thread-payload");

  assert.equal(listed.length, 0);
  assert.equal(read, null);
});
