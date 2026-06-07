import crypto from "node:crypto";

import type express from "express";

import type { ButlerSseHub } from "./server-runtime-helpers.js";
import type { ButlerStateStore } from "./state-store.js";

type OperatorPreviewAnnotation = {
  id: string;
  number: number;
  x: number;
  y: number;
  width: number;
  height: number;
  color: string;
  note: string;
};

type OperatorPreviewAnnotationBatch = {
  id: string;
  at: number;
  intent: "batch" | "insert";
  leaseId: string;
  targetId: string;
  page: { title: string; url: string };
  annotations: OperatorPreviewAnnotation[];
};

type AnnotationPrefillTarget = { kind: "butler" } | { kind: "thread"; threadId: string };

export type PreviewAnnotationRoutesAccess = {
  app: express.Express;
  previewAnnotationSecret: string;
  runtimeBrokerToken: string | null;
  sseHub: ButlerSseHub;
  store: ButlerStateStore;
};

const MAX_PREVIEW_ANNOTATION_BATCHES = 40;

function clampUnit(value: unknown): number {
  const number = typeof value === "number" && Number.isFinite(value) ? value : 0;
  return Math.min(1, Math.max(0, number));
}

function normalizeOperatorPreviewAnnotationBatch(input: unknown): OperatorPreviewAnnotationBatch | null {
  if (!input || typeof input !== "object") {
    return null;
  }
  const record = input as Record<string, unknown>;
  const leaseId = typeof record.leaseId === "string" ? record.leaseId.trim() : "";
  const annotations = Array.isArray(record.annotations) ? record.annotations : [];
  const normalizedAnnotations = annotations
    .filter((entry): entry is Record<string, unknown> => Boolean(entry && typeof entry === "object"))
    .map((entry, index) => ({
      id: typeof entry.id === "string" && entry.id.trim() ? entry.id.trim().slice(0, 80) : `annotation-${index + 1}`,
      number: typeof entry.number === "number" && Number.isFinite(entry.number) ? Math.max(1, Math.trunc(entry.number)) : index + 1,
      x: clampUnit(entry.x),
      y: clampUnit(entry.y),
      width: clampUnit(entry.width),
      height: clampUnit(entry.height),
      color: typeof entry.color === "string" && entry.color.trim() ? entry.color.trim().slice(0, 32) : "#ff6b2c",
      note: typeof entry.note === "string" ? entry.note.slice(0, 1000) : ""
    }))
    .filter((entry) => entry.width > 0 && entry.height > 0)
    .slice(0, 100);

  if (!leaseId || normalizedAnnotations.length === 0) {
    return null;
  }

  const page = record.page && typeof record.page === "object" ? record.page as Record<string, unknown> : {};
  return {
    id: crypto.randomUUID(),
    at: Date.now(),
    intent: record.intent === "insert" ? "insert" : "batch",
    leaseId,
    targetId: typeof record.targetId === "string" && record.targetId.trim() ? record.targetId.trim().slice(0, 160) : "butler",
    page: {
      title: typeof page.title === "string" ? page.title.slice(0, 200) : "",
      url: typeof page.url === "string" ? page.url.slice(0, 2000) : ""
    },
    annotations: normalizedAnnotations
  };
}

function normalizeInternalAnnotationPrefillTarget(input: unknown): AnnotationPrefillTarget | null {
  if (!input || typeof input !== "object") {
    return null;
  }
  const id = typeof (input as { id?: unknown }).id === "string" ? (input as { id: string }).id.trim() : "";
  if (id === "butler") {
    return { kind: "butler" };
  }
  if (id.startsWith("thread:")) {
    const threadId = id.slice("thread:".length).trim();
    return threadId ? { kind: "thread", threadId } : null;
  }
  return null;
}

function formatAnnotationBatchText(batch: OperatorPreviewAnnotationBatch): string {
  const pageLine = batch.page.url ? `Page: ${batch.page.title || "Untitled"} (${batch.page.url})` : `Page: ${batch.page.title || "Untitled"}`;
  const pct = (value: number) => `${Math.round(value * 1000) / 10}%`;
  return [
    "Preview annotation batch",
    pageLine,
    "",
    ...batch.annotations.map((annotation) => {
      const rect = `x=${pct(annotation.x)}, y=${pct(annotation.y)}, w=${pct(annotation.width)}, h=${pct(annotation.height)}`;
      return `${annotation.number}. ${annotation.note || "Review this marked region."} (${rect})`;
    })
  ].join("\n");
}

