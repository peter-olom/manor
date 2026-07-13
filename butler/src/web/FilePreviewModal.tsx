import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";

import type { ReferencePreviewKind } from "../shared/references";
import { getStoredTextPreview, type FileReference } from "./api";
import { CloseIcon, DownloadIcon, ImageIcon, PencilIcon, WarningIcon } from "./icons";
import { Markdown } from "./Markdown";

const PdfPreview = lazy(() => import("./PdfPreview").then((module) => ({ default: module.PdfPreview })));

export type FilePreviewMedia = {
  id: string;
  name: string;
  mimeType: string;
  previewKind: ReferencePreviewKind;
  previewUrl: string;
  downloadUrl: string;
};

export const HTML_PREVIEW_CSP = "default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:; base-uri 'none'; form-action 'none'";
export const HTML_PREVIEW_SANDBOX = "";
export const BLOCKED_HTML_SELECTORS = "script, iframe, object, embed, link, base, meta, noscript";

export function isSafeHtmlReference(attributeName: string, value: string): boolean {
  const name = attributeName.toLowerCase();
  const normalizedValue = value.trim();
  if ((name === "href" || name === "xlink:href") && normalizedValue.startsWith("#")) return true;
  return name === "src" && /^data:image\/(?:png|jpeg|gif|webp|avif);/i.test(normalizedValue);
}

export function sanitizeHtmlCss(css: string): string {
  return css
    .replace(/@import\s+(?:url\()?[^;]+;?/gi, "")
    .replace(/url\(([^)]*)\)/gi, (match, rawValue: string) => {
      const value = rawValue.trim().replace(/^(?:"([\s\S]*)"|'([\s\S]*)')$/, "$1$2");
      return /^data:image\/(?:png|jpeg|gif|webp|avif);/i.test(value) ? match : "none";
    });
}

function removeUnsafeHtml(document: Document): void {
  for (const element of document.querySelectorAll(BLOCKED_HTML_SELECTORS)) element.remove();
  for (const form of document.querySelectorAll("form")) form.replaceWith(...form.childNodes);
  for (const element of document.querySelectorAll("*")) {
    for (const attribute of [...element.attributes]) {
      const name = attribute.name.toLowerCase();
      if (name.startsWith("on")) {
        element.removeAttribute(attribute.name);
        continue;
      }
      if (name === "style") {
        element.setAttribute(attribute.name, sanitizeHtmlCss(attribute.value));
        continue;
      }
      if (!["href", "src", "srcset", "action", "formaction", "poster", "data", "xlink:href"].includes(name)) continue;
      if (!isSafeHtmlReference(name, attribute.value)) element.removeAttribute(attribute.name);
    }
  }
  for (const style of document.querySelectorAll("style")) style.textContent = sanitizeHtmlCss(style.textContent ?? "");
}

export function buildSandboxedHtmlPreview(source: string): string {
  const parsed = new DOMParser().parseFromString(source, "text/html");
  removeUnsafeHtml(parsed);
  const styles = [...parsed.head.querySelectorAll("style")].map((style) => style.outerHTML).join("\n");
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${HTML_PREVIEW_CSP}"><meta name="referrer" content="no-referrer"><style>:root{color-scheme:light}*{box-sizing:border-box}body{max-width:960px;margin:0 auto;padding:32px;background:#fff;color:#17191d;font:15px/1.6 system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}img{max-width:100%;height:auto}pre{overflow:auto;padding:14px;background:#f4f5f7;border-radius:6px}table{border-collapse:collapse}th,td{padding:7px 10px;border:1px solid #d8dce3}</style>${styles}</head><body>${parsed.body.innerHTML}</body></html>`;
}

function previewLabel(kind: ReferencePreviewKind): string {
  if (kind === "markdown") return "Markdown";
  if (kind === "html") return "HTML";
  if (kind === "pdf") return "PDF";
  return "Text";
}

