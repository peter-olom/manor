import { useEffect, useMemo, useRef, useState } from "react";

import { getJson } from "./api";
import { ChevronDownIcon, FilesIcon } from "./icons";

import type { PairDetail, PairWorkspaceListResponse } from "../shared/pairing";

function workspaceName(cwd: string): string {
  if (cwd === "/repos") return "Shared workspace";
  const parts = cwd.split("/").filter(Boolean);
  const managedIndex = parts.indexOf(".manor-worktrees");
  if (managedIndex >= 0 && parts[managedIndex + 1]) return parts[managedIndex + 1]!;
  return parts.at(-1) ?? cwd;
}

function focusableElements(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(
    'button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])'
  )].filter((element) => element.getClientRects().length > 0);
}

export function SessionWorkspaceControl({
  pair,
  pending,
  onChange
}: {
  pair: PairDetail;
  pending: boolean;
  onChange: (cwd: string) => Promise<void>;
}) {
  const effectiveCwd = pair.worker?.cwd ?? pair.defaultCwd ?? "/repos";
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(effectiveCwd);
  const [workspaces, setWorkspaces] = useState<PairWorkspaceListResponse["workspaces"]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const dialogRef = useRef<HTMLElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const pendingRef = useRef(pending);
  pendingRef.current = pending;

  const filteredWorkspaces = useMemo(() => {
    const query = draft.trim().toLowerCase();
    if (!query || query.startsWith("/")) return workspaces;
    return workspaces.filter((workspace) => `${workspace.label} ${workspace.cwd}`.toLowerCase().includes(query));
  }, [draft, workspaces]);

  useEffect(() => {
    if (!open) return;
    setDraft(effectiveCwd);
    setError(null);
    setCopied(false);
    setLoading(true);
    void getJson<PairWorkspaceListResponse>("/api/workspaces")
      .then((payload) => setWorkspaces(payload.workspaces))
      .catch((caught) => setError(caught instanceof Error ? caught.message : String(caught)))
      .finally(() => setLoading(false));
    const frame = window.requestAnimationFrame(() => inputRef.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, [effectiveCwd, open]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        if (!pendingRef.current) setOpen(false);
        return;
      }
      if (event.key !== "Tab" || !dialogRef.current) return;
      const focusable = focusableElements(dialogRef.current);
      if (focusable.length === 0) return;
      const first = focusable[0]!;
      const last = focusable.at(-1)!;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      triggerRef.current?.focus();
    };
  }, [open]);

  const workerRunning = pair.worker?.status === "running" || pair.status === "worker_running";
  const changed = draft.trim() !== effectiveCwd;
  const submit = async () => {
    if (!changed || pending || workerRunning) return;
    setError(null);
    try {
      await onChange(draft.trim());
      setOpen(false);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  };

  return (
    <>
      <button
        ref={triggerRef}
        className="session-workspace-trigger"
        type="button"
        title={effectiveCwd}
        aria-label={`Workspace: ${effectiveCwd}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        disabled={pending}
        onClick={() => setOpen(true)}
      >
        <FilesIcon />
        <span className="session-workspace-name">{workspaceName(effectiveCwd)}</span>
        <span className="session-workspace-path">{effectiveCwd}</span>
        <ChevronDownIcon />
      </button>
      {open ? (
        <div className="modal-backdrop session-workspace-backdrop" onMouseDown={(event) => {
          if (event.target === event.currentTarget && !pending) setOpen(false);
        }}>
          <section ref={dialogRef} className="modal session-workspace-dialog" role="dialog" aria-modal="true" aria-labelledby="session-workspace-title" aria-describedby="session-workspace-description" tabIndex={-1}>
            <header>
              <div>
                <h2 id="session-workspace-title">Session workspace</h2>
                <p id="session-workspace-description">File mentions and the Worker use this directory.</p>
              </div>
              <button className="icon-button" type="button" aria-label="Close workspace dialog" disabled={pending} onClick={() => setOpen(false)}>×</button>
            </header>
            <label className="session-workspace-field">
              <span>Directory</span>
              <div>
                <input ref={inputRef} className="input" value={draft} disabled={pending} spellCheck={false} onChange={(event) => setDraft(event.target.value)} onKeyDown={(event) => {
                  if (event.key === "Enter") { event.preventDefault(); void submit(); }
                }} />
                <button className="button" type="button" disabled={pending} onClick={() => {
                  void navigator.clipboard.writeText(effectiveCwd).then(() => setCopied(true)).catch(() => setError("Could not copy the workspace directory."));
                }}>{copied ? "Copied" : "Copy"}</button>
              </div>
            </label>
            <div className="session-workspace-options" aria-label="Known workspaces">
              {loading ? <span className="session-workspace-empty">Loading workspaces…</span> : filteredWorkspaces.length > 0 ? filteredWorkspaces.map((workspace) => (
                <button key={workspace.cwd} type="button" className={workspace.cwd === draft ? "is-selected" : ""} disabled={pending} onClick={() => setDraft(workspace.cwd)}>
                  <strong>{workspace.label}</strong>
                  <span>{workspace.cwd}</span>
                </button>
              )) : <span className="session-workspace-empty">Enter an existing directory in the shared workspace.</span>}
            </div>
            {pair.worker ? (
              <p className={`session-workspace-note ${workerRunning ? "is-warning" : ""}`}>
                {workerRunning
                  ? "Wait for the current Worker turn to finish before changing workspace."
                  : "Changing workspace starts a new Worker there. Task context is handed over with a fresh review baseline; provider cache and hidden reasoning do not transfer."}
              </p>
            ) : <p className="session-workspace-note">The first Worker for this session will start in the selected workspace.</p>}
            {error ? <div className="error" role="alert">{error}</div> : null}
            <footer>
              <button className="button" type="button" disabled={pending} onClick={() => setOpen(false)}>Cancel</button>
              <button className="button is-primary" type="button" disabled={!changed || !draft.trim() || pending || workerRunning} onClick={() => void submit()}>
                {pending ? "Changing…" : pair.worker ? "Switch workspace" : "Use workspace"}
              </button>
            </footer>
          </section>
        </div>
      ) : null}
    </>
  );
}
