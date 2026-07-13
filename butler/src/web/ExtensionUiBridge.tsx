import { useEffect, useRef, useState } from "react";

import { getJson, postJson } from "./api";
import type { ExtensionUiDialog, ExtensionUiDialogResponse, ExtensionUiView } from "../shared/extension-ui";

const EMPTY_VIEW: ExtensionUiView = {
  dialog: null,
  notices: [],
  statuses: [],
  widgets: [],
  titles: [],
  editorText: null
};

function ExtensionDialog({
  dialog,
  pending,
  error,
  onRespond
}: {
  dialog: ExtensionUiDialog;
  pending: boolean;
  error: string | null;
  onRespond: (response: ExtensionUiDialogResponse) => void;
}) {
  const [value, setValue] = useState(dialog.prefill ?? "");
  const inputRef = useRef<HTMLInputElement | HTMLTextAreaElement | null>(null);

  useEffect(() => {
    setValue(dialog.prefill ?? "");
    window.setTimeout(() => inputRef.current?.focus(), 0);
  }, [dialog.id, dialog.prefill]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !pending) onRespond({ cancelled: true });
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onRespond, pending]);

  return (
    <div className="extension-dialog-backdrop" role="presentation">
      <section className="extension-dialog" role="dialog" aria-modal="true" aria-labelledby="extension-dialog-title">
        <div className="extension-dialog-copy">
          <span className="eyebrow">{dialog.lane === "butler" ? "Butler extension" : "Worker extension"}</span>
          <h2 id="extension-dialog-title">{dialog.title}</h2>
          {dialog.message ? <p>{dialog.message}</p> : null}
        </div>
        {dialog.method === "select" ? (
          <div className="extension-dialog-options" role="listbox" aria-label={dialog.title}>
            {dialog.options.map((option) => (
              <button key={option} className="button extension-dialog-option" type="button" disabled={pending} onClick={() => onRespond({ value: option })}>
                {option}
              </button>
            ))}
          </div>
        ) : dialog.method === "input" ? (
          <input
            ref={(node) => { inputRef.current = node; }}
            className="input extension-dialog-input"
            value={value}
            placeholder={dialog.placeholder ?? ""}
            disabled={pending}
            onChange={(event) => setValue(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && value.trim() && !pending) onRespond({ value });
            }}
          />
        ) : dialog.method === "editor" ? (
          <textarea
            ref={(node) => { inputRef.current = node; }}
            className="input extension-dialog-editor"
            value={value}
            disabled={pending}
            onChange={(event) => setValue(event.target.value)}
          />
        ) : null}
        {error ? <p className="error" role="alert">{error}</p> : null}
        {dialog.method !== "select" ? (
          <div className="extension-dialog-actions">
            <button className="button" type="button" disabled={pending} onClick={() => onRespond(dialog.method === "confirm" ? { confirmed: false } : { cancelled: true })}>
              {dialog.method === "confirm" ? "No" : "Cancel"}
            </button>
            <button className="button is-primary" type="button" disabled={pending || ((dialog.method === "input" || dialog.method === "editor") && !value.trim())} onClick={() => onRespond(dialog.method === "confirm" ? { confirmed: true } : { value })}>
              {dialog.method === "confirm" ? "Yes" : "Continue"}
            </button>
          </div>
        ) : (
          <div className="extension-dialog-actions">
            <button className="button" type="button" disabled={pending} onClick={() => onRespond({ cancelled: true })}>Cancel</button>
          </div>
        )}
      </section>
    </div>
  );
}

export function ExtensionUiBridge({ pairId, onEditorText }: { pairId: string | null; onEditorText: (text: string) => void }) {
  const [view, setView] = useState<ExtensionUiView>(EMPTY_VIEW);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function load(activePairId: string, signal?: AbortSignal) {
    try {
      const payload = await getJson<{ extensionUi: ExtensionUiView }>(`/api/pairs/${encodeURIComponent(activePairId)}/extension-ui`, signal ? { signal } : undefined);
      setView(payload.extensionUi);
    } catch (nextError) {
      if (!(nextError instanceof DOMException && nextError.name === "AbortError")) setError(nextError instanceof Error ? nextError.message : String(nextError));
    }
  }

  useEffect(() => {
    if (!pairId) {
      setView(EMPTY_VIEW);
      return;
    }
    const controller = new AbortController();
    void load(pairId, controller.signal);
    const timer = window.setInterval(() => void load(pairId, controller.signal), 1_000);
    return () => {
      controller.abort();
      window.clearInterval(timer);
    };
  }, [pairId]);

  useEffect(() => {
    if (!pairId || !view.editorText) return;
    const item = view.editorText;
    onEditorText(item.text);
    void postJson(`/api/pairs/${encodeURIComponent(pairId)}/extension-ui/dismiss`, { itemId: item.id })
      .then(() => setView((current) => ({ ...current, editorText: current.editorText?.id === item.id ? null : current.editorText })))
      .catch((nextError) => setError(nextError instanceof Error ? nextError.message : String(nextError)));
  }, [onEditorText, pairId, view.editorText]);

  async function respond(response: ExtensionUiDialogResponse) {
    if (!pairId || !view.dialog || pending) return;
    setPending(true);
    setError(null);
    try {
      await postJson(`/api/pairs/${encodeURIComponent(pairId)}/extension-ui/respond`, { requestId: view.dialog.id, response });
      await load(pairId);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : String(nextError));
    } finally {
      setPending(false);
    }
  }

  async function dismissNotice(itemId: string) {
    if (!pairId) return;
    setView((current) => ({ ...current, notices: current.notices.filter((notice) => notice.id !== itemId) }));
    await postJson(`/api/pairs/${encodeURIComponent(pairId)}/extension-ui/dismiss`, { itemId }).catch((nextError) => {
      setError(nextError instanceof Error ? nextError.message : String(nextError));
    });
  }

  const hasRuntimeUi = view.notices.length > 0 || view.statuses.length > 0 || view.widgets.length > 0;
  return (
    <>
      {hasRuntimeUi ? (
        <aside className="extension-runtime-ui" aria-label="Extension activity">
          {view.statuses.map((status) => <span className="extension-status" key={status.id}>{status.text}</span>)}
          {view.widgets.map((widget) => (
            <div className="extension-widget" key={widget.id}>{widget.lines.map((line, index) => <span key={`${widget.id}:${index}`}>{line}</span>)}</div>
          ))}
          {view.notices.map((notice) => (
            <button className={`extension-notice is-${notice.tone}`} type="button" key={notice.id} onClick={() => void dismissNotice(notice.id)} title="Dismiss">
              <span>{notice.message}</span><span aria-hidden="true">×</span>
            </button>
          ))}
        </aside>
      ) : null}
      {view.dialog ? <ExtensionDialog dialog={view.dialog} pending={pending} error={error} onRespond={(response) => void respond(response)} /> : null}
    </>
  );
}
