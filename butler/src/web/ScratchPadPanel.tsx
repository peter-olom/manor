import { useState } from "react";

import { postJson } from "./api";
import { OpenIcon, ScratchPadTabIcon, SendIcon, TrashIcon } from "./icons";
import type { ScratchPad, ScratchPadItem, ScratchPadItemStatus } from "./types";
import { formatJobIdLabel, formatJumpLabel } from "./utils";

const REVIEW_STATUSES = ["accepted", "parked", "dismissed"] as const;

function statusLabel(status: ScratchPadItemStatus): string {
  if (status === "ready_for_review") return "ready";
  return status.replaceAll("_", " ");
}

function itemTone(status: ScratchPadItemStatus): string {
  return status === "ready_for_review" ? "ready" : status;
}

export function ScratchPadPanel({
  variant = "compact",
  scratchPad,
  onOpenThread,
  onConfirmCleanup,
  showToast,
  showErrorToast
}: {
  variant?: "compact" | "window";
  scratchPad: ScratchPad;
  onOpenThread: (threadId: string) => void;
  onConfirmCleanup: (item: ScratchPadItem, cleanup: () => Promise<void>) => void;
  showToast: (message: string, tone?: "success" | "error" | "info", duration?: number, key?: string) => void;
  showErrorToast: (error: unknown, key?: string, duration?: number) => void;
}) {
  const [text, setText] = useState("");
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const canSubmit = text.trim().length > 0 && !busyKey;
  const activeCount = scratchPad.counts.captured + scratchPad.counts.exploring + scratchPad.counts.ready_for_review;
  const reviewedCount = scratchPad.counts.accepted + scratchPad.counts.parked + scratchPad.counts.dismissed;

  async function createItem() {
    const body = text.trim();
    if (!body) return;
    setBusyKey("create");
    try {
      await postJson("/api/scratch-pad/items", { text: body, autoStart: true });
      setText("");
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
                <article key={item.id} className={`scratch-pad-item is-${itemTone(item.status)}`}>
                  <div className="scratch-pad-item-head">
                    <span className="scratch-pad-title">{item.title}</span>
                    <span className="scratch-pad-status">{statusLabel(item.status)}</span>
                  </div>
                  <div className="scratch-pad-text">{item.text}</div>
                  <div className="scratch-pad-meta">
                    <span>{formatJumpLabel(item.startedAt ?? item.createdAt)}</span>
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
                    {item.status === "ready_for_review" ? (
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
