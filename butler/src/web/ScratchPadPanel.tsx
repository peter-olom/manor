import { useRef, useState } from "react";

import { postJson, uploadAttachment } from "./api";
import { AttachmentIcon, CloseIcon, OpenIcon, ScratchPadTabIcon, SendIcon, TrashIcon } from "./icons";
import type { FileReference, PreviewableImage, ScratchPad, ScratchPadAttachment, ScratchPadItem, ScratchPadItemStatus } from "./types";
import { formatJobIdLabel, formatJumpLabel } from "./utils";

const REVIEW_STATUSES = ["accepted", "parked", "dismissed"] as const;
const FILE_UPLOAD_ACCEPT = ".pdf,.ppt,.pptx,.xls,.xlsx,.doc,.docx,.txt,.csv,.json,.md,.zip,image/*,*/*";

export function statusLabel(status: ScratchPadItemStatus, readinessLabel?: string): string {
  if (readinessLabel) return readinessLabel;
  if (status === "ready_for_review") return "ready";
  return status.replaceAll("_", " ");
}

function itemTone(item: ScratchPadItem): string {
  if (item.readiness.status === "ready") return "ready";
  if (item.readiness.status === "needs_rework") return "needs-work";
  if (item.readiness.status === "blocked") return "blocked";
  return item.status === "ready_for_review" ? "ready" : item.status;
}

function openAttachment(attachment: Pick<ScratchPadAttachment, "url" | "name" | "mimeType">, onPreviewImage: (image: PreviewableImage) => void) {
  if (!attachment.url) return;
  if (attachment.mimeType.startsWith("image/")) {
    onPreviewImage({ id: attachment.url, name: attachment.name, url: attachment.url });
    return;
  }
  window.open(attachment.url, "_blank");
}

