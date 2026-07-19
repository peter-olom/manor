import { useEffect, useRef, useState } from "react";

import { postJson } from "./api";
import type { ManorRestartRequestView } from "../shared/manor-restart";

function restartTargetLabel(request: ManorRestartRequestView): string {
  if (request.gitRef) return request.gitRef;
  if (request.target === "latest") return "Latest source";
  return "Current checkout";
}

function updatesSource(request: ManorRestartRequestView): boolean {
  return request.update === true || request.target === "latest" || Boolean(request.gitRef);
}

export function ManorRestartDialog({
  pairId,
  request,
  onCleared
}: {
  pairId: string;
  request: ManorRestartRequestView;
  onCleared: () => void;
}) {
  const [action, setAction] = useState<"authorize" | "dismiss" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const dialogRef = useRef<HTMLElement | null>(null);
  const keepRunningRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const frame = window.requestAnimationFrame(() => keepRunningRef.current?.focus());
    const trapFocus = (event: KeyboardEvent) => {
      if (event.key !== "Tab" || !dialogRef.current) return;
      const controls = [...dialogRef.current.querySelectorAll<HTMLButtonElement>("button:not([disabled])")];
      const first = controls[0];
      const last = controls.at(-1);
      if (!first || !last) {
        event.preventDefault();
        dialogRef.current.focus();
        return;
      }
      if (document.activeElement === dialogRef.current) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
        return;
      }
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", trapFocus);
    return () => {
      window.cancelAnimationFrame(frame);
      document.removeEventListener("keydown", trapFocus);
      if (previousFocus?.isConnected) previousFocus.focus();
    };
  }, []);

  useEffect(() => {
    if (action) dialogRef.current?.focus();
  }, [action]);

  async function submit(nextAction: "authorize" | "dismiss") {
    if (action) return;
    setAction(nextAction);
    setError(null);
    const base = `/api/pairs/${encodeURIComponent(pairId)}/manor-restart-requests/${encodeURIComponent(request.id)}`;
    try {
      await postJson(
        `${base}/${nextAction}`,
        nextAction === "authorize" ? { operatorAction: "authorize_restart" } : {}
      );
      onCleared();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
      setAction(null);
    }
  }

  return (
    <div className="modal-backdrop manor-restart-backdrop">
      <section
        ref={dialogRef}
        className="modal manor-restart-dialog"
        tabIndex={-1}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="manor-restart-title"
        aria-describedby="manor-restart-description"
      >
        <header>
          <p className="manor-restart-kicker">Live Manor stack</p>
          <h2 id="manor-restart-title">Authorize Manor restart?</h2>
          <p id="manor-restart-description">Review this request before Manor rebuilds and restarts the live stack.</p>
        </header>
        <dl className="manor-restart-details">
          <div>
            <dt>Target</dt>
            <dd>{restartTargetLabel(request)}</dd>
          </div>
          <div>
            <dt>Reason</dt>
            <dd>{request.reason ?? "No reason provided"}</dd>
          </div>
          {request.details ? (
            <div>
              <dt>Details</dt>
              <dd>{request.details}</dd>
            </div>
          ) : null}
          {request.includeDesktop ? (
            <div>
              <dt>Desktop app</dt>
              <dd>Included</dd>
            </div>
          ) : null}
          <div>
            <dt>Update source</dt>
            <dd>{updatesSource(request) ? "Yes" : "No"}</dd>
          </div>
          <div>
            <dt>Rebuild services</dt>
            <dd>{request.build === false ? "No" : "Yes"}</dd>
          </div>
        </dl>
        <p className="manor-restart-note">Your approval starts the restart through Manor’s host controller.</p>
        {error ? <div className="error" role="alert">{error}</div> : null}
        <footer className="modal-actions">
          <button ref={keepRunningRef} className="button" type="button" disabled={action !== null} onClick={() => void submit("dismiss")}>
            {action === "dismiss" ? "Keeping Manor running…" : "Keep running"}
          </button>
          <button className="button is-danger-solid" type="button" disabled={action !== null} onClick={() => void submit("authorize")}>
            {action === "authorize" ? "Starting restart…" : "Authorize restart"}
          </button>
        </footer>
      </section>
    </div>
  );
}
