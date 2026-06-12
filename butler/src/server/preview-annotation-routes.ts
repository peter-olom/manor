import crypto from "node:crypto";

import type express from "express";

import type { ImageReferenceStore } from "./image-store.js";
import { captureAnnotatedPreviewScreenshot, formatAnnotationBatchText } from "./preview-annotation-capture.js";
import type { OperatorPreviewAnnotationBatch, OperatorPreviewAnnotationViewport } from "./preview-annotation-types.js";
import type { RuntimeBrokerClient } from "./runtime-broker-client.js";
import type { ButlerSseHub } from "./server-runtime-helpers.js";
import type { ButlerStateStore } from "./state-store.js";

type AnnotationPrefillTarget = { kind: "butler" } | { kind: "thread"; threadId: string };

export type PreviewAnnotationRoutesAccess = {
  app: express.Express;
  imageStore: ImageReferenceStore;
  previewAnnotationSecret: string;
  runtimeBroker: RuntimeBrokerClient;
  runtimeBrokerToken: string | null;
  sseHub: ButlerSseHub;
  store: ButlerStateStore;
};

const MAX_PREVIEW_ANNOTATION_BATCHES = 40;

function clampUnit(value: unknown): number {
  const number = typeof value === "number" && Number.isFinite(value) ? value : 0;
  return Math.min(1, Math.max(0, number));
}

function clampPositiveInteger(value: unknown, max: number): number {
  const number = typeof value === "number" && Number.isFinite(value) ? Math.round(value) : 0;
  return Math.min(max, Math.max(0, number));
}

function normalizeAnnotationViewport(input: unknown): OperatorPreviewAnnotationViewport | null {
  if (!input || typeof input !== "object") {
    return null;
  }
  const record = input as Record<string, unknown>;
  const width = clampPositiveInteger(record.width, 4096);
  const height = clampPositiveInteger(record.height, 4096);
  if (width <= 0 || height <= 0) {
    return null;
  }
  return {
    width,
    height,
    scrollX: clampPositiveInteger(record.scrollX, 1_000_000),
    scrollY: clampPositiveInteger(record.scrollY, 1_000_000),
    documentWidth: Math.max(width, clampPositiveInteger(record.documentWidth, 1_000_000)),
    documentHeight: Math.max(height, clampPositiveInteger(record.documentHeight, 1_000_000))
  };
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
      note: typeof entry.note === "string" ? entry.note.slice(0, 1000) : "",
      viewport: normalizeAnnotationViewport(entry.viewport)
    }))
    .filter((entry) => entry.width > 0 && entry.height > 0)
    .slice(0, 100);

  if (!leaseId || normalizedAnnotations.length === 0) {
    return null;
  }

  const page = record.page && typeof record.page === "object" ? record.page as Record<string, unknown> : {};
  return {
    id: typeof record.id === "string" && record.id.trim() ? record.id.trim().slice(0, 120) : crypto.randomUUID(),
    at: Date.now(),
    intent: record.intent === "insert" ? "insert" : "batch",
    ready: normalizedAnnotations.every((entry) => entry.note.trim().length > 0) && record.ready !== false,
    leaseId,
    targetId: typeof record.targetId === "string" && record.targetId.trim() ? record.targetId.trim().slice(0, 160) : "butler",
    page: {
      title: typeof page.title === "string" ? page.title.slice(0, 200) : "",
      url: typeof page.url === "string" ? page.url.slice(0, 2000) : ""
    },
    annotations: normalizedAnnotations
  };
}

function normalizePreviewAnnotationBatchClear(input: unknown): { leaseId: string; batchId: string; pageUrl: string } | null {
  if (!input || typeof input !== "object") {
    return null;
  }
  const record = input as Record<string, unknown>;
  if (!Array.isArray(record.annotations) || record.annotations.length !== 0) {
    return null;
  }
  const leaseId = typeof record.leaseId === "string" ? record.leaseId.trim() : "";
  const batchId = typeof record.id === "string" ? record.id.trim().slice(0, 120) : "";
  const page = record.page && typeof record.page === "object" ? record.page as Record<string, unknown> : {};
  const pageUrl = typeof page.url === "string" ? page.url.slice(0, 2000) : "";
  if (!leaseId || (!batchId && !pageUrl)) {
    return null;
  }
  return { leaseId, batchId, pageUrl };
}

