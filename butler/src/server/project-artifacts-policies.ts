import crypto from "node:crypto";
import path from "node:path";
import { promises as dns } from "node:dns";
import { constants, createWriteStream, promises as fs } from "node:fs";
import { request as httpRequest, type IncomingMessage, type RequestOptions } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import { Transform, type Readable, type Writable } from "node:stream";
import { pipeline } from "node:stream/promises";

import { formatProjectArtifactAccessLine } from "./project-artifact-access.js";
import { redactSensitiveText } from "./redact-sensitive-text.js";
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
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".webp")) return "image/webp";
  if (lower.endsWith(".gif")) return "image/gif";
  if (lower.endsWith(".svg")) return "image/svg+xml";
  if (lower.endsWith(".avif")) return "image/avif";
  if (lower.endsWith(".webm")) return "video/webm";
  if (lower.endsWith(".mp4") || lower.endsWith(".m4v")) return "video/mp4";
  if (lower.endsWith(".mov")) return "video/quicktime";
  if (lower.endsWith(".ogv")) return "video/ogg";
  if (lower.endsWith(".pdf")) return "application/pdf";
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
const PROJECT_ARTIFACT_DOWNLOAD_TIMEOUT_MS = 30_000;
const MAX_PROJECT_ARTIFACT_REDIRECTS = 5;

export function sanitizeProjectArtifactProvenanceUrl(rawUrl: string): string {
  return redactSensitiveText(rawUrl.trim());
}

export async function pipeProjectArtifactStreamWithinLimit(input: {
  source: Readable;
  destination: Writable;
  maxBytes: number;
  onChunk?: (chunk: Buffer) => void;
}): Promise<number> {
  let sizeBytes = 0;
  const limiter = new Transform({
    transform(chunk: Buffer | string, _encoding, callback) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      sizeBytes += buffer.byteLength;
      if (sizeBytes > input.maxBytes) {
        callback(new Error(`Artifact exceeds ${input.maxBytes} bytes`));
        return;
      }
      try {
        input.onChunk?.(buffer);
        callback(null, buffer);
      } catch (error) {
        callback(error instanceof Error ? error : new Error(String(error)));
      }
    }
  });
  await pipeline(input.source, limiter, input.destination);
  return sizeBytes;
}

function isInsideRoot(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!!relative && !relative.startsWith("..") && !path.isAbsolute(relative));
}

export async function resolveApprovedProjectFilePath(sourceFilePath: string, approvedRoots: string[]): Promise<string> {
  const requested = path.resolve(sourceFilePath);
  if (approvedRoots.length === 0) throw new Error("No approved project file roots are configured");
  const roots = await Promise.all(
    approvedRoots.map(async (rawRoot) => {
      const root = path.resolve(rawRoot);
      return { root, realRoot: await fs.realpath(root).catch(() => null) };
    })
  );
  const existingRoots = roots.filter((entry): entry is { root: string; realRoot: string } => Boolean(entry.realRoot));
  const lexicalRoot = existingRoots.find(({ root }) => isInsideRoot(requested, root));
  if (!lexicalRoot) {
    throw new Error(`Source file is outside approved roots: ${roots.map(({ root }) => root).join(", ")}`);
  }
  const sourceStats = await fs.lstat(requested);
  if (sourceStats.isSymbolicLink()) throw new Error("Source file cannot be a symbolic link");
  const realSource = await fs.realpath(requested);
  if (!isInsideRoot(realSource, lexicalRoot.realRoot)) {
    throw new Error(`Source file resolves outside approved root ${lexicalRoot.root}`);
  }
  return realSource;
}

function ipv4Parts(address: string): number[] | null {
  const parts = address.split(".").map(Number);
  return parts.length === 4 && parts.every((part) => Number.isInteger(part) && part >= 0 && part <= 255) ? parts : null;
}

function isPublicIpv4(address: string): boolean {
  const parts = ipv4Parts(address);
  if (!parts) return false;
  const [a, b, c] = parts;
  if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
  if (a === 100 && b >= 64 && b <= 127) return false;
  if (a === 169 && b === 254) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && (b === 168 || (b === 0 && (c === 0 || c === 2)))) return false;
  if (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) return false;
  if (a === 203 && b === 0 && c === 113) return false;
  return true;
}

