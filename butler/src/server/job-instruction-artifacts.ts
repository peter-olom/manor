import crypto from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

import { writeJsonStateFileAtomic } from "./json-state-file.js";
import type { JobPayloadView } from "./job-payload-types.js";
import type { CodexThreadExecutionContractView, SupervisionChecklistView } from "./types.js";

export type JobPayloadKind =
  | "delegation"
  | "steering"
  | "rejection_followup"
  | "held_context"
  | "direct_message"
  | "assist_context"
  | "worker_report";

export type JobPayloadStatus = "active" | "blocked" | "completed" | "closed";

export type JobPayloadUpdateInput = {
  kind: JobPayloadKind;
  instruction: string;
  summary?: string | null;
  status?: JobPayloadStatus | null;
  contract?: CodexThreadExecutionContractView | null;
  checklist?: SupervisionChecklistView | null;
  imageReferenceIds?: string[];
  fileReferenceIds?: string[];
  turnId?: string | null;
  messageId?: string | null;
  report?: JobPayloadView["report"] | null;
  createdAt?: number;
};

const nullableString = Type.Union([Type.String(), Type.Null()]);

export const JobPayloadSchema = Type.Object({
  schemaVersion: Type.Literal("manor.job_payload.v1"),
  payloadId: Type.String({ minLength: 1 }),
  threadId: Type.String({ minLength: 1 }),
  rootNodeId: Type.String({ minLength: 1 }),
  currentNodeId: Type.String({ minLength: 1 }),
  revision: Type.Number(),
  checksum: Type.String(),
  kind: Type.String(),
  status: Type.String(),
  createdAt: Type.Number(),
  updatedAt: Type.Number(),
  workspace: Type.Object({
    cwd: nullableString,
    branch: nullableString
  }),
  project: Type.Object({
    id: Type.String(),
    label: Type.String()
  }),
  display: Type.Object({
    summary: Type.String(),
    tags: Type.Array(Type.String())
  }),
  workerDirective: Type.String(),
  operatorGoal: nullableString,
  requestedTask: nullableString,
  checklist: Type.Array(Type.Object({
    id: Type.String(),
    text: Type.String(),
    status: Type.String(),
    note: nullableString
  })),
  proof: Type.Array(Type.String()),
  constraints: Type.Array(Type.String()),
  notes: Type.Array(Type.String()),
  attachments: Type.Object({
    images: Type.Array(Type.String()),
    files: Type.Array(Type.String())
  }),
  nodes: Type.Array(Type.Object({
    id: Type.String(),
    kind: Type.String(),
    parentId: nullableString,
    turnId: nullableString,
    messageId: nullableString,
    createdAt: Type.Number(),
    updatedAt: Type.Number(),
    summary: Type.String(),
    instruction: Type.String(),
    imageReferenceIds: Type.Array(Type.String()),
    fileReferenceIds: Type.Array(Type.String())
  })),
  delivery: Type.Object({
    threadId: Type.String(),
    turnId: nullableString,
    messageId: nullableString
  }),
  report: Type.Union([
    Type.Object({
      status: Type.String(),
      summary: Type.String(),
      details: nullableString,
      updatedAt: Type.Number(),
      evidence: Type.Array(Type.Unknown())
    }),
    Type.Null()
  ]),
  executionContract: Type.Union([Type.Unknown(), Type.Null()])
});

export function jobPayloadsRoot(baseDir: string): string {
  return path.join(baseDir, "job-payloads");
}

function normalizeText(value: string | null | undefined): string | null {
  const normalized = value?.replace(/\s+/g, " ").trim() ?? "";
  return normalized || null;
}

function normalizeList(values: Array<string | null | undefined>, max = 16): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const normalized = normalizeText(value);
    if (!normalized) continue;
    const key = normalized.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(normalized);
    if (out.length >= max) break;
  }
  return out;
}

function summaryFor(input: JobPayloadUpdateInput, contract: CodexThreadExecutionContractView | null): string {
  return (
    normalizeText(input.summary) ??
    normalizeText(contract?.operatorGoal) ??
    normalizeText(contract?.requestedTask) ??
    normalizeText(input.instruction)?.slice(0, 180) ??
    "Butler updated this job."
  );
}

function buildChecklist(
  contract: CodexThreadExecutionContractView | null,
  checklist?: SupervisionChecklistView | null
): JobPayloadView["checklist"] {
  const checklistItems = new Map((checklist?.items ?? []).map((item) => [item.id, item]));
  return (contract?.acceptancePoints ?? []).map((point, index) => {
    const id = `point-${index + 1}`;
    const checklistItem = checklistItems.get(id);
    return {
      id,
      text: point,
      status: checklistItem?.status ?? "pending",
      note: checklistItem?.butlerNote ?? null
    };
  });
}

