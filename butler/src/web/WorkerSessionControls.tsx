import { useEffect, useState } from "react";

import { getJson, postJson } from "./api";
import type { WorkerSessionControlAction, WorkerSessionControls } from "../shared/worker-session-controls";

function formatNumber(value: number): string {
  return new Intl.NumberFormat().format(value);
}

function formatCost(value: number): string {
  return new Intl.NumberFormat(undefined, { style: "currency", currency: "USD", maximumFractionDigits: 4 }).format(value);
}

type SessionControlsButtonProps = {
  pairId: string;
  lane: "butler" | "worker";
  disabled: boolean;
};

export function SessionControlsButton({ pairId, lane, disabled }: SessionControlsButtonProps) {
  const [open, setOpen] = useState(false);
  const [controls, setControls] = useState<WorkerSessionControls | null>(null);
  const [pending, setPending] = useState<WorkerSessionControlAction | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [instructions, setInstructions] = useState("");
  const [entryId, setEntryId] = useState("");

  async function load() {
    const payload = await getJson<{ controls: WorkerSessionControls }>(`/api/pairs/${encodeURIComponent(pairId)}/${lane}/controls`);
    setControls(payload.controls);
    setName(payload.controls.sessionName ?? "");
    setEntryId((current) => payload.controls.forkPoints.some((point) => point.entryId === current) ? current : payload.controls.forkPoints.at(-1)?.entryId ?? "");
  }

  useEffect(() => {
    if (!open) return;
    setError(null);
    void load().catch((nextError) => setError(nextError instanceof Error ? nextError.message : String(nextError)));
  }, [open, pairId]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !pending) setOpen(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, pending]);

  async function run(action: WorkerSessionControlAction, body: Record<string, unknown> = {}) {
    if (pending) return;
    setPending(action);
    setError(null);
    try {
      await postJson(`/api/pairs/${encodeURIComponent(pairId)}/${lane}/controls/${action}`, body);
      await load();
      if (action === "compact") setInstructions("");
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : String(nextError));
    } finally {
      setPending(null);
    }
  }

  return (
    <>
      <button className="button" type="button" disabled={disabled} onClick={() => setOpen(true)}>Session controls</button>
      {open ? (
        <div className="worker-session-backdrop" role="presentation">
          <section className="worker-session-dialog" role="dialog" aria-modal="true" aria-labelledby="worker-session-title">
            <header className="worker-session-head">
              <div>
                <span className="eyebrow">Pi {lane}</span>
                <h2 id="worker-session-title">Session controls</h2>
              </div>
              <button className="button" type="button" disabled={Boolean(pending)} onClick={() => setOpen(false)}>Close</button>
            </header>
            {!controls && !error ? <p className="muted">Loading session details…</p> : null}
            {controls?.stats ? (
              <dl className="worker-session-stats">
                <div><dt>Messages</dt><dd>{formatNumber(controls.stats.totalMessages)}</dd></div>
                <div><dt>Tool calls</dt><dd>{formatNumber(controls.stats.toolCalls)}</dd></div>
                <div><dt>Tokens</dt><dd>{formatNumber(controls.stats.tokens.total)}</dd></div>
                <div><dt>Cost</dt><dd>{formatCost(controls.stats.cost)}</dd></div>
                <div><dt>Context</dt><dd>{controls.stats.contextUsage?.percent == null ? "—" : `${Math.round(controls.stats.contextUsage.percent)}%`}</dd></div>
                <div><dt>Queued</dt><dd>{formatNumber(controls.pendingMessageCount)}</dd></div>
              </dl>
            ) : null}
            {controls ? (
              <div className="worker-session-sections">
                <section>
                  <h3>Name</h3>
                  <div className="worker-session-row">
                    <input className="input" value={name} maxLength={120} onChange={(event) => setName(event.target.value)} aria-label={`Pi ${lane} session name`} />
                    <button className="button" type="button" disabled={!name.trim() || Boolean(pending)} onClick={() => void run("rename", { name })}>Save</button>
                  </div>
                </section>
                <section>
                  <h3>Context</h3>
                  <textarea className="input worker-session-instructions" value={instructions} placeholder="Optional compaction instructions" onChange={(event) => setInstructions(event.target.value)} />
                  <div className="worker-session-actions">
                    <button className="button" type="button" disabled={controls.busy || controls.compacting || Boolean(pending)} onClick={() => void run("compact", { instructions })}>Compact now</button>
                    <button className="button" type="button" disabled={Boolean(pending)} onClick={() => void run("abort-retry")}>Cancel retry</button>
                    <a className="button" href={`/api/pairs/${encodeURIComponent(pairId)}/${lane}/export`}>Export HTML</a>
                  </div>
                </section>
                <section>
                  <h3>Branch</h3>
                  <div className="worker-session-row">
                    <select className="input" value={entryId} onChange={(event) => setEntryId(event.target.value)} aria-label="Branch point">
                      {controls.forkPoints.map((point) => <option key={point.entryId} value={point.entryId}>{point.text.slice(0, 110)}</option>)}
                    </select>
                    <button className="button" type="button" disabled={!entryId || controls.busy || controls.compacting || Boolean(pending)} onClick={() => void run("fork", { entryId })}>Fork here</button>
                  </div>
                  <button className="button" type="button" disabled={!controls.leafId || controls.busy || controls.compacting || Boolean(pending)} onClick={() => void run("clone")}>Clone active branch</button>
                </section>
              </div>
            ) : null}
            {error ? <p className="error" role="alert">{error}</p> : null}
          </section>
        </div>
      ) : null}
    </>
  );
}

export function WorkerSessionControlsButton({ pairId, disabled }: { pairId: string; disabled: boolean }) {
  return <SessionControlsButton pairId={pairId} lane="worker" disabled={disabled} />;
}
