export type JobOutputManifestKind = "project_artifact" | "proof" | "worker_report";

export interface JobOutputManifestEntryView {
  id: string;
  kind: JobOutputManifestKind;
  title: string;
  threadId: string;
  projectId: string;
  attemptId: string;
  sourceTurnId: string | null;
  artifactId: string | null;
  proofRunId: string | null;
  reportTurnId: string | null;
  logicalPath: string | null;
  contentType: string | null;
  sizeBytes: number | null;
  checksumSha256: string | null;
  availability: "available" | "missing";
  checksumStatus: "verified" | "mismatch" | "unverified";
  integrityCheckedAt: number | null;
  createdAt: number;
}

export interface JobOutputManifestView {
  version: 1;
  entries: JobOutputManifestEntryView[];
}

export interface JobPayloadView {
  schemaVersion: "manor.job_payload.v1";
  payloadId: string;
  threadId: string;
  protocol: {
    taskId: string;
    butlerThreadId: string | null;
    workerThreadId: string;
    currentAttemptId: string;
    attempt: number;
    version: number;
    parentThreadId: string | null;
    reportChannel: "manor-harness";
  };
  rootNodeId: string;
  currentNodeId: string;
  revision: number;
  checksum: string;
  kind: string;
  status: string;
  createdAt: number;
  updatedAt: number;
  workspace: { cwd: string | null; branch: string | null };
  project: { id: string; label: string };
  display: { summary: string; tags: string[] };
  workerDirective: string;
  operatorGoal: string | null;
  requestedTask: string | null;
  checklist: Array<{ id: string; text: string; status: string; note: string | null }>;
  proof: string[];
  constraints: string[];
  notes: string[];
  attachments: { images: string[]; files: string[] };
  outputManifest: JobOutputManifestView;
  snapshots: Array<{
    nodeId: string;
    revision: number;
    kind: string;
    status: string;
    updatedAt: number;
    display: { summary: string; tags: string[] };
    workerDirective: string;
    operatorGoal: string | null;
    requestedTask: string | null;
    checklist: Array<{ id: string; text: string; status: string; note: string | null }>;
    proof: string[];
    constraints: string[];
    notes: string[];
    delivery: { threadId: string; turnId: string | null; messageId: string | null };
  }>;
  nodes: Array<{
    id: string;
    kind: string;
    parentId: string | null;
    turnId: string | null;
    messageId: string | null;
    createdAt: number;
    updatedAt: number;
    summary: string;
    instruction: string;
    imageReferenceIds: string[];
    fileReferenceIds: string[];
  }>;
  delivery: { threadId: string; turnId: string | null; messageId: string | null };
  report: {
    status: string;
    summary: string;
    details: string | null;
    updatedAt: number;
    evidence: unknown[];
  } | null;
  executionContract: unknown | null;
}
