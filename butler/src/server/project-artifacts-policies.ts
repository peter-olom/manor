import crypto from "node:crypto";
import path from "node:path";
import { createWriteStream, promises as fs } from "node:fs";
import { Readable } from "node:stream";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import { pipeline } from "node:stream/promises";

import { formatProjectArtifactAccessLine } from "./project-artifact-access.js";
import type { RuntimeBrokerClient } from "./runtime-broker-client.js";
import type { ButlerStateStore } from "./state-store.js";
import type {
  ProjectArtifactKind,
  ProjectArtifactView,
  ProjectPolicyView,
  ServiceLeaseView,
  StackLeaseView
} from "./types.js";

function normalizeList(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return [...new Set(value.map((entry) => (typeof entry === "string" ? entry.trim() : "")).filter(Boolean))];
}

export function normalizeArtifactMetadata(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object") {
    return {};
  }
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter((entry): entry is [string, string] => typeof entry[0] === "string" && typeof entry[1] === "string")
      .map(([key, entryValue]) => [key.trim(), entryValue.trim()])
      .filter(([key]) => key.length > 0)
  );
}

function sanitizeFileName(name: string, fallback = "artifact.txt"): string {
  const trimmed = name.trim();
  if (!trimmed) {
    return fallback;
  }
  const base = path.basename(trimmed).replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return base || fallback;
}

function sanitizeProjectSegment(value: string, fallback: string): string {
  const normalized = value.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return normalized || fallback;
}

function matchesRegexList(value: string, patterns: string[]): boolean {
  if (patterns.length === 0) {
    return true;
  }
  return patterns.some((pattern) => {
    try {
      return new RegExp(pattern, "i").test(value);
    } catch {
      return false;
    }
  });
}

function detectContentType(fileName: string, fallback?: string | null): string {
  const explicit = typeof fallback === "string" && fallback.trim() ? fallback.trim() : "";
  if (explicit) {
    return explicit;
  }
  const lower = fileName.toLowerCase();
  if (lower.endsWith(".sql")) return "application/sql";
  if (lower.endsWith(".json")) return "application/json";
  if (lower.endsWith(".html") || lower.endsWith(".htm")) return "text/html";
  if (lower.endsWith(".css")) return "text/css";
  if (lower.endsWith(".js") || lower.endsWith(".mjs") || lower.endsWith(".cjs")) return "text/javascript";
  if (lower.endsWith(".md")) return "text/markdown";
  if (lower.endsWith(".txt")) return "text/plain";
  if (lower.endsWith(".csv")) return "text/csv";
  return "application/octet-stream";
}

function isTextLike(contentType: string, fileName: string): boolean {
  return (
    contentType.startsWith("text/") ||
    contentType === "application/json" ||
    contentType === "application/sql" ||
    fileName.toLowerCase().endsWith(".sql")
  );
}

function buildTextPreview(buffer: Buffer, contentType: string, fileName: string): string | null {
  if (!isTextLike(contentType, fileName)) {
    return null;
  }
  const text = buffer.toString("utf8");
  return text.length > 2000 ? `${text.slice(0, 2000)}\n...[truncated]` : text;
}

const MAX_PROJECT_ARTIFACT_DOWNLOAD_BYTES = 100 * 1024 * 1024;
const MAX_TEXT_PREVIEW_BYTES = 4096;

async function writeArtifactFile(input: {
  artifactsDir: string;
  projectId: string;
  fileName: string;
  content: Buffer;
}): Promise<string> {
  const projectSegment = sanitizeProjectSegment(input.projectId, "project");
  const artifactSegment = crypto.randomUUID();
  const fileName = sanitizeFileName(input.fileName);
  const dir = path.join(input.artifactsDir, "projects", projectSegment, artifactSegment);
  await fs.mkdir(dir, { recursive: true });
  const filePath = path.join(dir, fileName);
  await fs.writeFile(filePath, input.content);
  return filePath;
}