export function ScratchPadPanel({
  variant = "compact",
  scratchPad,
  defaultCwd,
  onOpenThread,
  onConfirmCleanup,
  onPreviewImage,
  showToast,
  showErrorToast
}: {
  variant?: "compact" | "window";
  scratchPad: ScratchPad;
  defaultCwd: string | null;
  onOpenThread: (threadId: string) => void;
  onConfirmCleanup: (item: ScratchPadItem, cleanup: () => Promise<void>) => void;
  onPreviewImage: (image: PreviewableImage) => void;
  showToast: (message: string, tone?: "success" | "error" | "info", duration?: number, key?: string) => void;
  showErrorToast: (error: unknown, key?: string, duration?: number) => void;
}) {
  const [text, setText] = useState("");
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [attachments, setAttachments] = useState<FileReference[]>([]);
  const [uploadingAttachments, setUploadingAttachments] = useState(0);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const canSubmit = text.trim().length > 0 && !busyKey && uploadingAttachments === 0;
  const activeCount = scratchPad.counts.captured + scratchPad.counts.exploring + scratchPad.counts.ready_for_review;
  const reviewedCount = scratchPad.counts.accepted + scratchPad.counts.parked + scratchPad.counts.dismissed;

  async function handleFiles(files: FileList | File[]) {
    const selected = Array.from(files);
    if (selected.length === 0) return;
    setUploadingAttachments((count) => count + selected.length);
    try {
      const uploaded = await Promise.all(selected.map((file) => uploadAttachment(file)));
      setAttachments((current) => [...current, ...uploaded]);
    } catch (error) {
      showErrorToast(error, "scratch-attachment-upload");
    } finally {
      setUploadingAttachments((count) => Math.max(0, count - selected.length));
    }
  }

  async function createItem() {
    const body = text.trim();
    if (!body) return;
    setBusyKey("create");
    try {
      await postJson("/api/scratch-pad/items", {
        text: body,
        autoStart: true,
        cwd: defaultCwd ?? undefined,
        workspaceMode: "managed_worktree",
        imageReferenceIds: attachments.filter((attachment) => attachment.mimeType.startsWith("image/")).map((attachment) => attachment.id),
        fileReferenceIds: attachments.filter((attachment) => !attachment.mimeType.startsWith("image/")).map((attachment) => attachment.id)
      });
      setText("");
      setAttachments([]);
      showToast("Scratch item started");
    } catch (error) {
      showErrorToast(error, "scratch-create");
    } finally {
      setBusyKey((current) => (current === "create" ? null : current));
    }
  }

  async function startItem(item: ScratchPadItem) {
    setBusyKey(`start:${item.id}`);
    try {
      await postJson(`/api/scratch-pad/items/${encodeURIComponent(item.id)}/start`, {});
      showToast("Scratch item started");
    } catch (error) {
      showErrorToast(error, "scratch-start");
    } finally {
      setBusyKey((current) => (current === `start:${item.id}` ? null : current));
    }
  }

  async function reviewItem(item: ScratchPadItem, status: (typeof REVIEW_STATUSES)[number]) {
    setBusyKey(`${status}:${item.id}`);
    try {
      await postJson(`/api/scratch-pad/items/${encodeURIComponent(item.id)}/review`, { status });
      showToast(`Scratch item ${status}`);
    } catch (error) {
      showErrorToast(error, "scratch-review");
    } finally {
      setBusyKey((current) => (current === `${status}:${item.id}` ? null : current));
    }
  }

  async function cleanupItem(item: ScratchPadItem) {
    setBusyKey(`cleanup:${item.id}`);
    try {
      const result = await postJson<{ threadDeleted?: boolean }>(`/api/scratch-pad/items/${encodeURIComponent(item.id)}/delete`, {});
      showToast(result.threadDeleted ? "Scratch item, thread, and artifacts cleaned up" : "Scratch item cleaned up");
    } catch (error) {
      showErrorToast(error, "scratch-delete");
    } finally {
      setBusyKey((current) => (current === `cleanup:${item.id}` ? null : current));
    }
  }

  async function removeItemAttachment(item: ScratchPadItem, attachment: ScratchPadAttachment) {
    setBusyKey(`attachment:${item.id}:${attachment.id}`);
    try {
      await postJson(`/api/scratch-pad/items/${encodeURIComponent(item.id)}/attachments/${encodeURIComponent(attachment.id)}/remove`, {});
      showToast("Attachment removed");
    } catch (error) {
      showErrorToast(error, "scratch-attachment-remove");
    } finally {
      setBusyKey((current) => (current === `attachment:${item.id}:${attachment.id}` ? null : current));
    }
  }

  return (
    <div className={`scratch-pad-panel is-${variant}`}>
      {variant === "window" ? (
        <div className="scratch-pad-window-head">
          <div className="scratch-pad-window-title">Scratch pad</div>
          <div className="scratch-pad-counts" aria-label="Scratch pad counts">
            <span>{activeCount} active</span>
            <span>{scratchPad.counts.ready_for_review} ready</span>
            <span>{reviewedCount} reviewed</span>
          </div>
        </div>
      ) : null}
      <div className="scratch-pad-body">
        <section className={`scratch-pad-list-shell ${scratchPad.items.length === 0 ? "is-empty" : ""}`} aria-label="Scratch pad items">
          <div className="scratch-pad-list">
            {scratchPad.items.length === 0 ? (
              <div className="scratch-pad-empty">
                <ScratchPadTabIcon />
                <span>Nothing queued</span>
              </div>
            ) : (
              scratchPad.items.map((item) => (
                <article key={item.id} className={`scratch-pad-item is-${itemTone(item)}`}>
                  <div className="scratch-pad-item-head">
                    <span className="scratch-pad-title">{item.title}</span>
                    <span className="scratch-pad-status">{statusLabel(item.status, item.readiness.label)}</span>
                  </div>
                  <div className="scratch-pad-text">{item.text}</div>
                  {item.dossier.resultSummary || item.dossier.acceptedEvidence > 0 || item.dossier.reviewerSummary ? (
                    <div className="scratch-pad-dossier-mini">
                      {item.dossier.resultSummary ? <p>{item.dossier.resultSummary}</p> : null}
                      {item.dossier.totalEvidence > 0 ? (
                        <span>{item.dossier.acceptedEvidence}/{item.dossier.totalEvidence} evidence accepted</span>
                      ) : null}
                      {item.dossier.reviewerSummary ? <span>{item.dossier.reviewerSummary}</span> : null}
                      {item.dossier.nextAction ? <strong>{item.dossier.nextAction}</strong> : null}
                    </div>
                  ) : (
                    <div className="scratch-pad-readiness">{item.readiness.summary}</div>
                  )}
                  {item.attachments.length > 0 ? (
                    <div className="scratch-pad-attachments">
                      {item.attachments.map((attachment) => (
                        <span key={attachment.id} className={`scratch-pad-attachment-row ${attachment.available ? "" : "is-unavailable"}`}>
                          <button
                            type="button"
                            className="scratch-pad-attachment"
                            onClick={() => openAttachment(attachment, onPreviewImage)}
                            disabled={!attachment.available || !attachment.url}
                            title={attachment.available ? attachment.name : "Attachment unavailable"}
                          >
                            <AttachmentIcon />
                            <span>{attachment.name}</span>
                          </button>
                          {!item.threadId ? (
                            <button
                              type="button"
                              className="scratch-pad-attachment-remove"
                              aria-label={`Remove ${attachment.name}`}
                              onClick={(event) => {
                                event.preventDefault();
                                event.stopPropagation();
                                void removeItemAttachment(item, attachment);
                              }}
                            >
                              <CloseIcon />
                            </button>
                          ) : null}
                        </span>
                      ))}
                    </div>
                  ) : null}
                  {item.dossier.reviewerConcerns.length > 0 ? (
                    <div className="scratch-pad-concerns">
                      {item.dossier.reviewerConcerns.slice(0, 2).map((concern) => (
                        <span key={concern}>{concern}</span>
                      ))}
                    </div>
                  ) : null}
                  <div className="scratch-pad-meta">
                    <span>{formatJumpLabel(item.startedAt ?? item.createdAt)}</span>
                    {item.dossier.attachmentSummary ? <span>{item.dossier.attachmentSummary}</span> : null}
                  </div>
                  <div className="scratch-pad-actions">
                    {item.threadId ? (
                      <button type="button" className="scratch-pad-action" onClick={() => onOpenThread(item.threadId!)}>
                        <OpenIcon />
                        <span>{formatJobIdLabel(item.threadId)}</span>
                      </button>
                    ) : (
                      <button type="button" className="scratch-pad-action" disabled={Boolean(busyKey)} onClick={() => void startItem(item)}>
                        <SendIcon />
                        <span>Start</span>
                      </button>
                    )}
                    {item.readiness.status === "ready" || item.status === "ready_for_review" ? (
                      REVIEW_STATUSES.map((status) => (
                        <button
                          key={status}
                          type="button"
                          className="scratch-pad-action"
                          disabled={Boolean(busyKey)}
                          onClick={() => void reviewItem(item, status)}
                        >
                          {status}
                        </button>
                      ))
                    ) : null}
                    <button
                      type="button"
                      className="scratch-pad-icon-action"
                      disabled={Boolean(busyKey)}
                      onClick={() => onConfirmCleanup(item, () => cleanupItem(item))}
                      aria-label="Cleanup scratch item"
                      title="Cleanup"
                    >
                      <TrashIcon />
                    </button>
                  </div>
                </article>
              ))
            )}
          </div>
        </section>
        <form
          className="scratch-pad-composer composer"
          onSubmit={(event) => {
            event.preventDefault();
            void createItem();
          }}
        >
          <input
            ref={fileInputRef}
            type="file"
            accept={FILE_UPLOAD_ACCEPT}
            multiple
            hidden
            onChange={(event) => {
              if (event.target.files) void handleFiles(event.target.files);
              event.currentTarget.value = "";
            }}
          />
          {attachments.length > 0 || uploadingAttachments > 0 ? (
            <div className="scratch-pad-composer-attachments">
              {attachments.map((attachment) => (
                <span
                  key={attachment.id}
                  className="scratch-pad-composer-attachment"
                  title={attachment.name}
                >
                  <button
                    type="button"
                    onClick={() =>
                      attachment.mimeType.startsWith("image/")
                        ? onPreviewImage({ id: attachment.id, name: attachment.name, url: attachment.url })
                        : window.open(attachment.url, "_blank")
                    }
                  >
                    <AttachmentIcon />
                    <span>{attachment.name}</span>
                  </button>
                  <button
                    type="button"
                    aria-label={`Remove ${attachment.name}`}
                    onClick={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                      setAttachments((current) => current.filter((entry) => entry.id !== attachment.id));
                    }}
                  >
                    <CloseIcon />
                  </button>
                </span>
              ))}
              {uploadingAttachments > 0 ? <span className="scratch-pad-uploading">Uploading {uploadingAttachments}</span> : null}
            </div>
          ) : null}
          <div className="composer-main">
            <textarea
              value={text}
              onChange={(event) => setText(event.target.value)}
              onKeyDown={(event) => {
                if (event.key !== "Enter" || (!event.metaKey && !event.ctrlKey)) return;
                event.preventDefault();
                void createItem();
              }}
              placeholder="Dump an idea"
              rows={3}
              aria-label="Scratch pad idea"
            />
          </div>
          <div className="composer-footer">
            <div className="composer-note">Cmd/Ctrl + Enter sends</div>
            <div className="composer-actions">
              <button
                className="composer-add-image"
                type="button"
                onClick={() => fileInputRef.current?.click()}
                aria-label="Add file"
                title="Add file"
              >
                <AttachmentIcon />
              </button>
              <button className="composer-send" type="submit" disabled={!canSubmit} aria-label="Send scratch pad idea">
                <span className="composer-send-label">Send</span>
                <span className="composer-send-icon">
                  <SendIcon />
                </span>
              </button>
            </div>
          </div>
        </form>
      </div>
    </div>
  );
}