function buildProof(contract: CodexThreadExecutionContractView | null): string[] {
  const requirements: string[] = [];
  if (contract?.proofExpectation === "requested") {
    requirements.push(contract.proofExpectationLabel);
  }
  for (const row of contract?.verificationMatrix ?? []) {
    requirements.push(...row.expectedEvidence);
  }
  return normalizeList(requirements, 16);
}

function tagsFor(payload: Pick<JobPayloadView, "checklist" | "proof" | "constraints" | "notes" | "report">): string[] {
  return [
    payload.checklist.length > 0 ? "checklist" : null,
    payload.proof.length > 0 ? "proof" : null,
    payload.constraints.length > 0 ? "constraints" : null,
    payload.notes.length > 0 ? "notes" : null,
    payload.report ? "report" : null
  ].filter((tag): tag is string => Boolean(tag));
}

function checksumPayload(payload: JobPayloadView): string {
  const copy = { ...payload, checksum: "" };
  return crypto.createHash("sha256").update(JSON.stringify(copy)).digest("hex");
}

function finalizePayload(payload: JobPayloadView): JobPayloadView {
  const finalized = {
    ...payload,
    display: {
      ...payload.display,
      tags: tagsFor(payload)
    }
  };
  finalized.checksum = checksumPayload(finalized);
  if (!Value.Check(JobPayloadSchema, finalized)) {
    throw new Error("Invalid Manor job payload.");
  }
  return finalized;
}

function buildNode(
  payload: JobPayloadView | null,
  input: JobPayloadUpdateInput,
  summary: string,
  now: number
): JobPayloadView["nodes"][number] {
  return {
    id: `node-${now}-${crypto.randomUUID().slice(0, 8)}`,
    kind: input.kind,
    parentId: payload?.currentNodeId ?? null,
    turnId: input.turnId ?? null,
    messageId: input.messageId ?? null,
    createdAt: now,
    updatedAt: now,
    summary,
    instruction: input.instruction.trim(),
    imageReferenceIds: [...new Set(input.imageReferenceIds ?? [])],
    fileReferenceIds: [...new Set(input.fileReferenceIds ?? [])]
  };
}

export function buildJobPayload(input: {
  threadId: string;
} & JobPayloadUpdateInput): JobPayloadView {
  const now = input.createdAt ?? Date.now();
  const contract = input.contract ?? null;
  const summary = summaryFor(input, contract);
  const node = buildNode(null, input, summary, now);
  return finalizePayload({
    schemaVersion: "manor.job_payload.v1",
    payloadId: `payload-${input.threadId}`,
    threadId: input.threadId,
    rootNodeId: node.id,
    currentNodeId: node.id,
    revision: 1,
    checksum: "",
    kind: input.kind,
    status: input.status ?? "active",
    createdAt: now,
    updatedAt: now,
    workspace: {
      cwd: contract?.workspaceCwd ?? null,
      branch: contract?.branch ?? null
    },
    project: {
      id: contract?.projectId ?? "unknown",
      label: contract?.projectLabel ?? "Unknown"
    },
    display: {
      summary,
      tags: []
    },
    workerDirective: input.instruction.trim(),
    operatorGoal: contract?.operatorGoal ?? null,
    requestedTask: contract?.requestedTask ?? normalizeText(input.instruction),
    checklist: buildChecklist(contract, input.checklist),
    proof: buildProof(contract),
    constraints: normalizeList([
      ...(contract?.mission?.blockedConditions ?? []),
      ...(contract?.notes ?? []).filter((note) => /\b(do not|must|requires|approval|blocked|constraint|safe)\b/i.test(note))
    ], 16),
    notes: normalizeList(contract?.notes ?? [], 24),
    attachments: {
      images: [...new Set(input.imageReferenceIds ?? [])],
      files: [...new Set(input.fileReferenceIds ?? [])]
    },
    nodes: [node],
    delivery: {
      threadId: input.threadId,
      turnId: input.turnId ?? null,
      messageId: input.messageId ?? null
    },
    report: input.report ?? null,
    executionContract: contract
  });
}

