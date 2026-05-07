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
    ".gif": "image/gif",
    ".htm": "text/html; charset=utf-8",
    ".html": "text/html; charset=utf-8",
    ".jpeg": "image/jpeg",
    ".jpg": "image/jpeg",
    ".json": "application/json",
    ".log": "text/plain; charset=utf-8",
    ".md": "text/markdown; charset=utf-8",
    ".pdf": "application/pdf",
    ".png": "image/png",
    ".txt": "text/plain; charset=utf-8",
    ".xml": "application/xml",
    ".yaml": "application/yaml",
    ".yml": "application/yaml",
    ".zip": "application/zip"
  };
  return types[extension] ?? "application/octet-stream";
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
  if (input.action !== "proof.file") {
    return null;
  }

  const rawFilePath = normalizeString(input.params.filePath);
  if (!rawFilePath) {
    throw new Error("proof.file requires filePath");
  }

  const sourcePath = path.resolve(input.capability.cwd, rawFilePath);
  const stat = await fs.stat(sourcePath).catch(() => null);
  if (!stat?.isFile()) {
    throw new Error(`Proof file does not exist or is not a regular file: ${rawFilePath}`);
  }

  const runId = `file-${crypto.randomUUID()}`;
  const now = Date.now();
  const fileName = safeFileName(sourcePath);
  const targetDir = path.join(input.artifactsDir, "files", input.capability.threadId, runId);
  const targetPath = path.join(targetDir, fileName);
  await fs.mkdir(targetDir, { recursive: true });
  await fs.copyFile(sourcePath, targetPath);

  const label = normalizeString(input.params.label) || fileName;
  const title = normalizeString(input.params.title) || `File proof: ${label}`;
  const project = input.resolveWorkspaceProject();
  const artifact = {
    kind: "file" as const,
    label,
    fileName,
    filePath: targetPath,
    contentType: normalizeString(input.params.contentType) || contentTypeForFile(fileName),
    sizeBytes: stat.size,
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
    text: `Recorded file proof ${runId}.`,
    data: { proof, verification }
  };
}