function ipv6Value(address: string): bigint | null {
  if (address.includes("%")) return null;
  const raw = address.toLowerCase();
  let normalized = raw;
  const lastColon = normalized.lastIndexOf(":");
  const ipv4 = normalized.slice(lastColon + 1);
  if (ipv4.includes(".")) {
    const parts = ipv4Parts(ipv4);
    if (!parts) return null;
    normalized = `${normalized.slice(0, lastColon)}:${((parts[0] << 8) | parts[1]).toString(16)}:${((parts[2] << 8) | parts[3]).toString(16)}`;
  }
  const halves = normalized.split("::");
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const missing = 8 - left.length - right.length;
  if ((halves.length === 1 && missing !== 0) || (halves.length === 2 && missing < 1)) return null;
  const words = [...left, ...Array(missing).fill("0"), ...right];
  if (words.length !== 8 || words.some((word) => !/^[0-9a-f]{1,4}$/.test(word))) return null;
  return words.reduce((value, word) => (value << 16n) | BigInt(`0x${word}`), 0n);
}

function inIpv6Prefix(value: bigint, prefix: bigint, bits: number): boolean {
  const shift = BigInt(128 - bits);
  return value >> shift === prefix >> shift;
}

function isPublicIpv6(address: string): boolean {
  const value = ipv6Value(address);
  if (value === null || value === 0n || value === 1n) return false;
  const mappedPrefix = 0xffffn << 32n;
  if (value >> 32n === mappedPrefix >> 32n) {
    const ipv4 = Number(value & 0xffffffffn);
    return isPublicIpv4(`${ipv4 >>> 24}.${(ipv4 >>> 16) & 255}.${(ipv4 >>> 8) & 255}.${ipv4 & 255}`);
  }
  return inIpv6Prefix(value, 0x20000000000000000000000000000000n, 3) &&
    !inIpv6Prefix(value, 0x20010000000000000000000000000000n, 32) &&
    !inIpv6Prefix(value, 0x20010010000000000000000000000000n, 28) &&
    !inIpv6Prefix(value, 0x20010002000000000000000000000000n, 48) &&
    !inIpv6Prefix(value, 0x20010020000000000000000000000000n, 28) &&
    !inIpv6Prefix(value, 0x20010db8000000000000000000000000n, 32) &&
    !inIpv6Prefix(value, 0x20020000000000000000000000000000n, 16) &&
    !inIpv6Prefix(value, 0x3fff0000000000000000000000000000n, 20);
}

export function isPublicProjectArtifactAddress(address: string): boolean {
  const family = isIP(address);
  return family === 4 ? isPublicIpv4(address) : family === 6 ? isPublicIpv6(address) : false;
}

async function resolvePublicArtifactAddress(hostname: string): Promise<{ address: string; family: 4 | 6 }> {
  const literalFamily = isIP(hostname);
  const records = literalFamily
    ? [{ address: hostname, family: literalFamily as 4 | 6 }]
    : await dns.lookup(hostname, { all: true, verbatim: true });
  if (records.length === 0) throw new Error(`Download host ${hostname} did not resolve`);
  if (records.some((record) => !isPublicProjectArtifactAddress(record.address))) {
    throw new Error(`Download host ${hostname} resolves to a non-public network address`);
  }
  return records[0] as { address: string; family: 4 | 6 };
}

function parseProjectArtifactUrl(rawUrl: string): URL {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error("Download URL is invalid");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("Download URL must use HTTP or HTTPS");
  if (url.username || url.password) throw new Error("Download URL cannot include credentials");
  return url;
}

type PublicArtifactResponse = { response: IncomingMessage; finalUrl: URL; clearDeadline: () => void };