async function createArtifactFileTarget(input: {
  artifactsDir: string;
  projectId: string;
  fileName: string;
}): Promise<{ fileName: string; filePath: string }> {
  const projectSegment = sanitizeProjectSegment(input.projectId, "project");
  const artifactSegment = crypto.randomUUID();
  const fileName = sanitizeFileName(input.fileName);
  const dir = path.join(input.artifactsDir, "projects", projectSegment, artifactSegment);
  await fs.mkdir(dir, { recursive: true });
  return {
    fileName,
    filePath: path.join(dir, fileName)
  };
}

async function checksumSha256(content: Buffer): Promise<string> {
  return crypto.createHash("sha256").update(content).digest("hex");
}

export async function createProjectArtifactFromText(input: {
  artifactsDir: string;
  projectId: string;
  projectLabel: string;
  threadId?: string | null;
  kind: ProjectArtifactKind;
  title: string;
  description?: string | null;
  fileName?: string | null;
  contentType?: string | null;
  text: string;
  tags?: string[];
  metadata?: Record<string, string>;
}): Promise<ProjectArtifactView> {
  const fileName = sanitizeFileName(
    input.fileName || `${input.title.toLowerCase().replace(/[^a-z0-9._-]+/g, "-") || "artifact"}.txt`
  );
  const contentType = detectContentType(fileName, input.contentType);
  const content = Buffer.from(input.text, "utf8");
  const filePath = await writeArtifactFile({
    artifactsDir: input.artifactsDir,
    projectId: input.projectId,
    fileName,
    content
  });
  const now = Date.now();
  return {
    id: crypto.randomUUID(),
    projectId: input.projectId,
    projectLabel: input.projectLabel,
    kind: input.kind,
    title: input.title.trim(),
    description: typeof input.description === "string" && input.description.trim() ? input.description.trim() : null,
    fileName,
    filePath,
    contentType,
    sizeBytes: content.byteLength,
    tags: normalizeList(input.tags),
    metadata: input.metadata ?? {},
    source: {
      kind: "inline",
      url: null,
      createdByThreadId: input.threadId?.trim() || null,
      checksumSha256: await checksumSha256(content)
    },
    textPreview: buildTextPreview(content, contentType, fileName),
    createdAt: now,
    updatedAt: now
  };
}

export async function createProjectArtifactFromUrl(input: {
  artifactsDir: string;
  projectId: string;
  projectLabel: string;
  threadId?: string | null;
  kind: ProjectArtifactKind;
  title: string;
  description?: string | null;
  url: string;
  fileName?: string | null;
  contentType?: string | null;
  tags?: string[];
  metadata?: Record<string, string>;
}): Promise<ProjectArtifactView> {
  const response = await fetch(input.url);
  if (!response.ok) {
    throw new Error(`Download failed with ${response.status}`);
  }
  const declaredLength = Number(response.headers.get("content-length") ?? "");
  if (Number.isFinite(declaredLength) && declaredLength > MAX_PROJECT_ARTIFACT_DOWNLOAD_BYTES) {
    throw new Error(`Download exceeds ${MAX_PROJECT_ARTIFACT_DOWNLOAD_BYTES} bytes`);
  }
  if (!response.body) {
    throw new Error("Download returned no body");
  }
  const urlPath = (() => {
    try {
      return new URL(input.url).pathname;
    } catch {
      return "";
    }
  })();
  const target = await createArtifactFileTarget({
    artifactsDir: input.artifactsDir,
    projectId: input.projectId,
    fileName: input.fileName || path.basename(urlPath) || "download.bin"
  });
  const responseContentType = response.headers.get("content-type");
  const contentType = detectContentType(target.fileName, input.contentType || responseContentType);
  const hash = crypto.createHash("sha256");
  const previewChunks: Buffer[] = [];
  let previewBytes = 0;
  let sizeBytes = 0;
  const source = Readable.fromWeb(response.body as NodeReadableStream<Uint8Array>);
  source.on("data", (chunk: Buffer | string) => {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    sizeBytes += buffer.byteLength;
    if (sizeBytes > MAX_PROJECT_ARTIFACT_DOWNLOAD_BYTES) {
      source.destroy(new Error(`Download exceeds ${MAX_PROJECT_ARTIFACT_DOWNLOAD_BYTES} bytes`));
      return;
    }
    hash.update(buffer);
    if (previewBytes < MAX_TEXT_PREVIEW_BYTES) {
      const slice = buffer.subarray(0, Math.min(buffer.byteLength, MAX_TEXT_PREVIEW_BYTES - previewBytes));
      previewChunks.push(slice);
      previewBytes += slice.byteLength;
    }
  });
  try {
    await pipeline(source, createWriteStream(target.filePath));
  } catch (error) {
    await fs.rm(target.filePath, { force: true });
    throw error;
  }
  const previewBuffer = previewChunks.length > 0 ? Buffer.concat(previewChunks) : Buffer.alloc(0);
  const now = Date.now();
  return {
    id: crypto.randomUUID(),
    projectId: input.projectId,
    projectLabel: input.projectLabel,
    kind: input.kind,
    title: input.title.trim(),
    description: typeof input.description === "string" && input.description.trim() ? input.description.trim() : null,
    fileName: target.fileName,
    filePath: target.filePath,
    contentType,
    sizeBytes,
    tags: normalizeList(input.tags),
    metadata: input.metadata ?? {},
    source: {
      kind: "url",
      url: input.url.trim(),
      createdByThreadId: input.threadId?.trim() || null,
      checksumSha256: hash.digest("hex")
    },
    textPreview: buildTextPreview(previewBuffer, contentType, target.fileName),
    createdAt: now,
    updatedAt: now
  };
}

