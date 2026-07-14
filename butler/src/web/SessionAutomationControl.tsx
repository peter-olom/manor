import { useEffect, useRef, useState } from "react";

import { AutomationIcon } from "./icons";
import type { PairAutomationLastRun, PairDetail } from "../shared/pairing";

function focusableElements(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>('button:not([disabled]), [tabindex]:not([tabindex="-1"])')]
    .filter((element) => element.getClientRects().length > 0);
}

function outcomeLabel(outcome: PairAutomationLastRun | null): string {
  if (!outcome) return "Never run";
  if (outcome.outcome === "needs_input") return "Needs input";
  return outcome.outcome.charAt(0).toUpperCase() + outcome.outcome.slice(1);
}

export function SessionAutomationControl({
  pair,
  pending,
  onEnabledChange,
  onDelete,
  onEdit
}: {
  pair: PairDetail;
  pending: boolean;
  onEnabledChange: (enabled: boolean) => Promise<void>;
  onDelete: () => Promise<void>;
  onEdit: () => void;
}) {
  const automation = pair.automation;
  const [open, setOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const dialogRef = useRef<HTMLElement | null>(null);
  const pendingRef = useRef(pending);
  pendingRef.current = pending;

  useEffect(() => {
    if (!open) return;
    setConfirmDelete(false);
    setError(null);
    const frame = requestAnimationFrame(() => focusableElements(dialogRef.current!)[0]?.focus());
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !pendingRef.current) { event.preventDefault(); setOpen(false); return; }
      if (event.key !== "Tab" || !dialogRef.current) return;
      const focusable = focusableElements(dialogRef.current);
      const first = focusable[0]; const last = focusable.at(-1);
      if (!first || !last) return;
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => { cancelAnimationFrame(frame); document.removeEventListener("keydown", onKeyDown); triggerRef.current?.focus(); };
  }, [open]);

  if (!automation) return null;
  const intervalSummary = automation.schedule.kind === "interval" && automation.endsAtLabel
    ? `${automation.schedule.everyMinutes === 1 ? "Every minute" : `Every ${automation.schedule.everyMinutes} min`} · until ${automation.endsAtLabel}`
    : automation.scheduleLabel;
  const triggerLabel = `${automation.state === "active" ? "" : `${automation.state.charAt(0).toUpperCase()}${automation.state.slice(1)} · `}${intervalSummary}`;
  const mutate = async (action: () => Promise<void>) => {
    setError(null);
    try { await action(); } catch (caught) { setError(caught instanceof Error ? caught.message : String(caught)); }
  };

  return (
    <>
      <button ref={triggerRef} className={`session-automation-trigger is-${automation.state}`} type="button" aria-haspopup="dialog" aria-expanded={open} aria-label={`Automation: ${triggerLabel}`} onClick={() => setOpen(true)}>
        <AutomationIcon /><span>{triggerLabel}</span>
      </button>
      {open ? (
        <div className="modal-backdrop session-automation-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget && !pending) setOpen(false); }}>
          <section ref={dialogRef} className="modal session-automation-dialog" role="dialog" aria-modal="true" aria-labelledby="automation-title" aria-describedby="automation-description">
            <header>
              <div><h2 id="automation-title">Session automation</h2><p id="automation-description">Runs on Butler’s system wall clock.</p></div>
              <button className="icon-button" type="button" disabled={pending} aria-label="Close automation dialog" onClick={() => setOpen(false)}>×</button>
            </header>
            <div className="automation-status-row" aria-live="polite">
              <span className={`automation-state is-${automation.state}`}>{automation.state.charAt(0).toUpperCase() + automation.state.slice(1)}</span>
              <strong>{automation.scheduleLabel}</strong>
            </div>
            <div className="automation-instruction"><span>Instructions</span><p>{automation.instruction}</p></div>
            <dl className="automation-details">
              {automation.endsAtLabel ? <div><dt>Runs through</dt><dd>{automation.endsAtLabel}</dd></div> : null}
              <div><dt>Next run</dt><dd>{automation.state === "completed" ? "None" : automation.enabled ? automation.nextRunLabel ?? "Calculating…" : "Paused"}</dd></div>
              <div><dt>Last run</dt><dd>{automation.lastRunLabel ?? "Never"}</dd></div>
              <div><dt>Outcome</dt><dd>{outcomeLabel(automation.lastRun)}</dd></div>
            </dl>
            <p className="session-workspace-note">Results are posted here and saved with this session. Missed runs while Butler is offline are skipped.</p>
            {error ? <div className="error" role="alert">{error}</div> : null}
            {confirmDelete ? <div className="automation-delete-confirm" role="alert"><span>Delete this schedule? Existing results and session history stay.</span><button className="button is-danger" type="button" disabled={pending} onClick={() => void mutate(async () => { await onDelete(); setOpen(false); })}>{pending ? "Deleting…" : "Delete schedule"}</button></div> : null}
            <footer>
              <button className="button is-danger" type="button" disabled={pending} onClick={() => setConfirmDelete(true)}>Delete</button>
              <span className="automation-footer-spacer" />
              <button className="button" type="button" disabled={pending} onClick={() => { setOpen(false); onEdit(); }}>Edit with Butler</button>
              {automation.state !== "completed" ? <button className="button is-primary" type="button" disabled={pending} onClick={() => void mutate(() => onEnabledChange(!automation.enabled))}>{pending ? "Saving…" : automation.enabled ? "Pause" : "Resume"}</button> : null}
            </footer>
          </section>
        </div>
      ) : null}
    </>
  );
}
