import { promises as fs } from "node:fs";

import type { ImageReferenceStore, ImageReferenceView } from "./image-store.js";
import type { OperatorPreviewAnnotation, OperatorPreviewAnnotationBatch, OperatorPreviewAnnotationViewport } from "./preview-annotation-types.js";
import type { RuntimeBrokerClient } from "./runtime-broker-client.js";
import type { PreviewVerificationArtifactView } from "./types.js";

const DEFAULT_VIEWPORT: OperatorPreviewAnnotationViewport = {
  width: 1920,
  height: 1080,
  scrollX: 0,
  scrollY: 0,
  documentWidth: 1920,
  documentHeight: 1080
};

function clampPositiveInteger(value: number, fallback: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, Math.round(value)));
}

function viewportForAnnotation(annotation: OperatorPreviewAnnotation): OperatorPreviewAnnotationViewport {
  const viewport = annotation.viewport ?? DEFAULT_VIEWPORT;
  return {
    width: clampPositiveInteger(viewport.width, DEFAULT_VIEWPORT.width, 320, 4096),
    height: clampPositiveInteger(viewport.height, DEFAULT_VIEWPORT.height, 240, 4096),
    scrollX: clampPositiveInteger(viewport.scrollX, 0, 0, 1_000_000),
    scrollY: clampPositiveInteger(viewport.scrollY, 0, 0, 1_000_000),
    documentWidth: clampPositiveInteger(viewport.documentWidth, viewport.width || DEFAULT_VIEWPORT.width, 320, 1_000_000),
    documentHeight: clampPositiveInteger(viewport.documentHeight, viewport.height || DEFAULT_VIEWPORT.height, 240, 1_000_000)
  };
}

function primaryViewport(batch: OperatorPreviewAnnotationBatch): OperatorPreviewAnnotationViewport {
  return viewportForAnnotation(batch.annotations[0] ?? {
    id: "annotation-1",
    number: 1,
    x: 0,
    y: 0,
    width: 1,
    height: 1,
    color: "#ff6b2c",
    note: "",
    viewport: DEFAULT_VIEWPORT
  });
}

