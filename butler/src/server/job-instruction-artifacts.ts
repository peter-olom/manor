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
  butlerThreadId?: string | null;
  parentThreadId?: string | null;
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
  protocol: Type.Object({
    taskId: Type.String({ minLength: 1 }),
    butlerThreadId: nullableString,
    workerThreadId: Type.String({ minLength: 1 }),
    currentAttemptId: Type.String({ minLength: 1 }),
    attempt: Type.Number(),
    version: Type.Number(),
    parentThreadId: nullableString,
    reportChannel: Type.Literal("manor-harness")
  }),
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
  snapshots: Type.Array(Type.Object({
    nodeId: Type.String(),
    revision: Type.Number(),
    kind: Type.String(),
    status: Type.String(),
    updatedAt: Type.Number(),
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
    delivery: Type.Object({
      threadId: Type.String(),
      turnId: nullableString,
      messageId: nullableString
    })
  })),
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

function tagsFor(payload: Pick<JobPayloadView, "checklist" | "proof" | "constraints" | "notes"> & { report?: JobPayloadView["report"] | null }): string[] {
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
    },
    snapshots: payload.snapshots.map((snapshot) => ({
      ...snapshot,
      display: {
        ...snapshot.display,
        tags: snapshot.display.tags.length > 0 ? snapshot.display.tags : tagsFor(snapshot)
      }
    }))
  };
  finalized.checksum = checksumPayload(finalized);
  if (!Value.Check(JobPayloadSchema, finalized)) {
    throw new Error("Invalid Manor job payload.");
  }
  return finalized;
}

function snapshotFromPayload(
  payload: JobPayloadView,
  node: JobPayloadView["nodes"][number],
  revision = payload.revision
): JobPayloadView["snapshots"][number] {
  return {
    nodeId: node.id,
    revision,
    kind: node.kind,
    status: payload.status,
    updatedAt: node.updatedAt,
    display: {
      summary: node.summary,
      tags: tagsFor(payload)
    },
    workerDirective: node.instruction,
    operatorGoal: payload.operatorGoal,
    requestedTask: payload.requestedTask,
    checklist: payload.checklist.map((item) => ({ ...item })),
    proof: [...payload.proof],
    constraints: [...payload.constraints],
    notes: [...payload.notes],
    delivery: {
      threadId: payload.threadId,
      turnId: node.turnId ?? null,
      messageId: node.messageId ?? null
    }
  };
}

function synthesizeSnapshots(payload: JobPayloadView): JobPayloadView["snapshots"] {
  return payload.nodes.map((node, index) => ({
    ...snapshotFromPayload(payload, node, index + 1),
    display: {
      summary: node.summary,
      tags: tagsFor(payload)
    },
    workerDirective: node.instruction,
    updatedAt: node.updatedAt
  }));
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
  const payload: JobPayloadView = {
    schemaVersion: "manor.job_payload.v1",
    payloadId: `payload-${input.threadId}`,
    threadId: input.threadId,
    protocol: {
      taskId: `task-${input.threadId}`,
      butlerThreadId: input.butlerThreadId ?? null,
      workerThreadId: input.threadId,
      currentAttemptId: `attempt-${input.threadId}-1`,
      attempt: 1,
      version: 1,
      parentThreadId: input.parentThreadId ?? null,
      reportChannel: "manor-harness"
    },
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
    snapshots: [],
    nodes: [node],
    delivery: {
      threadId: input.threadId,
      turnId: input.turnId ?? null,
      messageId: input.messageId ?? null
    },
    report: input.report ?? null,
    executionContract: contract
  };
  payload.snapshots = [snapshotFromPayload(payload, node)];
  return finalizePayload(payload);
}