export function updateJobPayload(payload: JobPayloadView, input: JobPayloadUpdateInput): JobPayloadView {
  const now = input.createdAt ?? Date.now();
  const contract = input.contract ?? payload.executionContract ?? null;
  const typedContract = contract as CodexThreadExecutionContractView | null;
  const summary = summaryFor(input, typedContract);
  const node = buildNode(payload, input, summary, now);
  const next: JobPayloadView = {
    ...payload,
    currentNodeId: node.id,
    revision: payload.revision + 1,
    kind: input.kind,
    status: input.status ?? payload.status,
    updatedAt: now,
    workspace: {
      cwd: typedContract?.workspaceCwd ?? payload.workspace.cwd,
      branch: typedContract?.branch ?? payload.workspace.branch
    },
    project: {
      id: typedContract?.projectId ?? payload.project.id,
      label: typedContract?.projectLabel ?? payload.project.label
    },
    display: {
      summary,
      tags: payload.display.tags
    },
    workerDirective: input.instruction.trim() || payload.workerDirective,
    operatorGoal: typedContract?.operatorGoal ?? payload.operatorGoal,
    requestedTask: typedContract?.requestedTask ?? payload.requestedTask,
    checklist: typedContract ? buildChecklist(typedContract, input.checklist) : payload.checklist,
    proof: typedContract ? buildProof(typedContract) : payload.proof,
    constraints: typedContract
      ? normalizeList([
          ...(typedContract.mission?.blockedConditions ?? []),
          ...(typedContract.notes ?? []).filter((note) => /\b(do not|must|requires|approval|blocked|constraint|safe)\b/i.test(note))
        ], 16)
      : payload.constraints,
    notes: typedContract ? normalizeList(typedContract.notes ?? [], 24) : payload.notes,
    attachments: {
      images: [...new Set([...payload.attachments.images, ...(input.imageReferenceIds ?? [])])],
      files: [...new Set([...payload.attachments.files, ...(input.fileReferenceIds ?? [])])]
    },
    nodes: [...payload.nodes, node],
    delivery: {
      threadId: payload.threadId,
      turnId: input.turnId ?? payload.delivery.turnId,
      messageId: input.messageId ?? payload.delivery.messageId
    },
    report: input.report ?? payload.report,
    executionContract: typedContract ?? payload.executionContract
  };
  return finalizePayload(next);
}

export function bindJobPayloadDelivery(payload: JobPayloadView, delivery: { turnId?: string | null; messageId?: string | null }): JobPayloadView {
  return finalizePayload({
    ...payload,
    revision: payload.revision + 1,
    updatedAt: Date.now(),
    delivery: {
      threadId: payload.threadId,
      turnId: delivery.turnId ?? payload.delivery.turnId,
      messageId: delivery.messageId ?? payload.delivery.messageId
    }
  });
}

export function parseJobPayload(value: unknown): JobPayloadView | null {
  return Value.Check(JobPayloadSchema, value) ? value as JobPayloadView : null;
}

function payloadFilePath(rootDir: string, threadId: string): string {
  return path.join(rootDir, threadId, "current.json");
}

export async function persistJobPayload(rootDir: string, payload: JobPayloadView): Promise<JobPayloadView> {
  const parsed = parseJobPayload(payload);
  if (!parsed) {
    throw new Error("Invalid Manor job payload.");
  }
  await writeJsonStateFileAtomic(payloadFilePath(rootDir, payload.threadId), parsed);
  return parsed;
}

export async function readCurrentJobPayload(rootDir: string, threadId: string): Promise<JobPayloadView | null> {
  const payload = await fs
    .readFile(payloadFilePath(rootDir, threadId), "utf8")
    .then((raw) => parseJobPayload(JSON.parse(raw)))
    .catch(() => null);
  return payload?.threadId === threadId ? payload : null;
}

export async function listJobPayloads(rootDir: string): Promise<JobPayloadView[]> {
  const entries = await fs.readdir(rootDir, { withFileTypes: true }).catch(() => []);
  const payloads = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => readCurrentJobPayload(rootDir, entry.name))
  );
  return payloads
    .filter((payload): payload is JobPayloadView => Boolean(payload))
    .sort((left, right) => right.updatedAt - left.updatedAt);
}

function formatPayloadReadCommand(threadId?: string | null): string {
  return threadId
    ? `Run \`manor-harness --thread ${threadId} payload current\` first and reuse that \`--thread\` value for any payload update`
    : "Run `manor-harness payload current` first";
}

export function formatJobPayloadMessage(kind: JobPayloadKind, threadId?: string | null): string {
  const readLatest = formatPayloadReadCommand(threadId);
  if (kind === "delegation") {
    return `I put the job details in Manor for this thread. ${readLatest}, then do the work and report back through the harness.`;
  }
  if (kind === "held_context") {
    return "I saved new context for this job. Keep going for now; I will apply it during review.";
  }
  if (kind === "rejection_followup") {
    return `I updated the job details with the checklist items that need another pass. ${readLatest}, then continue.`;
  }
  if (kind === "assist_context") {
    return `I added Manor guidance for this job. ${readLatest} before continuing.`;
  }
  return `I updated the job details in Manor. ${readLatest}, then continue from there.`;
}

export function formatPayloadCurrentText(payload: JobPayloadView | null): string {
  if (!payload) {
    return "No Manor job payload is stored for this thread.";
  }
  return JSON.stringify(payload, null, 2);
}
