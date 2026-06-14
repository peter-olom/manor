import crypto from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

import type { HarnessCapability } from "./codex-harness-helpers.js";
import { normalizeString } from "./codex-harness-helpers.js";
import { ButlerStateStore } from "./state-store.js";
import type { CodexThreadRecord, PreviewVerificationView } from "./types.js";

function safeFileName(value: string): string {
  return path.basename(value).replace(/[^\w.-]+/g, "-") || "proof-file";
}

function contentTypeForFile(fileName: string): string {
  const extension = path.extname(fileName).toLowerCase();
  const types: Record<string, string> = {
    ".csv": "text/csv; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".cjs": "text/javascript; charset=utf-8",
    ".env": "text/plain; charset=utf-8",
    ".gif": "image/gif",
    ".htm": "text/html; charset=utf-8",
    ".html": "text/html; charset=utf-8",
    ".ini": "text/plain; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".jpeg": "image/jpeg",
    ".jpg": "image/jpeg",
    ".json": "application/json",
    ".jsonl": "application/x-ndjson",
    ".lock": "text/plain; charset=utf-8",
    ".log": "text/plain; charset=utf-8",
    ".md": "text/markdown; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8",
    ".pdf": "application/pdf",
    ".png": "image/png",
    ".sql": "application/sql",
    ".svg": "image/svg+xml",
    ".toml": "application/toml",
    ".ts": "text/plain; charset=utf-8",
    ".tsx": "text/plain; charset=utf-8",
    ".txt": "text/plain; charset=utf-8",
    ".xml": "application/xml",
    ".yaml": "application/yaml",
    ".yml": "application/yaml",
    ".zip": "application/zip"
  };
  return types[extension] ?? "application/octet-stream";
}

function defaultTextProofFileName(title: string): string {
  const stem = title.replace(/[^\w.-]+/g, "-").replace(/^-+|-+$/g, "").toLowerCase() || "proof-note";
  return `${stem}.txt`;
}

function emptyVerification(runId: string, now: number, title: string, artifact: PreviewVerificationView["artifacts"][number]): PreviewVerificationView {
  return {
    runId,
    mode: "headless",
    checkedAt: now,
    durationMs: 0,
    ok: true,
    status: null,
    title,
    url: "",
    error: null,
    failureKind: "none",
    summary: {
      consoleMessageCount: 0,
      pageErrorCount: 0,
      failedRequestCount: 0,
      responseErrorCount: 0,
      assetFailureCount: 0,
      phaseCount: 1
    },
    phases: [
      {
        name: "record_file_proof",
        label: "Record file proof",
        status: "completed",
        startedAt: now,
        completedAt: now,
        durationMs: 0,
        message: "Copied file proof into Manor storage."
      }
    ],
    readiness: {
      initialUrl: "",
      finalUrl: "",
      expectedPath: null,
      selector: null,
      selectorSatisfied: null,
      routeStatus: null,
      routeOk: true,
      loginRedirectDetected: false,
      htmlErrorSignals: [],
      sameOriginAssetFailureCount: 0,
      websocketFailureCount: 0,
      notes: []
    },
    auth: {
      headerCount: 0,
      cookieCount: 0,
      cookieNames: [],
      usedSessionCookie: false
    },
    artifacts: [artifact],
    consoleMessages: [],
    pageErrors: [],
    failedRequests: []
  };
}

export async function handleHarnessProofAction(input: {
  action: string;
  params: Record<string, unknown>;
  capability: HarnessCapability;
  thread: CodexThreadRecord;
  store: ButlerStateStore;
  artifactsDir: string;
  resolveWorkspaceProject: () => { id: string; label: string };
}): Promise<{ text: string; data?: Record<string, unknown> } | null> {
  if (input.action !== "proof.file" && input.action !== "proof.text") {
    return null;
  }

  const runId = `file-${crypto.randomUUID()}`;
  const now = Date.now();
  const targetDir = path.join(input.artifactsDir, "files", input.capability.threadId, runId);
  await fs.mkdir(targetDir, { recursive: true });

  const requestedTitle = normalizeString(input.params.title);
  const text = typeof input.params.text === "string" ? input.params.text : "";
  let fileName = "";
  let targetPath = "";
  let sizeBytes = 0;
  let contentType = "";

  if (input.action === "proof.text") {
    if (!requestedTitle) {
      throw new Error("proof.text requires title");
    }
    if (!text.trim()) {
      throw new Error("proof.text requires text");
    }
    fileName = safeFileName(normalizeString(input.params.fileName) || defaultTextProofFileName(requestedTitle));
    targetPath = path.join(targetDir, fileName);
    await fs.writeFile(targetPath, text, "utf8");
    sizeBytes = Buffer.byteLength(text, "utf8");
    contentType = normalizeString(input.params.contentType) || contentTypeForFile(fileName);
  } else {
    const rawFilePath = normalizeString(input.params.filePath);
    if (!rawFilePath) {
      throw new Error("proof.file requires filePath");
    }

    const sourcePath = path.resolve(input.capability.cwd, rawFilePath);
    const stat = await fs.stat(sourcePath).catch(() => null);
    if (!stat?.isFile()) {
      throw new Error(`Proof file does not exist or is not a regular file: ${rawFilePath}`);
    }

    fileName = safeFileName(sourcePath);
    targetPath = path.join(targetDir, fileName);
    await fs.copyFile(sourcePath, targetPath);
    sizeBytes = stat.size;
    contentType = normalizeString(input.params.contentType) || contentTypeForFile(fileName);
  }

  const label = normalizeString(input.params.label) || fileName;
  const title = normalizeString(input.params.title) || `File proof: ${label}`;
  const project = input.resolveWorkspaceProject();
  const artifact = {
    kind: "file" as const,
    label,
    fileName,
    filePath: targetPath,
    contentType,
    sizeBytes,
    url: null,
    downloadUrl: null,
    availability: "available" as const,
    retainedUntilAt: null,
    expiredAt: null
  };
  const verification = emptyVerification(runId, now, title, artifact);
  const proof = input.store.recordBrowserVerification({
    threadId: input.capability.threadId,
    projectId: project.id,
    projectLabel: project.label,
    title,
    verification
  });

  return {
    text: `Recorded ${input.action === "proof.text" ? "text" : "file"} proof ${runId}.`,
    data: { proof, verification }
  };
}