function safeFileBase(value: string): string {
  const trimmed = value.trim().replace(/\s+/g, "-").replace(/[^a-z0-9._-]+/gi, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
  return trimmed.slice(0, 80) || "preview";
}

export function buildAnnotatedPreviewFileName(batch: OperatorPreviewAnnotationBatch): string {
  return `${safeFileBase(batch.page.title || "preview")}-annotated-preview.png`;
}

export function formatAnnotationBatchText(batch: OperatorPreviewAnnotationBatch): string {
  const pageLine = batch.page.url ? `Page: ${batch.page.title || "Untitled"} (${batch.page.url})` : `Page: ${batch.page.title || "Untitled"}`;
  return [
    "Please follow up on the numbered tags in the attached annotated preview screenshot.",
    pageLine,
    "",
    ...batch.annotations.map((annotation) => `${annotation.number}. ${annotation.note || "Review this marked region."}`)
  ].join("\n");
}

function buildOverlayScript(batch: OperatorPreviewAnnotationBatch): string {
  const viewport = primaryViewport(batch);
  const payload = {
    viewport,
    annotations: batch.annotations.map((annotation) => {
      const markViewport = viewportForAnnotation(annotation);
      return {
        number: annotation.number,
        x: annotation.x,
        y: annotation.y,
        width: annotation.width,
        height: annotation.height,
        color: annotation.color || "#ff6b2c",
        viewport: markViewport
      };
    })
  };

  return `
const payload = ${JSON.stringify(payload)};
await page.setViewportSize({ width: payload.viewport.width, height: payload.viewport.height });
await page.evaluate((payload) => {
  const namespace = "http://www.w3.org/2000/svg";
  const previous = document.getElementById("manor-preview-annotation-capture-overlay");
  previous?.remove();

  window.scrollTo(payload.viewport.scrollX, payload.viewport.scrollY);
  const documentElement = document.documentElement;
  const body = document.body;
  const pageWidth = Math.max(
    payload.viewport.documentWidth,
    documentElement.scrollWidth || 0,
    body?.scrollWidth || 0,
    payload.viewport.width
  );
  const pageHeight = Math.max(
    payload.viewport.documentHeight,
    documentElement.scrollHeight || 0,
    body?.scrollHeight || 0,
    payload.viewport.height
  );

  const overlay = document.createElement("div");
  overlay.id = "manor-preview-annotation-capture-overlay";
  Object.assign(overlay.style, {
    position: "absolute",
    left: "0",
    top: "0",
    width: pageWidth + "px",
    height: pageHeight + "px",
    pointerEvents: "none",
    zIndex: "2147483646"
  });

  const svg = document.createElementNS(namespace, "svg");
  svg.setAttribute("width", String(pageWidth));
  svg.setAttribute("height", String(pageHeight));
  svg.setAttribute("viewBox", "0 0 " + pageWidth + " " + pageHeight);
  svg.style.position = "absolute";
  svg.style.left = "0";
  svg.style.top = "0";
  svg.style.overflow = "visible";

  for (const annotation of payload.annotations) {
    const viewport = annotation.viewport || payload.viewport;
    const x = viewport.scrollX + annotation.x * viewport.width;
    const y = viewport.scrollY + annotation.y * viewport.height;
    const width = Math.max(1, annotation.width * viewport.width);
    const height = Math.max(1, annotation.height * viewport.height);
    const color = typeof annotation.color === "string" && annotation.color ? annotation.color : "#ff6b2c";
    const lineWidth = Math.max(3, Math.round(Math.min(width, height) * 0.025));
    const badgeRadius = Math.max(14, Math.min(22, Math.round(Math.min(width, height) * 0.12)));
    const badgeX = x + badgeRadius + lineWidth;
    const badgeY = y + badgeRadius + lineWidth;

    const group = document.createElementNS(namespace, "g");
    const rect = document.createElementNS(namespace, "rect");
    rect.setAttribute("x", String(x));
    rect.setAttribute("y", String(y));
    rect.setAttribute("width", String(width));
    rect.setAttribute("height", String(height));
    rect.setAttribute("fill", color + "22");
    rect.setAttribute("stroke", color);
    rect.setAttribute("stroke-width", String(lineWidth));

    const circle = document.createElementNS(namespace, "circle");
    circle.setAttribute("cx", String(badgeX));
    circle.setAttribute("cy", String(badgeY));
    circle.setAttribute("r", String(badgeRadius));
    circle.setAttribute("fill", color);

    const text = document.createElementNS(namespace, "text");
    text.setAttribute("x", String(badgeX));
    text.setAttribute("y", String(badgeY + 1));
    text.setAttribute("fill", "#fff");
    text.setAttribute("font-family", "system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif");
    text.setAttribute("font-size", String(Math.max(14, Math.round(badgeRadius * 0.95))));
    text.setAttribute("font-weight", "700");
    text.setAttribute("text-anchor", "middle");
    text.setAttribute("dominant-baseline", "central");
    text.textContent = String(annotation.number);

    group.append(rect, circle, text);
    svg.append(group);
  }

  overlay.append(svg);
  document.documentElement.append(overlay);
}, payload);
await page.waitForTimeout(250);
`;
}

function findScreenshotArtifact(artifacts: PreviewVerificationArtifactView[], fileName: string): PreviewVerificationArtifactView | null {
  return artifacts.find((artifact) => artifact.kind === "screenshot" && artifact.fileName === fileName && artifact.filePath) ??
    artifacts.find((artifact) => artifact.kind === "screenshot" && artifact.label === "Annotated preview screenshot" && artifact.filePath) ??
    null;
}

export async function captureAnnotatedPreviewScreenshot(input: {
  batch: OperatorPreviewAnnotationBatch;
  runtimeBroker: RuntimeBrokerClient;
  imageStore: ImageReferenceStore;
}): Promise<ImageReferenceView> {
  const viewport = primaryViewport(input.batch);
  const fileName = buildAnnotatedPreviewFileName(input.batch);
  let sessionId: string | null = null;

  try {
    const session = await input.runtimeBroker.startPreviewBrowserSession({
      leaseId: input.batch.leaseId,
      targetUrl: input.batch.page.url || undefined,
      mode: "headless",
      resolution: viewport.width > 1920 || viewport.height > 1080 ? "2k" : "1080p",
      postLoadWaitMs: 500
    });
    sessionId = session.sessionId;

    await input.runtimeBroker.runBrowserSessionAction(sessionId, {
      type: "evaluate",
      script: buildOverlayScript(input.batch),
      autoCapture: false
    });
    await input.runtimeBroker.runBrowserSessionAction(sessionId, {
      type: "screenshot",
      label: "Annotated preview screenshot",
      fileName,
      autoCapture: false
    });

    const stopped = await input.runtimeBroker.stopBrowserSession(sessionId, "preview annotation screenshot capture");
    sessionId = null;
    const artifact = findScreenshotArtifact(stopped.verification.artifacts, fileName);
    if (!artifact?.filePath) {
      throw new Error("Annotated screenshot artifact was not produced.");
    }
    const buffer = await fs.readFile(artifact.filePath);
    return await input.imageStore.createFromBuffer({
      name: fileName,
      mimeType: "image/png",
      buffer,
      sizeBytes: artifact.sizeBytes ?? undefined
    });
  } finally {
    if (sessionId) {
      await input.runtimeBroker.stopBrowserSession(sessionId, "preview annotation screenshot capture cleanup").catch(() => undefined);
    }
  }
}