async function withArtifactDownloadDeadline<T>(work: Promise<T>, deadline: number): Promise<T> {
  const remainingMs = deadline - Date.now();
  if (remainingMs <= 0) throw new Error(`Download timed out after ${PROJECT_ARTIFACT_DOWNLOAD_TIMEOUT_MS}ms`);
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`Download timed out after ${PROJECT_ARTIFACT_DOWNLOAD_TIMEOUT_MS}ms`)),
      remainingMs
    );
    work.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); }
    );
  });
}

async function requestPublicArtifactUrl(rawUrl: string, deadline: number, redirects = 0): Promise<PublicArtifactResponse> {
  if (redirects > MAX_PROJECT_ARTIFACT_REDIRECTS) throw new Error(`Download exceeded ${MAX_PROJECT_ARTIFACT_REDIRECTS} redirects`);
  const url = parseProjectArtifactUrl(rawUrl);
  const hostname = url.hostname.startsWith("[") && url.hostname.endsWith("]") ? url.hostname.slice(1, -1) : url.hostname;
  const resolved = await withArtifactDownloadDeadline(resolvePublicArtifactAddress(hostname), deadline);
  const remainingMs = deadline - Date.now();
  if (remainingMs <= 0) throw new Error(`Download timed out after ${PROJECT_ARTIFACT_DOWNLOAD_TIMEOUT_MS}ms`);
  const options: RequestOptions = {
    protocol: url.protocol,
    hostname: resolved.address,
    family: resolved.family,
    port: url.port || undefined,
    path: `${url.pathname}${url.search}`,
    method: "GET",
    headers: { host: url.host, accept: "*/*", "user-agent": "Manor-Project-Artifact/1.0" },
    ...(url.protocol === "https:" && isIP(hostname) === 0 ? { servername: hostname } : {})
  };
  const requester = url.protocol === "https:" ? httpsRequest : httpRequest;
  const result = await new Promise<PublicArtifactResponse>((resolve, reject) => {
    let response: IncomingMessage | null = null;
    const request = requester(options, (incoming) => {
      response = incoming;
      resolve({ response: incoming, finalUrl: url, clearDeadline: () => clearTimeout(deadlineTimer) });
    });
    const deadlineTimer = setTimeout(() => {
      const error = new Error(`Download timed out after ${PROJECT_ARTIFACT_DOWNLOAD_TIMEOUT_MS}ms`);
      response?.destroy(error);
      request.destroy(error);
    }, remainingMs);
    request.setTimeout(remainingMs, () => request.destroy(new Error(`Download timed out after ${PROJECT_ARTIFACT_DOWNLOAD_TIMEOUT_MS}ms`)));
    request.once("error", (error) => {
      clearTimeout(deadlineTimer);
      reject(error);
    });
    request.end();
  });
  const status = result.response.statusCode ?? 0;
  const location = result.response.headers.location;
  if ([301, 302, 303, 307, 308].includes(status)) {
    result.clearDeadline();
    result.response.destroy();
    if (!location) throw new Error(`Download redirect ${status} did not include a location`);
    return requestPublicArtifactUrl(new URL(location, url).toString(), deadline, redirects + 1);
  }
  if (status < 200 || status >= 300) {
    result.clearDeadline();
    result.response.destroy();
    throw new Error(`Download failed with ${status}`);
  }
  return result;
}

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
  const requestedAt = Date.now();
  const { response, finalUrl, clearDeadline } = await requestPublicArtifactUrl(
    input.url,
    requestedAt + PROJECT_ARTIFACT_DOWNLOAD_TIMEOUT_MS
  );
  const declaredLengthHeader = response.headers["content-length"];
  const declaredLength = Number(Array.isArray(declaredLengthHeader) ? declaredLengthHeader[0] : declaredLengthHeader ?? "");
  if (Number.isFinite(declaredLength) && declaredLength > MAX_PROJECT_ARTIFACT_DOWNLOAD_BYTES) {
    clearDeadline();
    response.destroy();
    throw new Error(`Download exceeds ${MAX_PROJECT_ARTIFACT_DOWNLOAD_BYTES} bytes`);
  }
  const target = await createArtifactFileTarget({
    artifactsDir: input.artifactsDir,
    projectId: input.projectId,
    fileName: input.fileName || path.basename(finalUrl.pathname) || "download.bin"
  }).catch((error) => {
    clearDeadline();
    response.destroy();
    throw error;
  });
  const responseContentType = Array.isArray(response.headers["content-type"])
    ? response.headers["content-type"][0]
    : response.headers["content-type"];
  const contentType = detectContentType(target.fileName, input.contentType || responseContentType);
  const hash = crypto.createHash("sha256");
  const previewChunks: Buffer[] = [];
  let previewBytes = 0;
  let sizeBytes = 0;
  response.on("data", (chunk: Buffer | string) => {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    sizeBytes += buffer.byteLength;
    if (sizeBytes > MAX_PROJECT_ARTIFACT_DOWNLOAD_BYTES) {
      response.destroy(new Error(`Download exceeds ${MAX_PROJECT_ARTIFACT_DOWNLOAD_BYTES} bytes`));
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
    await pipeline(response, createWriteStream(target.filePath));
  } catch (error) {
    await fs.rm(target.filePath, { force: true });
    throw error;
  } finally {
    clearDeadline();
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
      url: sanitizeProjectArtifactProvenanceUrl(input.url),
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
  approvedRoots?: string[];
}): Promise<ProjectArtifactView> {
  const sourceFilePath = input.approvedRoots
    ? await resolveApprovedProjectFilePath(input.sourceFilePath, input.approvedRoots)
    : path.resolve(input.sourceFilePath);
  const handle = await fs.open(sourceFilePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  const stats = await handle.stat();
  if (!stats.isFile()) {
    await handle.close();
    throw new Error("Source artifact is not a file");
  }
  if (stats.size > MAX_PROJECT_ARTIFACT_DOWNLOAD_BYTES) {
    await handle.close();
    throw new Error(`Artifact exceeds ${MAX_PROJECT_ARTIFACT_DOWNLOAD_BYTES} bytes`);
  }

  const fileName = sanitizeFileName(input.fileName || path.basename(sourceFilePath) || "artifact.bin");
  const contentType = detectContentType(fileName, input.contentType);
  const target = await createArtifactFileTarget({
    artifactsDir: input.artifactsDir,
    projectId: input.projectId,
    fileName
  }).catch(async (error) => {
    await handle.close().catch(() => undefined);
    throw error;
  });
  const hash = crypto.createHash("sha256");
  const previewChunks: Buffer[] = [];
  let previewBytes = 0;
  let sizeBytes = 0;
  try {
    const source = handle.createReadStream({ autoClose: false });
    sizeBytes = await pipeProjectArtifactStreamWithinLimit({
      source,
      destination: createWriteStream(target.filePath),
      maxBytes: MAX_PROJECT_ARTIFACT_DOWNLOAD_BYTES,
      onChunk: (buffer) => {
        hash.update(buffer);
        if (previewBytes < MAX_TEXT_PREVIEW_BYTES) {
          const slice = buffer.subarray(0, Math.min(buffer.byteLength, MAX_TEXT_PREVIEW_BYTES - previewBytes));
          previewChunks.push(slice);
          previewBytes += slice.byteLength;
        }
      }
    });
  } catch (error) {
    await fs.rm(target.filePath, { force: true });
    throw error;
  } finally {
    await handle.close().catch(() => undefined);
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
  mode: "context_only";
  executed: false;
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
  if (service && service.projectId !== policy.projectId) {
    throw new Error(`Service ${service.id} belongs to project ${service.projectId}, not ${policy.projectId}`);
  }
  const artifacts = getPolicyArtifacts(store, policy);
  const prefix = service ? `Loaded policy ${policy.title} for service ${service.title};` : `Loaded policy ${policy.title};`;
  return {
    policyId: policy.id,
    artifacts: [...policy.artifacts],
    mode: "context_only",
    executed: false,
    message: `${prefix} ${policy.instruction}${artifacts.length > 0 ? ` Artifacts: ${summarizePolicyArtifacts(artifacts)}.` : ""} No commands or service changes were executed.`
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
