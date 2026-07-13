import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent } from "react";

import {
  deleteStoredReference,
  listStoredReferences,
  uploadAttachment,
  type FileReference,
  type StoredReference
} from "./api";
import { AttachmentIcon, DownloadIcon, ImageIcon, SearchIcon, TrashIcon, WarningIcon } from "./icons";
import { FilePreviewModal } from "./FilePreviewModal";
import { ImagePreviewModal, type PreviewMedia } from "./ImagePreviewModal";

export type ReferenceFilter = "all" | "image" | "file";
type FileDragPhase = "enter" | "over" | "leave" | "drop" | "end";
const MAX_AUTOMATIC_THUMBNAIL_BYTES = 3 * 1024 * 1024;
const INLINE_PREVIEW_IMAGE_MIME_TYPES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp", "image/avif"]);

function displayKind(item: StoredReference): "image" | "file" {
  return item.mimeType.toLowerCase().startsWith("image/") ? "image" : "file";
}

export function shouldLoadImageThumbnail(item: StoredReference): boolean {
  return canPreviewStoredImage(item) && item.sizeBytes <= MAX_AUTOMATIC_THUMBNAIL_BYTES;
}

export function canPreviewStoredImage(item: StoredReference): boolean {
  return item.kind === "image" && INLINE_PREVIEW_IMAGE_MIME_TYPES.has(item.mimeType.toLowerCase());
}

export function filterStoredReferences(
  items: StoredReference[],
  filter: ReferenceFilter,
  search: string
): StoredReference[] {
  const query = search.trim().toLowerCase();
  return items.filter((item) => {
    if (filter !== "all" && displayKind(item) !== filter) return false;
    return !query || item.name.toLowerCase().includes(query) || item.mimeType.toLowerCase().includes(query);
  });
}