export async function createProjectArtifactFromFile(input: {
  artifactsDir: string;
  projectId: string;
  projectLabel: string;
  threadId?: string | null;
  kind: ProjectArtifactKind;
  title: string;
  description?: string | null;
  sourceFilePath: string;
  fileName?: string | null;
  contentType?: string | null;
  tags?: string[];
  metadata?: Record<string, string>;
}): Promise<ProjectArtifactView> {
  const sourceFilePath = path.resolve(input.sourceFilePath);
  const stats = await fs.stat(sourceFilePath);
  if (!stats.isFile()) {
    throw new Error("Source artifact is not a file");
  }
  if (stats.size > MAX_PROJECT_ARTIFACT_DOWNLOAD_BYTES) {
    throw new Error(`Artifact exceeds ${MAX_PROJECT_ARTIFACT_DOWNLOAD_BYTES} bytes`);
  }

  const fileName = sanitizeFileName(input.fileName || path.basename(sourceFilePath) || "artifact.bin");
  const contentType = detectContentType(fileName, input.contentType);
  const target = await createArtifactFileTarget({
    artifactsDir: input.artifactsDir,
    projectId: input.projectId,
    fileName
  });
  const hash = crypto.createHash("sha256");
  const previewChunks: Buffer[] = [];
  let previewBytes = 0;
  const handle = await fs.open(sourceFilePath, "r");
  try {
    for await (const chunk of handle.createReadStream()) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      hash.update(buffer);
      if (previewBytes < MAX_TEXT_PREVIEW_BYTES) {
        const slice = buffer.subarray(0, Math.min(buffer.byteLength, MAX_TEXT_PREVIEW_BYTES - previewBytes));
        previewChunks.push(slice);
        previewBytes += slice.byteLength;
      }
    }
  } finally {
    await handle.close().catch(() => undefined);
  }
  await fs.copyFile(sourceFilePath, target.filePath);
  const previewBuffer = previewChunks.length > 0 ? Buffer.concat(previewChunks) : Buffer.alloc(0);
  const now = Date.now();
  return {
    id: crypto.randomUUID(),
    projectId: input.projectId,
    projectLabel: input.projectLabel,
    kind: input.kind,
    title: input.title.trim(),
    description: typeof input.description === "string" && input.description.trim() ? input.description.trim() : null,
    fileName: target.fileName,
    filePath: target.filePath,
    contentType,
    sizeBytes: stats.size,
    tags: normalizeList(input.tags),
    metadata: input.metadata ?? {},
    source: {
      kind: "generated",
      url: null,
      createdByThreadId: input.threadId?.trim() || null,
      checksumSha256: hash.digest("hex")
    },
    textPreview: buildTextPreview(previewBuffer, contentType, target.fileName),
    createdAt: now,
    updatedAt: now
  };
}