export function FilePreviewModal({ media, attachTargetLabel, onAttached, onClose, showErrorToast }: {
  media: FilePreviewMedia;
  attachTargetLabel: string | null;
  onAttached: (payload: { attachment: FileReference; text: string }) => Promise<void> | void;
  onClose: () => void;
  showErrorToast: (error: unknown) => void;
}) {
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const [text, setText] = useState("");
  const [loading, setLoading] = useState(true);
  const [truncated, setTruncated] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [htmlMode, setHtmlMode] = useState<"rendered" | "source">("rendered");
  const [annotationMode, setAnnotationMode] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    setText("");
    setTruncated(false);
    setHtmlMode("rendered");
    setAnnotationMode(false);
    setBusy(false);
    if (media.previewKind === "pdf") return () => controller.abort();
    void getStoredTextPreview(media.previewUrl, controller.signal)
      .then((result) => {
        setText(result.text);
        setTruncated(result.truncated);
      })
      .catch((err) => {
        if (!controller.signal.aborted) setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [media.previewKind, media.previewUrl]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        if (!busy) onClose();
        return;
      }
      if (event.key !== "Tab" || !dialogRef.current) return;
      const focusable = [...dialogRef.current.querySelectorAll<HTMLElement>("a[href], button:not(:disabled), [tabindex]:not([tabindex='-1'])")]
        .filter((element) => !element.hidden && element.getAttribute("aria-hidden") !== "true");
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (!first || !last) return;
      const focusIsInside = dialogRef.current.contains(document.activeElement);
      if (event.shiftKey && (!focusIsInside || document.activeElement === first)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (!focusIsInside || document.activeElement === last)) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [busy, onClose]);

  const renderedHtml = useMemo(
    () => media.previewKind === "html" && text ? buildSandboxedHtmlPreview(text) : "",
    [media.previewKind, text]
  );

  return (
    <div className="modal-backdrop image-preview-backdrop" onClick={() => (!busy ? onClose() : undefined)}>
      <div ref={dialogRef} className={`modal-card-image modal-card-file${annotationMode ? " modal-card-annotation" : ""}`} role="dialog" aria-modal="true" aria-labelledby="file-preview-title" onClick={(event) => event.stopPropagation()}>
        <div className="modal-head image-preview-head">
          <div className="file-preview-title">
            <h2 id="file-preview-title">{media.name}</h2>
            <span>{previewLabel(media.previewKind)}</span>
          </div>
          <div className="modal-head-actions">
            {media.previewKind === "html" && !loading && !error ? (
              <div className="segmented file-preview-modes" role="group" aria-label="HTML preview mode">
                <button type="button" aria-pressed={htmlMode === "rendered"} className={htmlMode === "rendered" ? "is-selected" : ""} onClick={() => setHtmlMode("rendered")}>Rendered</button>
                <button type="button" aria-pressed={htmlMode === "source"} className={htmlMode === "source" ? "is-selected" : ""} onClick={() => setHtmlMode("source")}>Source</button>
              </div>
            ) : null}
            {!annotationMode ? <a className="modal-icon-action" href={media.downloadUrl} download aria-label={`Download ${media.name}`} title="Download"><DownloadIcon /></a> : null}
            {media.previewKind === "pdf" && attachTargetLabel ? (
              annotationMode
                ? <button className="modal-icon-action" type="button" onClick={() => setAnnotationMode(false)} disabled={busy} aria-label="Preview PDF" title="Preview PDF"><ImageIcon /></button>
                : <button className="modal-icon-action" type="button" onClick={() => setAnnotationMode(true)} disabled={busy} aria-label="Annotate PDF" title="Annotate PDF"><PencilIcon /></button>
            ) : null}
            <button className="modal-close modal-icon-action" type="button" onClick={onClose} aria-label="Close file preview" autoFocus disabled={busy}>
              <CloseIcon />
            </button>
          </div>
        </div>
        <div className={`file-preview-shell${media.previewKind === "pdf" ? " is-pdf" : ""}`}>
          {truncated ? <div className="file-preview-notice" role="status">Showing the first 1 MB. Download the file to read the rest.</div> : null}
          {loading && media.previewKind !== "pdf" ? <div className="file-preview-state"><span className="spinner" /> Loading preview…</div> : null}
          {error ? <div className="file-preview-state is-error" role="alert"><WarningIcon /><strong>Preview unavailable</strong><span>{error}</span></div> : null}
          {!loading && !error && media.previewKind === "markdown" ? <div className="file-preview-markdown"><Markdown text={text} allowRemoteImages={false} /></div> : null}
          {!loading && !error && media.previewKind === "html" && htmlMode === "rendered" ? <iframe className="file-preview-html" title={`Rendered preview of ${media.name}`} sandbox={HTML_PREVIEW_SANDBOX} referrerPolicy="no-referrer" srcDoc={renderedHtml} /> : null}
          {!loading && !error && (media.previewKind === "text" || htmlMode === "source") ? <pre className="file-preview-text">{text}</pre> : null}
          {media.previewKind === "pdf" ? (
            <Suspense fallback={<div className="file-preview-state"><span className="spinner" /> Loading preview…</div>}>
              <PdfPreview
                name={media.name}
                url={media.previewUrl}
                sourceReferenceId={media.id}
                annotationMode={annotationMode}
                attachTargetLabel={attachTargetLabel}
                onAttached={async (payload) => {
                  await onAttached(payload);
                  onClose();
                }}
                onBusyChange={setBusy}
                onError={showErrorToast}
              />
            </Suspense>
          ) : null}
        </div>
      </div>
    </div>
  );
}
