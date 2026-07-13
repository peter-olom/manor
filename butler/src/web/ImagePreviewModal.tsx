import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";

import { uploadAttachment, type FileReference, type ReferenceUploadContext } from "./api";
import { CloseIcon, DownloadIcon, ImageIcon, PencilIcon, TrashIcon, ZoomInIcon, ZoomOutIcon } from "./icons";

export type PreviewMedia = {
  name: string;
  url: string;
  kind: "image";
  downloadUrl?: string | null;
};

type AnnotationRect = {
  x: number;
  y: number;
  width: number;
  height: number;
};

type ProofAnnotation = AnnotationRect & {
  id: string;
  text: string;
};

type DraftAnnotation = {
  startX: number;
  startY: number;
  currentX: number;
  currentY: number;
  pointerId: number;
};

const TAG_COLOR = "#ff6b2c";
const TAG_FILL = "rgba(255, 107, 44, 0.14)";
const TAG_ACTIVE_FILL = "rgba(255, 107, 44, 0.22)";
const IMAGE_ZOOM_LEVELS = [1, 1.5, 2, 3, 4] as const;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function normalizePointer(event: ReactPointerEvent<SVGSVGElement>, bounds: DOMRect): { x: number; y: number } {
  return {
    x: clamp((event.clientX - bounds.left) / bounds.width, 0, 1),
    y: clamp((event.clientY - bounds.top) / bounds.height, 0, 1)
  };
}

function rectFromPoints(startX: number, startY: number, currentX: number, currentY: number): AnnotationRect {
  const left = Math.min(startX, currentX);
  const top = Math.min(startY, currentY);
  const right = Math.max(startX, currentX);
  const bottom = Math.max(startY, currentY);
  return {
    x: left,
    y: top,
    width: right - left,
    height: bottom - top
  };
}

function buildAnnotationPrompt(annotations: ProofAnnotation[]): string {
  return [
    "Please follow up on the numbered tags in the attached annotated proof image.",
    "",
    ...annotations.map((annotation, index) => `${index + 1}. ${annotation.text.trim()}`)
  ].join("\n");
}