export async function readProjectArtifactContent(artifact: ProjectArtifactView): Promise<{
  content: string | null;
  truncated: boolean;
}> {
  if (!isTextLike(artifact.contentType, artifact.fileName)) {
    return { content: null, truncated: false };
  }
  const raw = await fs.readFile(artifact.filePath, "utf8");
  if (raw.length > 100_000) {
    return { content: `${raw.slice(0, 100_000)}\n...[truncated]`, truncated: true };
  }
  return { content: raw, truncated: false };
}

export function buildProjectPolicy(input: {
  projectId: string;
  projectLabel: string;
  title: string;
  instruction: string;
  artifacts?: string[];
  triggers?: string[];
  policyId?: string | null;
  existing?: ProjectPolicyView | null;
}): ProjectPolicyView {
  const now = Date.now();
  const previous = input.existing ?? null;
  const artifacts = input.artifacts === undefined ? previous?.artifacts ?? [] : input.artifacts;
  const triggers = input.triggers === undefined ? previous?.triggers ?? [] : input.triggers;
  return {
    id: input.policyId?.trim() || previous?.id || crypto.randomUUID(),
    projectId: input.projectId,
    projectLabel: input.projectLabel,
    title: input.title.trim(),
    instruction: input.instruction.trim(),
    artifacts: normalizeList(artifacts),
    triggers: normalizeList(triggers),
    createdAt: previous?.createdAt ?? now,
    updatedAt: now
  };
}

export function resolveProjectPolicyArtifactIds(input: {
  store: ButlerStateStore;
  projectId: string;
  artifactIds: string[] | undefined;
}): string[] | undefined {
  if (input.artifactIds === undefined) {
    return undefined;
  }
  const normalized = normalizeList(input.artifactIds);
  const invalid = normalized.filter((artifactId) => !input.store.getProjectArtifact(input.projectId, artifactId));
  if (invalid.length > 0) {
    throw new Error(`Unknown project artifact id${invalid.length === 1 ? "" : "s"}: ${invalid.join(", ")}`);
  }
  return normalized;
}

function buildServiceStartedTriggerTerms(input: {
  service: ServiceLeaseView;
  stack: Pick<StackLeaseView, "storageMode"> | null;
}): string[] {
  const mode = input.stack?.storageMode ?? "none";
  return [
    "service.started",
    `service.started:${input.service.templateId}`,
    `service.started:${input.service.connection.engine}`,
    `service.started:${mode}`,
    `service.started:${input.service.templateId}:${input.service.connection.engine}`,
    `service.started:${input.service.templateId}:${mode}`,
    `service.started:${input.service.connection.engine}:${mode}`,
    `service.started:${input.service.templateId}:${input.service.connection.engine}:${mode}`
  ];
}

function matchesPolicyTriggerList(triggers: string[], terms: string[]): boolean {
  if (triggers.length === 0) {
    return false;
  }
  return triggers.some((trigger) => {
    const normalized = trigger.trim();
    if (!normalized) {
      return false;
    }
    if (terms.includes(normalized)) {
      return true;
    }
    return terms.some((term) => matchesRegexList(term, [normalized]));
  });
}

export function matchesServiceStartedPolicy(input: {
  policy: ProjectPolicyView;
  service: ServiceLeaseView;
  stack: Pick<StackLeaseView, "storageMode"> | null;
}): boolean {
  return matchesPolicyTriggerList(input.policy.triggers, buildServiceStartedTriggerTerms(input));
}

function getPolicyArtifacts(store: ButlerStateStore, policy: ProjectPolicyView): ProjectArtifactView[] {
  return [...new Set(policy.artifacts)]
    .map((artifactId) => store.getProjectArtifact(policy.projectId, artifactId))
    .filter((artifact): artifact is ProjectArtifactView => Boolean(artifact));
}

function summarizePolicyArtifacts(artifacts: ProjectArtifactView[]): string {
  return artifacts.length > 0
    ? artifacts.map((artifact) => formatProjectArtifactAccessLine(artifact)).join("; ")
    : "none";
}