export function remapJobPayloadForWorkerHandoff(
  payload: JobPayloadView,
  input: {
    threadId: string;
    butlerThreadId?: string | null;
    parentThreadId: string;
    contract: CodexThreadExecutionContractView;
  }
): JobPayloadView {
  const now = Date.now();
  const attempt = payload.protocol.attempt + 1;
  const remapped: JobPayloadView = {
    ...payload,
    payloadId: `payload-${input.threadId}`,
    threadId: input.threadId,
    protocol: {
      ...payload.protocol,
      butlerThreadId: input.butlerThreadId ?? payload.protocol.butlerThreadId,
      workerThreadId: input.threadId,
      currentAttemptId: `attempt-${input.threadId}-${attempt}`,
      attempt,
      version: payload.protocol.version + 1,
      parentThreadId: input.parentThreadId,
      reportChannel: "manor-harness"
    },
    status: "active",
    updatedAt: now,
    workspace: {
      cwd: input.contract.workspaceCwd,
      branch: input.contract.branch
    },
    project: {
      id: input.contract.projectId,
      label: input.contract.projectLabel
    },
    display: {
      ...payload.display,
      tags: [...payload.display.tags]
    },
    checklist: payload.checklist.map((item) => ({ ...item })),
    proof: [...payload.proof],
    constraints: [...payload.constraints],
    notes: [...payload.notes],
    attachments: {
      images: [...payload.attachments.images],
      files: [...payload.attachments.files]
    },
    nodes: payload.nodes.map((node) => ({
      ...node,
      imageReferenceIds: [...node.imageReferenceIds],
      fileReferenceIds: [...node.fileReferenceIds]
    })),
    snapshots: payload.snapshots.map((snapshot) => ({
      ...snapshot,
      display: { ...snapshot.display, tags: [...snapshot.display.tags] },
      checklist: snapshot.checklist.map((item) => ({ ...item })),
      proof: [...snapshot.proof],
      constraints: [...snapshot.constraints],
      notes: [...snapshot.notes],
      delivery: {
        ...snapshot.delivery,
        threadId: input.threadId
      }
    })),
    delivery: {
      threadId: input.threadId,
      turnId: null,
      messageId: null
    },
    report: payload.report
      ? { ...payload.report, evidence: [...payload.report.evidence] }
      : null,
    executionContract: input.contract
  };
  return finalizePayload(remapped);
}

export function updateJobPayload(payload: JobPayloadView, input: JobPayloadUpdateInput): JobPayloadView {
  const now = input.createdAt ?? Date.now();
  const contract = input.contract ?? payload.executionContract ?? null;
  const typedContract = contract as CodexThreadExecutionContractView | null;
  const summary = summaryFor(input, typedContract);
  const node = buildNode(payload, input, summary, now);
  const next: JobPayloadView = {
    ...payload,
    protocol: {
      ...payload.protocol,
      workerThreadId: payload.threadId,
      version: payload.protocol.version + 1,
      butlerThreadId: input.butlerThreadId ?? payload.protocol.butlerThreadId,
      parentThreadId: input.parentThreadId ?? payload.protocol.parentThreadId,
      reportChannel: "manor-harness"
    },
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
    snapshots: [...(payload.snapshots.length > 0 ? payload.snapshots : synthesizeSnapshots(payload))],
    delivery: {
      threadId: payload.threadId,
      turnId: input.turnId ?? payload.delivery.turnId,
      messageId: input.messageId ?? payload.delivery.messageId
    },
    report: input.report ?? payload.report,
    executionContract: typedContract ?? payload.executionContract
  };
  next.snapshots.push(snapshotFromPayload(next, node));
  return finalizePayload(next);
}

export function bindJobPayloadDelivery(payload: JobPayloadView, delivery: { turnId?: string | null; messageId?: string | null }): JobPayloadView {
  const currentNodeId = payload.currentNodeId;
  const turnId = delivery.turnId ?? payload.delivery.turnId;
  const messageId = delivery.messageId ?? payload.delivery.messageId;
  return finalizePayload({
    ...payload,
    revision: payload.revision + 1,
    updatedAt: Date.now(),
    nodes: payload.nodes.map((node) =>
      node.id === currentNodeId
        ? { ...node, turnId: turnId ?? node.turnId, messageId: messageId ?? node.messageId, updatedAt: Date.now() }
        : node
    ),
    snapshots: (payload.snapshots.length > 0 ? payload.snapshots : synthesizeSnapshots(payload)).map((snapshot) =>
      snapshot.nodeId === currentNodeId
        ? {
            ...snapshot,
            updatedAt: Date.now(),
            delivery: {
              threadId: payload.threadId,
              turnId: turnId ?? snapshot.delivery.turnId,
              messageId: messageId ?? snapshot.delivery.messageId
            }
          }
        : snapshot
    ),
    delivery: {
      threadId: payload.threadId,
      turnId,
      messageId
    }
  });
}

export function parseJobPayload(value: unknown): JobPayloadView | null {
  const record = value && typeof value === "object" ? value as Record<string, unknown> : null;
  if (!record) {
    return null;
  }
  const normalized = {
    ...record,
    snapshots: Array.isArray(record.snapshots)
      ? record.snapshots
      : Array.isArray(record.nodes)
        ? synthesizeSnapshots(record as unknown as JobPayloadView)
        : []
  };
  return Value.Check(JobPayloadSchema, normalized) ? normalized as JobPayloadView : null;
}

