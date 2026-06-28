import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  buildJobPayload,
  formatJobPayloadMessage,
  listJobPayloads,
  persistJobPayload,
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
    taskText: "- Add payload support\n- Verify harness access",
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
  assert.deepEqual(read?.checklist.map((point) => point.text), contract.acceptancePoints);
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
  assert.deepEqual(read?.attachments.images, ["image-1"]);
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