export function formatProjectPolicyContextLines(input: {
  store: ButlerStateStore;
  projectId: string;
}): string[] {
  const policies = input.store.listProjectPolicies(input.projectId);
  if (policies.length === 0) {
    return [];
  }
  return [
    "Project policies:",
    ...policies.map((policy, index) => {
      const artifacts = getPolicyArtifacts(input.store, policy);
      return `${index + 1}. ${policy.title} | triggers=${policy.triggers.join("|") || "none"} | artifacts=${summarizePolicyArtifacts(artifacts)} | ${policy.instruction}`;
    })
  ];
}

function describeMatchedServicePolicy(policy: ProjectPolicyView, artifacts: ProjectArtifactView[]): string {
  return `Matched policy ${policy.title}; ${policy.instruction}${artifacts.length > 0 ? ` Artifacts: ${summarizePolicyArtifacts(artifacts)}.` : ""}`;
}

export function formatMatchedServicePolicyContextLines(input: {
  store: ButlerStateStore;
  service: ServiceLeaseView;
  stack: Pick<StackLeaseView, "storageMode"> | null;
}): string[] {
  const policies = input.store
    .listProjectPolicies(input.service.projectId)
    .filter((policy) => matchesServiceStartedPolicy({ policy, service: input.service, stack: input.stack }));
  if (policies.length === 0) {
    return [];
  }
  return [
    "Matched project policies:",
    ...policies.map((policy, index) => {
      const artifacts = getPolicyArtifacts(input.store, policy);
      return `${index + 1}. ${describeMatchedServicePolicy(policy, artifacts)}`;
    })
  ];
}

export function findProjectPolicyBySelector(input: {
  store: ButlerStateStore;
  projectId: string;
  selector: string;
}): ProjectPolicyView | null {
  const selector = input.selector.trim();
  if (!selector) {
    return null;
  }
  const folded = selector.toLowerCase();
  const policies = input.store.listProjectPolicies(input.projectId);
  const idMatch = policies.find((policy) => policy.id === selector);
  if (idMatch) {
    return idMatch;
  }
  const titleMatches = policies.filter((policy) => policy.title.trim().toLowerCase() === folded);
  if (titleMatches.length > 1) {
    throw new Error(`Policy title is ambiguous; use the policy id for '${selector}'`);
  }
  return titleMatches[0] ?? null;
}

type PolicyApplicationResult = {
  policyId: string;
  artifacts: string[];
  message: string;
};

async function executeProjectPolicy(input: {
  store: ButlerStateStore;
  runtimeBroker: RuntimeBrokerClient;
  policy: ProjectPolicyView;
  service?: ServiceLeaseView | null;
  stack?: Pick<StackLeaseView, "storageMode"> | null;
}): Promise<PolicyApplicationResult> {
  const { store, policy, service } = input;
  const artifacts = getPolicyArtifacts(store, policy);
  const prefix = service ? `Matched policy ${policy.title};` : `Loaded policy ${policy.title};`;
  return {
    policyId: policy.id,
    artifacts: [...policy.artifacts],
    message: `${prefix} ${policy.instruction}${artifacts.length > 0 ? ` Artifacts: ${summarizePolicyArtifacts(artifacts)}.` : ""}`
  };
}

export async function applyServiceStartedPolicies(input: {
  artifactsDir: string;
  store: ButlerStateStore;
  runtimeBroker: RuntimeBrokerClient;
  service: ServiceLeaseView;
  stack: Pick<StackLeaseView, "storageMode"> | null;
}): Promise<
  Array<{
    policyId: string;
    artifacts: string[];
    message: string;
  }>
> {
  const { store, runtimeBroker, service, stack } = input;
  const policies = store.listProjectPolicies(service.projectId).filter((policy) =>
    matchesServiceStartedPolicy({ policy, service, stack })
  );
  const results: Array<{
    policyId: string;
    artifacts: string[];
    message: string;
  }> = [];

  for (const policy of policies) {
    results.push(await executeProjectPolicy({ store, runtimeBroker, policy, service, stack }));
  }

  return results;
}

export async function invokeProjectPolicy(input: {
  store: ButlerStateStore;
  runtimeBroker: RuntimeBrokerClient;
  policy: ProjectPolicyView;
  service?: ServiceLeaseView | null;
  stack?: Pick<StackLeaseView, "storageMode"> | null;
}): Promise<PolicyApplicationResult> {
  return executeProjectPolicy(input);
}