export function normalizeInternalAnnotationPrefillTarget(input: unknown): AnnotationPrefillTarget | null {
  if (!input || typeof input !== "object") {
    return null;
  }
  const record = input as Record<string, unknown>;
  const kind = typeof record.kind === "string" ? record.kind.trim() : "";
  if (kind === "butler") {
    return { kind: "butler" };
  }
  if (kind === "thread") {
    const threadId = typeof record.threadId === "string" ? record.threadId.trim() : "";
    return threadId ? { kind: "thread", threadId } : null;
  }

  const id = typeof record.id === "string" ? record.id.trim() : "";
  if (id === "butler") {
    return { kind: "butler" };
  }
  if (id.startsWith("thread:")) {
    const threadId = id.slice("thread:".length).trim();
    return threadId ? { kind: "thread", threadId } : null;
  }
  return null;
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
    const existingIndex = current.findIndex((entry) =>
      entry.id === batch.id || (Boolean(batch.page.url) && entry.page.url === batch.page.url)
    );
    if (existingIndex >= 0) {
      current[existingIndex] = batch;
    } else {
      current.push(batch);
    }
    if (current.length > MAX_PREVIEW_ANNOTATION_BATCHES) {
      current.splice(0, current.length - MAX_PREVIEW_ANNOTATION_BATCHES);
    }
    previewAnnotationBatches.set(batch.leaseId, current);
    access.store.notePreviewLeaseActivity(batch.leaseId, batch.at);
  }

  function listPreviewAnnotationBatches(): OperatorPreviewAnnotationBatch[] {
    return [...previewAnnotationBatches.values()].flat().sort((left, right) => right.at - left.at);
  }

  function findPreviewAnnotationBatch(batchId: string): OperatorPreviewAnnotationBatch | null {
    for (const batches of previewAnnotationBatches.values()) {
      const batch = batches.find((entry) => entry.id === batchId);
      if (batch) {
        return batch;
      }
    }
    return null;
  }

  function removePreviewAnnotationBatch(batchId: string): boolean {
    let removed = false;
    for (const [leaseId, batches] of previewAnnotationBatches.entries()) {
      const next = batches.filter((entry) => entry.id !== batchId);
      if (next.length !== batches.length) {
        removed = true;
      }
      if (next.length === 0) {
        previewAnnotationBatches.delete(leaseId);
      } else {
        previewAnnotationBatches.set(leaseId, next);
      }
    }
    return removed;
  }

  function removePreviewAnnotationBatchByIdentity(leaseId: string, batchId: string, pageUrl: string): boolean {
    const batches = previewAnnotationBatches.get(leaseId);
    if (!batches) {
      return false;
    }
    const next = batches.filter((entry) => {
      if (batchId && entry.id === batchId) {
        return false;
      }
      if (pageUrl && entry.page.url === pageUrl) {
        return false;
      }
      return true;
    });
    if (next.length === batches.length) {
      return false;
    }
    if (next.length === 0) {
      previewAnnotationBatches.delete(leaseId);
    } else {
      previewAnnotationBatches.set(leaseId, next);
    }
    return true;
  }

  function targetIdForPrefill(target: AnnotationPrefillTarget): string {
    return target.kind === "thread" ? `thread:${target.threadId}` : "butler";
  }

  function validateAnnotationPrefillTarget(target: AnnotationPrefillTarget | null): target is AnnotationPrefillTarget {
    return Boolean(target && (target.kind === "butler" || access.store.getThread(target.threadId)));
  }

  async function insertPreviewAnnotationBatch(batch: OperatorPreviewAnnotationBatch, target: AnnotationPrefillTarget) {
    if (!batch.ready) {
      throw new Error("Preview annotation is not ready.");
    }
    const insertBatch = { ...batch, intent: "insert" as const, targetId: targetIdForPrefill(target) };
    const attachment = await captureAnnotatedPreviewScreenshot({
      batch: insertBatch,
      runtimeBroker: access.runtimeBroker,
      imageStore: access.imageStore
    });
    access.sseHub.broadcastComposerPrefill({
      id: crypto.randomUUID(),
      target,
      text: formatAnnotationBatchText(insertBatch),
      attachment
    });
    access.sseHub.broadcastToast("Preview annotations inserted into the composer.", "success", 2200);
    removePreviewAnnotationBatch(batch.id);
    return { batch: insertBatch, attachment };
  }

  access.app.post("/api/preview-annotations/batches", async (request, response) => {
    const clearRequest = normalizePreviewAnnotationBatchClear(request.body);
    if (clearRequest) {
      const lease = access.store.getPreviewLease(clearRequest.leaseId);
      if (!lease || lease.status === "stopped" || lease.status === "stopping") {
        response.status(404).json({ error: "Preview lease not found" });
        return;
      }
      if (!hasPreviewAnnotationAccess(request, clearRequest.leaseId)) {
        response.status(403).json({ error: "Forbidden" });
        return;
      }
      const removed = removePreviewAnnotationBatchByIdentity(clearRequest.leaseId, clearRequest.batchId, clearRequest.pageUrl);
      access.store.notePreviewLeaseActivity(clearRequest.leaseId, Date.now());
      response.json({ ok: true, removed, batch: null });
      return;
    }

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
    if (batch.intent === "insert" && !batch.ready) {
      response.status(400).json({ error: "Add comments to every mark before inserting preview annotations." });
      return;
    }

    recordPreviewAnnotationBatch(batch);
    if (batch.intent === "insert" && target) {
      try {
        await insertPreviewAnnotationBatch(batch, target);
      } catch (error) {
        response.status(500).json({
          error: `Annotated screenshot capture failed: ${error instanceof Error ? error.message : String(error)}`
        });
        return;
      }
    }

    response.json({ ok: true, batch });
  });

  access.app.get("/api/preview-annotations/operator/batches", (_request, response) => {
    response.json({ batches: listPreviewAnnotationBatches() });
  });

  access.app.post("/api/preview-annotations/operator/batches/:batchId/insert", async (request, response) => {
    const batchId = typeof request.params.batchId === "string" ? request.params.batchId.trim() : "";
    const batch = batchId ? findPreviewAnnotationBatch(batchId) : null;
    if (!batch) {
      response.status(404).json({ error: "Preview annotation not found" });
      return;
    }
    const lease = access.store.getPreviewLease(batch.leaseId);
    if (!lease || lease.status === "stopped" || lease.status === "stopping") {
      response.status(404).json({ error: "Preview lease not found" });
      return;
    }
    const target = normalizeInternalAnnotationPrefillTarget(request.body?.target);
    if (!validateAnnotationPrefillTarget(target)) {
      response.status(400).json({ error: "Annotation target is unavailable" });
      return;
    }
    if (!batch.ready) {
      response.status(400).json({ error: "Add comments to every mark before inserting preview annotations." });
      return;
    }

    try {
      const result = await insertPreviewAnnotationBatch(batch, target);
      response.json({ ok: true, ...result });
    } catch (error) {
      response.status(500).json({
        error: `Annotated screenshot capture failed: ${error instanceof Error ? error.message : String(error)}`
      });
    }
  });

  access.app.delete("/api/preview-annotations/operator/batches/:batchId", (request, response) => {
    const batchId = typeof request.params.batchId === "string" ? request.params.batchId.trim() : "";
    if (!batchId || !removePreviewAnnotationBatch(batchId)) {
      response.status(404).json({ error: "Preview annotation not found" });
      return;
    }
    response.json({ ok: true });
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
