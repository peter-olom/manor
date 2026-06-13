import { useEffect, useRef, useState } from "react";
import type { CSSProperties, PointerEvent as ReactPointerEvent } from "react";

import { CloseIcon } from "./icons";
import type { BrowserAnnotationBatch } from "./types";

function formatPreviewAnnotationBatchLabel(batch: BrowserAnnotationBatch): string {
  const title = batch.page.title.trim() || "Preview";
  const count = batch.annotations.length;
  const state = batch.ready ? "Ready" : "Needs comments";
  return `${state} · ${title} · ${count} mark${count === 1 ? "" : "s"}`;
}

type CompanionToolbarDragEvent = {
  pointerId: number;
  clientX: number;
  clientY: number;
};

type CompanionToolbarStyle = CSSProperties & {
  "--preview-annotation-companion-bottom"?: string;
};

export function PreviewAnnotationCompanionToolbar({
  batches,
  selectedBatchId,
  targetLabel,
  busy,
  onSelectedBatchChange,
  onInsert,
  onDismiss
}: {
  batches: BrowserAnnotationBatch[];
  selectedBatchId: string;
  targetLabel: string | null;
  busy: boolean;
  onSelectedBatchChange: (batchId: string) => void;
  onInsert: () => void;
  onDismiss: () => void;
}) {
  const toolbarRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<{ pointerId: number; offsetX: number; offsetY: number } | null>(null);
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null);
  const [defaultBottom, setDefaultBottom] = useState<number | null>(null);
  const [dragging, setDragging] = useState(false);
  const selectedBatch = batches.find((batch) => batch.id === selectedBatchId) ?? batches[0] ?? null;
  const toolbarStyle: CompanionToolbarStyle | undefined = position
    ? { left: position.left, top: position.top, right: "auto", bottom: "auto" }
    : defaultBottom !== null
      ? { "--preview-annotation-companion-bottom": `${defaultBottom}px` }
      : undefined;

  function clampPosition(left: number, top: number): { left: number; top: number } {
    const toolbar = toolbarRef.current;
    const width = toolbar?.offsetWidth ?? 1;
    const height = toolbar?.offsetHeight ?? 1;
    return {
      left: Math.min(Math.max(8, left), Math.max(8, window.innerWidth - width - 8)),
      top: Math.min(Math.max(8, top), Math.max(8, window.innerHeight - height - 8))
    };
  }

  function measureDefaultBottom(): number | null {
    const toolbarHeight = toolbarRef.current?.offsetHeight ?? 54;
    const fallbackBottom = window.innerWidth <= 860 ? 132 : 136;
    const composer = Array.from(document.querySelectorAll<HTMLElement>(".composer"))
      .map((element) => {
        const style = window.getComputedStyle(element);
        return { element, rect: element.getBoundingClientRect(), style };
      })
      .filter(({ rect, style }) =>
        rect.width > 240 &&
        rect.height > 40 &&
        rect.bottom > 0 &&
        rect.top < window.innerHeight &&
        style.display !== "none" &&
        style.visibility !== "hidden"
      )
      .sort((left, right) => right.rect.bottom - left.rect.bottom)[0];

    if (!composer) {
      return null;
    }

    const aboveComposerBottom = Math.round(window.innerHeight - composer.rect.top + 12);
    const maxBottom = Math.max(fallbackBottom, window.innerHeight - toolbarHeight - 8);
    return Math.min(Math.max(fallbackBottom, aboveComposerBottom), maxBottom);
  }

  function startDrag(event: ReactPointerEvent<HTMLButtonElement>): void {
    const toolbar = toolbarRef.current;
    if (!toolbar) {
      return;
    }
    const rect = toolbar.getBoundingClientRect();
    dragRef.current = {
      pointerId: event.pointerId,
      offsetX: event.clientX - rect.left,
      offsetY: event.clientY - rect.top
    };
    setPosition({ left: rect.left, top: rect.top });
    setDragging(true);
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {}
    event.preventDefault();
  }

  function moveDrag(event: CompanionToolbarDragEvent): void {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) {
      return;
    }
    setPosition(clampPosition(event.clientX - drag.offsetX, event.clientY - drag.offsetY));
  }

  function endDrag(event: { pointerId: number }): void {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) {
      return;
    }
    dragRef.current = null;
    setDragging(false);
  }

  useEffect(() => {
    function handleResize(): void {
      setPosition((current) => current ? clampPosition(current.left, current.top) : current);
    }

    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, []);

  useEffect(() => {
    if (position) {
      return;
    }

    let frame = 0;
    let observer: ResizeObserver | null = null;

    function syncDefaultBottom(): void {
      frame = 0;
      setDefaultBottom(measureDefaultBottom());
    }

    function scheduleSync(): void {
      if (frame) {
        window.cancelAnimationFrame(frame);
      }
      frame = window.requestAnimationFrame(syncDefaultBottom);
    }

    scheduleSync();
    window.addEventListener("resize", scheduleSync);
    window.addEventListener("orientationchange", scheduleSync);

    if ("ResizeObserver" in window) {
      observer = new ResizeObserver(scheduleSync);
      document.querySelectorAll<HTMLElement>(".composer").forEach((composer) => observer?.observe(composer));
    }

    return () => {
      if (frame) {
        window.cancelAnimationFrame(frame);
      }
      observer?.disconnect();
      window.removeEventListener("resize", scheduleSync);
      window.removeEventListener("orientationchange", scheduleSync);
    };
  }, [batches.length, position, selectedBatch?.id, targetLabel]);

  useEffect(() => {
    if (!dragging) {
      return;
    }

    window.addEventListener("pointermove", moveDrag);
    window.addEventListener("pointerup", endDrag);
    window.addEventListener("pointercancel", endDrag);
    return () => {
      window.removeEventListener("pointermove", moveDrag);
      window.removeEventListener("pointerup", endDrag);
      window.removeEventListener("pointercancel", endDrag);
    };
  }, [dragging]);

  if (!selectedBatch) {
    return null;
  }

  return (
    <div
      className={`preview-annotation-companion${dragging ? " is-dragging" : ""}`}
      ref={toolbarRef}
      role="region"
      aria-label="Preview annotations"
      style={toolbarStyle}
    >
      <button
        type="button"
        className="preview-annotation-companion-handle"
        onPointerDown={startDrag}
        onPointerMove={moveDrag}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        aria-label="Drag annotation toolbar"
        title="Drag annotation toolbar"
      >
        ⋮⋮
      </button>
      <div className="preview-annotation-companion-main">
        <span className={`preview-annotation-companion-dot${selectedBatch.ready ? "" : " is-pending"}`} aria-hidden="true" />
        <span className="preview-annotation-companion-label">Preview annotations</span>
        <select value={selectedBatch.id} onChange={(event) => onSelectedBatchChange(event.target.value)} aria-label="Preview annotation">
          {batches.map((batch) => (
            <option key={batch.id} value={batch.id}>
              {formatPreviewAnnotationBatchLabel(batch)}
            </option>
          ))}
        </select>
        <span className="preview-annotation-companion-meta">
          {selectedBatch.ready ? `Target: ${targetLabel ?? "open Butler or a Codex job"}` : "Add comments to every mark"}
        </span>
      </div>
      <div className="preview-annotation-companion-actions">
        <button type="button" className="preview-annotation-companion-insert" onClick={onInsert} disabled={busy || !targetLabel || !selectedBatch.ready}>
          {busy ? "Inserting…" : "Insert"}
        </button>
        <button type="button" className="preview-annotation-companion-dismiss" onClick={onDismiss} disabled={busy} aria-label="Dismiss annotation">
          <CloseIcon />
        </button>
      </div>
    </div>
  );
}