function buildAnnotatedFileName(name: string): string {
  const withoutExtension = name.trim().replace(/\.[^.]+$/, "") || "proof";
  const safeBase = withoutExtension.replace(/[\\/:*?"<>|]+/g, "-").trim() || "proof";
  return `${safeBase}-annotated.png`;
}

function createAnnotationId(): string {
  return typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `annotation-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function toBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) {
        resolve(blob);
        return;
      }
      reject(new Error("The annotated image could not be created."));
    }, "image/png");
  });
}

function drawTagBadge(context: CanvasRenderingContext2D, label: string, x: number, y: number, boxWidth: number, boxHeight: number): void {
  const radius = Math.max(16, Math.min(24, Math.round(Math.min(boxWidth, boxHeight) * 0.16)));
  const centerX = x + radius;
  const centerY = y + radius;
  context.fillStyle = TAG_COLOR;
  context.beginPath();
  context.arc(centerX, centerY, radius, 0, Math.PI * 2);
  context.fill();
  context.fillStyle = "#ffffff";
  context.font = `600 ${Math.max(14, radius)}px system-ui, sans-serif`;
  context.textAlign = "center";
  context.textBaseline = "middle";
  context.fillText(label, centerX, centerY + 1);
}

async function renderAnnotatedImage(image: HTMLImageElement, annotations: ProofAnnotation[]): Promise<Blob> {
  const naturalWidth = image.naturalWidth;
  const naturalHeight = image.naturalHeight;
  if (!naturalWidth || !naturalHeight) {
    throw new Error("The proof image is not ready yet.");
  }

  const canvas = document.createElement("canvas");
  canvas.width = naturalWidth;
  canvas.height = naturalHeight;
  const context = canvas.getContext("2d");
  if (!context) {
    throw new Error("Canvas export is not available.");
  }

  context.drawImage(image, 0, 0, naturalWidth, naturalHeight);
  for (const [index, annotation] of annotations.entries()) {
    const x = annotation.x * naturalWidth;
    const y = annotation.y * naturalHeight;
    const width = annotation.width * naturalWidth;
    const height = annotation.height * naturalHeight;
    const lineWidth = Math.max(3, Math.round(Math.min(naturalWidth, naturalHeight) * 0.004));
    context.fillStyle = TAG_FILL;
    context.fillRect(x, y, width, height);
    context.lineWidth = lineWidth;
    context.strokeStyle = TAG_COLOR;
    context.strokeRect(x, y, width, height);
    drawTagBadge(context, String(index + 1), x, y, width, height);
  }

  return toBlob(canvas);
}

export function ImagePreviewModal({
  media,
  attachTargetLabel,
  uploadContext,
  onAttached,
  onClose,
  showErrorToast
}: {
  media: PreviewMedia;
  attachTargetLabel: string | null;
  uploadContext?: ReferenceUploadContext;
  onAttached: (payload: { attachment: FileReference; text: string }) => Promise<void> | void;
  onClose: () => void;
  showErrorToast: (error: unknown) => void;
}) {
  const imageRef = useRef<HTMLImageElement | null>(null);
  const overlayRef = useRef<SVGSVGElement | null>(null);
  const annotationListRef = useRef<HTMLDivElement | null>(null);
  const annotationItemRefs = useRef(new Map<string, HTMLDivElement>());
  const previousAnnotationCountRef = useRef(0);
  const pendingNewAnnotationIdRef = useRef<string | null>(null);
  const [annotationMode, setAnnotationMode] = useState(false);
  const [imageReady, setImageReady] = useState(false);
  const [annotations, setAnnotations] = useState<ProofAnnotation[]>([]);
  const [activeAnnotationId, setActiveAnnotationId] = useState<string | null>(null);
  const [draftAnnotation, setDraftAnnotation] = useState<DraftAnnotation | null>(null);
  const [busy, setBusy] = useState(false);
  const [imageZoomIndex, setImageZoomIndex] = useState(0);

  useEffect(() => {
    setAnnotationMode(false);
    setImageReady(false);
    setAnnotations([]);
    setActiveAnnotationId(null);
    setDraftAnnotation(null);
    setBusy(false);
    setImageZoomIndex(0);
    previousAnnotationCountRef.current = 0;
    pendingNewAnnotationIdRef.current = null;
    annotationItemRefs.current.clear();
  }, [media.name, media.url]);

  useEffect(() => {
    const previousCount = previousAnnotationCountRef.current;
    previousAnnotationCountRef.current = annotations.length;
    if (annotations.length <= previousCount) return;
    requestAnimationFrame(() => {
      const list = annotationListRef.current;
      if (list) list.scrollTop = list.scrollHeight;
    });
  }, [annotations.length]);

  useEffect(() => {
    if (!activeAnnotationId) return;
    if (pendingNewAnnotationIdRef.current === activeAnnotationId) {
      pendingNewAnnotationIdRef.current = null;
      return;
    }
    requestAnimationFrame(() => {
      annotationItemRefs.current.get(activeAnnotationId)?.scrollIntoView({ behavior: "smooth", block: "center" });
    });
  }, [activeAnnotationId]);

  const missingNoteCount = useMemo(() => annotations.filter((annotation) => annotation.text.trim().length === 0).length, [annotations]);
  const canAttach = Boolean(attachTargetLabel) && imageReady && annotations.length > 0 && missingNoteCount === 0 && !busy;
  const imageZoom = IMAGE_ZOOM_LEVELS[imageZoomIndex] ?? 1;
  const imageZoomLabel = `${Math.round(imageZoom * 100)}%`;
  const draftRect = draftAnnotation ? rectFromPoints(draftAnnotation.startX, draftAnnotation.startY, draftAnnotation.currentX, draftAnnotation.currentY) : null;

  function updateAnnotationText(annotationId: string, text: string): void {
    setAnnotations((current) => current.map((annotation) => (annotation.id === annotationId ? { ...annotation, text } : annotation)));
  }

  function removeAnnotation(annotationId: string): void {
    const nextAnnotations = annotations.filter((annotation) => annotation.id !== annotationId);
    setAnnotations(nextAnnotations);
    setActiveAnnotationId((selected) => (selected === annotationId ? nextAnnotations[0]?.id ?? null : selected));
  }

  function beginDraft(event: ReactPointerEvent<SVGSVGElement>): void {
    if (busy || !annotationMode || !imageReady) return;
    const overlay = overlayRef.current;
    if (!overlay) return;
    event.preventDefault();
    const bounds = overlay.getBoundingClientRect();
    if (!bounds.width || !bounds.height) return;
    const point = normalizePointer(event, bounds);
    overlay.setPointerCapture(event.pointerId);
    setDraftAnnotation({
      startX: point.x,
      startY: point.y,
      currentX: point.x,
      currentY: point.y,
      pointerId: event.pointerId
    });
  }

  function updateDraft(event: ReactPointerEvent<SVGSVGElement>): void {
    if (!draftAnnotation || draftAnnotation.pointerId !== event.pointerId) return;
    const overlay = overlayRef.current;
    if (!overlay) return;
    const point = normalizePointer(event, overlay.getBoundingClientRect());
    setDraftAnnotation((current) => (current && current.pointerId === event.pointerId ? { ...current, currentX: point.x, currentY: point.y } : current));
  }

  function finishDraft(event: ReactPointerEvent<SVGSVGElement>): void {
    if (!draftAnnotation || draftAnnotation.pointerId !== event.pointerId) return;
    const overlay = overlayRef.current;
    if (!overlay) {
      setDraftAnnotation(null);
      return;
    }
    if (overlay.hasPointerCapture(event.pointerId)) overlay.releasePointerCapture(event.pointerId);
    const bounds = overlay.getBoundingClientRect();
    const point = normalizePointer(event, bounds);
    const nextRect = rectFromPoints(draftAnnotation.startX, draftAnnotation.startY, point.x, point.y);
    setDraftAnnotation(null);
    if (nextRect.width * bounds.width < 18 || nextRect.height * bounds.height < 18) return;
    const nextAnnotation: ProofAnnotation = { id: createAnnotationId(), text: "", ...nextRect };
    pendingNewAnnotationIdRef.current = nextAnnotation.id;
    setAnnotations((current) => [...current, nextAnnotation]);
    setActiveAnnotationId(nextAnnotation.id);
  }

  async function handleAttach(): Promise<void> {
    if (!canAttach || !imageRef.current) return;
    setBusy(true);
    try {
      const blob = await renderAnnotatedImage(imageRef.current, annotations);
      const file = new File([blob], buildAnnotatedFileName(media.name), { type: "image/png" });
      const attachment = await uploadAttachment(file, uploadContext);
      await onAttached({ attachment, text: buildAnnotationPrompt(annotations) });
      onClose();
    } catch (error) {
      showErrorToast(error);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="modal-backdrop image-preview-backdrop" onClick={() => (!busy ? onClose() : undefined)}>
      <div
        className={`modal-card-image${annotationMode ? " modal-card-annotation" : ""}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby="image-preview-title"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="modal-head image-preview-head">
          <h2 id="image-preview-title">{media.name}</h2>
          <div className="modal-head-actions">
            {!annotationMode && media.downloadUrl ? (
              <a className="modal-icon-action" href={media.downloadUrl} download aria-label="Download proof" title="Download proof">
                <DownloadIcon />
              </a>
            ) : null}
            {annotationMode ? (
              <button className="modal-icon-action" type="button" onClick={() => setAnnotationMode(false)} disabled={busy} aria-label="Preview image" title="Preview image">
                <ImageIcon />
              </button>
            ) : attachTargetLabel ? (
              <button className="modal-icon-action" type="button" onClick={() => setAnnotationMode(true)} disabled={busy} aria-label="Annotate image" title="Annotate image">
                <PencilIcon />
              </button>
            ) : null}
            {!annotationMode ? (
              <div className="modal-zoom-controls" aria-label="Image zoom">
                <button className="modal-icon-action" type="button" onClick={() => setImageZoomIndex((current) => Math.max(0, current - 1))} disabled={busy || imageZoomIndex === 0} aria-label="Zoom out" title="Zoom out">
                  <ZoomOutIcon />
                </button>
                <span className="modal-zoom-value">{imageZoomLabel}</span>
                <button className="modal-icon-action" type="button" onClick={() => setImageZoomIndex((current) => Math.min(IMAGE_ZOOM_LEVELS.length - 1, current + 1))} disabled={busy || imageZoomIndex === IMAGE_ZOOM_LEVELS.length - 1} aria-label="Zoom in" title="Zoom in">
                  <ZoomInIcon />
                </button>
              </div>
            ) : null}
            <button className="modal-close modal-icon-action" onClick={onClose} aria-label="Close image preview" disabled={busy}>
              <CloseIcon />
            </button>
          </div>
        </div>

        {annotationMode ? (
          <div className="proof-annotation-layout">
            <div className="proof-annotation-stage-panel">
              <div className="proof-annotation-hint">
                <p>Drag on the image to create numbered tags. Each tag maps to the same number in the note list.</p>
              </div>
              <div className="proof-annotation-stage-shell">
                <div className="proof-annotation-stage">
                  <img ref={imageRef} src={media.url} alt={media.name} className="modal-image proof-annotation-image" crossOrigin="anonymous" onLoad={() => setImageReady(true)} />
                  <svg
                    ref={overlayRef}
                    className="proof-annotation-overlay"
                    viewBox="0 0 100 100"
                    preserveAspectRatio="none"
                    onPointerDown={beginDraft}
                    onPointerMove={updateDraft}
                    onPointerUp={finishDraft}
                    onPointerCancel={() => setDraftAnnotation(null)}
                  >
                    {annotations.map((annotation, index) => {
                      const isActive = annotation.id === activeAnnotationId;
                      const badgeRadius = Math.min(5.2, Math.max(3, Math.min(annotation.width, annotation.height) * 18));
                      return (
                        <g
                          key={annotation.id}
                          className={`proof-annotation-mark${isActive ? " is-active" : ""}`}
                          onPointerDown={(event) => {
                            event.stopPropagation();
                            setActiveAnnotationId(annotation.id);
                          }}
                          onClick={(event) => {
                            event.stopPropagation();
                            setActiveAnnotationId(annotation.id);
                          }}
                        >
                          <rect x={annotation.x * 100} y={annotation.y * 100} width={annotation.width * 100} height={annotation.height * 100} fill={isActive ? TAG_ACTIVE_FILL : TAG_FILL} stroke={TAG_COLOR} strokeWidth={isActive ? 0.7 : 0.55} />
                          <circle cx={annotation.x * 100 + badgeRadius} cy={annotation.y * 100 + badgeRadius} r={badgeRadius} fill={TAG_COLOR} />
                          <text x={annotation.x * 100 + badgeRadius} y={annotation.y * 100 + badgeRadius} className="proof-annotation-badge-text">
                            {index + 1}
                          </text>
                        </g>
                      );
                    })}
                    {draftRect ? <rect x={draftRect.x * 100} y={draftRect.y * 100} width={draftRect.width * 100} height={draftRect.height * 100} className="proof-annotation-draft" /> : null}
                  </svg>
                </div>
              </div>
            </div>

            <aside className="proof-annotation-sidebar">
              <div className="proof-annotation-sidebar-head">
                <div>
                  <strong>Annotations</strong>
                  <p>{annotations.length === 0 ? "Create a tag on the image to start." : "Write one note for each numbered tag."}</p>
                </div>
                <span className="proof-annotation-count">{annotations.length}</span>
              </div>
              {annotations.length === 0 ? (
                <div className="proof-annotation-empty">No tags yet.</div>
              ) : (
                <div className="proof-annotation-list" ref={annotationListRef}>
                  {annotations.map((annotation, index) => (
                    <div
                      key={annotation.id}
                      ref={(element) => {
                        if (element) annotationItemRefs.current.set(annotation.id, element);
                        else annotationItemRefs.current.delete(annotation.id);
                      }}
                      className={`proof-annotation-item${annotation.id === activeAnnotationId ? " is-active" : ""}`}
                    >
                      <button className="proof-annotation-item-head" type="button" onClick={() => setActiveAnnotationId(annotation.id)}>
                        <span className="proof-annotation-item-tag">{index + 1}</span>
                        <span className="proof-annotation-item-label">Tag {index + 1}</span>
                      </button>
                      <textarea value={annotation.text} onChange={(event) => updateAnnotationText(annotation.id, event.target.value)} placeholder={`What should tag ${index + 1} call out?`} rows={3} />
                      <button className="proof-annotation-remove" type="button" onClick={() => removeAnnotation(annotation.id)} aria-label={`Remove tag ${index + 1}`}>
                        <TrashIcon />
                        <span>Remove</span>
                      </button>
                    </div>
                  ))}
                </div>
              )}
              <div className="proof-annotation-sidebar-footer">
                <p className="proof-annotation-target">
                  {attachTargetLabel ? `Done will send the annotated image and note list to ${attachTargetLabel}.` : "Open Butler or a thread to attach the finished annotated image."}
                </p>
                {missingNoteCount > 0 ? (
                  <p className="proof-annotation-warning">
                    Add text for {missingNoteCount === 1 ? "the remaining tag" : `all ${missingNoteCount} remaining tags`} before attaching.
                  </p>
                ) : null}
                <button className="button is-primary proof-annotation-attach" type="button" onClick={() => void handleAttach()} disabled={!canAttach}>
                  {busy ? "Attaching..." : attachTargetLabel ? `Done and send to ${attachTargetLabel}` : "Done and send"}
                </button>
              </div>
            </aside>
          </div>
        ) : (
          <div className={`modal-image-shell${imageZoom > 1 ? " is-zoomed" : ""}`}>
            <img ref={imageRef} src={media.url} alt={media.name} className="modal-image" crossOrigin="anonymous" style={imageZoom > 1 ? { width: `${imageZoom * 100}%` } : undefined} onLoad={() => setImageReady(true)} />
          </div>
        )}
      </div>
    </div>
  );
}