export function registerPreviewAnnotationRoutes(access: PreviewAnnotationRoutesAccess): void {
  const previewAnnotationBatches = new Map<string, OperatorPreviewAnnotationBatch[]>();

  function buildPreviewAnnotationToken(leaseId: string): string {
    return crypto.createHmac("sha256", access.previewAnnotationSecret).update(leaseId).digest("hex");
  }

  function hasPreviewAnnotationAccess(request: express.Request, leaseId: string): boolean {
    return request.header("x-manor-preview-annotation-token") === buildPreviewAnnotationToken(leaseId);
  }

  function resolveAnnotationPrefillTarget(batch: OperatorPreviewAnnotationBatch): AnnotationPrefillTarget | null {
    if (batch.targetId === "butler") {
      return { kind: "butler" };
    }
    if (!batch.targetId.startsWith("thread:")) {
      return null;
    }
    const threadId = batch.targetId.slice("thread:".length).trim();
    const lease = access.store.getPreviewLease(batch.leaseId);
    if (!threadId || lease?.threadId !== threadId || !access.store.getThread(threadId)) {
      return null;
    }
    return { kind: "thread", threadId };
  }

  function recordPreviewAnnotationBatch(batch: OperatorPreviewAnnotationBatch): void {
    const current = previewAnnotationBatches.get(batch.leaseId) ?? [];
    current.push(batch);
    if (current.length > MAX_PREVIEW_ANNOTATION_BATCHES) {
      current.splice(0, current.length - MAX_PREVIEW_ANNOTATION_BATCHES);
    }
    previewAnnotationBatches.set(batch.leaseId, current);
    access.store.notePreviewLeaseActivity(batch.leaseId, batch.at);
  }

  access.app.post("/api/preview-annotations/batches", (request, response) => {
    const batch = normalizeOperatorPreviewAnnotationBatch(request.body);
    if (!batch) {
      response.status(400).json({ error: "leaseId and annotations are required" });
      return;
    }
    const lease = access.store.getPreviewLease(batch.leaseId);
    if (!lease || lease.status === "stopped" || lease.status === "stopping") {
      response.status(404).json({ error: "Preview lease not found" });
      return;
    }
    if (!hasPreviewAnnotationAccess(request, batch.leaseId)) {
      response.status(403).json({ error: "Forbidden" });
      return;
    }
    const target = resolveAnnotationPrefillTarget(batch);
    if (batch.intent === "insert" && !target) {
      response.status(400).json({ error: "Annotation target is unavailable" });
      return;
    }

    recordPreviewAnnotationBatch(batch);
    if (batch.intent === "insert" && target) {
      access.sseHub.broadcastComposerPrefill({
        id: crypto.randomUUID(),
        target,
        text: formatAnnotationBatchText(batch)
      });
      access.sseHub.broadcastToast("Preview annotations inserted into the composer.", "success", 2200);
    }

    response.json({ ok: true, batch });
  });

  access.app.get("/api/preview-annotations/:leaseId/batches", (request, response) => {
    const leaseId = typeof request.params.leaseId === "string" ? request.params.leaseId.trim() : "";
    const lease = leaseId ? access.store.getPreviewLease(leaseId) : null;
    if (!lease) {
      response.status(404).json({ error: "Preview lease not found" });
      return;
    }
    if (!hasPreviewAnnotationAccess(request, leaseId)) {
      response.status(403).json({ error: "Forbidden" });
      return;
    }
    response.json({ batches: previewAnnotationBatches.get(leaseId) ?? [] });
  });

  access.app.post("/api/internal/browser-annotations/insert", (request, response) => {
    if (!access.runtimeBrokerToken || request.header("x-manor-broker-token") !== access.runtimeBrokerToken) {
      response.status(403).json({ error: "Forbidden" });
      return;
    }
    const target = normalizeInternalAnnotationPrefillTarget(request.body?.target);
    const text = typeof request.body?.text === "string" ? request.body.text.trim() : "";
    if (!target || !text) {
      response.status(400).json({ error: "target and text are required" });
      return;
    }
    if (target.kind === "thread" && !access.store.getThread(target.threadId)) {
      response.status(404).json({ error: "Thread not found" });
      return;
    }
    access.sseHub.broadcastComposerPrefill({
      id: crypto.randomUUID(),
      target,
      text
    });
    access.sseHub.broadcastToast("Preview annotations inserted into the composer.", "success", 2200);
    response.json({ ok: true });
  });
}