export function formatReferenceSize(sizeBytes: number): string {
  if (sizeBytes < 1024) return `${sizeBytes} B`;
  if (sizeBytes < 1024 * 1024) return `${(sizeBytes / 1024).toFixed(sizeBytes < 10 * 1024 ? 1 : 0)} KB`;
  return `${(sizeBytes / (1024 * 1024)).toFixed(sizeBytes < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}

export function reduceStoredFileDrag(input: {
  phase: FileDragPhase;
  depth: number;
  hasFileType: boolean;
  files: File[];
  canUpload: boolean;
}): { depth: number; active: boolean; preventDefault: boolean; filesToUpload: File[] } {
  const accepted = input.hasFileType || (input.phase === "drop" && input.files.length > 0);
  if (input.phase === "end") return { depth: 0, active: false, preventDefault: false, filesToUpload: [] };
  if (input.phase === "enter") {
    if (!accepted) return { depth: input.depth, active: false, preventDefault: false, filesToUpload: [] };
    const depth = input.depth + 1;
    return { depth, active: input.canUpload, preventDefault: true, filesToUpload: [] };
  }
  if (input.phase === "over") {
    return { depth: input.depth, active: input.depth > 0 && input.canUpload, preventDefault: accepted, filesToUpload: [] };
  }
  if (input.phase === "leave") {
    const depth = Math.max(0, input.depth - 1);
    return { depth, active: depth > 0 && input.canUpload, preventDefault: input.depth > 0, filesToUpload: [] };
  }
  return {
    depth: 0,
    active: false,
    preventDefault: accepted,
    filesToUpload: accepted && input.canUpload ? input.files : []
  };
}

function formatCreatedAt(value: number): string {
  return new Date(value).toLocaleString([], {
    month: "short",
    day: "numeric",
    year: new Date(value).getFullYear() === new Date().getFullYear() ? undefined : "numeric",
    hour: "2-digit",
    minute: "2-digit"
  });
}

function referenceTypeLabel(item: StoredReference): string {
  if (displayKind(item) === "image") return "Image";
  const extension = item.name.split(".").pop();
  return extension && extension !== item.name ? extension.toUpperCase() : "File";
}

export function FileExplorer({ active, attachTargetLabel, onAttached }: {
  active: boolean;
  attachTargetLabel: string | null;
  onAttached: (payload: { attachment: FileReference; text: string }) => Promise<void> | void;
}) {
  const [items, setItems] = useState<StoredReference[]>([]);
  const [filter, setFilter] = useState<ReferenceFilter>("all");
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const [mutationError, setMutationError] = useState<string | null>(null);
  const [previewMedia, setPreviewMedia] = useState<PreviewMedia | null>(null);
  const [previewReference, setPreviewReference] = useState<StoredReference | null>(null);
  const previewOpenerRef = useRef<HTMLButtonElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const dragDepthRef = useRef(0);
  const [dragActive, setDragActive] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setRefreshError(null);
    try {
      setItems(await listStoredReferences());
    } catch (err) {
      setRefreshError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!active) return;
    void load();
    const interval = window.setInterval(() => void load(), 5000);
    return () => window.clearInterval(interval);
  }, [active, load]);

  const counts = useMemo(() => ({
    all: items.length,
    image: items.filter((item) => displayKind(item) === "image").length,
    file: items.filter((item) => displayKind(item) === "file").length
  }), [items]);
  const visibleItems = useMemo(() => filterStoredReferences(items, filter, search), [filter, items, search]);
  const error = mutationError ?? refreshError;
  const itemsById = useMemo(() => new Map(items.map((item) => [item.id, item])), [items]);
  const childrenByParentId = useMemo(() => {
    const children = new Map<string, StoredReference[]>();
    for (const item of items) {
      if (!item.sourceReferenceId) continue;
      const current = children.get(item.sourceReferenceId) ?? [];
      current.push(item);
      children.set(item.sourceReferenceId, current);
    }
    return children;
  }, [items]);

  async function uploadFiles(files: File[]) {
    if (files.length === 0 || uploading) return;
    setUploading(true);
    setMutationError(null);
    try {
      const failures: unknown[] = [];
      for (const file of files) {
        try {
          await uploadAttachment(file);
        } catch (err) {
          failures.push(err);
        }
      }
      await load();
      if (failures.length > 0) {
        const first = failures[0];
        throw first instanceof Error
          ? first
          : new Error(`${failures.length} ${failures.length === 1 ? "file" : "files"} could not be uploaded.`);
      }
    } catch (err) {
      setMutationError(err instanceof Error ? err.message : String(err));
    } finally {
      setUploading(false);
    }
  }

  async function deleteReference(item: StoredReference) {
    if (item.hasChildren || deletingId) return;
    if (!window.confirm(`Delete “${item.name}” permanently? It will no longer open from session history. This cannot be undone.`)) return;
    setDeletingId(item.id);
    setMutationError(null);
    try {
      await deleteStoredReference(item.id);
      setItems((current) => current.filter((entry) => entry.id !== item.id));
    } catch (err) {
      setMutationError(err instanceof Error ? err.message : String(err));
    } finally {
      setDeletingId(null);
    }
  }

  function applyFileDrag(phase: FileDragPhase, event: DragEvent<HTMLElement>) {
    const transition = reduceStoredFileDrag({
      phase,
      depth: dragDepthRef.current,
      hasFileType: Array.from(event.dataTransfer.types).includes("Files"),
      files: Array.from(event.dataTransfer.files),
      canUpload: !uploading
    });
    if (transition.preventDefault) event.preventDefault();
    if (phase === "over" && transition.preventDefault) event.dataTransfer.dropEffect = uploading ? "none" : "copy";
    dragDepthRef.current = transition.depth;
    setDragActive(transition.active);
    if (transition.filesToUpload.length > 0) void uploadFiles(transition.filesToUpload);
  }

  function openFilePreview(item: StoredReference, opener: HTMLButtonElement): void {
    previewOpenerRef.current = opener;
    setPreviewReference(item);
  }

  function closeFilePreview(): void {
    setPreviewReference(null);
    const opener = previewOpenerRef.current;
    previewOpenerRef.current = null;
    requestAnimationFrame(() => opener?.focus());
  }

  return (
    <section
      className={`file-explorer${dragActive ? " is-dragging" : ""}`}
      onDragEnter={(event) => applyFileDrag("enter", event)}
      onDragOver={(event) => applyFileDrag("over", event)}
      onDragLeave={(event) => applyFileDrag("leave", event)}
      onDrop={(event) => applyFileDrag("drop", event)}
      onDragEnd={(event) => applyFileDrag("end", event)}
      aria-label="Files"
    >
      {dragActive ? <div className="file-explorer-drop" aria-live="polite">Drop files to upload</div> : null}
      <div className="file-explorer-toolbar">
        <div className="segmented file-explorer-filters" role="group" aria-label="Filter by file type">
          {(["all", "image", "file"] as ReferenceFilter[]).map((option) => (
            <button
              key={option}
              type="button"
              aria-pressed={filter === option}
              className={filter === option ? "is-selected" : ""}
              onClick={() => setFilter(option)}
            >
              {option === "all" ? "All" : option === "image" ? "Images" : "Other"}
              <span>{counts[option]}</span>
            </button>
          ))}
        </div>
        <div className="file-explorer-actions">
          <label className="search file-explorer-search">
            <span className="search-icon"><SearchIcon /></span>
            <input
              type="search"
              placeholder="Search files…"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              aria-label="Search files"
            />
          </label>
          <input
            ref={inputRef}
            className="composer-upload-input"
            type="file"
            multiple
            tabIndex={-1}
            onChange={(event) => {
              const files = Array.from(event.target.files ?? []);
              event.target.value = "";
              void uploadFiles(files);
            }}
          />
          <button className="button is-primary" type="button" disabled={uploading} onClick={() => inputRef.current?.click()}>
            {uploading ? <span className="spinner" /> : <AttachmentIcon />}
            <span>{uploading ? "Uploading…" : "Upload files"}</span>
          </button>
        </div>
      </div>

      {error ? <div className="error file-explorer-error" role="alert"><WarningIcon /><span>{error}</span></div> : null}

      <div className="file-explorer-list-shell">
        {loading && items.length === 0 ? (
          <div className="file-explorer-state">Loading files…</div>
        ) : visibleItems.length === 0 ? (
          <div className="file-explorer-state">
            <ImageIcon />
            <strong>{items.length === 0 ? "No files yet" : "No matching files"}</strong>
            <span>{items.length === 0 ? "Upload a file or drop it anywhere on this page." : "Try another search or file type."}</span>
          </div>
        ) : (
          <>
            <div className="file-explorer-columns" aria-hidden="true">
              <span>Name</span><span>Type</span><span>Size</span><span>Added</span><span>Actions</span>
            </div>
            <ul className="file-explorer-list">
              {visibleItems.map((item) => {
                const isImage = displayKind(item) === "image";
                const canPreviewImage = canPreviewStoredImage(item);
                const canPreviewText = Boolean(item.previewKind && item.previewUrl);
                const parent = item.sourceReferenceId ? itemsById.get(item.sourceReferenceId) : undefined;
                const children = childrenByParentId.get(item.id) ?? [];
                const lineageLabel = parent
                  ? `Derived from ${parent.name}`
                  : children.length > 0
                    ? `Newer ${children.length === 1 ? "version" : "versions"}: ${children.map((child) => child.name).join(", ")}`
                    : null;
                const deleteLabel = children.length > 0
                  ? `Delete newer ${children.length === 1 ? "version" : "versions"} first: ${children.map((child) => child.name).join(", ")}`
                  : "Delete";
                return (
                <li key={item.id} className="file-explorer-row">
                  <div className="file-explorer-name-cell">
                    {canPreviewImage ? (
                      <button
                        className="file-explorer-thumb is-image"
                        type="button"
                        onClick={() => setPreviewMedia({ name: item.name, url: item.url, kind: "image", downloadUrl: item.downloadUrl })}
                        aria-label={`Preview ${item.name}`}
                      >
                        {shouldLoadImageThumbnail(item)
                          ? <img src={item.url} alt="" loading="lazy" decoding="async" fetchPriority="low" />
                          : <ImageIcon />}
                      </button>
                    ) : canPreviewText ? (
                      <button className="file-explorer-thumb is-file" type="button" onClick={(event) => openFilePreview(item, event.currentTarget)} aria-label={`Preview ${item.name}`}>
                        {referenceTypeLabel(item).slice(0, 4)}
                      </button>
                    ) : <span className={`file-explorer-thumb ${isImage ? "is-file-image" : "is-file"}`}>{isImage ? <ImageIcon /> : referenceTypeLabel(item).slice(0, 4)}</span>}
                    <div>
                      {canPreviewImage ? (
                        <button className="file-explorer-name" type="button" onClick={() => setPreviewMedia({ name: item.name, url: item.url, kind: "image", downloadUrl: item.downloadUrl })}>{item.name}</button>
                      ) : canPreviewText ? (
                        <button className="file-explorer-name" type="button" onClick={(event) => openFilePreview(item, event.currentTarget)}>{item.name}</button>
                      ) : <a className="file-explorer-name" href={item.downloadUrl}>{item.name}</a>}
                      <span className="file-explorer-mime">{item.mimeType}</span>
                      {lineageLabel ? <span className="file-explorer-lineage" title={lineageLabel}>{lineageLabel}</span> : null}
                    </div>
                  </div>
                  <span className="file-explorer-type">{referenceTypeLabel(item)}{item.version ? <small>v{item.version}</small> : null}</span>
                  <span className="file-explorer-size">{formatReferenceSize(item.sizeBytes)}</span>
                  <time className="file-explorer-time" dateTime={new Date(item.createdAt).toISOString()}>{formatCreatedAt(item.createdAt)}</time>
                  <div className="file-explorer-row-actions">
                    <a className="icon-button" href={item.downloadUrl} download aria-label={`Download ${item.name}`} title="Download"><DownloadIcon /></a>
                    <button
                      className="icon-button is-danger"
                      type="button"
                      disabled={item.hasChildren || deletingId !== null}
                      onClick={() => void deleteReference(item)}
                      aria-label={item.hasChildren ? `${deleteLabel} before deleting ${item.name}` : `Delete ${item.name}`}
                      title={deleteLabel}
                    >
                      {deletingId === item.id ? <span className="spinner" /> : <TrashIcon />}
                    </button>
                  </div>
                </li>
                );
              })}
            </ul>
          </>
        )}
      </div>

      {previewMedia ? (
        <ImagePreviewModal
          media={previewMedia}
          attachTargetLabel={null}
          onAttached={() => undefined}
          onClose={() => setPreviewMedia(null)}
          showErrorToast={(err) => setMutationError(err instanceof Error ? err.message : String(err))}
        />
      ) : null}
      {previewReference?.previewKind && previewReference.previewUrl ? (
        <FilePreviewModal
          media={{
            id: previewReference.id,
            name: previewReference.name,
            mimeType: previewReference.mimeType,
            previewKind: previewReference.previewKind,
            previewUrl: previewReference.previewUrl,
            downloadUrl: previewReference.downloadUrl
          }}
          attachTargetLabel={attachTargetLabel}
          onAttached={async (payload) => {
            await onAttached(payload);
            await load();
          }}
          onClose={closeFilePreview}
          showErrorToast={(err) => setMutationError(err instanceof Error ? err.message : String(err))}
        />
      ) : null}
    </section>
  );
}
