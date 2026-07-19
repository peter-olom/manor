import { useEffect, useRef } from "react";

import { SandSpinner } from "./SandSpinner";
import type { ManorRestartProgressView } from "../shared/manor-restart";

export type ManorRestartProgressPhase = "starting" | "running" | "reconnecting" | "verifying" | "confirmed" | "failed" | "unconfirmed";

export function resolveManorRestartProgressPhase(input: {
  progress: ManorRestartProgressView;
  connected: boolean;
  hasConnected: boolean;
  hadDisconnect: boolean;
  statusReachable: boolean | null;
}): ManorRestartProgressPhase {
  if (input.progress.status === "failed") return "failed";
  if (input.progress.status === "unconfirmed" && input.statusReachable) return "unconfirmed";
  if (input.progress.status === "completed") return input.connected ? "confirmed" : "reconnecting";
  if (input.statusReachable === null) return "starting";
  if (!input.statusReachable || (input.hasConnected && !input.connected)) return "reconnecting";
  if (input.hadDisconnect) return "verifying";
  return "running";
}

function phaseContent(phase: ManorRestartProgressPhase, currentStep: string | null) {
  switch (phase) {
    case "starting": return { title: "Starting Manor restart", body: "The host controller is accepting the restart request." };
    case "running": return { title: "Restart in progress", body: currentStep || "Manor is rebuilding and restarting its services." };
    case "reconnecting": return { title: "Manor is restarting", body: "Connection lost as expected. Reconnecting automatically…" };
    case "verifying": return { title: "Connection restored", body: currentStep || "The restart is still finishing its checks." };
    case "confirmed": return { title: "Manor restarted", body: "Connection restored and the host controller confirmed completion." };
    case "failed": return { title: "Restart failed", body: "The host controller could not complete the restart." };
    case "unconfirmed": return { title: "Restart status unconfirmed", body: "Manor is reachable, but the host controller no longer reports this restart." };
  }
}

export function ManorRestartProgressDialog({
  progress,
  connected,
  hasConnected,
  hadDisconnect,
  statusReachable,
  acknowledging,
  actionError,
  onRetry,
  onAcknowledge
}: {
  progress: ManorRestartProgressView;
  connected: boolean;
  hasConnected: boolean;
  hadDisconnect: boolean;
  statusReachable: boolean | null;
  acknowledging: boolean;
  actionError: string | null;
  onRetry: () => void;
  onAcknowledge: () => void;
}) {
  const phase = resolveManorRestartProgressPhase({ progress, connected, hasConnected, hadDisconnect, statusReachable });
  const content = phaseContent(phase, progress.currentStep);
  const terminal = phase === "confirmed" || phase === "failed" || phase === "unconfirmed";
  const actionRef = useRef<HTMLButtonElement | null>(null);
  const dialogRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const frame = window.requestAnimationFrame(() => dialogRef.current?.focus());
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
      } else if (event.shiftKey && document.activeElement === first) {
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
    if (terminal) actionRef.current?.focus();
  }, [terminal]);

  const activeStep = phase === "confirmed" ? 3 : phase === "reconnecting" || phase === "verifying" ? 2 : 1;

  return (
    <div className="modal-backdrop manor-restart-backdrop">
      <section ref={dialogRef} className={`modal manor-restart-dialog manor-restart-progress is-${phase}`} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby="manor-restart-progress-title">
        <div className="manor-restart-progress-hero" aria-hidden="true">
          {phase === "confirmed" ? <span className="manor-restart-result-icon is-success">✓</span>
            : phase === "failed" || phase === "unconfirmed" ? <span className="manor-restart-result-icon is-warning">!</span>
              : <SandSpinner />}
        </div>
        <div className="manor-restart-progress-copy" role={phase === "failed" ? "alert" : "status"} aria-live={phase === "failed" ? "assertive" : "polite"}>
          <p className="manor-restart-kicker">Live Manor stack</p>
          <h2 id="manor-restart-progress-title">{content.title}</h2>
          <p>{content.body}</p>
        </div>
        <ol className="manor-restart-steps" aria-label="Restart progress">
          {["Restarting", "Reconnecting", "Confirmed"].map((label, index) => {
            const step = index + 1;
            const state = step < activeStep ? "is-complete" : step === activeStep ? "is-active" : "";
            return <li key={label} className={state}><span>{step < activeStep || phase === "confirmed" ? "✓" : step}</span><small>{label}</small></li>;
          })}
        </ol>
        {actionError ? <div className="error" role="alert">{actionError}</div> : null}
        {terminal ? (
          <footer className="modal-actions">
            {phase === "unconfirmed" ? <button className="button" type="button" disabled={acknowledging} onClick={onRetry}>Check again</button> : null}
            <button ref={actionRef} className={phase === "confirmed" ? "button is-primary" : "button"} type="button" disabled={acknowledging} onClick={onAcknowledge}>
              {acknowledging ? "Closing…" : phase === "confirmed" ? "Continue" : "Close"}
            </button>
          </footer>
        ) : null}
      </section>
    </div>
  );
}