function payloadFilePath(rootDir: string, threadId: string): string {
  return path.join(rootDir, threadId, "current.json");
}

export async function persistJobPayload(rootDir: string, payload: JobPayloadView, options: { beforeCommit?: () => void | Promise<void> } = {}): Promise<JobPayloadView> {
  const parsed = parseJobPayload(payload);
  if (!parsed) {
    throw new Error("Invalid Manor job payload.");
  }
  await writeJsonStateFileAtomic(payloadFilePath(rootDir, payload.threadId), parsed, options);
  return parsed;
}

export async function readCurrentJobPayload(rootDir: string, threadId: string): Promise<JobPayloadView | null> {
  const payload = await fs
    .readFile(payloadFilePath(rootDir, threadId), "utf8")
    .then((raw) => parseJobPayload(JSON.parse(raw)))
    .catch(() => null);
  return payload?.threadId === threadId ? payload : null;
}

export function assertJobPayloadWorkerAuthority(payload: JobPayloadView, workerThreadId: string): void {
  if (
    payload.threadId !== workerThreadId ||
    payload.protocol.workerThreadId !== workerThreadId ||
    payload.delivery.threadId !== workerThreadId
  ) {
    throw new Error("Manor job payload is not bound to this Codex worker thread.");
  }
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
    ? `Use \`manor-harness --thread ${threadId} payload current\` to read the latest details, and keep that same \`--thread\` value for payload updates.`
    : "Use `manor-harness payload current` to read the latest details.";
}

function firstReadableSentence(value?: string | null): string | null {
  const source = value
    ?.replace(/`[^`]+`/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!source) {
    return null;
  }
  const match = source.match(/^(.{1,180}?)(?:[.!?](?:\s|$)|$)/);
  const sentence = (match?.[1] ?? source.slice(0, 180)).trim();
  return sentence ? sentence.replace(/[,:;]+$/, "") : null;
}

function finishSentence(value: string): string {
  return /[.!?]$/.test(value) ? value : `${value}.`;
}

function collaborativeDelegationLead(instruction?: string | null, summary?: string | null): string {
  const sentence = firstReadableSentence(instruction) ?? firstReadableSentence(summary) ?? "work on this task";
  const normalized = sentence.replace(/^please\s+/i, "").trim();
  const match = normalized.match(/^(build|create|implement|add|fix|verify|check|test|run|update|make)\s+(.+)$/i);
  if (match) {
    return finishSentence(`We're going to ${match[1]?.toLowerCase()} ${match[2] ?? ""}`.trim());
  }
  if (/^(we're|we are|let's|please)\b/i.test(sentence)) {
    return finishSentence(sentence);
  }
  return finishSentence(sentence);
}

function followUpLead(kind: JobPayloadKind, instruction?: string | null, summary?: string | null): string {
  const sentence = firstReadableSentence(instruction) ?? firstReadableSentence(summary);
  if (sentence) {
    return finishSentence(sentence);
  }
  if (kind === "rejection_followup") {
    return "Please take another pass on the checklist items that need work.";
  }
  if (kind === "assist_context") {
    return "I added Manor guidance for this job.";
  }
  return "Please continue from the latest job details.";
}

export function formatJobPayloadMessage(kind: JobPayloadKind, threadId?: string | null, instruction?: string | null, summary?: string | null): string {
  const readLatest = formatPayloadReadCommand(threadId);
  if (kind === "delegation") {
    return `${collaborativeDelegationLead(instruction, summary)} I put the job details in Manor for this thread. ${readLatest} Report back through the harness when done.`;
  }
  if (kind === "held_context") {
    return `${followUpLead(kind, instruction, summary)} I saved this as new context for the job. Keep going for now; I will apply it during review.`;
  }
  if (kind === "rejection_followup") {
    return `${followUpLead(kind, instruction, summary)} I updated the job payload with the checklist items that need another pass. ${readLatest}`;
  }
  if (kind === "assist_context") {
    return `${followUpLead(kind, instruction, summary)} ${readLatest} before continuing.`;
  }
  return `${followUpLead(kind, instruction, summary)} I updated the job payload. ${readLatest}`;
}

export function formatPayloadCurrentText(payload: JobPayloadView | null): string {
  if (!payload) {
    return "No Manor job payload is stored for this thread.";
  }
  return JSON.stringify(payload, null, 2);
}
