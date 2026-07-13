import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { GlobalWorkerOptions, getDocument, type PDFDocumentProxy, type RenderTask } from "pdfjs-dist";
import pdfWorkerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";

import { uploadFileVersion, type FileReference } from "./api";
import { ChevronLeftIcon, ChevronRightIcon, TrashIcon, WarningIcon } from "./icons";
import { buildAnnotatedPdfName, buildPdfAnnotationPrompt, pdfLabelOrigin, pdfRectFromViewport, type AnnotationRect, type PdfAnnotation } from "./pdf-annotations";
import { calculatePdfCanvasLayout } from "./pdf-preview-layout";

GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

type DraftAnnotation = { startX: number; startY: number; currentX: number; currentY: number; pointerId: number };

const TAG_COLOR = "#ff6b2c";
const TAG_FILL = "rgba(255, 107, 44, 0.14)";
const TAG_ACTIVE_FILL = "rgba(255, 107, 44, 0.22)";

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function createAnnotationId(): string {
  return typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `annotation-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function rectFromPoints(startX: number, startY: number, currentX: number, currentY: number): AnnotationRect {
  const left = Math.min(startX, currentX);
  const top = Math.min(startY, currentY);
  return { x: left, y: top, width: Math.max(startX, currentX) - left, height: Math.max(startY, currentY) - top };
}

function normalizedPointer(event: ReactPointerEvent<SVGSVGElement>, bounds: DOMRect): { x: number; y: number } {
  return {
    x: clamp((event.clientX - bounds.left) / bounds.width, 0, 1),
    y: clamp((event.clientY - bounds.top) / bounds.height, 0, 1)
  };
}

async function createAnnotatedPdf(url: string, sourceDocument: PDFDocumentProxy, annotations: PdfAnnotation[]): Promise<Blob> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`The source PDF could not be read (${response.status})`);
  const { PDFDocument, StandardFonts, degrees, rgb } = await import("pdf-lib");
  const output = await PDFDocument.load(await response.arrayBuffer());
  const font = await output.embedFont(StandardFonts.HelveticaBold);
  for (const [index, annotation] of annotations.entries()) {
    const sourcePage = await sourceDocument.getPage(annotation.pageNumber);
    const viewport = sourcePage.getViewport({ scale: 1 });
    const page = output.getPage(annotation.pageNumber - 1);
    const rect = pdfRectFromViewport(viewport, annotation);
    const lineWidth = Math.max(1, Math.min(page.getWidth(), page.getHeight()) * 0.004);
    page.drawRectangle({
      ...rect,
      color: rgb(1, 107 / 255, 44 / 255),
      opacity: annotation.wholePage ? 0 : 0.14,
      borderColor: rgb(1, 107 / 255, 44 / 255),
      borderWidth: lineWidth,
      borderOpacity: 1
    });
    const radius = Math.max(8, Math.min(16, Math.min(rect.width, rect.height) * 0.16));
    const displayRadius = Math.max(8, Math.min(16, Math.min(annotation.width * viewport.width, annotation.height * viewport.height) * 0.16));
    const center = viewport.convertToPdfPoint(annotation.x * viewport.width + displayRadius, annotation.y * viewport.height + displayRadius);
    const centerX = center[0] ?? rect.x + radius;
    const centerY = center[1] ?? rect.y + rect.height - radius;
    page.drawCircle({ x: centerX, y: centerY, size: radius, color: rgb(1, 107 / 255, 44 / 255) });
    const label = String(index + 1);
    const fontSize = Math.max(8, radius);
    const textWidth = font.widthOfTextAtSize(label, fontSize);
    const rotation = ((page.getRotation().angle % 360) + 360) % 360;
    const textPosition = pdfLabelOrigin(centerX, centerY, textWidth, fontSize, rotation);
    page.drawText(label, { ...textPosition, size: fontSize, font, color: rgb(1, 1, 1), rotate: degrees(rotation) });
  }
  return new Blob([await output.save()], { type: "application/pdf" });
}

export function PdfPreview({
  name,
  url,
  sourceReferenceId,
  annotationMode,
  attachTargetLabel,
  onAttached,
  onBusyChange,
  onError
}: {
  name: string;
  url: string;
  sourceReferenceId: string;
  annotationMode: boolean;
  attachTargetLabel: string | null;
  onAttached: (payload: { attachment: FileReference; text: string }) => Promise<void> | void;
  onBusyChange: (busy: boolean) => void;
  onError: (error: unknown) => void;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const overlayRef = useRef<SVGSVGElement | null>(null);
  const [pdfDocument, setPdfDocument] = useState<PDFDocumentProxy | null>(null);
  const [pageNumber, setPageNumber] = useState(1);
  const [pageSize, setPageSize] = useState({ width: 0, height: 0 });
  const [availableWidth, setAvailableWidth] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [annotations, setAnnotations] = useState<PdfAnnotation[]>([]);
  const [activeAnnotationId, setActiveAnnotationId] = useState<string | null>(null);
  const [draftAnnotation, setDraftAnnotation] = useState<DraftAnnotation | null>(null);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const updateWidth = () => setAvailableWidth(container.clientWidth);
    updateWidth();
    const observer = new ResizeObserver(updateWidth);
    observer.observe(container);
    return () => observer.disconnect();
  }, [annotationMode]);

  useEffect(() => {
    let active = true;
    setPdfDocument(null);
    setPageNumber(1);
    setAnnotations([]);
    setActiveAnnotationId(null);
    setDraftAnnotation(null);
    setLoading(true);
    setError(null);
    const task = getDocument({ url });
    void task.promise
      .then((loadedDocument) => {
        if (active) setPdfDocument(loadedDocument);
        else void loadedDocument.destroy();
      })
      .catch((reason) => {
        if (active) setError(reason instanceof Error ? reason.message : "The PDF could not be opened");
      });
    return () => {
      active = false;
      void task.destroy();
    };
  }, [url]);

  useEffect(() => {
    if (!pdfDocument || !availableWidth || !canvasRef.current) return;
    let active = true;
    let renderTask: RenderTask | null = null;
    setLoading(true);
    setError(null);
    void pdfDocument.getPage(pageNumber)
      .then((page) => {
        if (!active || !canvasRef.current) return;
        const baseViewport = page.getViewport({ scale: 1 });
        const layout = calculatePdfCanvasLayout(baseViewport.width, baseViewport.height, availableWidth, window.devicePixelRatio);
        const viewport = page.getViewport({ scale: layout.cssScale });
        const canvas = canvasRef.current;
        const context = canvas.getContext("2d");
        if (!context) throw new Error("Canvas rendering is unavailable");
        canvas.width = layout.pixelWidth;
        canvas.height = layout.pixelHeight;
        canvas.style.width = `${Math.floor(viewport.width)}px`;
        canvas.style.height = `${Math.floor(viewport.height)}px`;
        setPageSize({ width: Math.floor(viewport.width), height: Math.floor(viewport.height) });
        renderTask = page.render({
          canvas,
          canvasContext: context,
          viewport,
          transform: layout.outputScale === 1 ? undefined : [layout.outputScale, 0, 0, layout.outputScale, 0, 0]
        });
        return renderTask.promise;
      })
      .then(() => {
        if (active) setLoading(false);
      })
      .catch((reason) => {
        if (active && reason?.name !== "RenderingCancelledException") {
          setLoading(false);
          setError(reason instanceof Error ? reason.message : "The PDF page could not be rendered");
        }
      });
    return () => {
      active = false;
      renderTask?.cancel();
    };
  }, [availableWidth, pdfDocument, pageNumber]);

  const pageAnnotations = useMemo(() => annotations.filter((annotation) => annotation.pageNumber === pageNumber), [annotations, pageNumber]);
  const missingNoteCount = useMemo(() => annotations.filter((annotation) => annotation.text.trim().length === 0).length, [annotations]);
  const draftRect = draftAnnotation ? rectFromPoints(draftAnnotation.startX, draftAnnotation.startY, draftAnnotation.currentX, draftAnnotation.currentY) : null;
  const canAttach = Boolean(attachTargetLabel && pdfDocument && annotations.length > 0 && missingNoteCount === 0 && !busy);

  function beginDraft(event: ReactPointerEvent<SVGSVGElement>): void {
    if (!annotationMode || busyRef.current || loading) return;
    const overlay = overlayRef.current;
    if (!overlay) return;
    event.preventDefault();
    const point = normalizedPointer(event, overlay.getBoundingClientRect());
    overlay.setPointerCapture(event.pointerId);
    setDraftAnnotation({ startX: point.x, startY: point.y, currentX: point.x, currentY: point.y, pointerId: event.pointerId });
  }

  function updateDraft(event: ReactPointerEvent<SVGSVGElement>): void {
    if (busyRef.current || !draftAnnotation || draftAnnotation.pointerId !== event.pointerId || !overlayRef.current) return;
    const point = normalizedPointer(event, overlayRef.current.getBoundingClientRect());
    setDraftAnnotation((current) => current?.pointerId === event.pointerId ? { ...current, currentX: point.x, currentY: point.y } : current);
  }

  function finishDraft(event: ReactPointerEvent<SVGSVGElement>): void {
    if (busyRef.current || !draftAnnotation || draftAnnotation.pointerId !== event.pointerId || !overlayRef.current) return;
    const overlay = overlayRef.current;
    if (overlay.hasPointerCapture(event.pointerId)) overlay.releasePointerCapture(event.pointerId);
    const bounds = overlay.getBoundingClientRect();
    const point = normalizedPointer(event, bounds);
    const rect = rectFromPoints(draftAnnotation.startX, draftAnnotation.startY, point.x, point.y);
    setDraftAnnotation(null);
    if (rect.width * bounds.width < 18 || rect.height * bounds.height < 18) return;
    const annotation: PdfAnnotation = { ...rect, id: createAnnotationId(), pageNumber, text: "" };
    setAnnotations((current) => [...current, annotation]);
    setActiveAnnotationId(annotation.id);
  }

  function removeAnnotation(annotationId: string): void {
    if (busyRef.current) return;
    setAnnotations((current) => current.filter((annotation) => annotation.id !== annotationId));
    setActiveAnnotationId((current) => current === annotationId ? null : current);
  }

  function addKeyboardAnnotation(): void {
    if (busyRef.current || loading) return;
    const annotation: PdfAnnotation = { id: createAnnotationId(), pageNumber, x: 0.02, y: 0.02, width: 0.96, height: 0.96, text: "", wholePage: true };
    setAnnotations((current) => [...current, annotation]);
    setActiveAnnotationId(annotation.id);
  }

  async function handleAttach(): Promise<void> {
    if (!canAttach || !pdfDocument) return;
    busyRef.current = true;
    setBusy(true);
    onBusyChange(true);
    const submittedAnnotations = annotations.map((annotation) => ({ ...annotation }));
    try {
      const blob = await createAnnotatedPdf(url, pdfDocument, submittedAnnotations);
      const file = new File([blob], buildAnnotatedPdfName(name), { type: "application/pdf" });
      const attachment = await uploadFileVersion(file, sourceReferenceId);
      await onAttached({ attachment, text: buildPdfAnnotationPrompt(submittedAnnotations) });
    } catch (reason) {
      onError(reason);
    } finally {
      busyRef.current = false;
      setBusy(false);
      onBusyChange(false);
    }
  }

  const preview = (
    <div ref={containerRef} className="pdf-preview" aria-label={`PDF preview of ${name}`}>
      {pdfDocument && pdfDocument.numPages > 1 ? (
        <div className="pdf-preview-toolbar" aria-label="PDF page controls">
          <button type="button" onClick={() => setPageNumber((page) => Math.max(1, page - 1))} disabled={busy || pageNumber === 1} aria-label="Previous page"><ChevronLeftIcon /></button>
          <span>Page {pageNumber} of {pdfDocument.numPages}</span>
          <button type="button" onClick={() => setPageNumber((page) => Math.min(pdfDocument.numPages, page + 1))} disabled={busy || pageNumber === pdfDocument.numPages} aria-label="Next page"><ChevronRightIcon /></button>
        </div>
      ) : null}
      <div className="pdf-preview-page">
        <div className="pdf-preview-canvas-wrap" style={pageSize.width ? { width: pageSize.width, height: pageSize.height } : undefined}>
          <canvas ref={canvasRef} role="img" aria-label={`Page ${pageNumber} of ${name}`} />
          {annotationMode && !loading ? (
            <svg ref={overlayRef} className="proof-annotation-overlay" viewBox="0 0 100 100" preserveAspectRatio="none" aria-label={`Annotation drawing surface for page ${pageNumber}`} onPointerDown={beginDraft} onPointerMove={updateDraft} onPointerUp={finishDraft} onPointerCancel={() => setDraftAnnotation(null)}>
              {pageAnnotations.map((annotation) => {
                const index = annotations.findIndex((entry) => entry.id === annotation.id);
                const active = annotation.id === activeAnnotationId;
                const badgeRadius = Math.min(5.2, Math.max(3, Math.min(annotation.width, annotation.height) * 18));
                return (
                  <g key={annotation.id} className={`proof-annotation-mark${active ? " is-active" : ""}`} onPointerDown={(event) => { event.stopPropagation(); setActiveAnnotationId(annotation.id); }}>
                    <rect x={annotation.x * 100} y={annotation.y * 100} width={annotation.width * 100} height={annotation.height * 100} fill={annotation.wholePage ? "transparent" : active ? TAG_ACTIVE_FILL : TAG_FILL} stroke={TAG_COLOR} strokeWidth={active ? 0.7 : 0.55} />
                    <circle cx={annotation.x * 100 + badgeRadius} cy={annotation.y * 100 + badgeRadius} r={badgeRadius} fill={TAG_COLOR} />
                    <text x={annotation.x * 100 + badgeRadius} y={annotation.y * 100 + badgeRadius} className="proof-annotation-badge-text">{index + 1}</text>
                  </g>
                );
              })}
              {draftRect ? <rect x={draftRect.x * 100} y={draftRect.y * 100} width={draftRect.width * 100} height={draftRect.height * 100} className="proof-annotation-draft" /> : null}
            </svg>
          ) : null}
        </div>
        <p className="sr-only">This page is rendered visually. Use the Download button above to open the complete PDF with your document reader.</p>
      </div>
      {loading && !error ? <div className="file-preview-state"><span className="spinner" /> Loading preview…</div> : null}
      {error ? <div className="file-preview-state is-error" role="alert"><WarningIcon /><strong>Preview unavailable</strong><span>{error}</span></div> : null}
    </div>
  );

  if (!annotationMode) return preview;
  return (
    <div className="proof-annotation-layout pdf-annotation-layout">
      <div className="proof-annotation-stage-panel">
        <div className="proof-annotation-hint">
          <p>Drag to tag a region, or add a whole-page note. Page changes keep your existing annotations.</p>
          <button type="button" className="button is-quiet" onClick={addKeyboardAnnotation} disabled={busy || loading}>Add whole-page note to page {pageNumber}</button>
        </div>
        {preview}
      </div>
      <aside className="proof-annotation-sidebar">
        <div className="proof-annotation-sidebar-head">
          <div><strong>Annotations</strong><p>{annotations.length === 0 ? "Create a tag on the PDF to start." : "Write one note for each numbered tag."}</p></div>
          <span className="proof-annotation-count">{annotations.length}</span>
        </div>
        {annotations.length === 0 ? <div className="proof-annotation-empty">No tags yet.</div> : (
          <div className="proof-annotation-list">
            {annotations.map((annotation, index) => (
              <div key={annotation.id} className={`proof-annotation-item${annotation.id === activeAnnotationId ? " is-active" : ""}`}>
                <button className="proof-annotation-item-head" type="button" disabled={busy} onClick={() => { setPageNumber(annotation.pageNumber); setActiveAnnotationId(annotation.id); }}>
                  <span className="proof-annotation-item-tag">{index + 1}</span>
                  <span className="proof-annotation-item-label">Page {annotation.pageNumber}{annotation.wholePage ? " · Whole page" : ""}</span>
                </button>
                <textarea disabled={busy} value={annotation.text} onChange={(event) => setAnnotations((current) => current.map((entry) => entry.id === annotation.id ? { ...entry, text: event.target.value } : entry))} placeholder={`What should tag ${index + 1} call out?`} rows={3} />
                <button className="proof-annotation-remove" type="button" disabled={busy} onClick={() => removeAnnotation(annotation.id)} aria-label={`Remove tag ${index + 1}`}><TrashIcon /><span>Remove</span></button>
              </div>
            ))}
          </div>
        )}
        <div className="proof-annotation-sidebar-footer">
          <p className="proof-annotation-target">Done creates a new immutable PDF version and adds it to {attachTargetLabel ?? "Butler"}.</p>
          {missingNoteCount > 0 ? <p className="proof-annotation-warning">Add text for {missingNoteCount === 1 ? "the remaining tag" : `all ${missingNoteCount} remaining tags`} before sending.</p> : null}
          <button className="button is-primary proof-annotation-attach" type="button" onClick={() => void handleAttach()} disabled={!canAttach}>{busy ? "Creating PDF…" : `Done and send to ${attachTargetLabel ?? "Butler"}`}</button>
        </div>
      </aside>
    </div>
  );
}
